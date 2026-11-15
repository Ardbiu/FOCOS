import json

import pytest
from test_export import BASIC, run_export

from focos_pipeline import checks, export


@pytest.fixture
def out(tmp_path):
    return run_export(tmp_path, BASIC)


def test_a_fresh_export_passes_every_check(out):
    passed = checks.run_checks(out)
    assert passed == [
        "month count is 287",
        "no negative, NaN or infinite values",
        "every tile in meta.json exists",
        "grid total equals the sum of point weights",
        "raw grid total equals the count of in-series points",
        "national series equals the sum of the provinces",
        "national series equals the points",
        "no in-series point is dated outside 2003-01-01..data_end_date",
        "every day is carried by one satellite",
    ]


def failures(out):
    with pytest.raises(checks.CheckFailed) as err:
        checks.run_checks(out)
    return str(err.value)


def test_a_missing_tile_fails_loudly(out):
    (out / "points" / "t_-32_-65.csv.gz").unlink()
    assert "t_-32_-65" in failures(out)


def test_a_province_file_that_disagrees_with_the_points_fails(out):
    path = out / "summary" / "provinces.json"
    data = json.loads(path.read_text())
    data["areas"][0]["monthly"][0] += 5.0
    path.write_text(json.dumps(data))
    message = failures(out)
    assert "national series equals the sum of the provinces" in message


def test_a_grid_that_lost_weight_fails(out):
    cells, values, idx = export.read_grid(out / "grid" / "monthly.bin.gz")
    export.write_grid(out / "grid" / "monthly.bin.gz", cells[:-1], values[:-1], idx[:-1])
    assert "grid total equals the sum of point weights" in failures(out)


def test_a_nan_in_a_grid_fails(out):
    cells, values, idx = export.read_grid(out / "grid" / "monthly.bin.gz")
    bad = values.copy()
    bad[0] = float("nan")
    export.write_grid(out / "grid" / "monthly.bin.gz", cells, bad, idx)
    assert "no negative, NaN or infinite values" in failures(out)


def test_a_wrong_month_count_fails(out):
    path = out / "meta.json"
    meta = json.loads(path.read_text())
    meta["month_count"] = 286
    path.write_text(json.dumps(meta))
    assert "month count is 287" in failures(out)


def test_an_in_series_point_after_the_data_end_date_fails(out):
    path = out / "meta.json"
    meta = json.loads(path.read_text())
    meta["data_end_date"] = "2010-01-01"
    path.write_text(json.dumps(meta))
    assert "no in-series point is dated outside" in failures(out)


def test_a_day_carried_by_two_satellites_fails(tmp_path):
    rows = BASIC + [("2013-01-05", "N20", -34.62, -58.41, "06", 1, 0.2)]
    assert "every day is carried by one satellite" in failures(run_export(tmp_path, rows))

