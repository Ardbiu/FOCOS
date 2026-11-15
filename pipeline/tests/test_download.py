import pytest

from focos_pipeline import download


def test_yearly_urls_cover_modis_snpp_and_noaa20():
    items = download.yearly_urls()
    modis_years = sorted(y for s, y, _, _ in items if s == "modis")
    snpp_years = sorted(y for s, y, _, _ in items if s == "viirs-snpp")
    noaa20_years = sorted(y for s, y, _, _ in items if s == "viirs-jpss1")
    assert modis_years == list(range(2002, 2026))
    assert snpp_years == list(range(2012, 2026))
    assert noaa20_years == list(range(2018, 2026))
    assert len(items) == 46


def test_yearly_urls_use_the_exact_firms_patterns():
    urls = {(s, y): u for s, y, u, _ in download.yearly_urls()}
    assert urls[("modis", 2003)] == (
        "https://firms.modaps.eosdis.nasa.gov/data/country/modis/2003/modis_2003_Argentina.csv"
    )
    assert urls[("viirs-snpp", 2012)] == (
        "https://firms.modaps.eosdis.nasa.gov/data/country/viirs-snpp/2012/viirs-snpp_2012_Argentina.csv"
    )
    assert urls[("viirs-jpss1", 2018)] == (
        "https://firms.modaps.eosdis.nasa.gov/data/country/viirs-jpss1/2018/viirs-jpss1_2018_Argentina.csv"
    )


def test_local_paths_sit_under_the_raw_folder_by_sensor(tmp_path):
    paths = {(s, y): p for s, y, _, p in download.yearly_urls(raw_dir=tmp_path)}
    assert paths[("modis", 2003)] == tmp_path / "modis" / "modis_2003_Argentina.csv"
    assert paths[("viirs-snpp", 2025)] == tmp_path / "viirs-snpp" / "viirs-snpp_2025_Argentina.csv"


def test_an_existing_local_file_is_skipped(tmp_path):
    existing = tmp_path / "modis" / "modis_2003_Argentina.csv"
    existing.parent.mkdir(parents=True)
    existing.write_text("already here")
    fetched = []

    def fake_fetch(url, dest):
        fetched.append(url)
        dest.write_text("latitude,longitude\n")

    download.download_yearly(fetch=fake_fetch, raw_dir=tmp_path)

    assert len(fetched) == 45
    assert not any("modis_2003_" in u for u in fetched)
    assert existing.read_text() == "already here"


def test_a_failed_fetch_raises_an_error_naming_the_url(tmp_path):
    def failing_fetch(url, dest):
        raise OSError("connection reset")

    with pytest.raises(download.DownloadError) as err:
        download.download_yearly(fetch=failing_fetch, raw_dir=tmp_path)

    assert "modis_2002_Argentina.csv" in str(err.value)
    assert "https://firms.modaps.eosdis.nasa.gov" in str(err.value)


def test_a_failed_fetch_leaves_no_partial_file_behind(tmp_path):
    def half_fetch(url, dest):
        dest.write_text("half a file")
        raise OSError("timed out")

    with pytest.raises(download.DownloadError):
        download.download_yearly(fetch=half_fetch, raw_dir=tmp_path)

    assert list(tmp_path.rglob("*.csv")) == []
    assert list(tmp_path.rglob("*.part")) == []


def test_a_yearly_file_that_is_not_a_firms_csv_is_rejected(tmp_path):
    def error_body_fetch(url, dest):
        dest.write_text("<html>Service unavailable</html>")

    with pytest.raises(download.DownloadError) as err:
        download.download_yearly(fetch=error_body_fetch, raw_dir=tmp_path)
    assert "not a FIRMS CSV" in str(err.value)
    assert list(tmp_path.rglob("*.csv")) == []
