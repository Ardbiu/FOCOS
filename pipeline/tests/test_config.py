from datetime import date

from focos_pipeline import config


def test_month_idx_starts_at_january_2003():
    assert config.month_idx(2003, 1) == 0


def test_month_idx_of_november_2026_is_286():
    assert config.month_idx(2026, 11) == 286


def test_month_count_covers_2003_through_november_2026():
    assert config.MONTH_COUNT == 287


def test_cell_id_of_grid_origin_is_zero():
    assert config.cell_id(-56.0, -74.0) == 0


def test_cell_id_inside_first_cell_is_zero():
    assert config.cell_id(-55.96, -73.96) == 0


def test_cell_id_one_row_up_is_one_row_of_columns():
    assert config.cell_id(-55.94, -73.96) == 420


def test_cell_id_on_a_cell_boundary_belongs_to_the_upper_cell():
    # -55.95 is exactly one cell above the origin; float error must not pull it down.
    assert config.cell_id(-55.95, -74.0) == 420


def test_cell_id_outside_the_grid_is_none():
    assert config.cell_id(-20.0, -60.0) is None


def test_cell_id_on_the_far_edges_is_none():
    assert config.cell_id(-21.0, -60.0) is None
    assert config.cell_id(-40.0, -53.0) is None


def test_tile_id_uses_floor_of_latitude_and_longitude():
    assert config.tile_id(-34.6, -58.4) == "t_-35_-59"


def test_country_is_argentina():
    assert config.COUNTRY == "Argentina"


def test_region_block_holds_every_country_specific_value():
    assert set(config.REGION) == {"country", "bbox", "grid", "provinces_url"}
    assert config.REGION["bbox"] == {"west": -74.0, "south": -56.0, "east": -53.0, "north": -21.0}
    assert config.REGION["grid"] == {"lat0": -56.0, "lon0": -74.0, "cell": 0.05, "nlat": 700, "nlon": 420}


def test_series_and_calibration_constants():
    assert config.SERIES_START == date(2003, 1, 1)
    assert config.SWITCH_DATE == date(2012, 2, 1)
    assert config.TRAIN_YEARS == (2012, 2019)
    assert config.TEST_YEARS == (2020, 2021)
    assert config.MODIS_MIN_CONF == 30
    assert config.VIIRS_KEEP_CONF == ("n", "h")
    assert config.AQUA_OUTAGE_2020 == (date(2020, 8, 16), date(2020, 9, 2))


def test_noaa20_takes_over_in_november_2026_and_trains_on_2018_and_2019():
    assert config.SWITCH2_DATE == date(2026, 11, 1)
    assert config.NOAA20_TRAIN_YEARS == (2018, 2019)
