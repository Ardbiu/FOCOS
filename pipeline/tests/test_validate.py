import json
from datetime import date, timedelta

import duckdb
import pandas as pd
import pytest

from focos_pipeline import validate


def points(rows):
    """Rows of (local_date, sat, prov, lat, lon, n_pix, w) with an optional eighth value, wk.

    Without it, wk is 1 / n_pix for Aqua and w for the VIIRS satellites.
    """
    rows = [tuple(r) + ((1.0 / r[5] if r[1] == "A" else r[6]),) if len(r) == 7 else tuple(r) for r in rows]
    df = pd.DataFrame(rows, columns=["local_date", "sat", "prov", "lat", "lon", "n_pix", "w", "wk"])
    df["local_date"] = pd.to_datetime(df["local_date"]).dt.date
    df["year"] = [d.year for d in df["local_date"]]
    df["month"] = [d.month for d in df["local_date"]]
    df["s"] = [1 if (sat == "N" and d >= date(2012, 2, 1)) or (sat == "A" and d < date(2012, 2, 1)) else 0
               for sat, d in zip(df["sat"], df["local_date"])]
    return duckdb.from_df(df)


def test_metrics_bias_and_median_absolute_error():
    m = validate.metrics(pred=[110, 180], truth=[100, 200])
    assert m["bias"] == pytest.approx(-0.0333, abs=1e-4)
    assert m["mape"] == pytest.approx(10.0)
    assert m["n"] == 2


def test_metrics_log_correlation_is_one_for_identical_series():
    m = validate.metrics(pred=[5, 50, 500, 20], truth=[5, 50, 500, 20])
    assert m["logcorr"] == pytest.approx(1.0)


def test_metrics_of_nothing_are_none_not_nan():
    m = validate.metrics(pred=[], truth=[])
    assert m == {"n": 0, "bias": None, "mape": None, "logcorr": None}


def test_comparison_sums_aqua_fcps_harmonized_weights_and_raw_viirs_pixels():
    rows = [
        ("2020-07-11", "A", "06", -34.5, -60.5, 2, 0.0),
        ("2020-07-11", "A", "06", -34.5, -60.5, 2, 0.0),
        ("2020-07-11", "N", "06", -34.5, -60.5, 1, 0.25),
        ("2020-07-11", "N", "06", -34.6, -60.5, 1, 0.35),
    ]
    out = validate.comparison(points(rows), excluded_days=set(), by=["year", "month", "prov"])
    assert out.to_dict("records") == [
        {"year": 2020, "month": 7, "prov": "06", "aqua": 1.0, "aqua_pix": 2.0,
         "harmonized": pytest.approx(0.6), "naive": 2.0}
    ]


def test_comparison_leaves_out_excluded_days_and_days_before_the_switch():
    window = {date(2020, 8, 16) + timedelta(days=i) for i in range(18)}
    rows = [
        ("2020-08-20", "N", "06", -34.5, -60.5, 1, 0.3),   # inside the 2020 outage window
        ("2020-08-10", "N", "06", -34.5, -60.5, 1, 0.3),
        ("2012-01-25", "N", "06", -34.5, -60.5, 1, 0.0),   # before the switch
    ]
    out = validate.comparison(points(rows), excluded_days=window, by=["year"])
    assert out.to_dict("records") == [{"year": 2020, "aqua": 0.0, "aqua_pix": 0.0, "harmonized": pytest.approx(0.3), "naive": 1.0}]


def test_comparison_can_group_by_one_degree_tile():
    rows = [
        ("2020-07-10", "N", "06", -34.5, -60.5, 1, 0.3),
        ("2020-07-10", "N", "06", -35.5, -60.5, 1, 0.3),
    ]
    out = validate.comparison(points(rows), excluded_days=set(), by=["tile"])
    assert sorted(out["tile"]) == ["t_-35_-61", "t_-36_-61"]


def test_scored_pairs_drop_rows_below_twenty_aqua_fcps():
    pairs = pd.DataFrame({"aqua": [19.0, 20.0, 300.0], "harmonized": [30.0, 22.0, 270.0], "naive": [90.0, 100.0, 1500.0]})
    result = validate.scale_metrics(pairs)
    assert result["harmonized"]["n"] == 2
    assert result["harmonized"]["mape"] == pytest.approx(10.0)
    assert result["naive"]["mape"] == pytest.approx(400.0)


def test_peak_month_agreement_is_the_share_of_province_years_with_the_same_busiest_month():
    pairs = pd.DataFrame([
        {"year": 2020, "month": 8, "prov": "06", "aqua": 100.0, "harmonized": 90.0, "naive": 500.0},
        {"year": 2020, "month": 9, "prov": "06", "aqua": 50.0, "harmonized": 60.0, "naive": 300.0},
        {"year": 2020, "month": 8, "prov": "14", "aqua": 100.0, "harmonized": 70.0, "naive": 500.0},
        {"year": 2020, "month": 9, "prov": "14", "aqua": 80.0, "harmonized": 95.0, "naive": 300.0},
    ])
    result = validate.peak_month_agreement(pairs)
    assert result == {"harmonized": 0.5, "naive": 1.0, "n": 2}


def test_build_validation_writes_every_part_the_method_page_draws(tmp_path):
    rows = []
    for year in (2012, 2013, 2020, 2021):
        for month in (2, 8):
            for i in range(30):
                rows.append((f"{year}-{month:02d}-{1 + i % 20:02d}", "A", "06", -34.5 - i * 0.02, -60.5, 1, 0.0))
                rows.append((f"{year}-{month:02d}-{1 + i % 20:02d}", "N", "06", -34.5 - i * 0.02, -60.5, 1, 0.9))
    db = tmp_path / "work.duckdb"
    con = duckdb.connect(str(db))
    con.register("p", points(rows).df())
    con.sql("CREATE TABLE points AS SELECT * FROM p")
    con.sql("CREATE TABLE outage (sat VARCHAR, local_date DATE)")
    con.close()
    frozen = {"candidate": "C1", "m": None, "train_years": [2012, 2019], "test_years": [2020, 2021],
              "loyo": {"scores": {"C0": 400.0, "C1": 20.0, "C2": 17.0, "C3": 18.0}}}
    out_path = tmp_path / "validation.json"

    result = validate.build_validation(db_path=db, frozen=frozen, province_names={"06": "Buenos Aires"}, out_path=out_path)

    written = json.loads(out_path.read_text())
    assert written == json.loads(json.dumps(result))
    assert set(written) == {
        "generated_utc", "chosen", "m", "train_years", "test_years", "loyo", "targets", "test",
        "targets_met", "peak_month_agreement", "rank_corr", "yearly_national", "test_pairs",
        "yearly_ratio", "seam", "typical_error_pct", "naive_error_pct", "excluded_days", "partner_check",
        "noaa20", "province_bias", "error_by_count", "excluded_dates", "yearly_test", "bias_by_level",
    }
    assert written["noaa20"] is None
    assert written["province_bias"] == [
        # 115, not 120: five of the August 2020 rows fall inside the excluded outage window.
        {"prov": "06", "name": "Buenos Aires", "aqua": 115.0, "harmonized": pytest.approx(103.5), "bias": pytest.approx(-0.1)}
    ]
    assert written["excluded_dates"][0] == "2020-08-16" and len(written["excluded_dates"]) == written["excluded_days"]
    assert written["yearly_test"] == [
        {"year": 2020, "aqua": 55.0, "harmonized": pytest.approx(49.5), "bias": pytest.approx(-0.1)},
        {"year": 2021, "aqua": 60.0, "harmonized": pytest.approx(54.0), "bias": pytest.approx(-0.1)},
    ]
    assert set(written["test"]) == {"harmonized", "naive"}
    assert set(written["test"]["harmonized"]) == {"national_month", "province_month", "tile_month"}
    assert written["test"]["harmonized"]["province_month"]["mape"] == pytest.approx(10.0)
    assert written["typical_error_pct"] == pytest.approx(10.0)
    assert written["naive_error_pct"] == pytest.approx(0.0)
    assert written["test_pairs"][0] == {
        "prov": "06", "name": "Buenos Aires", "year": 2020, "month": 2,
        "aqua": 30.0, "harmonized": pytest.approx(27.0), "naive": 30.0,
    }
    assert [r["year"] for r in written["yearly_ratio"]] == [2012, 2013, 2020, 2021]
    assert written["yearly_ratio"][0]["ratio"] == pytest.approx(1 / 0.9)
    assert written["partner_check"] is None


def test_comparison_can_put_noaa20_on_the_viirs_side():
    rows = [
        ("2020-07-10", "A", "06", -34.5, -60.5, 1, 0.0),
        ("2020-07-10", "N", "06", -34.5, -60.5, 1, 0.3),
        ("2020-07-10", "N20", "06", -34.5, -60.5, 1, 0.0, 0.25),
    ]
    out = validate.comparison(points(rows), excluded_days=set(), by=["year"], viirs_sat="N20")
    assert out.to_dict("records") == [{"year": 2020, "aqua": 1.0, "aqua_pix": 1.0, "harmonized": pytest.approx(0.25), "naive": 1.0}]


def test_handover_compares_harmonized_noaa20_with_harmonized_snpp():
    rows = [
        ("2023-07-10", "N", "06", -34.5, -60.5, 1, 0.3),
        ("2023-07-10", "N20", "06", -34.5, -60.5, 1, 0.0, 0.27),
        ("2023-07-11", "N20", "06", -34.5, -60.5, 1, 0.0, 0.27),   # an excluded day
    ]
    out = validate.handover(points(rows), excluded_days={date(2023, 7, 11)}, by=["year", "month"])
    assert out.to_dict("records") == [
        {"year": 2023, "month": 7, "snpp": pytest.approx(0.3), "noaa20": pytest.approx(0.27)}
    ]


def test_build_validation_reports_noaa20_when_its_points_exist(tmp_path):
    rows = []
    for year in (2012, 2013, 2020, 2021, 2023):
        for month in (2, 8):
            for i in range(30):
                day = f"{year}-{month:02d}-{1 + i % 20:02d}"
                rows.append((day, "A", "06", -34.5 - i * 0.02, -60.5, 1, 0.0))
                rows.append((day, "N", "06", -34.5 - i * 0.02, -60.5, 1, 0.9))
                if year >= 2020:
                    rows.append((day, "N20", "06", -34.5 - i * 0.02, -60.5, 1, 0.0, 0.8))
    db = tmp_path / "work.duckdb"
    con = duckdb.connect(str(db))
    con.register("p", points(rows).df())
    con.sql("CREATE TABLE points AS SELECT * FROM p")
    con.sql("CREATE TABLE outage (sat VARCHAR, local_date DATE)")
    con.close()
    frozen = {"candidate": "C1", "m": None, "train_years": [2012, 2019], "test_years": [2020, 2021],
              "loyo": {"scores": {"C0": 400.0, "C1": 20.0, "C2": 17.0, "C3": 18.0}}}

    result = validate.build_validation(db_path=db, frozen=frozen, province_names={"06": "Buenos Aires"},
                                       out_path=tmp_path / "validation.json", noaa20_train_years=[2018, 2019])

    block = result["noaa20"]
    assert set(block) == {"train_years", "test", "handover", "typical_error_pct", "province_bias"}
    assert block["province_bias"][0]["bias"] == pytest.approx(-0.2)
    assert block["train_years"] == [2018, 2019]
    assert set(block["test"]) == {"national_month", "province_month", "tile_month"}
    assert block["test"]["province_month"]["mape"] == pytest.approx(20.0)
    assert block["test"]["national_month"]["bias"] == pytest.approx(-0.2)
    assert block["typical_error_pct"] == pytest.approx(20.0)
    assert block["handover"]["years"] == [2022, 2025]
    assert block["handover"]["national_month"]["n"] == 2
    assert block["handover"]["province_month"]["mape"] == pytest.approx(100 * 0.1 / 0.9)
    # The S-NPP results are untouched by NOAA-20 being there.
    assert result["typical_error_pct"] == pytest.approx(10.0)


def test_naive_error_compares_raw_viirs_pixels_with_raw_aqua_pixels():
    # Review finding: pixels against cell-passes handicapped the naive stitch.
    pairs = pd.DataFrame({"aqua": [100.0], "aqua_pix": [125.0], "harmonized": [90.0], "naive": [500.0]})
    result = validate.scale_metrics(pairs)
    assert result["naive"]["mape"] == pytest.approx(300.0)
    assert result["harmonized"]["mape"] == pytest.approx(10.0)


def test_error_by_count_shows_how_error_grows_when_fire_is_scarce():
    # Review finding: the headline error holds only for months with at least 20 Aqua cell-passes.
    pairs = pd.DataFrame({"aqua": [2.0, 3.0, 10.0, 100.0, 0.0], "harmonized": [4.0, 6.0, 15.0, 90.0, 5.0]})
    assert validate.error_by_count(pairs) == [
        {"band": "1-4", "n": 2, "mape": pytest.approx(100.0)},
        {"band": "5-19", "n": 1, "mape": pytest.approx(50.0)},
        {"band": "20+", "n": 1, "mape": pytest.approx(10.0)},
    ]


def test_comparison_starts_when_the_viirs_satellite_starts():
    rows = [
        ("2018-02-10", "A", "06", -34.5, -60.5, 1, 0.0),
        ("2018-04-05", "A", "06", -34.5, -60.5, 1, 0.0),
        ("2018-04-05", "N20", "06", -34.5, -60.5, 1, 0.0, 0.3),
    ]
    out = validate.comparison(points(rows), excluded_days=set(), by=["year"], viirs_sat="N20")
    assert out.to_dict("records") == [
        {"year": 2018, "aqua": 1.0, "aqua_pix": 1.0, "harmonized": pytest.approx(0.3), "naive": 1.0}
    ]


def test_comparison_ends_when_the_viirs_satellite_ends():
    rows = [
        ("2026-10-20", "A", "06", -34.5, -60.5, 1, 0.0),
        ("2026-10-20", "N", "06", -34.5, -60.5, 1, 0.3),
        ("2026-11-05", "A", "06", -34.5, -60.5, 1, 0.0),
        ("2026-11-05", "N20", "06", -34.5, -60.5, 1, 0.0, 0.3),
    ]
    out = validate.comparison(points(rows), excluded_days=set(), by=["year"])
    assert out.to_dict("records") == [
        {"year": 2026, "aqua": 1.0, "aqua_pix": 1.0, "harmonized": pytest.approx(0.3), "naive": 1.0}
    ]


def test_bias_by_level_shows_how_the_record_behaves_in_extreme_months():
    # Found while checking the story months: in very unusual months the record runs low.
    rows = [{"prov": "18", "year": y, "month": 8, "aqua": 100.0, "harmonized": 100.0} for y in range(2012, 2020)]
    rows.append({"prov": "18", "year": 2020, "month": 8, "aqua": 1200.0, "harmonized": 900.0})
    rows.append({"prov": "18", "year": 2021, "month": 8, "aqua": 100.0, "harmonized": 110.0})
    out = validate.bias_by_level(pd.DataFrame(rows), test_years=[2020, 2021])
    assert [r["band"] for r in out] == ["<0.5x", "0.5-2x", "2-5x", "5-10x", "10x+"]
    by_band = {r["band"]: r for r in out}
    assert by_band["10x+"] == {"band": "10x+", "n": 1, "bias": pytest.approx(-0.25), "mape": pytest.approx(25.0)}
    assert by_band["0.5-2x"] == {"band": "0.5-2x", "n": 1, "bias": pytest.approx(0.10), "mape": pytest.approx(10.0)}
    assert by_band["5-10x"] == {"band": "5-10x", "n": 0, "bias": None, "mape": None}
