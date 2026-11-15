"""Invariant checks on the exported files. A wrong number must not reach the app.

Every check reads the files the web app reads, not the work database, so a
pass means the shipped files agree with each other.
"""
from __future__ import annotations

import json
from pathlib import Path

import duckdb
import numpy as np

from . import config, export

REL_TOL = 1e-6
ROUNDING_TOL = 0.05  # series are rounded to 3 decimals and point weights to 4


class CheckFailed(AssertionError):
    """One or more invariant checks failed. The message lists each one."""


def _close(a: float, b: float) -> bool:
    return abs(a - b) <= max(ROUNDING_TOL, REL_TOL * max(abs(a), abs(b)))


def run_checks(out_dir: Path | None = None) -> list[str]:
    """Run every check; return the names that passed or raise CheckFailed."""
    out_dir = Path(out_dir) if out_dir is not None else config.WEB_DATA_DIR
    meta = json.loads((out_dir / "meta.json").read_text())
    areas = json.loads((out_dir / "summary" / "provinces.json").read_text())["areas"]
    nation, provinces = areas[0], areas[1:]
    grids = {name: export.read_grid(out_dir / "grid" / f"{name}.bin.gz") for name in ("monthly", "raw", "mtd")}
    tile_files = sorted((out_dir / "points").glob("*.csv.gz"))

    con = duckdb.connect()
    try:
        if tile_files:
            file_list = ", ".join(f"'{f}'" for f in tile_files)
            con.sql(f"""
                CREATE TABLE pts AS SELECT * FROM read_csv([{file_list}], header = true, columns = {{
                    'lat': 'DOUBLE', 'lon': 'DOUBLE', 'date': 'DATE', 'dn': 'VARCHAR', 'sat': 'VARCHAR',
                    'conf': 'VARCHAR', 'frp': 'DOUBLE', 's': 'INTEGER', 'w': 'DOUBLE'}})
            """)
        else:
            con.sql("CREATE TABLE pts (lat DOUBLE, lon DOUBLE, date DATE, dn VARCHAR, sat VARCHAR, "
                    "conf VARCHAR, frp DOUBLE, s INTEGER, w DOUBLE)")
        point_w, point_s, bad_w = con.sql(
            "SELECT coalesce(sum(w), 0), coalesce(sum(s), 0), "
            "count(*) FILTER (WHERE w < 0 OR isnan(w) OR isinf(w)) FROM pts").fetchall()[0]
        monthly_points = np.zeros(config.MONTH_COUNT)
        for idx, w in con.sql(f"""
            SELECT (year(date) - {config.SERIES_START.year}) * 12 + month(date) - 1, sum(w)
            FROM pts GROUP BY 1
        """).fetchall():
            if 0 <= idx < config.MONTH_COUNT:
                monthly_points[idx] = w
        outside = con.sql(f"""
            SELECT count(*) FROM pts
            WHERE s = 1 AND (date < DATE '{config.SERIES_START.isoformat()}' OR date > DATE '{meta["data_end_date"]}')
        """).fetchall()[0][0]
        shared_days = con.sql(
            "SELECT count(*) FROM (SELECT date FROM pts WHERE s = 1 GROUP BY date HAVING count(DISTINCT sat) > 1)"
        ).fetchall()[0][0]
    finally:
        con.close()

    def check_month_count():
        if meta["month_count"] != config.MONTH_COUNT:
            return f"meta.month_count is {meta['month_count']}"
        for area in areas:
            if len(area["monthly"]) != config.MONTH_COUNT or len(area["raw"]) != config.MONTH_COUNT:
                return f"area {area['id']} does not have {config.MONTH_COUNT} months"

    def check_values():
        for name, (_, values, _) in grids.items():
            if len(values) and (not np.all(np.isfinite(values)) or np.any(values < 0)):
                return f"grid {name} holds a negative, NaN or infinite value"
        for area in areas:
            for key in ("monthly", "raw", "mtd"):
                numbers = np.asarray(area[key], dtype=float)
                if len(numbers) and (not np.all(np.isfinite(numbers)) or np.any(numbers < 0)):
                    return f"area {area['id']} {key} holds a negative, NaN or infinite value"
        if bad_w:
            return f"{bad_w} point weights are negative, NaN or infinite"

    def check_tiles():
        present = {f.name[: -len(".csv.gz")] for f in tile_files}
        missing = sorted(set(meta["tiles"]) - present)
        extra = sorted(present - set(meta["tiles"]))
        if missing or extra:
            return f"missing tiles {missing[:5]}, unlisted tiles {extra[:5]}"

    def check_grid_total():
        total = float(grids["monthly"][1].sum(dtype=np.float64))
        if abs(total - point_w) > REL_TOL * max(point_w, 1.0) + ROUNDING_TOL:
            return f"grid total {total:.3f} vs point weights {point_w:.3f}"

    def check_raw_total():
        total = float(grids["raw"][1].sum(dtype=np.float64))
        if round(total) != point_s:
            return f"raw grid total {total:.0f} vs in-series points {point_s}"

    def check_nation_is_sum():
        for key in ("monthly", "raw"):
            summed = np.sum([p[key] for p in provinces], axis=0) if provinces else np.zeros(config.MONTH_COUNT)
            for i, (a, b) in enumerate(zip(nation[key], summed)):
                if not _close(a, b):
                    return f"{key}[{i}]: nation {a} vs provinces {b}"

    def check_nation_is_points():
        for i, (a, b) in enumerate(zip(nation["monthly"], monthly_points)):
            if not _close(a, b):
                return f"monthly[{i}]: nation {a} vs points {b:.3f}"

    def check_dates():
        if outside:
            return f"{outside} in-series points are dated outside the series"

    def check_one_carrier():
        if shared_days:
            return f"{shared_days} days have in-series points from more than one satellite"

    named = [
        ("month count is 287", check_month_count),
        ("no negative, NaN or infinite values", check_values),
        ("every tile in meta.json exists", check_tiles),
        ("grid total equals the sum of point weights", check_grid_total),
        ("raw grid total equals the count of in-series points", check_raw_total),
        ("national series equals the sum of the provinces", check_nation_is_sum),
        ("national series equals the points", check_nation_is_points),
        ("no in-series point is dated outside 2003-01-01..data_end_date", check_dates),
        ("every day is carried by one satellite", check_one_carrier),
    ]
    passed, failed = [], []
    for name, check in named:
        problem = check()
        if problem:
            failed.append(f"{name}: {problem}")
        else:
            passed.append(name)
    if failed:
        raise CheckFailed("\n".join(failed))
    return passed
