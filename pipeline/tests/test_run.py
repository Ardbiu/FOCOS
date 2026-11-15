import json

import duckdb
import pytest
from test_clean import MODIS_HEADER, VIIRS_HEADER, modis_row, viirs_row

from focos_pipeline import run


def test_help_exits_cleanly():
    assert run.main(["help"]) == 0


def test_unknown_step_exits_with_usage_error():
    assert run.main(["no-such-step"]) == 2


@pytest.fixture
def tiny(tmp_path):
    """A raw folder with one MODIS and one VIIRS file, one square province, and a database path."""
    raw = tmp_path / "raw"
    (raw / "modis").mkdir(parents=True)
    (raw / "viirs-snpp").mkdir(parents=True)
    (raw / "modis" / "modis_2020_Argentina.csv").write_text(
        "\n".join([MODIS_HEADER, modis_row(lat=-30.0, sat="Aqua"), modis_row(lat=-31.0, sat="Terra")]) + "\n"
    )
    (raw / "viirs-snpp" / "viirs-snpp_2020_Argentina.csv").write_text(
        "\n".join([VIIRS_HEADER, viirs_row(lat=-30.0), viirs_row(lat=-45.0)]) + "\n"
    )
    province_file = tmp_path / "provincias.geojson"
    ring = [[[-61.0, -32.0], [-59.0, -32.0], [-59.0, -29.0], [-61.0, -29.0], [-61.0, -32.0]]]
    province_file.write_text(json.dumps({"type": "FeatureCollection", "features": [{
        "type": "Feature", "properties": {"id": "X1", "nombre": "Test"},
        "geometry": {"type": "Polygon", "coordinates": ring},
    }]}))
    db = tmp_path / "work" / "focos.duckdb"
    run.build(db_path=db, raw_dir=raw, provinces_path=province_file)
    return {"db": db, "raw": raw, "provinces": province_file, "dir": tmp_path}


def query(db, sql):
    con = duckdb.connect(str(db), read_only=True)
    try:
        return con.sql(sql).fetchall()
    finally:
        con.close()


def test_build_makes_one_pixel_table_with_both_sensors_fcp_keys_and_provinces(tiny):
    rows = query(tiny["db"], "SELECT sat, lat, n_pix, strength, prov FROM pix ORDER BY sat, lat DESC")
    assert rows == [
        ("A", -30.0, 1, 1, "X1"),
        ("N", -30.0, 1, 1, "X1"),
        ("N", -45.0, 1, 1, None),
        ("T", -31.0, 1, 1, "X1"),
    ]


def test_build_stores_the_training_table_and_the_outage_days(tiny):
    training = query(tiny["db"], "SELECT year, month, prov, m, v1, v_pix FROM agg ORDER BY prov NULLS LAST")
    assert training == [(2020, 3, "X1", 1.0, 1.0, 1), (2020, 3, None, 0.0, 1.0, 1)]
    assert query(tiny["db"], "SELECT count(*) FROM outage") == [(0,)]


def test_weigh_stores_aqua_and_snpp_points_with_series_flag_and_weight(tiny):
    calibration = tiny["dir"] / "calibration.json"
    calibration.write_text(json.dumps({"candidate": "C1", "m": None, "model": {
        "candidate": "C1", "train_years": [2012, 2019], "m": None, "overall": 0.5, "national": {},
    }}))

    run.weigh(db_path=tiny["db"], calibration_path=calibration)

    rows = query(tiny["db"], "SELECT sat, s, w FROM points ORDER BY sat, lat DESC")
    assert rows == [("A", 0, 0.0), ("N", 1, 0.5), ("N", 1, 0.5)]


def test_build_adds_api_rows_after_dropping_flares_and_foreign_points(tmp_path):
    raw = tmp_path / "raw"
    for folder in ("modis", "viirs-snpp", "viirs-snpp-2026"):
        (raw / folder).mkdir(parents=True)
    flare = dict(lat=-30.505, lon=-60.505, typ=2)
    (raw / "modis" / "modis_2020_Argentina.csv").write_text("\n".join([
        MODIS_HEADER,
        modis_row(lat=-30.0, sat="Aqua"),
        modis_row(day="2019-05-01", **flare),
        modis_row(day="2020-05-01", **flare),
    ]) + "\n")
    (raw / "viirs-snpp" / "viirs-snpp_2020_Argentina.csv").write_text(
        "\n".join([VIIRS_HEADER, viirs_row(lat=-30.0)]) + "\n"
    )
    untyped_header = VIIRS_HEADER.rsplit(",", 1)[0]
    untyped = lambda **kw: viirs_row(day="2026-11-03", **kw).rsplit(",", 1)[0]
    (raw / "viirs-snpp-2026" / "VIIRS_SNPP_NRT_2026-11-01_5.csv").write_text("\n".join([
        untyped_header,
        untyped(lat=-31.0),                 # a real fire inside the province
        untyped(lat=-30.505, lon=-60.505),  # on the flare
        untyped(lat=-45.0),                 # outside the province
        viirs_row(day="2026-11-04", lat=-31.5).rsplit(",", 1)[0],   # the last, possibly partial, day
    ]) + "\n")
    province_file = tmp_path / "provincias.geojson"
    ring = [[[-61.0, -32.0], [-59.0, -32.0], [-59.0, -29.0], [-61.0, -29.0], [-61.0, -32.0]]]
    province_file.write_text(json.dumps({"type": "FeatureCollection", "features": [{
        "type": "Feature", "properties": {"id": "X1", "nombre": "Test"},
        "geometry": {"type": "Polygon", "coordinates": ring},
    }]}))
    db = tmp_path / "work" / "focos.duckdb"

    run.build(db_path=db, raw_dir=raw, provinces_path=province_file)

    rows = query(db, "SELECT lat, has_type, prov FROM pix WHERE year = 2026 ORDER BY lat")
    assert rows == [(-31.0, False, "X1")]


def test_build_takes_noaa20_files_when_they_exist_and_stores_its_own_training_table(tmp_path):
    raw = tmp_path / "raw"
    for folder in ("modis", "viirs-snpp", "viirs-jpss1"):
        (raw / folder).mkdir(parents=True)
    (raw / "modis" / "modis_2020_Argentina.csv").write_text(
        "\n".join([MODIS_HEADER, modis_row(lat=-30.0, sat="Aqua")]) + "\n")
    (raw / "viirs-snpp" / "viirs-snpp_2020_Argentina.csv").write_text(
        "\n".join([VIIRS_HEADER, viirs_row(lat=-30.0)]) + "\n")
    (raw / "viirs-jpss1" / "viirs-jpss1_2020_Argentina.csv").write_text(
        "\n".join([VIIRS_HEADER, viirs_row(lat=-29.8, sat="N20"), viirs_row(lat=-29.9, sat="N20")]) + "\n")
    province_file = tmp_path / "provincias.geojson"
    ring = [[[-61.0, -32.0], [-59.0, -32.0], [-59.0, -29.0], [-61.0, -29.0], [-61.0, -32.0]]]
    province_file.write_text(json.dumps({"type": "FeatureCollection", "features": [{
        "type": "Feature", "properties": {"id": "X1", "nombre": "Test"},
        "geometry": {"type": "Polygon", "coordinates": ring},
    }]}))
    db = tmp_path / "work" / "focos.duckdb"

    run.build(db_path=db, raw_dir=raw, provinces_path=province_file)

    assert query(db, "SELECT sat, count(*) FROM pix GROUP BY sat ORDER BY sat") == [("A", 1), ("N", 1), ("N20", 2)]
    assert query(db, "SELECT m, v1, v_pix FROM agg") == [(1.0, 1.0, 1)]
    assert query(db, "SELECT m, v1, v_pix FROM agg_n20") == [(1.0, 2.0, 2)]

    model = {"candidate": "C1", "train_years": [2012, 2019], "m": None, "overall": 0.5, "national": {}}
    calibration = tmp_path / "calibration.json"
    calibration.write_text(json.dumps({"candidate": "C1", "m": None, "model": model}))
    noaa20_calibration = tmp_path / "calibration_noaa20.json"
    noaa20_calibration.write_text(json.dumps({"candidate": "C1", "m": None, "model": dict(model, overall=0.25)}))

    run.weigh(db_path=db, calibration_path=calibration, noaa20_calibration_path=noaa20_calibration)

    rows = query(db, "SELECT sat, s, w, wk FROM points ORDER BY sat, lat")
    assert rows == [("A", 0, 0.0, 1.0), ("N", 1, 0.5, 0.5), ("N20", 0, 0.0, 0.25), ("N20", 0, 0.0, 0.25)]
