"""Command line for the pipeline: python -m focos_pipeline.run <step>."""
from __future__ import annotations

import sys
from pathlib import Path

import duckdb

from . import calibrate, clean, config, download, fcp, provinces, weights

DB_PATH = config.WORK_DIR / "focos.duckdb"


def build(
    db_path: Path | None = None,
    raw_dir: Path | None = None,
    provinces_path: Path | None = None,
) -> None:
    """Clean every raw file and store one pixel table, `pix`.

    Each row carries its FCP keys and the id of its province (NULL when the
    point is not within reach of any province).
    """
    import pandas as pd

    db_path = Path(db_path) if db_path is not None else DB_PATH
    db_path.parent.mkdir(parents=True, exist_ok=True)
    if provinces_path is None:
        provinces_path = provinces.download_provinces()
    province_list = provinces.load_provinces(provinces_path)
    con = duckdb.connect(str(db_path))
    try:
        parts, tables = [], []
        archive_files = {sensor: clean.sensor_files(sensor, raw_dir) for sensor in clean.SENSORS}
        for sensor, files in archive_files.items():
            if not files:
                continue  # NOAA-20 is optional; a sensor with no files is simply absent
            name = "clean_" + sensor.replace("-", "_")
            clean.load_clean(sensor, files=files, con=con).create(name)
            tables.append(name)
            parts.append(f"SELECT * FROM {name}")
        if not parts:
            raise FileNotFoundError("no raw files to build from")
        # 2026 rows pulled from the API over a bounding box: cut them down to the
        # country, and drop untyped rows that sit on known static heat sources.
        api_files = {sensor: clean.sensor_files(folder, raw_dir) for sensor, folder in download.API_FOLDERS.items()}
        if any(api_files.values()):
            sources = [
                clean.load_typed_rows(sensor, files=files, con=con)
                for sensor, files in archive_files.items() if files
            ]
            static = sources[0]
            for more in sources[1:]:
                static = static.union(more)
            mask = clean.static_mask(static)
            for sensor, files in api_files.items():
                if not files:
                    continue
                api_df = clean.filter_api_rows(
                    clean.drop_last_day(clean.load_clean(sensor, files=files, con=con).df()), mask, province_list
                )
                name = "clean_api_" + sensor.replace("-", "_")
                con.register("api_df", api_df)
                con.sql(f"""
                    CREATE OR REPLACE TABLE {name} AS
                    SELECT lat, lon, utc_dt, CAST(local_date AS DATE) AS local_date, year, month, dn, sat,
                           conf_raw, frp, has_type, try_cast(type AS INTEGER) AS type
                    FROM api_df
                """)
                con.unregister("api_df")
                tables.append(name)
                parts.append(f"SELECT * FROM {name}")
        con.sql(
            "CREATE OR REPLACE TABLE clean_all AS SELECT row_number() OVER () AS rid, * FROM ("
            + " UNION ALL ".join(parts) + ")"
        )
        coords = con.sql("SELECT rid, lat, lon FROM clean_all").fetchnumpy()
        prov_df = pd.DataFrame({
            "rid": coords["rid"],
            "prov": provinces.assign(coords["lon"], coords["lat"], province_list),
        })
        con.register("prov_df", prov_df)
        located = con.sql(
            "SELECT c.* EXCLUDE (rid), CAST(p.prov AS VARCHAR) AS prov "
            "FROM clean_all AS c JOIN prov_df AS p USING (rid)"
        )
        con.sql("DROP TABLE IF EXISTS pix_new")
        fcp.add_fcp_keys(located).create("pix_new")
        con.sql("DROP TABLE IF EXISTS pix")
        con.sql("ALTER TABLE pix_new RENAME TO pix")
        con.unregister("prov_df")
        store_outages_and_training_table(con)
        for name in tables:
            con.sql(f"DROP TABLE {name}")
        con.sql("DROP TABLE clean_all")
    finally:
        con.close()


def excluded_days(con: duckdb.DuckDBPyConnection, sats: tuple[str, ...] = ("A", "N")) -> set:
    """Days left out of calibration and validation for a pair of sensors: outage
    days of either one, plus the whole documented Aqua outage window of 2020."""
    from datetime import timedelta

    sat_list = ", ".join(f"'{sat}'" for sat in sats)
    days = {row[0] for row in con.sql(f"SELECT local_date FROM outage WHERE sat IN ({sat_list})").fetchall()}
    first, last = config.AQUA_OUTAGE_2020
    days |= {first + timedelta(days=i) for i in range((last - first).days + 1)}
    return days


def store_outages_and_training_table(con: duckdb.DuckDBPyConnection) -> None:
    """Store `outage` (sat, local_date) and the tables calibration fits on:
    `agg` (Aqua against S-NPP) and, when NOAA-20 is present, `agg_n20`."""
    import pandas as pd

    pix = con.table("pix")
    present = {row[0] for row in con.sql("SELECT DISTINCT sat FROM pix").fetchall()}
    carriers = [sat for sat in ("A", "N", "N20") if sat in present]
    rows = [(sat, day) for sat in carriers for day in sorted(fcp.outage_days(pix, sat))]
    outage_df = pd.DataFrame(rows, columns=["sat", "local_date"])
    outage_df["local_date"] = pd.to_datetime(outage_df["local_date"]).dt.date
    con.sql("DROP TABLE IF EXISTS outage")
    con.sql("CREATE TABLE outage (sat VARCHAR, local_date DATE)")
    if len(outage_df):
        con.register("outage_df", outage_df)
        con.sql("INSERT INTO outage SELECT sat, CAST(local_date AS DATE) FROM outage_df")
        con.unregister("outage_df")
    pairs = [("agg", "N")] + ([("agg_n20", "N20")] if "N20" in present else [])
    con.sql("DROP TABLE IF EXISTS agg_n20")
    for table, viirs_sat in pairs:
        agg_df = calibrate.training_table(pix, excluded_days(con, ("A", viirs_sat)), viirs_sat=viirs_sat)
        con.register("agg_df", agg_df)
        con.sql(f"CREATE OR REPLACE TABLE {table} AS SELECT * FROM agg_df")
        con.unregister("agg_df")


def weigh(db_path: Path | None = None, calibration_path: Path | None = None,
          noaa20_calibration_path: Path | None = None) -> None:
    """Store `points`: every pixel of the carriers with its series flag and weight.

    NOAA-20 joins when its pixels are in `pix` and its calibration is frozen;
    it then also carries the days S-NPP was out (`weights.noaa20_fill_days`).
    """
    db_path = Path(db_path) if db_path is not None else DB_PATH
    model = calibrate.load_frozen(calibration_path)["model"]
    noaa20_path = Path(noaa20_calibration_path) if noaa20_calibration_path is not None \
        else calibrate.NOAA20_CALIBRATION_PATH
    con = duckdb.connect(str(db_path))
    try:
        pix = con.table("pix")
        has_noaa20 = bool(con.sql("SELECT 1 FROM pix WHERE sat = 'N20' LIMIT 1").fetchall())
        if has_noaa20 and noaa20_path.exists():
            has_outages = bool(con.sql(
                "SELECT 1 FROM information_schema.tables WHERE table_name = 'outage'").fetchall())
            outages = con.sql("SELECT sat, local_date FROM outage").fetchall() if has_outages else []
            noaa20_first = con.sql("SELECT min(local_date) FROM pix WHERE sat = 'N20'").fetchall()[0][0]
            weighted = weights.assign_weights(
                pix.filter("sat = 'A'"), pix.filter("sat = 'N'"), model,
                noaa20=pix.filter("sat = 'N20'"), noaa20_model=calibrate.load_frozen(noaa20_path)["model"],
                fill_days=weights.noaa20_fill_days(outages, noaa20_first),
            )
        else:
            weighted = weights.assign_weights(pix.filter("sat = 'A'"), pix.filter("sat = 'N'"), model)
        con.sql("DROP TABLE IF EXISTS points")
        weighted.create("points")
    finally:
        con.close()


def report(db_path: Path | None = None, raw_dir: Path | None = None) -> None:
    """Print what cleaning kept and dropped, yearly FCP totals and outage days."""
    db_path = Path(db_path) if db_path is not None else DB_PATH
    for sensor in clean.SENSORS:
        print(f"\n== {sensor}: rows per local year (raw, dropped by type / confidence / duplicate, kept)")
        for row in clean.filter_counts(sensor, files=clean.sensor_files(sensor, raw_dir)):
            raw = max(row["raw"], 1)
            print(
                f"{row['year']}  raw {row['raw']:>8}  type {row['bad_type'] / raw:6.1%}  "
                f"conf {row['low_conf'] / raw:6.1%}  dup {row['duplicate'] / raw:6.1%}  kept {row['kept']:>8}"
            )
    con = duckdb.connect(str(db_path), read_only=True)
    try:
        pix = con.table("pix")
        print("\n== FCPs and pixels per satellite and local year")
        counts = fcp.fcp_counts(pix, by=["sat", "year"]).order("sat, year").fetchall()
        for sat, year, n_fcp, n_pix in counts:
            print(f"{sat:>3} {year}  fcp {n_fcp:>8}  pixels {n_pix:>8}")
        for sat in ("A", "N"):
            days = sorted(fcp.outage_days(pix, sat))
            print(f"\n== outage days for {sat}: {len(days)}")
            print(", ".join(d.isoformat() for d in days))
    finally:
        con.close()


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    step = argv[0] if argv else "help"
    if step == "download":
        download.download_yearly()
        return 0
    if step == "download-2026":
        key = download.load_map_key()
        availability = download.fetch_availability(key)
        for source in (download.SP_SOURCE, download.NRT_SOURCE):
            print(f"{source}: {availability[source][0]} .. {availability[source][1]}")
        gap = download.availability_gap(availability)
        print("gap between the two products:", f"{gap[0]} .. {gap[1]}" if gap else "none")
        paths = download.download_2026(map_key=key, availability=availability)
        print(f"{len(paths)} files in {paths[0].parent if paths else download.API_FOLDER}")
        return 0
    if step == "all":
        # Everything after the one-time freeze, in order.
        build()
        weigh()
        for sub in ("validate", "export", "check"):
            code = main([sub, *argv[1:]])
            if code:
                return code
        return 0
    if step == "build":
        build()
        return 0
    if step == "report":
        report()
        return 0
    if step == "freeze":
        frozen = calibrate.freeze()
        print(f"frozen: {frozen['candidate']} (m = {frozen['m']}), scores {frozen['loyo']['scores']}")
        return 0
    if step == "freeze-noaa20":
        frozen = calibrate.freeze_noaa20()
        print(f"frozen for NOAA-20: {frozen['candidate']} (m = {frozen['m']}), trained on {frozen['train_years']}")
        return 0
    if step == "weigh":
        weigh()
        return 0
    if step == "validate":
        from . import validate

        out_dir = Path(argv[1]) if len(argv) > 1 else config.WEB_DATA_DIR
        names = {p["id"]: p["name"] for p in provinces.load_provinces()}
        result = validate.build_validation(province_names=names, out_path=out_dir / "validation.json")
        print(f"wrote {out_dir / 'validation.json'}: typical error {result['typical_error_pct']:.1f}%, "
              f"naive {result['naive_error_pct']:.1f}%, targets met {result['targets_met']}")
        return 0
    if step == "export":
        import json

        from . import export

        out_dir = Path(argv[1]) if len(argv) > 1 else config.WEB_DATA_DIR
        validation = json.loads((out_dir / "validation.json").read_text())
        meta = export.export_all(out_dir=out_dir, frozen=calibrate.load_frozen(), validation=validation,
                                 provinces=provinces.load_provinces())
        total = 0
        for path in sorted(out_dir.rglob("*")):
            if path.is_file():
                total += path.stat().st_size
                if path.parent.name != "points":
                    print(f"{path.stat().st_size / 1e6:8.2f} MB  {path.relative_to(out_dir)}")
        tiles = list((out_dir / "points").glob("*.csv.gz"))
        print(f"{sum(t.stat().st_size for t in tiles) / 1e6:8.2f} MB  points/ ({len(tiles)} tiles, "
              f"largest {max(t.stat().st_size for t in tiles) / 1e6:.2f} MB)")
        print(f"{total / 1e6:8.2f} MB  total; data through {meta['data_end_date']}; "
              f"incomplete months {len(meta['incomplete_months'])}")
        return 0
    if step == "check":
        from . import checks

        out_dir = Path(argv[1]) if len(argv) > 1 else config.WEB_DATA_DIR
        for name in checks.run_checks(out_dir):
            print("ok:", name)
        return 0
    print("usage: python -m focos_pipeline.run download | download-2026 | build | report | freeze | freeze-noaa20 | weigh | validate [out_dir] | export [out_dir] | check [out_dir] | all [out_dir]")
    return 0 if step == "help" else 2


if __name__ == "__main__":
    raise SystemExit(main())
