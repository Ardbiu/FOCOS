from datetime import date

import duckdb
import pandas as pd
import pytest

from focos_pipeline import weights

HALF = {"candidate": "C1", "train_years": [2012, 2019], "m": None, "overall": 0.5, "national": {}}


def pixels(rows):
    """Rows of (local_date, sat, n_pix); every row is its own pixel in one cell."""
    df = pd.DataFrame(rows, columns=["local_date", "sat", "n_pix"])
    df["local_date"] = pd.to_datetime(df["local_date"]).dt.date
    df["month"] = [d.month for d in df["local_date"]]
    df["dn"] = "D"
    df["lat"], df["lon"] = -34.005, -58.995
    df["cell01_lat"], df["cell01_lon"] = -3401, -5900
    df["strength"] = [1 if n == 1 else 2 if n <= 3 else 3 for n in df["n_pix"]]
    return duckdb.from_df(df)


def weighted(aqua_rows, snpp_rows, model=HALF):
    aqua = pixels(aqua_rows or [("2001-01-01", "A", 1)])
    snpp = pixels(snpp_rows or [("2001-01-01", "N", 1)])
    out = weights.assign_weights(aqua, snpp, model).df()
    return out[out["local_date"].astype(str) != "2001-01-01"].sort_values(["sat", "local_date"]).reset_index(drop=True)


def test_viirs_weights_in_one_fcp_sum_to_k():
    out = weighted([], [("2013-01-05", "N", 4)] * 4)
    assert list(out["w"]) == pytest.approx([0.125] * 4)
    assert out["w"].sum() == pytest.approx(0.5)


def test_aqua_weights_in_one_fcp_sum_to_one():
    out = weighted([("2008-06-01", "A", 2)] * 2, [])
    assert list(out["w"]) == pytest.approx([0.5, 0.5])
    assert list(out["s"]) == [1, 1]


def test_aqua_leaves_the_series_on_the_switch_date():
    out = weighted([("2012-01-31", "A", 1), ("2012-02-01", "A", 1)], [])
    assert list(out["s"]) == [1, 0]
    assert list(out["w"]) == pytest.approx([1.0, 0.0])


def test_viirs_joins_the_series_on_the_switch_date():
    out = weighted([], [("2012-01-25", "N", 1), ("2012-02-01", "N", 1)])
    assert list(out["s"]) == [0, 1]
    assert list(out["w"]) == pytest.approx([0.0, 0.5])


def test_aqua_before_2003_is_not_in_the_series():
    out = weighted([("2002-12-31", "A", 1), ("2003-01-01", "A", 1)], [])
    assert list(out["s"]) == [0, 1]
    assert list(out["w"]) == pytest.approx([0.0, 1.0])


def test_k_follows_the_models_stratum():
    model = {"candidate": "C1", "train_years": [2012, 2019], "m": None, "overall": 0.5,
             "national": {"DJF|D": 0.2, "JJA|D": 0.4}}
    out = weighted([], [("2013-01-05", "N", 1), ("2013-07-05", "N", 1)], model)
    assert list(out["w"]) == pytest.approx([0.2, 0.4])


def test_output_keeps_every_input_row_and_adds_block_s_and_w():
    out = weights.assign_weights(
        pixels([("2008-06-01", "A", 1)]), pixels([("2013-01-05", "N", 1)]), HALF
    ).df()
    assert len(out) == 2
    assert {"s", "w", "block"} <= set(out.columns)
    assert set(out["block"]) == {"-7|-12"}


QUARTER = {"candidate": "C1", "train_years": [2018, 2019], "m": None, "overall": 0.25, "national": {}}


def three_carriers(aqua_rows, snpp_rows, noaa20_rows, fill_days=()):
    out = weights.assign_weights(
        pixels(aqua_rows or [("2001-01-01", "A", 1)]),
        pixels(snpp_rows or [("2001-01-01", "N", 1)]),
        HALF,
        noaa20=pixels(noaa20_rows or [("2001-01-01", "N20", 1)]),
        noaa20_model=QUARTER,
        fill_days=fill_days,
    ).df()
    return out[out["local_date"].astype(str) != "2001-01-01"].sort_values(["sat", "local_date"]).reset_index(drop=True)


def test_snpp_hands_the_series_to_noaa20_on_the_second_switch_date():
    out = three_carriers(
        [],
        [("2026-10-31", "N", 1), ("2026-11-01", "N", 1)],
        [("2026-10-31", "N20", 1), ("2026-11-01", "N20", 2), ("2026-11-01", "N20", 2)],
    )
    snpp = out[out["sat"] == "N"]
    noaa20 = out[out["sat"] == "N20"]
    assert list(snpp["s"]) == [1, 0]
    assert list(snpp["w"]) == pytest.approx([0.5, 0.0])
    assert list(noaa20["s"]) == [0, 1, 1]
    assert list(noaa20["w"]) == pytest.approx([0.0, 0.125, 0.125])


def test_without_noaa20_snpp_keeps_carrying_the_series_after_the_second_switch_date():
    out = weighted([], [("2026-11-01", "N", 1)])
    assert list(out["s"]) == [1]
    assert list(out["w"]) == pytest.approx([0.5])


def test_wk_is_the_weight_a_pixel_would_carry_whether_or_not_it_is_in_the_series():
    out = three_carriers(
        [("2020-06-01", "A", 2), ("2020-06-01", "A", 2)],
        [("2012-01-25", "N", 1)],
        [("2020-06-01", "N20", 1)],
    )
    aqua, snpp, noaa20 = (out[out["sat"] == sat] for sat in ("A", "N", "N20"))
    assert list(aqua["w"]) == pytest.approx([0.0, 0.0]) and list(aqua["wk"]) == pytest.approx([0.5, 0.5])
    assert list(snpp["w"]) == pytest.approx([0.0]) and list(snpp["wk"]) == pytest.approx([0.5])
    assert list(noaa20["w"]) == pytest.approx([0.0]) and list(noaa20["wk"]) == pytest.approx([0.25])


def test_in_series_pixels_have_w_equal_to_wk():
    out = three_carriers([("2008-06-01", "A", 1)], [("2013-01-05", "N", 1)], [("2026-11-05", "N20", 1)])
    assert list(out["s"]) == [1, 1, 1]
    assert list(out["w"]) == pytest.approx(list(out["wk"]))


def test_noaa20_carries_a_day_on_which_snpp_was_out():
    out = three_carriers(
        [],
        [("2022-07-26", "N", 1), ("2022-07-27", "N", 1)],
        [("2022-07-26", "N20", 1), ("2022-07-27", "N20", 2), ("2022-07-27", "N20", 2)],
        fill_days=[date(2022, 7, 27)],
    )
    snpp = out[out["sat"] == "N"]
    noaa20 = out[out["sat"] == "N20"]
    assert list(snpp["s"]) == [1, 0]
    assert list(snpp["w"]) == pytest.approx([0.5, 0.0])
    assert list(noaa20["s"]) == [0, 1, 1]
    assert list(noaa20["w"]) == pytest.approx([0.0, 0.125, 0.125])


def test_fill_days_are_snpp_outage_days_on_which_noaa20_was_flying_and_working():
    outages = [
        ("N", date(2017, 3, 1)),                                  # before NOAA-20 flew
        ("N", date(2022, 7, 27)),
        ("N", date(2022, 7, 28)), ("N20", date(2022, 7, 28)),     # both out
        ("A", date(2022, 7, 29)),                                 # Aqua's outages do not matter
        ("N", date(2026, 11, 3)),                                 # NOAA-20 already carries the series
    ]
    assert weights.noaa20_fill_days(outages, noaa20_first=date(2018, 4, 1)) == [date(2022, 7, 27)]


def test_there_are_no_fill_days_without_noaa20():
    assert weights.noaa20_fill_days([("N", date(2022, 7, 27))], noaa20_first=None) == []

