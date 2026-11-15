"""Validation of the harmonized series against Aqua MODIS (section 4.7).

Harmonized VIIRS is compared with Aqua on days both sensors worked, at three
scales, on the held-out test years. The same numbers are computed for the
naive stitch (raw VIIRS pixels) so the two can be shown side by side.
"""
from __future__ import annotations

import json
import math
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from . import config

MIN_AQUA_FCP = 20
TARGETS = {"national_bias_abs_max": 0.10, "province_month_mape_max": 25.0, "national_month_logcorr_min": 0.95}
SEAM_FIRST, SEAM_LAST = (2012, 2), (2013, 12)


def _clean(value):
    """A float that JSON can hold: None instead of NaN or infinity."""
    if value is None:
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def metrics(pred, truth) -> dict:
    """Bias, median absolute % error and log correlation of pred against truth."""
    pred = np.asarray(pred, dtype=float)
    truth = np.asarray(truth, dtype=float)
    n = int(len(truth))
    if n == 0:
        return {"n": 0, "bias": None, "mape": None, "logcorr": None}
    total = truth.sum()
    bias = pred.sum() / total - 1.0 if total > 0 else None
    positive = truth > 0
    mape = np.median(np.abs(pred[positive] - truth[positive]) / truth[positive] * 100.0) if positive.any() else None
    logcorr = None
    if n >= 2:
        a, b = np.log1p(pred), np.log1p(truth)
        if a.std() > 0 and b.std() > 0:
            logcorr = np.corrcoef(a, b)[0, 1]
    return {"n": n, "bias": _clean(bias), "mape": _clean(mape), "logcorr": _clean(logcorr)}


def _not_excluded(excluded_days: set[date]) -> str:
    day_list = ", ".join(f"DATE '{d.isoformat()}'" for d in sorted(excluded_days))
    return f"AND local_date NOT IN ({day_list})" if day_list else ""


TILE_SQL = "'t_' || CAST(floor(lat) AS INTEGER) || '_' || CAST(floor(lon) AS INTEGER)"


def comparison(points: duckdb.DuckDBPyRelation, excluded_days: set[date], by: list[str],
               viirs_sat: str = "N") -> pd.DataFrame:
    """Aqua FCPs, raw Aqua pixels, harmonized VIIRS and raw VIIRS pixels, summed over comparable days.

    The VIIRS side is one satellite (`viirs_sat`: "N" for S-NPP, "N20" for
    NOAA-20), valued at `wk`, the weight each pixel would carry. Comparable
    days start at the switch date, run from that satellite's first day of data
    to its last, and leave out `excluded_days`. `by` may use year, month, prov
    and tile (the 1-degree tile id).
    """
    if not viirs_sat.isalnum():
        raise ValueError(f"bad satellite code: {viirs_sat!r}")
    cols = ", ".join(by)
    return points.query("pts", f"""
        WITH comparable AS (
            SELECT year, month, prov, {TILE_SQL} AS tile,
                CASE WHEN sat = 'A' THEN 1.0 / n_pix ELSE 0.0 END AS aqua,
                CASE WHEN sat = 'A' THEN 1.0 ELSE 0.0 END AS aqua_pix,
                CASE WHEN sat = '{viirs_sat}' THEN wk ELSE 0.0 END AS harmonized,
                CASE WHEN sat = '{viirs_sat}' THEN 1.0 ELSE 0.0 END AS naive
            FROM pts
            WHERE sat IN ('A', '{viirs_sat}')
              AND local_date >= DATE '{config.SWITCH_DATE.isoformat()}' {_not_excluded(excluded_days)}
              AND local_date >= (SELECT min(local_date) FROM pts WHERE sat = '{viirs_sat}')
              AND local_date <= (SELECT max(local_date) FROM pts WHERE sat = '{viirs_sat}')
        )
        SELECT {cols}, sum(aqua) AS aqua, sum(aqua_pix) AS aqua_pix,
               sum(harmonized) AS harmonized, sum(naive) AS naive
        FROM comparable GROUP BY {cols} ORDER BY {cols}
    """).df()


def handover(points: duckdb.DuckDBPyRelation, excluded_days: set[date], by: list[str]) -> pd.DataFrame:
    """Harmonized S-NPP next to harmonized NOAA-20 over comparable days (both at `wk`)."""
    cols = ", ".join(by)
    return points.query("pts", f"""
        WITH comparable AS (
            SELECT year, month, prov, {TILE_SQL} AS tile,
                CASE WHEN sat = 'N' THEN wk ELSE 0.0 END AS snpp,
                CASE WHEN sat = 'N20' THEN wk ELSE 0.0 END AS noaa20
            FROM pts
            WHERE sat IN ('N', 'N20') {_not_excluded(excluded_days)}
        )
        SELECT {cols}, sum(snpp) AS snpp, sum(noaa20) AS noaa20
        FROM comparable GROUP BY {cols} ORDER BY {cols}
    """).df()


def scale_metrics(pairs: pd.DataFrame, min_aqua: float = MIN_AQUA_FCP) -> dict:
    """Metrics for the harmonized and the naive series on rows with enough Aqua FCPs.

    Harmonized VIIRS is scored against Aqua cell-passes. The naive stitch is
    raw against raw: VIIRS pixels against Aqua pixels, as a user stitching the
    two downloads would see it.
    """
    scored = pairs[pairs["aqua"] >= min_aqua]
    raw_truth = scored["aqua_pix"] if "aqua_pix" in scored else scored["aqua"]
    return {
        "harmonized": metrics(scored["harmonized"], scored["aqua"]),
        "naive": metrics(scored["naive"], raw_truth),
    }


COUNT_BANDS = (("1-4", 1, 5), ("5-19", 5, 20), ("20+", 20, float("inf")))


def error_by_count(pairs: pd.DataFrame) -> list[dict]:
    """Median absolute % error of the harmonized series by how much fire Aqua saw.

    The headline error holds for months with at least 20 Aqua cell-passes;
    this shows how it grows when fire is scarce.
    """
    out = []
    for band, low, high in COUNT_BANDS:
        rows = pairs[(pairs["aqua"] >= low) & (pairs["aqua"] < high)]
        result = metrics(rows["harmonized"], rows["aqua"])
        out.append({"band": band, "n": result["n"], "mape": result["mape"]})
    return out


LEVEL_BANDS = (("<0.5x", 0.0, 0.5), ("0.5-2x", 0.5, 2.0), ("2-5x", 2.0, 5.0), ("5-10x", 5.0, 10.0),
               ("10x+", 10.0, float("inf")))
LEVEL_BASELINE_YEARS = (2012, 2021)  # before Aqua's drift shows
LEVEL_MIN_USUAL = 5.0


def bias_by_level(pairs: pd.DataFrame, test_years, min_aqua: float = MIN_AQUA_FCP) -> list[dict]:
    """Bias and error on the test years by how unusual the month was for Aqua.

    A month's level is Aqua's count divided by Aqua's usual count for that
    province and calendar month (the median over 2012-2021). Extreme months
    tend to be understated, and this says by how much.
    """
    base = _in_years(pairs, LEVEL_BASELINE_YEARS)
    usual = base.groupby(["prov", "month"])["aqua"].median().rename("usual").reset_index()
    rows = _in_years(pairs, test_years).merge(usual, on=["prov", "month"])
    rows = rows[(rows["aqua"] >= min_aqua) & (rows["usual"] >= LEVEL_MIN_USUAL)]
    level = rows["aqua"] / rows["usual"]
    out = []
    for band, low, high in LEVEL_BANDS:
        g = rows[(level >= low) & (level < high)]
        result = metrics(g["harmonized"], g["aqua"])
        out.append({"band": band, "n": result["n"], "bias": result["bias"], "mape": result["mape"]})
    return out


def province_bias(pairs: pd.DataFrame, province_names: dict, min_aqua: float = 100.0) -> list[dict]:
    """Per province over the test years: Aqua, harmonized, and harmonized / Aqua - 1.

    The pooled bias hides provinces that run persistently high or low.
    """
    totals = pairs.groupby("prov", as_index=False)[["aqua", "harmonized"]].sum()
    totals = totals[totals["aqua"] >= min_aqua].sort_values("prov")
    return [
        {"prov": r.prov, "name": province_names.get(r.prov, r.prov), "aqua": round(float(r.aqua), 2),
         "harmonized": round(float(r.harmonized), 2), "bias": _clean(r.harmonized / r.aqua - 1.0)}
        for r in totals.itertuples()
    ]


def peak_month_agreement(pairs: pd.DataFrame, min_aqua: float = MIN_AQUA_FCP) -> dict:
    """Share of province-years whose busiest month matches Aqua's busiest month."""
    hits = {"harmonized": 0, "naive": 0}
    n = 0
    for _, g in pairs.groupby(["prov", "year"]):
        if g["aqua"].sum() < min_aqua:
            continue
        n += 1
        peak = g.loc[g["aqua"].idxmax(), "month"]
        for series in hits:
            hits[series] += int(g.loc[g[series].idxmax(), "month"] == peak)
    return {"harmonized": hits["harmonized"] / n if n else None,
            "naive": hits["naive"] / n if n else None, "n": n}


def _spearman(a, b):
    if len(a) < 3:
        return None
    return _clean(spearmanr(a, b).statistic)


def _in_years(df: pd.DataFrame, years) -> pd.DataFrame:
    return df[(df["year"] >= years[0]) & (df["year"] <= years[1])]


HANDOVER_YEARS = (2022, 2025)  # both VIIRS satellites flying, outside the training and test years


def _noaa20_block(points, outage_days: dict, window: set, test_years, train_years, province_names) -> dict:
    """NOAA-20 against Aqua on the test years, and against S-NPP after them."""
    excluded = outage_days.get("A", set()) | outage_days.get("N20", set()) | window
    scales = {
        "national_month": comparison(points, excluded, ["year", "month"], viirs_sat="N20"),
        "province_month": comparison(points, excluded, ["year", "month", "prov"], viirs_sat="N20"),
        "tile_month": comparison(points, excluded, ["year", "month", "tile"], viirs_sat="N20"),
    }
    test = {name: scale_metrics(_in_years(pairs, test_years))["harmonized"] for name, pairs in scales.items()}
    both_out = outage_days.get("N", set()) | outage_days.get("N20", set())
    hand = {}
    for name, by in (("national_month", ["year", "month"]), ("province_month", ["year", "month", "prov"])):
        pairs = _in_years(handover(points, both_out, by), HANDOVER_YEARS)
        pairs = pairs[pairs["snpp"] >= MIN_AQUA_FCP]
        hand[name] = metrics(pairs["noaa20"], pairs["snpp"])
    return {
        "train_years": list(train_years),
        "test": test,
        "handover": {"years": list(HANDOVER_YEARS), **hand},
        "typical_error_pct": test["province_month"]["mape"],
        "province_bias": province_bias(_in_years(scales["province_month"], test_years), province_names),
    }


def build_validation(db_path: Path | None = None, frozen: dict | None = None,
                     province_names: dict | None = None, out_path: Path | None = None,
                     noaa20_train_years=None) -> dict:
    """Compute everything the method page draws and write validation.json."""
    from . import calibrate

    db_path = Path(db_path) if db_path is not None else config.WORK_DIR / "focos.duckdb"
    frozen = frozen if frozen is not None else calibrate.load_frozen()
    province_names = province_names or {}
    out_path = Path(out_path) if out_path is not None else config.WEB_DATA_DIR / "validation.json"
    test_years = frozen["test_years"]

    con = duckdb.connect(str(db_path), read_only=True)
    try:
        points = con.table("points")
        outage_days: dict[str, set] = {}
        for sat, day in con.sql("SELECT sat, local_date FROM outage").fetchall():
            outage_days.setdefault(sat, set()).add(day)
        first, last = config.AQUA_OUTAGE_2020
        window = {first + timedelta(days=i) for i in range((last - first).days + 1)}
        # Aqua against S-NPP: days when either was out, plus the 2020 Aqua window.
        excluded = outage_days.get("A", set()) | outage_days.get("N", set()) | window
        has_noaa20 = bool(con.sql("SELECT 1 FROM points WHERE sat = 'N20' LIMIT 1").fetchall())
        noaa20 = None
        if has_noaa20:
            noaa20 = _noaa20_block(points, outage_days, window, test_years,
                                   noaa20_train_years or config.NOAA20_TRAIN_YEARS, province_names)

        national_month = comparison(points, excluded, ["year", "month"])
        province_month = comparison(points, excluded, ["year", "month", "prov"])
        tile_month = comparison(points, excluded, ["year", "month", "tile"])
        yearly = comparison(points, excluded, ["year"])
        yearly_national = points.query("pts", f"""
            SELECT year,
                sum(CASE WHEN sat = 'A' THEN 1.0 / n_pix END) AS aqua,
                sum(CASE WHEN sat <> 'A' AND s = 1 THEN 1.0 END) AS viirs_raw,
                sum(CASE WHEN sat <> 'A' AND s = 1 THEN w END) AS viirs_harmonized,
                sum(w) AS series,
                sum(s) AS raw_series
            FROM pts WHERE year >= {config.SERIES_START.year}
            GROUP BY year ORDER BY year
        """).df()
    finally:
        con.close()

    scales = {
        "national_month": scale_metrics(_in_years(national_month, test_years)),
        "province_month": scale_metrics(_in_years(province_month, test_years)),
        "tile_month": scale_metrics(_in_years(tile_month, test_years)),
    }
    test = {series: {scale: scales[scale][series] for scale in scales} for series in ("harmonized", "naive")}
    h = test["harmonized"]
    targets_met = {
        "national_bias": None if h["national_month"]["bias"] is None
        else abs(h["national_month"]["bias"]) <= TARGETS["national_bias_abs_max"],
        "province_month_mape": None if h["province_month"]["mape"] is None
        else h["province_month"]["mape"] <= TARGETS["province_month_mape_max"],
        "national_month_logcorr": None if h["national_month"]["logcorr"] is None
        else h["national_month"]["logcorr"] >= TARGETS["national_month_logcorr_min"],
    }

    test_province = _in_years(province_month, test_years)
    scored = test_province[test_province["aqua"] >= MIN_AQUA_FCP]
    test_pairs = [
        {"prov": r.prov, "name": province_names.get(r.prov, r.prov), "year": int(r.year), "month": int(r.month),
         "aqua": round(float(r.aqua), 2), "harmonized": round(float(r.harmonized), 2), "naive": round(float(r.naive), 2)}
        for r in scored.sort_values(["year", "month", "prov"]).itertuples()
    ]
    province_totals = test_province.groupby("prov")[["aqua", "harmonized"]].sum()

    seam_key = national_month["year"] * 100 + national_month["month"]
    seam = national_month[(seam_key >= SEAM_FIRST[0] * 100 + SEAM_FIRST[1]) & (seam_key <= SEAM_LAST[0] * 100 + SEAM_LAST[1])]

    def number(value):
        return None if value is None or pd.isna(value) else round(float(value), 2)

    result = {
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "chosen": frozen["candidate"],
        "m": frozen.get("m"),
        "train_years": frozen["train_years"],
        "test_years": test_years,
        "loyo": frozen["loyo"]["scores"],
        "targets": TARGETS,
        "test": test,
        "targets_met": targets_met,
        "peak_month_agreement": peak_month_agreement(test_province),
        "rank_corr": {
            "national_years": _spearman(yearly["aqua"], yearly["harmonized"]),
            "provinces_test_years": _spearman(province_totals["aqua"], province_totals["harmonized"]),
        },
        "yearly_national": [
            {"year": int(r.year), "aqua": number(r.aqua), "viirs_raw": number(r.viirs_raw),
             "viirs_harmonized": number(r.viirs_harmonized), "series": number(r.series),
             "raw_series": number(r.raw_series)}
            for r in yearly_national.itertuples()
        ],
        "test_pairs": test_pairs,
        "yearly_ratio": [
            {"year": int(r.year), "ratio": _clean(r.aqua / r.harmonized) if r.harmonized > 0 else None}
            for r in yearly.itertuples()
        ],
        "seam": {
            "months": [{"month": f"{int(r.year)}-{int(r.month):02d}", "aqua": number(r.aqua),
                        "harmonized": number(r.harmonized)} for r in seam.itertuples()],
            "metrics": metrics(seam["harmonized"], seam["aqua"]),
        },
        "typical_error_pct": h["province_month"]["mape"],
        "naive_error_pct": test["naive"]["province_month"]["mape"],
        "excluded_days": len(excluded),
        "partner_check": None,
        "noaa20": noaa20,
        "province_bias": province_bias(test_province, province_names),
        "error_by_count": error_by_count(test_province),
        "bias_by_level": bias_by_level(province_month, test_years),
        "excluded_dates": [d.isoformat() for d in sorted(excluded)],
        "yearly_test": [
            {"year": int(r.year), "aqua": round(float(r.aqua), 2), "harmonized": round(float(r.harmonized), 2),
             "bias": _clean(r.harmonized / r.aqua - 1.0) if r.aqua > 0 else None}
            for r in _in_years(yearly, test_years).itertuples()
        ],
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, indent=1))
    return result
