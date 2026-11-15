"""Every constant from sections 4 and 5 of the plan, in one place.

Country-specific values live in REGION so the pipeline can be pointed at
another FIRMS country file by editing one block.
"""
from __future__ import annotations

import math
from datetime import date
from pathlib import Path

# --- Region: the only country-specific block -------------------------------
REGION = {
    "country": "Argentina",
    "bbox": {"west": -74.0, "south": -56.0, "east": -53.0, "north": -21.0},
    "grid": {"lat0": -56.0, "lon0": -74.0, "cell": 0.05, "nlat": 700, "nlon": 420},
    "provinces_url": "https://apis.datos.gob.ar/georef/api/v2.0/provincias.geojson",
}

COUNTRY = REGION["country"]
BBOX = REGION["bbox"]
GRID = REGION["grid"]

# --- Series and calibration -------------------------------------------------
SERIES_START = date(2003, 1, 1)   # the calendar starts here
SWITCH_DATE = date(2012, 2, 1)    # first local date carried by S-NPP VIIRS
SWITCH2_DATE = date(2026, 11, 1)  # first local date carried by NOAA-20 VIIRS (S-NPP ended 2026-11-02)
NOAA20_TRAIN_YEARS = (2018, 2019) # inclusive: stable years Aqua and NOAA-20 both flew
TRAIN_YEARS = (2012, 2019)        # inclusive
TEST_YEARS = (2020, 2021)         # inclusive, opened once after the freeze
MODIS_MIN_CONF = 30
VIIRS_KEEP_CONF = ("n", "h")
AQUA_OUTAGE_2020 = (date(2020, 8, 16), date(2020, 9, 2))  # inclusive

# --- Calendar ---------------------------------------------------------------
CALENDAR_END = (2026, 11)
MONTH_COUNT = (CALENDAR_END[0] - SERIES_START.year) * 12 + CALENDAR_END[1]

# --- Paths --------------------------------------------------------------------
PIPELINE_DIR = Path(__file__).resolve().parents[1]
REPO_DIR = PIPELINE_DIR.parent
RAW_DIR = PIPELINE_DIR / "data" / "raw"
WORK_DIR = PIPELINE_DIR / "data" / "work"
WEB_DATA_DIR = REPO_DIR / "web" / "public" / "data"


def month_idx(year: int, month: int) -> int:
    """Months since January 2003 (January 2003 is 0)."""
    return (year - SERIES_START.year) * 12 + (month - 1)


def _grid_index(value: float, origin: float) -> int:
    # Round before flooring so a coordinate sitting exactly on a cell edge
    # (-55.95) is not pulled into the cell below by float error.
    return math.floor(round((value - origin) / GRID["cell"], 6))


def cell_id(lat: float, lon: float) -> int | None:
    """Grid cell holding (lat, lon), or None when the point is outside the grid."""
    i_lat = _grid_index(lat, GRID["lat0"])
    i_lon = _grid_index(lon, GRID["lon0"])
    if not (0 <= i_lat < GRID["nlat"] and 0 <= i_lon < GRID["nlon"]):
        return None
    return i_lat * GRID["nlon"] + i_lon


def tile_id(lat: float, lon: float) -> str:
    """Id of the 1-degree point tile holding (lat, lon)."""
    return f"t_{math.floor(lat)}_{math.floor(lon)}"
