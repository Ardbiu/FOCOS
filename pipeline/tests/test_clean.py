from datetime import date, datetime

from focos_pipeline import clean

MODIS_HEADER = (
    "latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,"
    "instrument,confidence,version,bright_t31,frp,daynight,type"
)
VIIRS_HEADER = (
    "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,"
    "instrument,confidence,version,bright_ti5,frp,daynight,type"
)


def modis_row(lat=-34.5, lon=-60.0, day="2020-03-01", time="1745", sat="Aqua", conf=80, dn="D", typ=0):
    return f"{lat},{lon},330.1,1.0,1.0,{day},{time},{sat},MODIS,{conf},6.1,290.0,12.5,{dn},{typ}"


def viirs_row(lat=-34.5, lon=-60.0, day="2020-03-01", time="1745", sat="N", conf="n", dn="D", typ=0):
    return f"{lat},{lon},330.1,0.4,0.4,{day},{time},{sat},VIIRS,{conf},2,290.0,3.2,{dn},{typ}"


def write_csv(tmp_path, name, header, rows):
    path = tmp_path / name
    path.write_text("\n".join([header, *rows]) + "\n")
    return path


def cleaned(tmp_path, sensor, header, rows):
    path = write_csv(tmp_path, f"{sensor}.csv", header, rows)
    return clean.load_clean(sensor, files=[path]).df()


def test_local_date_shifts_back_when_local_time_is_before_midnight():
    assert clean.to_local_date(datetime(2020, 3, 1, 2, 30), -60.0) == date(2020, 2, 29)


def test_local_date_stays_on_the_same_day_in_the_afternoon():
    assert clean.to_local_date(datetime(2020, 3, 1, 17, 45), -60.0) == date(2020, 3, 1)


def test_cleaned_rows_carry_the_local_date_year_and_month(tmp_path):
    df = cleaned(tmp_path, "modis", MODIS_HEADER, [
        modis_row(day="2020-03-01", time="0230", dn="N"),
        modis_row(day="2020-03-01", time="1745"),
        modis_row(day="2020-01-01", time="0100", dn="N"),
    ]).sort_values("utc_dt")
    assert [d.isoformat() for d in df["local_date"].dt.date] == ["2019-12-31", "2020-02-29", "2020-03-01"]
    assert list(df["year"]) == [2019, 2020, 2020]
    assert list(df["month"]) == [12, 2, 3]


def test_modis_confidence_29_is_dropped_and_30_is_kept(tmp_path):
    df = cleaned(tmp_path, "modis", MODIS_HEADER, [
        modis_row(lat=-30.0, conf=29),
        modis_row(lat=-31.0, conf=30),
    ])
    assert list(df["lat"]) == [-31.0]


def test_viirs_low_confidence_is_dropped_and_nominal_and_high_are_kept(tmp_path):
    df = cleaned(tmp_path, "viirs-snpp", VIIRS_HEADER, [
        viirs_row(lat=-30.0, conf="l"),
        viirs_row(lat=-31.0, conf="n"),
        viirs_row(lat=-32.0, conf="h"),
    ])
    assert sorted(df["lat"]) == [-32.0, -31.0]
    assert sorted(df["conf_raw"]) == ["h", "n"]


def test_only_type_zero_is_kept(tmp_path):
    df = cleaned(tmp_path, "modis", MODIS_HEADER, [
        modis_row(lat=-30.0, typ=0),
        modis_row(lat=-31.0, typ=1),
        modis_row(lat=-32.0, typ=2),
        modis_row(lat=-33.0, typ=3),
    ])
    assert list(df["lat"]) == [-30.0]
    assert list(df["type"]) == [0]
    assert list(df["has_type"]) == [True]


def test_exact_duplicates_collapse_to_one_row(tmp_path):
    df = cleaned(tmp_path, "modis", MODIS_HEADER, [modis_row(), modis_row()])
    assert len(df) == 1


def test_modis_satellites_become_t_and_a(tmp_path):
    df = cleaned(tmp_path, "modis", MODIS_HEADER, [
        modis_row(lat=-30.0, sat="Terra"),
        modis_row(lat=-31.0, sat="Aqua"),
    ]).sort_values("lat", ascending=False)
    assert list(df["sat"]) == ["T", "A"]


def test_snpp_rows_are_n(tmp_path):
    df = cleaned(tmp_path, "viirs-snpp", VIIRS_HEADER, [viirs_row()])
    assert list(df["sat"]) == ["N"]


def test_rows_from_a_file_without_a_type_column_are_kept_and_flagged(tmp_path):
    header = VIIRS_HEADER.rsplit(",", 1)[0]
    row = viirs_row().rsplit(",", 1)[0]
    df = cleaned(tmp_path, "viirs-snpp", header, [row])
    assert len(df) == 1
    assert list(df["has_type"]) == [False]
    assert df["type"].isna().all()


def test_columns_are_exactly_the_contract(tmp_path):
    df = cleaned(tmp_path, "modis", MODIS_HEADER, [modis_row()])
    assert list(df.columns) == [
        "lat", "lon", "utc_dt", "local_date", "year", "month",
        "dn", "sat", "conf_raw", "frp", "has_type", "type",
    ]


def test_filter_counts_report_what_each_filter_dropped(tmp_path):
    path = write_csv(tmp_path, "modis.csv", MODIS_HEADER, [
        modis_row(lat=-30.0),
        modis_row(lat=-30.0),            # duplicate
        modis_row(lat=-31.0, typ=2),     # static source
        modis_row(lat=-32.0, conf=10),   # low confidence
        modis_row(lat=-33.0),
    ])
    counts = clean.filter_counts("modis", files=[path])
    assert counts == [{"year": 2020, "raw": 5, "bad_type": 1, "low_conf": 1, "duplicate": 1, "kept": 2}]


def test_noaa20_rows_keep_the_code_n20(tmp_path):
    df = cleaned(tmp_path, "viirs-jpss1", VIIRS_HEADER, [viirs_row(sat="N20")])
    assert list(df["sat"]) == ["N20"]
