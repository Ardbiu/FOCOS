"""Calibration of VIIRS fire cell-passes to MODIS-equivalent counts (section 4.4).

Candidates
  C0  naive: raw VIIRS pixel count, no conversion (comparison only)
  C1  one national ratio per season and day/night
  C2  a ratio per 5-degree block, season and day/night, shrunk toward C1
  C3  strength-aware: non-negative weights for VIIRS FCPs of class 1, 2, 3,
      then a clipped per-block adjustment

All fitting works on a small table with one row per (year, month, day/night,
block, province): Aqua FCP-equivalents `m`, VIIRS FCP-equivalents by strength
class `v1`, `v2`, `v3`, and raw VIIRS pixels `v_pix`.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
from scipy.optimize import nnls

from . import config

CALIBRATION_PATH = config.PIPELINE_DIR / "data" / "calibration.json"
NOAA20_CALIBRATION_PATH = config.PIPELINE_DIR / "data" / "calibration_noaa20.json"
SEASON_OF_MONTH = {12: "DJF", 1: "DJF", 2: "DJF", 3: "MAM", 4: "MAM", 5: "MAM",
                   6: "JJA", 7: "JJA", 8: "JJA", 9: "SON", 10: "SON", 11: "SON"}
SIMPLICITY_ORDER = ("C1", "C2", "C3")
M_CANDIDATES = (50, 200, 1000)
DEFAULT_M = 200
MIN_AQUA_FCP = 20          # province-months below this are not scored
C3_MIN_ROW_TOTAL = 20      # C3 fits only rows with M + V at least this
SELECTION_TOLERANCE = 0.10  # "within 10% (relative) of the best score"


class TestYearsLocked(RuntimeError):
    """Raised when a model is fitted on a test year before the freeze."""

    __test__ = False  # not a pytest test class


def training_table(pix: duckdb.DuckDBPyRelation, excluded_days: set[date], viirs_sat: str = "N") -> pd.DataFrame:
    """One row per (year, month, dn, block, prov) from the pixel table.

    Compares Aqua with one VIIRS satellite (`viirs_sat`: "N" for S-NPP, "N20"
    for NOAA-20). Uses local dates from the switch date on, and leaves out
    `excluded_days` (days when either sensor was out).
    """
    if not viirs_sat.isalnum():
        raise ValueError(f"bad satellite code: {viirs_sat!r}")
    # Dates go in as literals so the query works on whatever connection owns `pix`.
    day_list = ", ".join(f"DATE '{d.isoformat()}'" for d in sorted(excluded_days))
    not_excluded = f"AND local_date NOT IN ({day_list})" if day_list else ""
    switch = config.SWITCH_DATE.isoformat()
    return pix.query("pix_rows", f"""
        SELECT
            year, month, dn,
            CAST(floor(cell01_lat / 500.0) AS INTEGER) || '|' || CAST(floor(cell01_lon / 500.0) AS INTEGER) AS block,
            prov,
            coalesce(sum(1.0 / n_pix) FILTER (WHERE sat = 'A'), 0) AS m,
            coalesce(sum(1.0 / n_pix) FILTER (WHERE sat = '{viirs_sat}' AND strength = 1), 0) AS v1,
            coalesce(sum(1.0 / n_pix) FILTER (WHERE sat = '{viirs_sat}' AND strength = 2), 0) AS v2,
            coalesce(sum(1.0 / n_pix) FILTER (WHERE sat = '{viirs_sat}' AND strength = 3), 0) AS v3,
            count(*) FILTER (WHERE sat = '{viirs_sat}') AS v_pix
        FROM pix_rows
        WHERE sat IN ('A', '{viirs_sat}') AND local_date >= DATE '{switch}' {not_excluded}
          -- compare only from the day the VIIRS satellite's own record starts
          AND local_date >= (SELECT min(local_date) FROM pix_rows WHERE sat = '{viirs_sat}')
        GROUP BY ALL
        ORDER BY ALL
    """).df()


def _prepared(data: pd.DataFrame, years) -> pd.DataFrame:
    df = data[data["year"].isin(list(years))].copy()
    df["season"] = df["month"].map(SEASON_OF_MONTH)
    df["v"] = df["v1"] + df["v2"] + df["v3"]
    return df


def block_adjustment(sum_m: float, sum_mhat: float, m: float) -> float:
    """Per-block correction r = (sum M + m) / (sum M-hat + m), clipped to 0.5..2."""
    denominator = sum_mhat + m
    if denominator <= 0:
        return 1.0
    return float(min(2.0, max(0.5, (sum_m + m) / denominator)))


def fit(candidate: str, years, data: pd.DataFrame | None = None, m: int | None = None,
        frozen_path: Path | None = None) -> dict:
    """Fit one candidate on the given years. Test years are locked until the freeze."""
    years = sorted(int(y) for y in years)
    first_test, last_test = config.TEST_YEARS
    if any(first_test <= y <= last_test for y in years):
        frozen_path = Path(frozen_path) if frozen_path is not None else CALIBRATION_PATH
        if not frozen_path.exists():
            raise TestYearsLocked("test years stay closed until the calibration is frozen")
    if data is None:
        data = load_training_table()
    df = _prepared(data, years)
    total_v = df["v"].sum()
    overall = float(df["m"].sum() / total_v) if total_v > 0 else 0.0
    model = {"candidate": candidate, "train_years": [years[0], years[-1]], "m": None, "overall": overall}

    national = {}
    for (season, dn), g in df.groupby(["season", "dn"]):
        v = g["v"].sum()
        national[f"{season}|{dn}"] = float(g["m"].sum() / v) if v > 0 else overall
    model["national"] = national

    if candidate == "C1":
        return model
    m = DEFAULT_M if m is None else m
    model["m"] = m
    if candidate == "C2":
        blocks = {}
        for (block, season, dn), g in df.groupby(["block", "season", "dn"]):
            parent = national.get(f"{season}|{dn}", overall)
            blocks[f"{block}|{season}|{dn}"] = float((g["m"].sum() + m * parent) / (g["v"].sum() + m))
        model["blocks"] = blocks
        return model
    if candidate == "C3":
        coef, adjust = {}, {}
        for dn, g in df.groupby("dn"):
            rows = g.groupby(["block", "year", "month"], as_index=False)[["m", "v1", "v2", "v3"]].sum()
            fit_rows = rows[rows["m"] + rows[["v1", "v2", "v3"]].sum(axis=1) >= C3_MIN_ROW_TOTAL]
            if len(fit_rows) == 0:
                beta = np.array([overall, overall, overall])
            else:
                weight = np.sqrt(1.0 / (fit_rows["m"].to_numpy() + 1.0))
                x = fit_rows[["v1", "v2", "v3"]].to_numpy() * weight[:, None]
                beta, _ = nnls(x, fit_rows["m"].to_numpy() * weight)
            coef[dn] = [float(b) for b in beta]
            rows["mhat"] = rows[["v1", "v2", "v3"]].to_numpy() @ beta
            for block, b in rows.groupby("block"):
                adjust[f"{block}|{dn}"] = block_adjustment(b["m"].sum(), b["mhat"].sum(), m)
        model["coef"], model["adjust"] = coef, adjust
        return model
    raise ValueError(f"unknown candidate: {candidate}")


def predict(model: dict, table: pd.DataFrame) -> np.ndarray:
    """k for every row of `table`, which needs month, dn, block and strength."""
    season = table["month"].map(SEASON_OF_MONTH).to_numpy()
    dn = table["dn"].to_numpy()
    block = table["block"].to_numpy()
    overall = model["overall"]
    national = model["national"]
    candidate = model["candidate"]
    out = np.empty(len(table), dtype=float)
    if candidate in ("C1", "C2"):
        blocks = model.get("blocks", {})
        for i in range(len(table)):
            parent = national.get(f"{season[i]}|{dn[i]}", overall)
            out[i] = blocks.get(f"{block[i]}|{season[i]}|{dn[i]}", parent) if candidate == "C2" else parent
        return out
    if candidate == "C3":
        strength = table["strength"].to_numpy()
        for i in range(len(table)):
            beta = model["coef"].get(dn[i])
            base = beta[int(strength[i]) - 1] if beta is not None else overall
            out[i] = base * model["adjust"].get(f"{block[i]}|{dn[i]}", 1.0)
        return out
    raise ValueError(f"unknown candidate: {candidate}")


def predicted(model: dict | None, data: pd.DataFrame) -> np.ndarray:
    """MODIS-equivalent total for every row of a training-shaped table (None = C0)."""
    if model is None:
        return data["v_pix"].to_numpy(dtype=float)
    keys = data[["month", "dn", "block"]].drop_duplicates()
    total = np.zeros(len(data))
    for strength in (1, 2, 3):
        k = keys.assign(strength=strength)
        k["k"] = predict(model, k)
        merged = data[["month", "dn", "block"]].merge(k, on=["month", "dn", "block"], how="left")
        total += merged["k"].to_numpy() * data[f"v{strength}"].to_numpy()
    return total


def province_month_errors(model: dict | None, data: pd.DataFrame) -> np.ndarray:
    """Absolute % error of each scored province-month total (Aqua FCPs >= 20)."""
    df = data[["year", "month", "prov", "m"]].copy()
    df["pred"] = predicted(model, data)
    totals = df.groupby(["year", "month", "prov"], as_index=False)[["m", "pred"]].sum()
    totals = totals[totals["m"] >= MIN_AQUA_FCP]
    return (np.abs(totals["pred"] - totals["m"]) / totals["m"] * 100.0).to_numpy()


def _loyo_score(candidate: str, m: int | None, data: pd.DataFrame, years: list[int]) -> float:
    errors = []
    for held_out in years:
        held = data[data["year"] == held_out]
        if candidate == "C0":
            model = None
        else:
            model = fit(candidate, [y for y in years if y != held_out], data=data, m=m)
        errors.append(province_month_errors(model, held))
    pooled = np.concatenate(errors) if errors else np.array([])
    return float(np.median(pooled)) if len(pooled) else float("nan")


def loyo_scores(data: pd.DataFrame | None = None, years: list[int] | None = None) -> dict:
    """Leave-one-year-out score of every candidate inside the training years.

    The score is the median absolute % error of province-month totals. C2 and
    C3 are scored for each m; the best m is the one reported.
    """
    if years is None:
        years = list(range(config.TRAIN_YEARS[0], config.TRAIN_YEARS[1] + 1))
    if data is None:
        data = load_training_table()
    data = data[data["year"].isin(years)]
    by_m = {c: {str(m): _loyo_score(c, m, data, years) for m in M_CANDIDATES} for c in ("C2", "C3")}
    best_m = {c: int(min(by_m[c], key=lambda k: by_m[c][k])) for c in by_m}
    scores = {
        "C0": _loyo_score("C0", None, data, years),
        "C1": _loyo_score("C1", None, data, years),
        "C2": by_m["C2"][str(best_m["C2"])],
        "C3": by_m["C3"][str(best_m["C3"])],
    }
    return {"scores": scores, "best_m": best_m, "by_m": by_m}


def choose(scores: dict) -> str:
    """The simplest candidate whose score is within 10% (relative) of the best."""
    best = min(scores[c] for c in SIMPLICITY_ORDER)
    for candidate in SIMPLICITY_ORDER:
        if scores[candidate] <= best * (1.0 + SELECTION_TOLERANCE) + 1e-12:
            return candidate
    raise RuntimeError("no candidate satisfied the selection rule")


def freeze(data: pd.DataFrame | None = None, years: list[int] | None = None,
           path: Path | None = None) -> dict:
    """Score, choose, fit on all training years and write calibration.json. Runs once."""
    path = Path(path) if path is not None else CALIBRATION_PATH
    if path.exists():
        raise FileExistsError(f"{path} exists: the calibration is already frozen")
    if years is None:
        years = list(range(config.TRAIN_YEARS[0], config.TRAIN_YEARS[1] + 1))
    if data is None:
        data = load_training_table()
    loyo = loyo_scores(data=data, years=years)
    candidate = choose(loyo["scores"])
    m = loyo["best_m"].get(candidate)
    model = fit(candidate, years, data=data, m=m)
    frozen = {
        "candidate": candidate,
        "m": m,
        "train_years": [years[0], years[-1]],
        "test_years": list(config.TEST_YEARS),
        "frozen_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "selection_rule": "simplest of C1, C2, C3 within 10% (relative) of the best leave-one-year-out score",
        "loyo": loyo,
        "model": model,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(frozen, indent=1))
    return frozen


def freeze_noaa20(data: pd.DataFrame | None = None, frozen: dict | None = None,
                  path: Path | None = None) -> dict:
    """Re-fit the method frozen for S-NPP (candidate and m) for NOAA-20. Runs once.

    No new selection is made: the same recipe is fitted against Aqua on the
    stable years both satellites flew, and tested on the same held-out years.
    """
    path = Path(path) if path is not None else NOAA20_CALIBRATION_PATH
    if path.exists():
        raise FileExistsError(f"{path} exists: the NOAA-20 calibration is already frozen")
    frozen = frozen if frozen is not None else load_frozen()
    years = list(range(config.NOAA20_TRAIN_YEARS[0], config.NOAA20_TRAIN_YEARS[1] + 1))
    if data is None:
        data = load_training_table(table="agg_n20")
    model = fit(frozen["candidate"], years, data=data, m=frozen.get("m"))
    out = {
        "candidate": frozen["candidate"],
        "m": frozen.get("m"),
        "train_years": [years[0], years[-1]],
        "test_years": list(config.TEST_YEARS),
        "frozen_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "method": "candidate and m frozen for S-NPP, re-fitted for NOAA-20 against Aqua; no new selection",
        "model": model,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, indent=1))
    return out


def load_frozen(path: Path | None = None) -> dict:
    path = Path(path) if path is not None else CALIBRATION_PATH
    return json.loads(path.read_text())


def load_training_table(db_path: Path | None = None, table: str = "agg") -> pd.DataFrame:
    """A training table stored by the build step: `agg` (Aqua against S-NPP) or `agg_n20`."""
    if table not in ("agg", "agg_n20"):
        raise ValueError(f"unknown training table: {table}")
    db_path = Path(db_path) if db_path is not None else config.WORK_DIR / "focos.duckdb"
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        return con.sql(f"SELECT * FROM {table}").df()
    finally:
        con.close()
