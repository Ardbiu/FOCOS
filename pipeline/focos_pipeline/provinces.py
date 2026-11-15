"""Province boundaries (Georef, Argentine government) and point-in-province lookup."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import box, shape

from . import config

GEOREF_PATH = config.RAW_DIR / "georef" / "provincias.geojson"
NEAREST_TOLERANCE_DEG = 0.1  # about 10 km: covers gaps left by simplified borders


def download_provinces(path: Path | None = None) -> Path:
    """Fetch the Georef provinces file unless it is already on disk."""
    path = Path(path) if path is not None else GEOREF_PATH
    if path.exists() and path.stat().st_size > 0:
        return path
    import requests

    path.parent.mkdir(parents=True, exist_ok=True)
    response = requests.get(
        config.REGION["provinces_url"], timeout=120, headers={"User-Agent": "focos-pipeline"}
    )
    response.raise_for_status()
    path.write_bytes(response.content)
    return path


def load_provinces(path: Path | None = None) -> list[dict]:
    """Provinces as {id, name, geom}, geometry repaired and clipped to the grid box."""
    path = Path(path) if path is not None else GEOREF_PATH
    b = config.BBOX
    grid_box = box(b["west"], b["south"], b["east"], b["north"])
    out = []
    for feature in json.loads(path.read_text())["features"]:
        geom = shapely.make_valid(shape(feature["geometry"])).intersection(grid_box)
        if geom.is_empty:
            continue
        props = feature["properties"]
        out.append({"id": str(props["id"]), "name": props["nombre"], "geom": geom})
    return out


def assign(lons, lats, provinces: list[dict], tolerance: float = NEAREST_TOLERANCE_DEG) -> np.ndarray:
    """Province id for every point; None when no province is within `tolerance` degrees.

    A point inside a province gets that province (the first listed wins where
    simplified borders overlap). A point in a gap goes to the nearest province.
    """
    lons = np.asarray(lons, dtype=float)
    lats = np.asarray(lats, dtype=float)
    ids = np.full(len(lons), None, dtype=object)
    todo = np.ones(len(lons), dtype=bool)
    for province in provinces:
        geom = province["geom"]
        west, south, east, north = geom.bounds
        idx = np.flatnonzero(todo & (lons >= west) & (lons <= east) & (lats >= south) & (lats <= north))
        if idx.size == 0:
            continue
        shapely.prepare(geom)
        hit = idx[shapely.contains_xy(geom, lons[idx], lats[idx])]
        ids[hit] = province["id"]
        todo[hit] = False
    rest = np.flatnonzero(todo)
    if rest.size and tolerance > 0:  # tolerance 0 means strictly inside
        tree = shapely.STRtree([p["geom"] for p in provinces])
        point_idx, geom_idx = tree.query_nearest(
            shapely.points(lons[rest], lats[rest]), max_distance=tolerance, all_matches=False
        )
        for i, g in zip(point_idx, geom_idx):
            ids[rest[i]] = provinces[g]["id"]
    return ids
