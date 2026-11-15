from datetime import date

import duckdb
import pandas as pd

from focos_pipeline import fcp


def table(rows):
    """Rows of (lat, lon, local_date, dn, sat) as a DuckDB relation."""
    df = pd.DataFrame(rows, columns=["lat", "lon", "local_date", "dn", "sat"])
    df["local_date"] = pd.to_datetime(df["local_date"]).dt.date
    return duckdb.from_df(df)


def test_negative_coordinates_floor_toward_minus_infinity():
    df = fcp.add_fcp_keys(table([(-34.0049, -58.9951, "2020-01-01", "D", "A")])).df()
    assert (df["cell01_lat"][0], df["cell01_lon"][0]) == (-3401, -5900)


def test_a_coordinate_exactly_on_a_cell_edge_is_not_pulled_down_by_float_error():
    df = fcp.add_fcp_keys(table([(-34.01, -58.99, "2020-01-01", "D", "A")])).df()
    assert (df["cell01_lat"][0], df["cell01_lon"][0]) == (-3401, -5899)


def test_pixels_in_one_cell_date_and_daynight_collapse_into_one_fcp():
    rows = [(-34.001 - i * 0.001, -58.991, "2020-01-01", "D", "A") for i in range(4)]
    rows.append((-34.001, -58.991, "2020-01-01", "N", "A"))
    df = fcp.add_fcp_keys(table(rows)).df()
    assert df["fcp_id"].nunique() == 2
    assert sorted(df.groupby("fcp_id")["n_pix"].first()) == [1, 4]
    assert len(df) == 5


def test_the_same_cell_seen_by_two_sensors_is_two_fcps():
    rows = [
        (-34.001, -58.991, "2020-01-01", "D", "A"),
        (-34.001, -58.991, "2020-01-01", "D", "N"),
    ]
    df = fcp.add_fcp_keys(table(rows)).df()
    assert df["fcp_id"].nunique() == 2


def test_strength_class_is_1_for_one_pixel_2_for_two_or_three_and_3_for_four_or_more():
    rows = []
    for cell, n in enumerate([1, 3, 4]):
        rows += [(-30.001 - cell, -60.001 - i * 0.0001, "2020-01-01", "D", "N") for i in range(n)]
    df = fcp.add_fcp_keys(table(rows)).df()
    by_size = dict(df.groupby("n_pix")["strength"].first())
    assert by_size == {1: 1, 3: 2, 4: 3}


def test_fcp_counts_count_distinct_fcps_and_pixels_per_group():
    rows = [
        (-34.001, -58.991, "2020-01-01", "D", "A"),
        (-34.002, -58.991, "2020-01-01", "D", "A"),
        (-35.001, -58.991, "2020-01-02", "D", "A"),
        (-35.001, -58.991, "2020-01-02", "D", "N"),
    ]
    keyed = fcp.add_fcp_keys(table(rows))
    counts = fcp.fcp_counts(keyed, by=["sat"]).df().set_index("sat")
    assert counts.loc["A", "fcp"] == 2
    assert counts.loc["A", "pixels"] == 3
    assert counts.loc["N", "fcp"] == 1


def usual_days(n_days=20, aqua_per_day=10, snpp_per_day=30):
    """Ordinary days in January 2020: S-NPP sees three times what Aqua sees."""
    rows = []
    for d in range(1, n_days + 1):
        day = f"2020-01-{d:02d}"
        rows += [(-30.0 - i * 0.02, -60.0, day, "D", "A") for i in range(aqua_per_day)]
        rows += [(-30.0 - i * 0.02, -61.0, day, "D", "N") for i in range(snpp_per_day)]
    return rows


def silent_aqua_day(day, snpp_rows):
    return [(-30.0 - i * 0.02, -61.0, day, "D", "N") for i in range(snpp_rows)]


def test_a_sensor_silent_while_the_others_saw_plenty_of_fire_is_an_outage_day():
    # 60 S-NPP rows imply about 20 Aqua rows; zero is not believable.
    rows = usual_days() + silent_aqua_day("2020-01-25", 60)
    rows.append((-30.0, -60.0, "2020-01-28", "D", "A"))
    assert fcp.outage_days(table(rows), "A") == {date(2020, 1, 25)}


def test_a_sensor_silent_on_a_quiet_day_is_not_an_outage_day():
    # 6 S-NPP rows imply about 2 Aqua rows; zero is ordinary.
    rows = usual_days() + silent_aqua_day("2020-01-25", 6)
    rows.append((-30.0, -60.0, "2020-01-28", "D", "A"))
    assert fcp.outage_days(table(rows), "A") == set()


def test_a_day_when_no_satellite_saw_anything_is_not_an_outage_day():
    rows = usual_days(10)
    rows.append((-30.0, -60.0, "2020-01-15", "D", "A"))
    rows.append((-30.0, -61.0, "2020-01-15", "D", "N"))
    assert fcp.outage_days(table(rows), "A") == set()
    assert fcp.outage_days(table(rows), "N") == set()


def test_outage_days_stay_inside_the_sensors_own_date_span():
    # S-NPP has rows before Aqua's first day; those days are not Aqua outages.
    rows = silent_aqua_day("2019-12-20", 60) + usual_days()
    assert fcp.outage_days(table(rows), "A") == set()


def test_a_sensor_that_lost_its_daytime_pass_is_an_outage_day_even_if_it_saw_night_fires():
    # Review finding: S-NPP reported a few night pixels but nothing by day, while Aqua saw plenty by day.
    rows = usual_days()
    rows += [(-30.0 - i * 0.02, -60.0, "2020-01-25", "D", "A") for i in range(30)]
    rows += [(-30.0 - i * 0.02, -61.0, "2020-01-25", "N", "N") for i in range(5)]
    rows += usual_days(1, 10, 30)[:0]
    rows.append((-30.0, -61.0, "2020-01-28", "D", "N"))
    assert fcp.outage_days(table(rows), "N") == {date(2020, 1, 25)}


def test_night_fires_only_on_a_quiet_day_are_not_an_outage():
    rows = usual_days()
    rows += [(-30.0 - i * 0.02, -60.0, "2020-01-25", "D", "A") for i in range(2)]
    rows += [(-30.0 - i * 0.02, -61.0, "2020-01-25", "N", "N") for i in range(5)]
    rows.append((-30.0, -61.0, "2020-01-28", "D", "N"))
    assert fcp.outage_days(table(rows), "N") == set()
