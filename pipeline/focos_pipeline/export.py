"""Write the static files the web app reads (section 5 of the plan).

Everything comes from the `points` table: one row per Aqua or S-NPP pixel with
its series flag `s` and MODIS-equivalent weight `w`. A point is exported when
it lies inside the grid box, has a province and is dated 2003 or later, so
grid totals, province totals and point files always agree.
"""
from __future__ import annotations

import calendar
import gzip
import json
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import numpy as np
from shapely.geometry import mapping

from . import config, weights

NATION_ID = "AR"
COVERAGE_MIN = 0.9
POINT_HEADER = "lat,lon,date,dn,sat,conf,frp,s,w"
FIRST_YEAR = config.SERIES_START.year
LAST_YEAR = config.CALENDAR_END[0]


def write_grid(path: Path, cell_ids, values, idx) -> None:
    """gzip of: uint32 N, N x uint32 cell_id, N x float32 value, N x uint16 index. Little-endian."""
    cell_ids = np.asarray(cell_ids, dtype="<u4")
    values = np.asarray(values, dtype="<f4")
    idx = np.asarray(idx, dtype="<u2")
    if not (len(cell_ids) == len(values) == len(idx)):
        raise ValueError("grid columns differ in length")
    payload = np.asarray([len(cell_ids)], dtype="<u4").tobytes() + cell_ids.tobytes() + values.tobytes() + idx.tobytes()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0) as out:
        out.write(payload)


def read_grid(path: Path):
    """The (cell_ids, values, index) arrays stored by write_grid."""
    data = gzip.decompress(Path(path).read_bytes())
    n = int(np.frombuffer(data, dtype="<u4", count=1)[0])
    cells = np.frombuffer(data, dtype="<u4", count=n, offset=4)
    values = np.frombuffer(data, dtype="<f4", count=n, offset=4 + 4 * n)
    idx = np.frombuffer(data, dtype="<u2", count=n, offset=4 + 8 * n)
    return cells, values, idx


def _round_coords(obj, digits: int):
    if isinstance(obj, (list, tuple)):
        return [_round_coords(x, digits) for x in obj]
    return round(obj, digits)


def write_provinces_geojson(path: Path, provinces: list[dict], tolerance: float = 0.002, digits: int = 3) -> None:
    """Province outlines for the map: lightly simplified, rounded, id and name only."""
    features = []
    for province in provinces:
        geom = province.get("geom")
        if geom is None:
            continue
        shape = mapping(geom.simplify(tolerance, preserve_topology=True))
        features.append({
            "type": "Feature",
            "properties": {"id": province["id"], "name": province["name"]},
            "geometry": {"type": shape["type"], "coordinates": _round_coords(shape["coordinates"], digits)},
        })
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, separators=(",", ":")))


def _incomplete_months(con: duckdb.DuckDBPyConnection, noaa20_carries: bool, filled: set | None = None) -> list[dict]:
    """Months where the sensor carrying the series lost more than 10% of its days.

    A day in `filled` was carried by NOAA-20 in place of S-NPP and is not lost.
    """
    filled = filled or set()
    switch_idx = config.month_idx(config.SWITCH_DATE.year, config.SWITCH_DATE.month)
    switch2_idx = config.month_idx(config.SWITCH2_DATE.year, config.SWITCH2_DATE.month)

    def carrier(idx: int) -> str:
        if idx < switch_idx:
            return "A"
        return "N20" if noaa20_carries and idx >= switch2_idx else "N"

    lost: dict[tuple[str, int, int], int] = {}
    for sat, day in con.sql("SELECT DISTINCT sat, local_date FROM outage").fetchall():
        if sat == "N" and day in filled:
            continue
        key = (sat, day.year, day.month)
        lost[key] = lost.get(key, 0) + 1
    out = []
    for (sat, year, month), days in lost.items():
        idx = config.month_idx(year, month)
        if not 0 <= idx < config.MONTH_COUNT or sat != carrier(idx):
            continue
        coverage = 1.0 - days / calendar.monthrange(year, month)[1]
        if coverage < COVERAGE_MIN:
            out.append({"month_idx": idx, "coverage": round(coverage, 3), "sensor": sat})
    return sorted(out, key=lambda r: r["month_idx"])


def _series(noaa20_carries: bool, validation: dict | None) -> list[dict]:
    """The carriers of the record, in order, each with its own typical error."""
    validation = validation or {}
    switch, switch2 = config.SWITCH_DATE, config.SWITCH2_DATE

    def month(d, back=0):
        year, mon = d.year, d.month - back
        if mon < 1:
            year, mon = year - 1, mon + 12
        return f"{year}-{mon:02d}"

    series = [
        {"sat": "A", "name": "Aqua MODIS", "from": month(config.SERIES_START), "to": month(switch, back=1),
         "typical_error_pct": None},
        {"sat": "N", "name": "S-NPP VIIRS", "from": month(switch),
         "to": month(switch2, back=1) if noaa20_carries else None,
         "typical_error_pct": validation.get("typical_error_pct")},
    ]
    if noaa20_carries:
        series.append({"sat": "N20", "name": "NOAA-20 VIIRS", "from": month(switch2), "to": None,
                       "typical_error_pct": (validation.get("noaa20") or {}).get("typical_error_pct")})
    return series


def export_all(db_path: Path | None = None, out_dir: Path | None = None, frozen: dict | None = None,
               validation: dict | None = None, provinces: list[dict] | None = None) -> dict:
    """Write meta.json, the three grids, the point tiles and the province summaries."""
    db_path = Path(db_path) if db_path is not None else config.WORK_DIR / "focos.duckdb"
    out_dir = Path(out_dir) if out_dir is not None else config.WEB_DATA_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    grid = config.GRID
    con = duckdb.connect(str(db_path))
    try:
        con.sql("SET threads = 1")  # one output file per tile, rows in query order
        con.sql(f"""
            CREATE OR REPLACE TEMP TABLE ex AS
            SELECT *,
                i_lat * {grid['nlon']} + i_lon AS cell_id,
                (year - {FIRST_YEAR}) * 12 + month - 1 AS month_idx,
                't_' || CAST(floor(lat) AS INTEGER) || '_' || CAST(floor(lon) AS INTEGER) AS tile
            FROM (
                SELECT *,
                    CAST(floor(round((lat - ({grid['lat0']})) / {grid['cell']}, 6)) AS INTEGER) AS i_lat,
                    CAST(floor(round((lon - ({grid['lon0']})) / {grid['cell']}, 6)) AS INTEGER) AS i_lon
                FROM points
                WHERE prov IS NOT NULL AND local_date >= DATE '{config.SERIES_START.isoformat()}'
                  AND NOT (sat = 'N20' AND s = 0)  -- NOAA-20 is exported only where it carries the series
            )
            WHERE i_lat BETWEEN 0 AND {grid['nlat'] - 1} AND i_lon BETWEEN 0 AND {grid['nlon'] - 1}
              AND (year - {FIRST_YEAR}) * 12 + month - 1 BETWEEN 0 AND {config.MONTH_COUNT - 1}
        """)
        end = con.sql("SELECT max(local_date) FROM ex WHERE s = 1").fetchall()[0][0]
        if end is None:
            raise RuntimeError("no in-series points to export")
        noaa20_carries = bool(con.sql(
            f"SELECT 1 FROM ex WHERE sat = 'N20' AND s = 1 "
            f"AND local_date >= DATE '{config.SWITCH2_DATE.isoformat()}' LIMIT 1").fetchall())
        filled = weights.noaa20_fill_days(
            con.sql("SELECT sat, local_date FROM outage").fetchall(),
            con.sql("SELECT min(local_date) FROM points WHERE sat = 'N20'").fetchall()[0][0],
        )
        is_month_end = end.day == calendar.monthrange(end.year, end.month)[1]
        mtd = None if is_month_end else {"month": end.month, "last_day": end.day}

        def grid_rows(sql):
            rows = con.sql(sql).fetchnumpy()
            return rows["cell_id"], rows["v"], rows["i"]

        write_grid(out_dir / "grid" / "monthly.bin.gz", *grid_rows(
            "SELECT cell_id, sum(w) AS v, month_idx AS i FROM ex WHERE w > 0 GROUP BY cell_id, month_idx ORDER BY i, cell_id"))
        write_grid(out_dir / "grid" / "raw.bin.gz", *grid_rows(
            "SELECT cell_id, sum(s) AS v, month_idx AS i FROM ex WHERE s = 1 GROUP BY cell_id, month_idx ORDER BY i, cell_id"))
        mtd_filter = f"month = {mtd['month']} AND day(local_date) <= {mtd['last_day']} AND w > 0" if mtd else "false"
        write_grid(out_dir / "grid" / "mtd.bin.gz", *grid_rows(
            f"SELECT cell_id, sum(w) AS v, year - {FIRST_YEAR} AS i FROM ex WHERE {mtd_filter} GROUP BY cell_id, year ORDER BY i, cell_id"))

        # Province summaries: the nation is the sum of its provinces by construction.
        n_years = LAST_YEAR - FIRST_YEAR + 1
        ids = [p["id"] for p in (provinces or [])]
        names = {p["id"]: p["name"] for p in (provinces or [])}
        for (pid,) in con.sql("SELECT DISTINCT prov FROM ex ORDER BY prov").fetchall():
            if pid not in names:
                ids.append(pid)
                names[pid] = pid
        series = {pid: {"monthly": np.zeros(config.MONTH_COUNT), "raw": np.zeros(config.MONTH_COUNT),
                        "mtd": np.zeros(n_years)} for pid in ids}
        for pid, idx, w, s in con.sql("SELECT prov, month_idx, sum(w), sum(s) FROM ex GROUP BY prov, month_idx").fetchall():
            series[pid]["monthly"][idx] = w
            series[pid]["raw"][idx] = s
        for pid, year, w in con.sql(f"SELECT prov, year, sum(w) FROM ex WHERE {mtd_filter} GROUP BY prov, year").fetchall():
            series[pid]["mtd"][year - FIRST_YEAR] = w

        def area(area_id, name, parts):
            return {
                "id": area_id, "name": name,
                "monthly": [round(float(x), 3) for x in sum(p["monthly"] for p in parts)],
                "raw": [int(x) for x in sum(p["raw"] for p in parts)],
                "mtd": [round(float(x), 3) for x in sum(p["mtd"] for p in parts)] if mtd else [],
            }

        zero = {"monthly": np.zeros(config.MONTH_COUNT), "raw": np.zeros(config.MONTH_COUNT), "mtd": np.zeros(n_years)}
        areas = [area(NATION_ID, config.COUNTRY, [zero, *series.values()])]
        areas += [area(pid, names[pid], [series[pid]]) for pid in ids]
        (out_dir / "summary").mkdir(parents=True, exist_ok=True)
        (out_dir / "summary" / "provinces.json").write_text(
            json.dumps({"areas": areas}, ensure_ascii=False, separators=(",", ":")))

        # Point tiles: one gzip CSV per 1-degree tile.
        points_dir = out_dir / "points"
        if points_dir.exists():
            shutil.rmtree(points_dir)
        points_dir.mkdir(parents=True)
        with tempfile.TemporaryDirectory(dir=out_dir) as tmp:
            con.sql(f"""
                COPY (
                    SELECT tile,
                        printf('%.5f', lat) AS lat, printf('%.5f', lon) AS lon,
                        strftime(local_date, '%Y-%m-%d') AS date, dn, sat, conf_raw AS conf,
                        CASE WHEN frp IS NULL THEN '' ELSE printf('%.1f', frp) END AS frp,
                        s, printf('%.6f', w) AS w
                    FROM ex ORDER BY tile, local_date, sat, lat, lon
                ) TO '{tmp}' (FORMAT CSV, HEADER, PARTITION_BY (tile), COMPRESSION GZIP, OVERWRITE_OR_IGNORE)
            """)
            tiles = []
            for part in sorted(Path(tmp).glob("tile=*")):
                files = sorted(part.glob("*.csv.gz"))
                if len(files) != 1:
                    raise RuntimeError(f"expected one file for {part.name}, found {len(files)}")
                tile = part.name.split("=", 1)[1]
                shutil.move(str(files[0]), points_dir / f"{tile}.csv.gz")
                tiles.append(tile)

        meta = {
            "version": 1,
            "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "country": config.COUNTRY,
            "data_end_date": end.isoformat(),
            "switch_month": f"{config.SWITCH_DATE.year}-{config.SWITCH_DATE.month:02d}",
            "grid": dict(grid),
            "month_count": config.MONTH_COUNT,
            "calibration": {k: (frozen or {}).get(k) for k in ("candidate", "train_years", "test_years")},
            "typical_error_pct": (validation or {}).get("typical_error_pct"),
            "naive_error_pct": (validation or {}).get("naive_error_pct"),
            "incomplete_months": _incomplete_months(con, noaa20_carries, set(filled)),
            "tiles": sorted(tiles),
            "mtd": mtd,
            "series": _series(noaa20_carries, validation),
            # Days NOAA-20 carried in place of S-NPP, which delivered no data.
            "gap_fill": {"sat": "N20", "name": "NOAA-20 VIIRS", "days": len(filled),
                         "first": filled[0].isoformat(), "last": filled[-1].isoformat()} if filled else None,
        }
        (out_dir / "meta.json").write_text(json.dumps(meta, indent=1))
        if provinces:
            write_provinces_geojson(out_dir / "provinces.geojson", provinces)
        return meta
    finally:
        con.close()
