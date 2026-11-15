"""Download NASA FIRMS yearly country files (no login needed).

Polite by design: one request at a time, and a file that already exists is
never fetched again.
"""
from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
from typing import Callable

from . import config

FIRMS_COUNTRY_BASE = "https://firms.modaps.eosdis.nasa.gov/data/country"
# sensor folder -> (first year, last year), inclusive
YEARLY_SOURCES = {"modis": (2002, 2025), "viirs-snpp": (2012, 2025), "viirs-jpss1": (2018, 2025)}
TIMEOUT_SECONDS = 60

Fetch = Callable[[str, Path], None]


class DownloadError(RuntimeError):
    """A file could not be fetched. The message names the URL."""


def yearly_urls(raw_dir: Path | None = None) -> list[tuple[str, int, str, Path]]:
    """Every yearly file as (sensor, year, url, local_path)."""
    raw_dir = Path(raw_dir) if raw_dir is not None else config.RAW_DIR
    items = []
    for sensor, (first, last) in YEARLY_SOURCES.items():
        for year in range(first, last + 1):
            name = f"{sensor}_{year}_{config.COUNTRY}.csv"
            url = f"{FIRMS_COUNTRY_BASE}/{sensor}/{year}/{name}"
            items.append((sensor, year, url, raw_dir / sensor / name))
    return items


def _check_csv(path: Path) -> None:
    """Refuse anything that is not a FIRMS CSV. An error page served with status 200
    would otherwise be cached and later read as "no fires"."""
    with open(path, "r", errors="replace") as handle:
        first = handle.readline().strip()
    if not first.lower().startswith("latitude,longitude"):
        raise ValueError(f"not a FIRMS CSV (starts with {first[:60]!r})")


def _http_fetch(url: str, dest: Path) -> None:
    import requests

    headers = {"User-Agent": "focos-pipeline"}
    with requests.get(url, stream=True, timeout=TIMEOUT_SECONDS, headers=headers) as response:
        response.raise_for_status()
        with open(dest, "wb") as out:
            for chunk in response.iter_content(chunk_size=1 << 20):
                out.write(chunk)


def download_yearly(fetch: Fetch = _http_fetch, raw_dir: Path | None = None) -> None:
    """Fetch every yearly file that is not already on disk, one at a time."""
    for sensor, year, url, path in yearly_urls(raw_dir):
        if path.exists() and path.stat().st_size > 0:
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        part = path.with_name(path.name + ".part")
        try:
            fetch(url, part)
            _check_csv(part)
        except Exception as exc:
            part.unlink(missing_ok=True)
            raise DownloadError(f"could not download {url}: {exc}") from exc
        part.rename(path)
        print(f"downloaded {sensor} {year}: {path.stat().st_size / 1e6:.1f} MB", flush=True)


# --- 2026: FIRMS API (needs a free MAP_KEY) ---------------------------------
FIRMS_API_BASE = "https://firms.modaps.eosdis.nasa.gov/api"
SP_SOURCE = "VIIRS_SNPP_SP"     # standard (science-quality) product
NRT_SOURCE = "VIIRS_SNPP_NRT"   # near real time
MAX_DAY_RANGE = 5
API_FOLDER = "viirs-snpp-2026"
# archive sensor -> folder for its API pulls
API_FOLDERS = {"viirs-snpp": "viirs-snpp-2026", "viirs-jpss1": "viirs-jpss1-2026", "modis": "modis-2026"}
MAP_KEY_NAME = "FIRMS_MAP_KEY"


class MissingMapKey(RuntimeError):
    """FIRMS_MAP_KEY is not set in the environment or the .env file."""


def load_map_key(env=None, env_file: Path | None = None) -> str:
    """The MAP_KEY from the environment, else from the git-ignored .env file."""
    import os

    env = os.environ if env is None else env
    if env.get(MAP_KEY_NAME):
        return env[MAP_KEY_NAME].strip()
    env_file = Path(env_file) if env_file is not None else config.REPO_DIR / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            name, _, value = line.partition("=")
            if name.strip() == MAP_KEY_NAME and value.strip():
                return value.strip().strip("'\"")
    raise MissingMapKey(f"{MAP_KEY_NAME} is not set. Put it in the environment or in {env_file}.")


def api_url(map_key: str, source: str, start: date, day_range: int) -> str:
    """Area query for `day_range` days starting at `start`, over the region's box."""
    if not 1 <= day_range <= MAX_DAY_RANGE:
        raise ValueError(f"day_range must be 1..{MAX_DAY_RANGE}, got {day_range}")
    b = config.BBOX
    area = ",".join(f"{b[k]:g}" for k in ("west", "south", "east", "north"))
    return f"{FIRMS_API_BASE}/area/csv/{map_key}/{source}/{area}/{day_range}/{start.isoformat()}"


def date_chunks(first: date, last: date, size: int = MAX_DAY_RANGE) -> list[tuple[date, int]]:
    """(start, n_days) pieces covering first..last inclusive, with no gap or overlap."""
    chunks = []
    start = first
    while start <= last:
        n = min(size, (last - start).days + 1)
        chunks.append((start, n))
        start += timedelta(days=n)
    return chunks


def parse_availability(text: str) -> dict[str, tuple[date, date]]:
    """The API's data_availability CSV as {source: (first date, last date)}."""
    out = {}
    lines = [line.strip() for line in text.strip().splitlines() if line.strip()]
    for line in lines[1:]:
        data_id, first, last = [part.strip() for part in line.split(",")[:3]]
        out[data_id] = (date.fromisoformat(first), date.fromisoformat(last))
    return out


def availability_gap(availability: dict) -> tuple[date, date] | None:
    """Dates covered by neither the standard nor the near-real-time product."""
    sp_last = availability[SP_SOURCE][1]
    nrt_first = availability[NRT_SOURCE][0]
    if nrt_first > sp_last + timedelta(days=1):
        return sp_last + timedelta(days=1), nrt_first - timedelta(days=1)
    return None


def plan_2026(availability: dict, first: date = date(2026, 1, 1),
              sp_source: str = SP_SOURCE, nrt_source: str = NRT_SOURCE) -> list[tuple[str, date, int]]:
    """(source, start, n_days) requests: the standard product while it lasts, then near real time.

    Either product may be missing from `availability`.
    """
    plan = []
    sp_last = availability[sp_source][1] if sp_source in availability else first - timedelta(days=1)
    if sp_last >= first:
        plan += [(sp_source, start, n) for start, n in date_chunks(first, sp_last)]
    if nrt_source in availability:
        nrt_first, nrt_last = availability[nrt_source]
        nrt_start = max(first, nrt_first, sp_last + timedelta(days=1))
        if nrt_last >= nrt_start:
            plan += [(nrt_source, start, n) for start, n in date_chunks(nrt_start, nrt_last)]
    return plan


# (archive sensor folder, standard product, near-real-time product, first date to pull).
# All three are pulled for the whole year: each satellite needs another one beside it,
# or an outage or a gap between products could not be seen.
API_SATELLITES = (
    ("viirs-snpp", SP_SOURCE, NRT_SOURCE, date(2026, 1, 1)),
    ("viirs-jpss1", "VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT", date(2026, 1, 1)),
    ("modis", "MODIS_SP", "MODIS_NRT", date(2026, 1, 1)),
)


def fetch_availability(map_key: str, get=None) -> dict:
    """Date coverage of every API source. Errors never carry the key."""
    if get is None:
        import requests

        get = requests.get
    try:
        response = get(
            f"{FIRMS_API_BASE}/data_availability/csv/{map_key}/all",
            timeout=TIMEOUT_SECONDS, headers={"User-Agent": "focos-pipeline"},
        )
        response.raise_for_status()
        return parse_availability(response.text)
    except Exception as exc:
        reason = str(exc).replace(map_key, "***")
        raise DownloadError(f"could not read FIRMS data availability: {reason}") from None


def download_2026(map_key: str | None = None, availability: dict | None = None,
                  fetch: Fetch = _http_fetch, raw_dir: Path | None = None) -> list[Path]:
    """Fetch 2026 detections in 5-day pieces: S-NPP from January, NOAA-20 from the
    handover date. Files never carry the key."""
    map_key = map_key or load_map_key()
    availability = availability if availability is not None else fetch_availability(map_key)
    raw_dir = Path(raw_dir) if raw_dir is not None else config.RAW_DIR
    paths = []
    for sensor, sp_source, nrt_source, first in API_SATELLITES:
        if sp_source not in availability and nrt_source not in availability:
            continue
        folder = raw_dir / API_FOLDERS[sensor]
        folder.mkdir(parents=True, exist_ok=True)
        for source, start, n in plan_2026(availability, first, sp_source, nrt_source):
            path = folder / f"{source}_{start.isoformat()}_{n}.csv"
            paths.append(path)
            if path.exists() and path.stat().st_size > 0:
                continue
            part = path.with_name(path.name + ".part")
            try:
                fetch(api_url(map_key, source, start, n), part)
                _check_csv(part)
            except Exception as exc:
                part.unlink(missing_ok=True)
                reason = str(exc).replace(map_key, "***")
                raise DownloadError(f"could not download {source} from {start} ({n} days): {reason}") from None
            part.rename(path)
    return paths
