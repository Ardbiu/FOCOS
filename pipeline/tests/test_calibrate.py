import json
from datetime import date

import duckdb
import numpy as np
import pandas as pd
import pytest

from focos_pipeline import calibrate

COLUMNS = ["year", "month", "dn", "block", "prov", "m", "v1", "v2", "v3", "v_pix"]


def agg(rows):
    """Rows of (year, month, dn, block, prov, m, v1, v2, v3); v_pix is filled in as 5x the FCPs."""
    df = pd.DataFrame(rows, columns=COLUMNS[:-1])
    df["v_pix"] = 5.0 * (df["v1"] + df["v2"] + df["v3"])
    return df.astype({"m": float, "v1": float, "v2": float, "v3": float})


def strata(month=1, dn="D", block="-7|-13", strength=1):
    return pd.DataFrame({"month": [month], "dn": [dn], "block": [block], "strength": [strength]})


def test_c1_ratio_is_aqua_over_viirs_in_the_stratum():
    data = agg([(2012, 1, "D", "-7|-13", "06", 30, 100, 0, 0)])
    model = calibrate.fit("C1", [2012], data=data)
    assert model["national"]["DJF|D"] == pytest.approx(0.30)
    assert calibrate.predict(model, strata())[0] == pytest.approx(0.30)


def test_c1_falls_back_to_the_overall_ratio_for_a_stratum_it_never_saw():
    data = agg([(2012, 1, "D", "-7|-13", "06", 30, 100, 0, 0)])
    model = calibrate.fit("C1", [2012], data=data)
    assert calibrate.predict(model, strata(month=7, dn="N"))[0] == pytest.approx(0.30)


def shrinkage_data():
    # Block B: M = 50, V = 100. Block C makes the national ratio exactly 0.3.
    return agg([
        (2012, 1, "D", "B", "06", 50, 100, 0, 0),
        (2012, 1, "D", "C", "06", 250, 900, 0, 0),
    ])


def test_c2_pulls_a_block_ratio_toward_the_national_one():
    model = calibrate.fit("C2", [2012], data=shrinkage_data(), m=200)
    assert calibrate.predict(model, strata(block="B"))[0] == pytest.approx(0.3667, abs=1e-4)


def test_c2_uses_the_national_ratio_for_a_block_with_no_data():
    model = calibrate.fit("C2", [2012], data=shrinkage_data(), m=200)
    assert calibrate.predict(model, strata(block="never-seen"))[0] == pytest.approx(0.30)


def test_c3_recovers_the_strength_coefficients_from_noise_free_data():
    rng = np.random.default_rng(7)
    rows = []
    for i in range(60):
        v1, v2, v3 = rng.integers(20, 400, size=3)
        m = 0.1 * v1 + 0.4 * v2 + 0.9 * v3
        rows.append((2012 + i % 4, 1 + i % 12, "D", f"B{i % 5}", "06", m, v1, v2, v3))
    model = calibrate.fit("C3", [2012, 2013, 2014, 2015], data=agg(rows), m=50)
    coef = model["coef"]["D"]
    assert coef == pytest.approx([0.1, 0.4, 0.9], abs=0.01)
    assert all(c >= 0 for c in coef)
    assert calibrate.predict(model, strata(block="B0", strength=3))[0] == pytest.approx(0.9, abs=0.02)


def test_c3_block_adjustment_is_clipped_between_half_and_two():
    assert calibrate.block_adjustment(300, 100, 0) == 2.0
    assert calibrate.block_adjustment(10, 100, 0) == 0.5
    assert calibrate.block_adjustment(150, 100, 0) == pytest.approx(1.5)
    assert calibrate.block_adjustment(0, 0, 50) == pytest.approx(1.0)


def test_selection_takes_the_simplest_candidate_within_ten_percent_of_the_best():
    assert calibrate.choose({"C1": 30, "C2": 21, "C3": 20}) == "C2"
    assert calibrate.choose({"C1": 21.5, "C2": 21, "C3": 20}) == "C1"
    assert calibrate.choose({"C1": 40, "C2": 30, "C3": 20}) == "C3"


def test_fitting_on_a_test_year_before_the_freeze_raises(tmp_path):
    data = agg([(2020, 1, "D", "B", "06", 30, 100, 0, 0)])
    with pytest.raises(calibrate.TestYearsLocked):
        calibrate.fit("C1", [2020], data=data, frozen_path=tmp_path / "calibration.json")


def test_fitting_on_a_test_year_is_allowed_once_frozen(tmp_path):
    frozen = tmp_path / "calibration.json"
    frozen.write_text("{}")
    data = agg([(2020, 1, "D", "B", "06", 30, 100, 0, 0)])
    assert calibrate.fit("C1", [2020], data=data, frozen_path=frozen)["candidate"] == "C1"


def steady_data(years=range(2012, 2020)):
    """Every province-month: Aqua sees 100 FCPs, VIIRS sees 400 FCPs in 2,000 pixels."""
    return agg([
        (y, mth, "D", "B", prov, 100, 400, 0, 0)
        for y in years for mth in range(1, 13) for prov in ("06", "14")
    ])


def test_leave_one_year_out_scores_zero_error_when_the_ratio_never_changes():
    result = calibrate.loyo_scores(data=steady_data(), years=list(range(2012, 2020)))
    assert result["scores"]["C1"] == pytest.approx(0.0, abs=1e-9)
    assert result["scores"]["C2"] == pytest.approx(0.0, abs=1e-9)


def test_naive_pixel_count_scores_its_full_overcount():
    # 2,000 raw pixels against 100 Aqua FCPs is a 1,900% error.
    result = calibrate.loyo_scores(data=steady_data(), years=list(range(2012, 2020)))
    assert result["scores"]["C0"] == pytest.approx(1900.0)


def test_scoring_ignores_province_months_with_fewer_than_twenty_aqua_fcps():
    quiet = agg([(2012, 1, "D", "B", "06", 5, 400, 0, 0), (2012, 2, "D", "B", "06", 100, 400, 0, 0)])
    model = calibrate.fit("C1", [2013], data=steady_data([2013]))
    errors = calibrate.province_month_errors(model, quiet)
    assert len(errors) == 1
    assert errors[0] == pytest.approx(0.0, abs=1e-9)


def test_freeze_writes_the_chosen_model_and_the_scores(tmp_path):
    path = tmp_path / "calibration.json"
    calibrate.freeze(data=steady_data(), years=list(range(2012, 2020)), path=path)
    frozen = json.loads(path.read_text())
    assert frozen["candidate"] == "C1"
    assert frozen["train_years"] == [2012, 2019]
    assert frozen["model"]["national"]["DJF|D"] == pytest.approx(0.25)
    assert set(frozen["loyo"]["scores"]) == {"C0", "C1", "C2", "C3"}


def test_freeze_refuses_to_run_twice(tmp_path):
    path = tmp_path / "calibration.json"
    calibrate.freeze(data=steady_data(), years=list(range(2012, 2020)), path=path)
    with pytest.raises(FileExistsError):
        calibrate.freeze(data=steady_data(), years=list(range(2012, 2020)), path=path)


def pix_table(rows):
    """Rows of (local_date, sat, dn, cell01_lat, cell01_lon, n_pix, strength, prov)."""
    df = pd.DataFrame(rows, columns=["local_date", "sat", "dn", "cell01_lat", "cell01_lon", "n_pix", "strength", "prov"])
    df["local_date"] = pd.to_datetime(df["local_date"]).dt.date
    df["year"] = [d.year for d in df["local_date"]]
    df["month"] = [d.month for d in df["local_date"]]
    return duckdb.from_df(df)


def test_training_table_sums_fcp_equivalents_by_block_and_strength():
    rows = [
        ("2013-01-05", "A", "D", -3401, -5900, 2, 2, "06"),
        ("2013-01-05", "A", "D", -3401, -5900, 2, 2, "06"),
        ("2013-01-05", "N", "D", -3401, -5900, 1, 1, "06"),
        ("2013-01-06", "N", "D", -3402, -5900, 4, 3, "06"),
        ("2013-01-06", "N", "D", -3402, -5900, 4, 3, "06"),
        ("2013-01-06", "N", "D", -3402, -5900, 4, 3, "06"),
        ("2013-01-06", "N", "D", -3402, -5900, 4, 3, "06"),
    ]
    out = calibrate.training_table(pix_table(rows), excluded_days=set())
    assert len(out) == 1
    row = out.iloc[0]
    assert (row["year"], row["month"], row["dn"], row["block"], row["prov"]) == (2013, 1, "D", "-7|-12", "06")
    assert (row["m"], row["v1"], row["v2"], row["v3"], row["v_pix"]) == (1.0, 1.0, 0.0, 1.0, 5)


def test_training_table_drops_excluded_days_and_days_before_the_switch():
    rows = [
        ("2012-01-25", "N", "D", -3401, -5900, 1, 1, "06"),
        ("2013-01-05", "N", "D", -3401, -5900, 1, 1, "06"),
        ("2013-01-06", "N", "D", -3401, -5900, 1, 1, "06"),
    ]
    out = calibrate.training_table(pix_table(rows), excluded_days={date(2013, 1, 6)})
    assert out["v1"].sum() == 1.0


def test_training_table_can_compare_aqua_with_noaa20_instead_of_snpp():
    rows = [
        ("2018-06-05", "A", "D", -3401, -5900, 1, 1, "06"),
        ("2018-06-05", "N", "D", -3401, -5900, 1, 1, "06"),
        ("2018-06-05", "N20", "D", -3401, -5900, 2, 2, "06"),
        ("2018-06-05", "N20", "D", -3401, -5900, 2, 2, "06"),
    ]
    out = calibrate.training_table(pix_table(rows), excluded_days=set(), viirs_sat="N20")
    row = out.iloc[0]
    assert (row["m"], row["v1"], row["v2"], row["v3"], row["v_pix"]) == (1.0, 0.0, 1.0, 0.0, 2)


def test_freeze_noaa20_refits_the_frozen_method_on_2018_and_2019_and_runs_once(tmp_path):
    path = tmp_path / "calibration_noaa20.json"
    frozen = {"candidate": "C2", "m": 200}
    calibrate.freeze_noaa20(data=steady_data(range(2018, 2022)), frozen=frozen, path=path)
    written = json.loads(path.read_text())
    assert (written["candidate"], written["m"]) == ("C2", 200)
    assert written["train_years"] == [2018, 2019]
    assert written["model"]["train_years"] == [2018, 2019]
    assert written["model"]["national"]["DJF|D"] == pytest.approx(0.25)
    with pytest.raises(FileExistsError):
        calibrate.freeze_noaa20(data=steady_data(range(2018, 2022)), frozen=frozen, path=path)


def test_leave_one_year_out_never_fits_on_the_year_it_scores():
    # 2015 has twice the usual ratio. Held out honestly, every other year is predicted 14.3% high
    # and 2015 50% low, so the pooled median is 14.29%. A fit that saw the held-out year gives 12.5%.
    data = pd.concat([steady_data([y for y in range(2012, 2020) if y != 2015]),
                      agg([(2015, mth, "D", "B", prov, 200, 400, 0, 0) for mth in range(1, 13) for prov in ("06", "14")])])
    result = calibrate.loyo_scores(data=data, years=list(range(2012, 2020)))
    assert result["scores"]["C1"] == pytest.approx(100 / 7, abs=0.01)


def test_training_table_starts_when_the_viirs_satellite_starts():
    # Bug caught by the held-out test: NOAA-20 begins 2018-04-01, and Aqua's fire from
    # January to March 2018 was being counted with nothing on the NOAA-20 side.
    rows = [
        ("2018-02-10", "A", "D", -3401, -5900, 1, 1, "06"),
        ("2018-04-05", "A", "D", -3401, -5900, 1, 1, "06"),
        ("2018-04-05", "N20", "D", -3401, -5900, 1, 1, "06"),
    ]
    out = calibrate.training_table(pix_table(rows), excluded_days=set(), viirs_sat="N20")
    assert list(out["month"]) == [4]
    assert (out["m"].sum(), out["v1"].sum()) == (1.0, 1.0)
