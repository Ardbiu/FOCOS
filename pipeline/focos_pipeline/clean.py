"""Read FIRMS CSVs into one schema and apply the cleaning rules (section 4.2).

Rules, in order: keep type 0 (rows from files with no type column are kept
and flagged), keep confident detections, drop exact duplicates, then stamp
each row with its local solar date.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from pathlib import Path

import duckdb

from . import config

SENSORS = ("modis", "viirs-snpp", "viirs-jpss1")  # FIRMS folder names; jpss1 is NOAA-20
COLUMNS = [
    "lat", "lon", "utc_dt", "local_date", "year", "month",
    "dn", "sat", "conf_raw", "frp", "has_type", "type",
]


def to_local_date(utc_dt: datetime, lon: float) -> date:
    """Local solar date: UTC time plus longitude / 15 hours."""
    return (utc_dt + timedelta(hours=lon / 15.0)).date()


def sensor_files(sensor: str, raw_dir: Path | None = None) -> list[Path]:
    raw_dir = Path(raw_dir) if raw_dir is not None else config.RAW_DIR
    return sorted((raw_dir / sensor).glob("*.csv"))


def _low_conf_sql(sensor: str) -> str:
    if sensor == "modis":
        return f"coalesce(try_cast(conf_raw AS INTEGER) < {config.MODIS_MIN_CONF}, true)"
    keep = ", ".join(f"'{c}'" for c in config.VIIRS_KEEP_CONF)
    return f"coalesce(substr(conf_raw, 1, 1) NOT IN ({keep}), true)"


def _flagged_sql(sensor: str, files: list[Path], con: duckdb.DuckDBPyConnection) -> str:
    """SQL for every raw row with its local date and one flag per filter."""
    if sensor not in SENSORS:
        raise ValueError(f"unknown sensor: {sensor}")
    if not files:
        raise FileNotFoundError(f"no CSV files for sensor {sensor}")
    file_list = ", ".join("'" + str(f).replace("'", "''") + "'" for f in files)
    reader = f"read_csv([{file_list}], all_varchar = true, union_by_name = true)"
    has_type_column = "type" in con.sql(f"SELECT * FROM {reader} LIMIT 0").columns
    type_sql = "try_cast(type AS INTEGER)" if has_type_column else "CAST(NULL AS INTEGER)"
    return f"""
    WITH src AS (
        SELECT
            CAST(latitude AS DOUBLE) AS lat,
            CAST(longitude AS DOUBLE) AS lon,
            acq_date,
            lpad(acq_time, 4, '0') AS acq_time,
            satellite,
            lower(confidence) AS conf_raw,
            try_cast(frp AS DOUBLE) AS frp,
            upper(daynight) AS dn,
            {type_sql} AS type
        FROM {reader}
    ),
    timed AS (
        SELECT *,
            strptime(acq_date || ' ' || acq_time, '%Y-%m-%d %H%M') AS utc_dt
        FROM src
    ),
    located AS (
        SELECT *,
            CAST(utc_dt + to_microseconds(CAST(round(lon / 15.0 * 3600e6) AS BIGINT)) AS DATE) AS local_date,
            (type IS NOT NULL AND type <> 0) AS bad_type,
            {_low_conf_sql(sensor)} AS low_conf
        FROM timed
    )
    SELECT *,
        row_number() OVER (
            PARTITION BY lat, lon, acq_date, acq_time, satellite, bad_type OR low_conf
            ORDER BY frp
        ) > 1 AS duplicate
    FROM located
    """


def load_clean(
    sensor: str,
    files: list[Path] | None = None,
    con: duckdb.DuckDBPyConnection | None = None,
) -> duckdb.DuckDBPyRelation:
    """Cleaned rows for one sensor folder ("modis" or "viirs-snpp")."""
    con = con or duckdb.default_connection()
    files = files if files is not None else sensor_files(sensor)
    flagged = _flagged_sql(sensor, files, con)
    return con.sql(f"""
        SELECT
            lat, lon, utc_dt, local_date,
            CAST(year(local_date) AS INTEGER) AS year,
            CAST(month(local_date) AS INTEGER) AS month,
            dn,
            CASE satellite WHEN 'Terra' THEN 'T' WHEN 'Aqua' THEN 'A' ELSE satellite END AS sat,
            conf_raw, frp,
            type IS NOT NULL AS has_type,
            type
        FROM ({flagged})
        WHERE NOT bad_type AND NOT low_conf AND NOT duplicate
    """)


def filter_counts(
    sensor: str,
    files: list[Path] | None = None,
    con: duckdb.DuckDBPyConnection | None = None,
) -> list[dict]:
    """Per local year: raw rows, rows dropped by each filter in order, rows kept."""
    con = con or duckdb.default_connection()
    files = files if files is not None else sensor_files(sensor)
    flagged = _flagged_sql(sensor, files, con)
    rows = con.sql(f"""
        SELECT
            CAST(year(local_date) AS INTEGER) AS year,
            count(*) AS raw,
            count(*) FILTER (WHERE bad_type) AS bad_type,
            count(*) FILTER (WHERE NOT bad_type AND low_conf) AS low_conf,
            count(*) FILTER (WHERE NOT bad_type AND NOT low_conf AND duplicate) AS duplicate,
            count(*) FILTER (WHERE NOT bad_type AND NOT low_conf AND NOT duplicate) AS kept
        FROM ({flagged})
        GROUP BY 1 ORDER BY 1
    """).fetchall()
    keys = ["year", "raw", "bad_type", "low_conf", "duplicate", "kept"]
    return [dict(zip(keys, row)) for row in rows]


# --- Rows with no type column (2026 near real time) -------------------------
def load_typed_rows(sensor: str, files: list[Path] | None = None,
                    con: duckdb.DuckDBPyConnection | None = None) -> duckdb.DuckDBPyRelation:
    """Every archive row that has a type (0 to 3): lat, lon, type, year."""
    con = con or duckdb.default_connection()
    files = files if files is not None else sensor_files(sensor)
    file_list = ", ".join("'" + str(f).replace("'", "''") + "'" for f in files)
    return con.sql(f"""
        SELECT CAST(latitude AS DOUBLE) AS lat, CAST(longitude AS DOUBLE) AS lon,
               CAST(type AS INTEGER) AS type, CAST(substr(acq_date, 1, 4) AS INTEGER) AS year
        FROM read_csv([{file_list}], all_varchar = true, union_by_name = true)
        WHERE try_cast(type AS INTEGER) IS NOT NULL
    """)


def static_mask(archive: duckdb.DuckDBPyRelation) -> set[tuple[int, int]]:
    """0.01-degree cells whose untyped rows are dropped.

    A cell is masked when, in the archive, non-fire rows (type 1, 2 or 3) are at
    least half of its rows and occur in at least two calendar years. Cells where
    vegetation fires are the majority stay, so near-real-time months are not
    stripped of fire the archive would have kept.
    """
    rows = archive.query("a", """
        SELECT CAST(floor(round(lat * 100, 6)) AS INTEGER) AS cy,
               CAST(floor(round(lon * 100, 6)) AS INTEGER) AS cx
        FROM a
        GROUP BY cy, cx
        HAVING count(DISTINCT year) FILTER (WHERE type IN (1, 2, 3)) >= 2
           AND 2 * count(*) FILTER (WHERE type IN (1, 2, 3)) >= count(*)
    """).fetchall()
    return {(cy, cx) for cy, cx in rows}


def drop_last_day(df):
    """Drop the last local date of an API pull: the day may be only partly observed,
    and a partial day must not be compared with full ones."""
    if len(df) == 0:
        return df
    return df[df["local_date"] < df["local_date"].max()].reset_index(drop=True)


def filter_api_rows(df, mask: set[tuple[int, int]], province_list: list[dict]):
    """Rows pulled from the API over a bounding box, cut down to the country.

    Drops every row outside the national polygon, and drops untyped rows that
    sit in the static-source mask (gas flares and other fixed heat sources).
    """
    import numpy as np

    from . import provinces

    inside = provinces.assign(df["lon"].to_numpy(), df["lat"].to_numpy(), province_list, tolerance=0.0)
    keep = np.array([p is not None for p in inside], dtype=bool)
    cy = np.floor(np.round(df["lat"].to_numpy(dtype=float) * 100, 6)).astype(int)
    cx = np.floor(np.round(df["lon"].to_numpy(dtype=float) * 100, 6)).astype(int)
    masked = np.array([(a, b) in mask for a, b in zip(cy, cx)], dtype=bool)
    keep &= ~(masked & ~df["has_type"].to_numpy(dtype=bool))
    return df[keep].reset_index(drop=True)
