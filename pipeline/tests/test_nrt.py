from datetime import date

import duckdb
import pandas as pd
import pytest
from shapely.geometry import box

from focos_pipeline import clean, download

KEY = "abc123secretkey"


def test_api_url_matches_the_firms_area_pattern():
    url = download.api_url(KEY, "VIIRS_SNPP_NRT", date(2026, 1, 1), 5)
    assert url == (
        "https://firms.modaps.eosdis.nasa.gov/api/area/csv/abc123secretkey/VIIRS_SNPP_NRT/-74,-56,-53,-21/5/2026-01-01"
    )


def test_api_url_rejects_a_day_range_outside_one_to_five():
    with pytest.raises(ValueError):
        download.api_url(KEY, "VIIRS_SNPP_NRT", date(2026, 1, 1), 6)


def test_date_chunks_cover_the_span_with_no_gap_or_overlap():
    chunks = download.date_chunks(date(2026, 1, 1), date(2026, 11, 14))
    days = []
    for start, n in chunks:
        assert 1 <= n <= 5
        days += [start.toordinal() + i for i in range(n)]
    assert days == list(range(date(2026, 1, 1).toordinal(), date(2026, 11, 14).toordinal() + 1))
    assert chunks[0] == (date(2026, 1, 1), 5)
    assert chunks[-1][1] == 318 % 5 or chunks[-1][1] == 5


def test_availability_text_is_parsed_into_date_ranges():
    text = "data_id,min_date,max_date\nVIIRS_SNPP_SP,2012-01-20,2026-07-31\nVIIRS_SNPP_NRT,2026-08-01,2026-11-14\n"
    assert download.parse_availability(text) == {
        "VIIRS_SNPP_SP": (date(2012, 1, 20), date(2026, 7, 31)),
        "VIIRS_SNPP_NRT": (date(2026, 8, 1), date(2026, 11, 14)),
    }


def test_each_chunk_uses_the_standard_product_while_it_lasts_then_near_real_time():
    availability = {
        "VIIRS_SNPP_SP": (date(2012, 1, 20), date(2026, 1, 7)),
        "VIIRS_SNPP_NRT": (date(2026, 1, 8), date(2026, 1, 12)),
    }
    plan = download.plan_2026(availability, first=date(2026, 1, 1))
    assert plan == [
        ("VIIRS_SNPP_SP", date(2026, 1, 1), 5),
        ("VIIRS_SNPP_SP", date(2026, 1, 6), 2),
        ("VIIRS_SNPP_NRT", date(2026, 1, 8), 5),
    ]


def test_a_gap_between_the_two_products_is_reported():
    availability = {
        "VIIRS_SNPP_SP": (date(2012, 1, 20), date(2026, 1, 7)),
        "VIIRS_SNPP_NRT": (date(2026, 1, 10), date(2026, 1, 12)),
    }
    assert download.availability_gap(availability) == (date(2026, 1, 8), date(2026, 1, 9))
    availability["VIIRS_SNPP_NRT"] = (date(2026, 1, 8), date(2026, 1, 12))
    assert download.availability_gap(availability) is None


def test_download_2026_saves_one_file_per_chunk_and_skips_files_already_there(tmp_path):
    availability = {
        "VIIRS_SNPP_SP": (date(2012, 1, 20), date(2026, 1, 7)),
        "VIIRS_SNPP_NRT": (date(2026, 1, 8), date(2026, 1, 12)),
    }
    fetched = []

    def fake_fetch(url, dest):
        fetched.append(url)
        dest.write_text("latitude,longitude\n")

    download.download_2026(map_key=KEY, availability=availability, fetch=fake_fetch, raw_dir=tmp_path)
    download.download_2026(map_key=KEY, availability=availability, fetch=fake_fetch, raw_dir=tmp_path)

    names = sorted(p.name for p in (tmp_path / "viirs-snpp-2026").iterdir())
    assert names == [
        "VIIRS_SNPP_NRT_2026-01-08_5.csv",
        "VIIRS_SNPP_SP_2026-01-01_5.csv",
        "VIIRS_SNPP_SP_2026-01-06_2.csv",
    ]
    assert len(fetched) == 3
    assert all(KEY not in name for name in names)


def test_a_failed_api_fetch_never_shows_the_key(tmp_path):
    availability = {"VIIRS_SNPP_SP": (date(2012, 1, 20), date(2026, 1, 3)), "VIIRS_SNPP_NRT": (date(2026, 1, 4), date(2026, 1, 4))}

    def failing_fetch(url, dest):
        raise OSError(f"403 for {url}")

    with pytest.raises(download.DownloadError) as err:
        download.download_2026(map_key=KEY, availability=availability, fetch=failing_fetch, raw_dir=tmp_path)
    assert KEY not in str(err.value)
    assert "VIIRS_SNPP_SP" in str(err.value)


def test_the_map_key_comes_from_the_environment_or_the_env_file(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("# local secrets\nFIRMS_MAP_KEY=fromfile\n")
    assert download.load_map_key(env={"FIRMS_MAP_KEY": "fromenv"}, env_file=env_file) == "fromenv"
    assert download.load_map_key(env={}, env_file=env_file) == "fromfile"
    with pytest.raises(download.MissingMapKey):
        download.load_map_key(env={}, env_file=tmp_path / "missing.env")


def archive(rows):
    """Rows of (lat, lon, type, year)."""
    return duckdb.from_df(pd.DataFrame(rows, columns=["lat", "lon", "type", "year"]))


NATION = [{"id": "06", "name": "Test", "geom": box(-70.0, -40.0, -58.0, -30.0)}]


def api_rows(rows):
    """Rows of (lat, lon, has_type)."""
    return pd.DataFrame(rows, columns=["lat", "lon", "has_type"])


def test_a_near_real_time_row_in_a_masked_cell_is_dropped():
    mask = clean.static_mask(archive([(-38.505, -68.505, 2, 2018), (-38.505, -68.505, 2, 2019)]))
    out = clean.filter_api_rows(api_rows([(-38.505, -68.505, False), (-35.0, -65.0, False)]), mask, NATION)
    assert list(out["lat"]) == [-35.0]


def test_a_row_that_already_has_a_type_is_not_masked():
    mask = clean.static_mask(archive([(-38.505, -68.505, 2, 2018), (-38.505, -68.505, 2, 2019)]))
    out = clean.filter_api_rows(api_rows([(-38.505, -68.505, True)]), mask, NATION)
    assert len(out) == 1


def test_a_row_outside_the_national_polygon_is_dropped():
    out = clean.filter_api_rows(api_rows([(-25.0, -57.0, False), (-25.0, -57.0, True), (-35.0, -65.0, True)]), set(), NATION)
    assert list(out["lat"]) == [-35.0]


def test_plan_uses_the_standard_noaa20_product_when_it_reaches_the_handover_date():
    availability = {
        "VIIRS_NOAA20_SP": (date(2018, 4, 1), date(2026, 11, 3)),
        "VIIRS_NOAA20_NRT": (date(2026, 9, 1), date(2026, 11, 7)),
    }
    plan = download.plan_2026(availability, first=date(2026, 11, 1), sp_source="VIIRS_NOAA20_SP", nrt_source="VIIRS_NOAA20_NRT")
    assert plan == [
        ("VIIRS_NOAA20_SP", date(2026, 11, 1), 3),
        ("VIIRS_NOAA20_NRT", date(2026, 11, 4), 4),
    ]


def test_static_mask_is_a_cell_where_non_fire_rows_are_the_majority_in_two_years():
    rows = [
        (-38.505, -68.505, 2, 2018), (-38.505, -68.505, 2, 2019), (-38.505, -68.505, 0, 2019),  # a flare
        (-30.005, -60.005, 2, 2018), (-30.005, -60.005, 2, 2018),                               # one year only
        (-31.005, -61.005, 0, 2018), (-31.005, -61.005, 0, 2019),                               # vegetation fire
    ]
    mask = clean.static_mask(archive(rows))
    assert mask == {(-3851, -6851)}


def test_a_cell_where_vegetation_fires_outnumber_static_rows_is_not_masked():
    # Review finding: masking such cells dropped real fire from near-real-time months.
    rows = [(-38.505, -68.505, 2, 2018), (-38.505, -68.505, 2, 2019)]
    rows += [(-38.505, -68.505, 0, 2018 + i % 3) for i in range(5)]
    assert clean.static_mask(archive(rows)) == set()


def test_the_mask_does_not_spread_to_neighbouring_cells():
    mask = clean.static_mask(archive([(-38.505, -68.505, 3, 2018), (-38.505, -68.505, 1, 2020)]))
    out = clean.filter_api_rows(api_rows([(-38.495, -68.515, False)]), mask, NATION)
    assert len(out) == 1


def test_the_last_local_day_of_an_api_pull_is_dropped_because_it_may_be_partial():
    df = pd.DataFrame({
        "lat": [-35.0, -35.1, -35.2],
        "local_date": pd.to_datetime(["2026-11-03", "2026-11-04", "2026-11-04"]),
    })
    out = clean.drop_last_day(df)
    assert list(out["lat"]) == [-35.0]


def test_download_2026_pulls_snpp_noaa20_and_modis_for_the_whole_year(tmp_path):
    # Review finding: with S-NPP alone there is no second satellite to reveal a gap.
    availability = {
        "VIIRS_SNPP_SP": (date(2012, 1, 20), date(2026, 1, 3)),
        "VIIRS_SNPP_NRT": (date(2026, 1, 4), date(2026, 1, 4)),
        "VIIRS_NOAA20_NRT": (date(2025, 12, 1), date(2026, 1, 7)),
        "MODIS_NRT": (date(2025, 12, 1), date(2026, 1, 3)),
    }

    def fake_fetch(url, dest):
        dest.write_text("latitude,longitude\n")

    download.download_2026(map_key=KEY, availability=availability, fetch=fake_fetch, raw_dir=tmp_path)

    names = lambda folder: sorted(p.name for p in (tmp_path / folder).iterdir())
    assert names("viirs-snpp-2026") == ["VIIRS_SNPP_NRT_2026-01-04_1.csv", "VIIRS_SNPP_SP_2026-01-01_3.csv"]
    assert names("viirs-jpss1-2026") == ["VIIRS_NOAA20_NRT_2026-01-01_5.csv", "VIIRS_NOAA20_NRT_2026-01-06_2.csv"]
    assert names("modis-2026") == ["MODIS_NRT_2026-01-01_3.csv"]


def test_an_error_page_served_as_a_csv_is_rejected_not_cached(tmp_path):
    # Review finding: an error body sent with status 200 was saved and later read as zero fires.
    availability = {"VIIRS_SNPP_SP": (date(2012, 1, 20), date(2026, 1, 3))}

    def error_body_fetch(url, dest):
        dest.write_text("Invalid MAP_KEY.\n")

    with pytest.raises(download.DownloadError) as err:
        download.download_2026(map_key=KEY, availability=availability, fetch=error_body_fetch, raw_dir=tmp_path)
    assert "not a FIRMS CSV" in str(err.value)
    assert list(tmp_path.rglob("*.csv")) == [] and list(tmp_path.rglob("*.part")) == []


def test_a_csv_with_only_a_header_is_accepted_as_no_fires(tmp_path):
    availability = {"VIIRS_SNPP_SP": (date(2012, 1, 20), date(2026, 1, 3))}

    def empty_fetch(url, dest):
        dest.write_text("latitude,longitude,bright_ti4\n")

    paths = download.download_2026(map_key=KEY, availability=availability, fetch=empty_fetch, raw_dir=tmp_path)
    assert [p.name for p in paths] == ["VIIRS_SNPP_SP_2026-01-01_3.csv"]


def test_a_failed_availability_call_never_shows_the_key():
    # Review finding: requests errors carry the URL, and the URL carries the key.
    def failing_get(url, **kwargs):
        raise OSError(f"403 Client Error for url: {url}")

    with pytest.raises(download.DownloadError) as err:
        download.fetch_availability(KEY, get=failing_get)
    assert KEY not in str(err.value)
    assert err.value.__cause__ is None
