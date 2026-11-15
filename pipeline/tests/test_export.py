import gzip
import json
import struct
from datetime import date

import duckdb
import numpy as np
import pandas as pd
import pytest

from focos_pipeline import config, export

SQUARE = {"id": "06", "name": "Buenos Aires"}
META_KEYS = {
    "version", "generated_utc", "country", "data_end_date", "switch_month", "grid", "month_count",
    "calibration", "typical_error_pct", "naive_error_pct", "incomplete_months", "tiles", "mtd", "series",
    "gap_fill",
}


def make_db(tmp_path, rows, outages=()):
    """Rows of (local_date, sat, lat, lon, prov, s, w). Returns the database path."""
    df = pd.DataFrame(rows, columns=["local_date", "sat", "lat", "lon", "prov", "s", "w"])
    df["local_date"] = pd.to_datetime(df["local_date"]).dt.date
    df["year"] = [d.year for d in df["local_date"]]
    df["month"] = [d.month for d in df["local_date"]]
    df["dn"] = "D"
    df["conf_raw"] = ["80" if sat == "A" else "n" for sat in df["sat"]]
    df["frp"] = 12.34
    out = pd.DataFrame(list(outages), columns=["sat", "local_date"])
    db = tmp_path / "work.duckdb"
    con = duckdb.connect(str(db))
    con.register("df", df)
    con.sql("CREATE TABLE points AS SELECT * FROM df")
    con.sql("CREATE TABLE outage (sat VARCHAR, local_date DATE)")
    if len(out):
        con.register("out", out)
        con.sql("INSERT INTO outage SELECT sat, CAST(local_date AS DATE) FROM out")
    con.close()
    return db


def run_export(tmp_path, rows, outages=()):
    db = make_db(tmp_path, rows, outages)
    out_dir = tmp_path / "out"
    provinces = [{"id": "06", "name": "Buenos Aires", "geom": None}, {"id": "14", "name": "Córdoba", "geom": None}]
    frozen = {"candidate": "C2", "train_years": [2012, 2019], "test_years": [2020, 2021]}
    validation = {"typical_error_pct": 17.3, "naive_error_pct": 454.3, "noaa20": {"typical_error_pct": 18.0}}
    export.export_all(db_path=db, out_dir=out_dir, frozen=frozen, validation=validation, provinces=provinces)
    return out_dir


BASIC = [
    ("2008-06-10", "A", -34.60, -58.40, "06", 1, 1.0),
    ("2008-06-11", "A", -34.60, -58.40, "06", 1, 0.5),
    ("2013-01-05", "N", -34.62, -58.41, "06", 1, 0.25),
    ("2013-01-05", "A", -34.62, -58.41, "06", 0, 0.0),
    ("2013-01-06", "N", -31.40, -64.20, "14", 1, 0.3),
    ("2013-01-07", "N", -20.00, -60.00, "14", 1, 0.3),   # north of the grid box
]


def test_a_written_grid_reads_back_to_the_same_triples(tmp_path):
    path = tmp_path / "g.bin.gz"
    export.write_grid(path, [5, 7, 420], [1.5, 0.25, 3.0], [0, 109, 286])
    cells, values, idx = export.read_grid(path)
    assert list(cells) == [5, 7, 420]
    assert list(values) == [1.5, 0.25, 3.0]
    assert list(idx) == [0, 109, 286]


def test_the_grid_byte_layout_is_n_then_cells_then_values_then_months_little_endian(tmp_path):
    path = tmp_path / "g.bin.gz"
    export.write_grid(path, [5, 7, 420], [1.5, 0.25, 3.0], [0, 109, 286])
    expected = struct.pack("<I", 3) + struct.pack("<3I", 5, 7, 420) + struct.pack("<3f", 1.5, 0.25, 3.0) + struct.pack("<3H", 0, 109, 286)
    assert gzip.decompress(path.read_bytes()) == expected


def test_a_point_lands_in_the_tile_named_by_the_floor_of_its_coordinates(tmp_path):
    out = run_export(tmp_path, BASIC)
    lines = gzip.decompress((out / "points" / "t_-35_-59.csv.gz").read_bytes()).decode().splitlines()
    assert lines[0] == "lat,lon,date,dn,sat,conf,frp,s,w"
    assert lines[1] == "-34.60000,-58.40000,2008-06-10,D,A,80,12.3,1,1.000000"
    assert len(lines) == 5


def test_a_point_outside_the_grid_box_is_skipped_everywhere(tmp_path):
    out = run_export(tmp_path, BASIC)
    assert sorted(p.name for p in (out / "points").iterdir()) == ["t_-32_-65.csv.gz", "t_-35_-59.csv.gz"]
    meta = json.loads((out / "meta.json").read_text())
    assert meta["tiles"] == ["t_-32_-65", "t_-35_-59"]
    areas = {a["id"]: a for a in json.loads((out / "summary" / "provinces.json").read_text())["areas"]}
    assert sum(areas["14"]["monthly"]) == pytest.approx(0.3)


def test_province_series_are_sums_of_point_weights_and_the_nation_is_their_sum(tmp_path):
    out = run_export(tmp_path, BASIC)
    areas = json.loads((out / "summary" / "provinces.json").read_text())["areas"]
    assert [a["id"] for a in areas] == ["AR", "06", "14"]
    by_id = {a["id"]: a for a in areas}
    june_2008 = config.month_idx(2008, 6)
    jan_2013 = config.month_idx(2013, 1)
    assert by_id["06"]["monthly"][june_2008] == pytest.approx(1.5)
    assert by_id["06"]["monthly"][jan_2013] == pytest.approx(0.25)
    assert by_id["06"]["raw"][june_2008] == 2
    assert by_id["AR"]["monthly"][jan_2013] == pytest.approx(0.55)
    for area in areas:
        assert len(area["monthly"]) == 287 and len(area["raw"]) == 287


def test_monthly_grid_holds_the_weights_and_raw_grid_the_in_series_pixel_counts(tmp_path):
    out = run_export(tmp_path, BASIC)
    cells, values, idx = export.read_grid(out / "grid" / "monthly.bin.gz")
    assert float(values.sum()) == pytest.approx(1.0 + 0.5 + 0.25 + 0.3)
    assert config.cell_id(-34.60, -58.40) in set(cells)
    raw_cells, raw_values, raw_idx = export.read_grid(out / "grid" / "raw.bin.gz")
    assert float(raw_values.sum()) == 4.0
    assert not np.any(values == 0)


def test_meta_has_every_field_of_the_contract(tmp_path):
    out = run_export(tmp_path, BASIC)
    meta = json.loads((out / "meta.json").read_text())
    assert set(meta) == META_KEYS
    assert meta["country"] == "Argentina"
    assert meta["month_count"] == 287
    assert meta["switch_month"] == "2012-02"
    assert meta["grid"] == {"lat0": -56.0, "lon0": -74.0, "cell": 0.05, "nlat": 700, "nlon": 420}
    assert meta["calibration"] == {"candidate": "C2", "train_years": [2012, 2019], "test_years": [2020, 2021]}
    assert meta["typical_error_pct"] == 17.3 and meta["naive_error_pct"] == 454.3
    assert meta["data_end_date"] == "2013-01-06"


def test_data_ending_mid_month_makes_a_month_to_date_layer(tmp_path):
    rows = [
        ("2025-11-10", "N", -34.60, -58.40, "06", 1, 0.25),
        ("2025-11-20", "N", -34.60, -58.40, "06", 1, 0.50),
        ("2026-11-05", "N", -34.60, -58.40, "06", 1, 0.40),
        ("2026-11-14", "N", -34.60, -58.40, "06", 1, 0.10),
    ]
    out = run_export(tmp_path, rows)
    meta = json.loads((out / "meta.json").read_text())
    assert meta["data_end_date"] == "2026-11-14"
    assert meta["mtd"] == {"month": 11, "last_day": 14}
    cells, values, years = export.read_grid(out / "grid" / "mtd.bin.gz")
    by_year = dict(zip((int(y) for y in years), (float(v) for v in values)))
    assert by_year == {2025 - 2003: pytest.approx(0.25), 2026 - 2003: pytest.approx(0.5)}
    nation = json.loads((out / "summary" / "provinces.json").read_text())["areas"][0]
    assert len(nation["mtd"]) == 24
    assert nation["mtd"][2025 - 2003] == pytest.approx(0.25)
    assert nation["mtd"][2026 - 2003] == pytest.approx(0.5)


def test_data_ending_on_a_month_end_has_no_month_to_date_layer(tmp_path):
    out = run_export(tmp_path, [("2025-12-31", "N", -34.60, -58.40, "06", 1, 0.25)])
    meta = json.loads((out / "meta.json").read_text())
    assert meta["mtd"] is None
    cells, values, years = export.read_grid(out / "grid" / "mtd.bin.gz")
    assert len(cells) == 0
    areas = json.loads((out / "summary" / "provinces.json").read_text())["areas"]
    assert all(area["mtd"] == [] for area in areas)


def test_a_month_with_too_many_outage_days_of_the_series_sensor_is_incomplete(tmp_path):
    outages = [("N", f"2022-07-{d:02d}") for d in (27, 28, 29, 30)] + [("A", "2022-07-01")] + [("N", "2022-06-05")]
    out = run_export(tmp_path, BASIC, outages)
    meta = json.loads((out / "meta.json").read_text())
    assert meta["incomplete_months"] == [
        {"month_idx": config.month_idx(2022, 7), "coverage": pytest.approx(1 - 4 / 31, abs=1e-3), "sensor": "N"}
    ]


def test_province_boundaries_keep_only_id_and_name(tmp_path):
    from shapely.geometry import box

    provinces = [{"id": "06", "name": "Buenos Aires", "geom": box(-60.123456789, -36.0, -58.0, -34.0)}]
    path = tmp_path / "provinces.geojson"
    export.write_provinces_geojson(path, provinces)
    written = json.loads(path.read_text())
    assert written["type"] == "FeatureCollection"
    assert written["features"][0]["properties"] == {"id": "06", "name": "Buenos Aires"}
    assert "-60.123456789" not in path.read_text()


def test_point_weights_keep_six_decimals_so_tiles_add_up_to_the_grid(tmp_path):
    # 0.3166666 repeated 30,000 times: four decimals would drift by a full unit.
    rows = [("2013-01-05", "N", -34.60 - (i % 100) * 0.001, -58.40, "06", 1, 0.3166666) for i in range(30000)]
    out = run_export(tmp_path, rows)
    lines = gzip.decompress((out / "points" / "t_-35_-59.csv.gz").read_bytes()).decode().splitlines()[1:]
    total = sum(float(line.rsplit(",", 1)[1]) for line in lines)
    cells, values, idx = export.read_grid(out / "grid" / "monthly.bin.gz")
    assert total == pytest.approx(float(values.sum(dtype="float64")), abs=0.05)


WITH_NOAA20 = BASIC + [
    ("2020-06-01", "N20", -34.61, -58.42, "06", 0, 0.0),    # NOAA-20 before it carries the series
    ("2026-10-30", "N", -34.61, -58.42, "06", 1, 0.3),
    ("2026-11-05", "N20", -34.61, -58.42, "06", 1, 0.2),
    ("2026-11-06", "N", -34.61, -58.42, "06", 0, 0.0),      # S-NPP after the handover
]


def test_noaa20_points_are_exported_only_where_they_carry_the_series(tmp_path):
    out = run_export(tmp_path, WITH_NOAA20)
    lines = gzip.decompress((out / "points" / "t_-35_-59.csv.gz").read_bytes()).decode().splitlines()[1:]
    noaa20 = [line for line in lines if ",N20," in line]
    assert noaa20 == ["-34.61000,-58.42000,2026-11-05,D,N20,n,12.3,1,0.200000"]
    assert any(",2026-11-06,D,N," in line for line in lines)


def test_meta_series_lists_two_carriers_until_noaa20_carries_data(tmp_path):
    meta = json.loads((run_export(tmp_path, BASIC) / "meta.json").read_text())
    assert meta["series"] == [
        {"sat": "A", "name": "Aqua MODIS", "from": "2003-01", "to": "2012-01", "typical_error_pct": None},
        {"sat": "N", "name": "S-NPP VIIRS", "from": "2012-02", "to": None, "typical_error_pct": 17.3},
    ]


def test_meta_series_lists_three_carriers_once_noaa20_carries_data(tmp_path):
    meta = json.loads((run_export(tmp_path, WITH_NOAA20) / "meta.json").read_text())
    assert meta["series"] == [
        {"sat": "A", "name": "Aqua MODIS", "from": "2003-01", "to": "2012-01", "typical_error_pct": None},
        {"sat": "N", "name": "S-NPP VIIRS", "from": "2012-02", "to": "2026-10", "typical_error_pct": 17.3},
        {"sat": "N20", "name": "NOAA-20 VIIRS", "from": "2026-11", "to": None, "typical_error_pct": 18.0},
    ]
    assert meta["data_end_date"] == "2026-11-05"
    assert meta["mtd"] == {"month": 11, "last_day": 5}


def test_a_month_carried_by_noaa20_is_incomplete_only_when_noaa20_was_out(tmp_path):
    outages = [("N", f"2026-11-{d:02d}") for d in (2, 3, 4, 5, 6)] + [("N20", f"2026-11-{d:02d}") for d in (10, 11, 12, 13)]
    meta = json.loads((run_export(tmp_path, WITH_NOAA20, outages) / "meta.json").read_text())
    assert meta["incomplete_months"] == [
        {"month_idx": config.month_idx(2026, 11), "coverage": pytest.approx(1 - 4 / 30, abs=1e-3), "sensor": "N20"}
    ]


def test_without_noaa20_november_2026_is_judged_by_snpp(tmp_path):
    outages = [("N", f"2026-11-{d:02d}") for d in (2, 3, 4, 5, 6)]
    meta = json.loads((run_export(tmp_path, BASIC, outages) / "meta.json").read_text())
    assert meta["incomplete_months"] == [
        {"month_idx": config.month_idx(2026, 11), "coverage": pytest.approx(1 - 5 / 30, abs=1e-3), "sensor": "N"}
    ]


WITH_FILL = BASIC + [
    ("2018-04-01", "N20", -34.62, -58.41, "06", 0, 0.0),
    ("2022-07-27", "N20", -34.62, -58.41, "06", 1, 0.2),
]


def test_a_day_filled_by_noaa20_does_not_count_against_the_month(tmp_path):
    outages = [("N", f"2022-07-{d:02d}") for d in (27, 28, 29, 30)] + [("N20", "2022-07-30")]
    meta = json.loads((run_export(tmp_path, WITH_FILL, outages) / "meta.json").read_text())
    assert meta["incomplete_months"] == []
    assert meta["gap_fill"] == {
        "sat": "N20", "name": "NOAA-20 VIIRS", "days": 3, "first": "2022-07-27", "last": "2022-07-29",
    }


def test_days_on_which_both_viirs_satellites_were_out_still_count_against_the_month(tmp_path):
    days = (27, 28, 29, 30)
    outages = [("N", f"2022-07-{d:02d}") for d in days] + [("N20", f"2022-07-{d:02d}") for d in days]
    meta = json.loads((run_export(tmp_path, WITH_FILL, outages) / "meta.json").read_text())
    assert meta["incomplete_months"] == [
        {"month_idx": config.month_idx(2022, 7), "coverage": pytest.approx(1 - 4 / 31, abs=1e-3), "sensor": "N"}
    ]
    assert meta["gap_fill"] is None


def test_days_filled_by_noaa20_do_not_make_it_a_carrier_of_the_series(tmp_path):
    meta = json.loads((run_export(tmp_path, WITH_FILL, [("N", "2022-07-27")]) / "meta.json").read_text())
    assert [(c["sat"], c["to"]) for c in meta["series"]] == [("A", "2012-01"), ("N", None)]


def test_without_noaa20_no_day_is_filled(tmp_path):
    meta = json.loads((run_export(tmp_path, BASIC, [("N", "2022-07-27")]) / "meta.json").read_text())
    assert meta["gap_fill"] is None

