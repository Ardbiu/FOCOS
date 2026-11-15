import json

import numpy as np

from focos_pipeline import provinces


def square(x0, y0, size=1.0):
    return [[[x0, y0], [x0 + size, y0], [x0 + size, y0 + size], [x0, y0 + size], [x0, y0]]]


def write_geojson(tmp_path, features):
    path = tmp_path / "provincias.geojson"
    path.write_text(json.dumps({"type": "FeatureCollection", "features": features}))
    return path


def feature(pid, name, coords, kind="Polygon"):
    return {
        "type": "Feature",
        "properties": {"id": pid, "nombre": name},
        "geometry": {"type": kind, "coordinates": coords},
    }


def two_squares(tmp_path):
    # West square covers lon -62..-61, east square covers lon -60.9..-59.9: a 0.1 degree gap.
    return provinces.load_provinces(write_geojson(tmp_path, [
        feature("01", "West", square(-62.0, -35.0)),
        feature("02", "East", square(-60.9, -35.0)),
    ]))


def test_load_provinces_keeps_id_and_name(tmp_path):
    loaded = two_squares(tmp_path)
    assert [(p["id"], p["name"]) for p in loaded] == [("01", "West"), ("02", "East")]


def test_a_point_inside_a_province_gets_its_id(tmp_path):
    ids = provinces.assign(np.array([-61.5, -60.4]), np.array([-34.5, -34.5]), two_squares(tmp_path))
    assert list(ids) == ["01", "02"]


def test_a_point_in_a_small_gap_goes_to_the_nearest_province(tmp_path):
    ids = provinces.assign(np.array([-60.98, -60.92]), np.array([-34.5, -34.5]), two_squares(tmp_path))
    assert list(ids) == ["01", "02"]


def test_a_point_far_from_every_province_gets_none(tmp_path):
    ids = provinces.assign(np.array([-55.0]), np.array([-34.5]), two_squares(tmp_path))
    assert list(ids) == [None]


def test_where_provinces_overlap_the_first_listed_wins(tmp_path):
    loaded = provinces.load_provinces(write_geojson(tmp_path, [
        feature("01", "First", square(-62.0, -35.0)),
        feature("02", "Second", square(-61.5, -35.0)),
    ]))
    ids = provinces.assign(np.array([-61.2]), np.array([-34.5]), loaded)
    assert list(ids) == ["01"]


def test_load_provinces_clips_to_the_grid_box_and_repairs_bad_geometry(tmp_path):
    bow_tie = [[[-70.0, -60.0], [-60.0, -50.0], [-60.0, -60.0], [-70.0, -50.0], [-70.0, -60.0]]]
    loaded = provinces.load_provinces(write_geojson(tmp_path, [feature("94", "South", bow_tie)]))
    geom = loaded[0]["geom"]
    assert geom.is_valid
    west, south, east, north = geom.bounds
    assert south >= -56.0 and north <= -21.0 and west >= -74.0 and east <= -53.0
