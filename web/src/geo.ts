// Geometry for area selection: the 0.05 degree grid, cell selection, clipping
// to the area the data covers, and point tiles. Pure functions, no fetching.
//
// Positions are GeoJSON order, [lon, lat], in degrees (WGS84).

import { feature, featureCollection } from '@turf/helpers';
import { intersect } from '@turf/intersect';
import { union } from '@turf/union';
import type { MultiPolygon, Polygon, Position } from 'geojson';

/** The grid of the data contract (plan section 5). loadMeta() checks meta.json against it. */
export const GRID = { lat0: -56.0, lon0: -74.0, cell: 0.05, nlat: 700, nlon: 420 } as const;
export const CELL_COUNT = GRID.nlat * GRID.nlon;

const GRID_NORTH = GRID.lat0 + GRID.nlat * GRID.cell;
const GRID_EAST = GRID.lon0 + GRID.nlon * GRID.cell;
const EARTH_RADIUS_KM = 6371.0088;
/** Tolerance, in cells, for a cell center that sits exactly on a shape's edge. */
const EDGE_EPSILON = 1e-9;

/** A selected area: a province, a drawn polygon or rectangle, or a circle turned into a polygon. */
export type Shape = Polygon | MultiPolygon;

/** `inside`: wholly covered. `clipped`: partly covered, cut to the covered part. `outside`: not covered. */
export type CoverageStatus = 'inside' | 'clipped' | 'outside';

export interface CellSelection {
  /** Ids of the grid cells that stand for the shape, ascending. */
  cells: Uint32Array;
  /**
   * True when the shape is smaller than one cell both ways, holds no cell
   * center, and the cell containing its center is used instead.
   */
  tooSmall: boolean;
  /**
   * True when the shape is longer than a cell but too narrow to hold a cell
   * center anywhere, and the cells its outline passes through are used instead.
   */
  thin: boolean;
}

export interface CoverageResult {
  /** The shape itself when `inside`, its covered part when `clipped`, `null` when `outside`. */
  shape: Shape | null;
  status: CoverageStatus;
}

// ---- Grid cells and tiles ------------------------------------------------------

/** The grid cell containing a position, or `null` when it is off the grid. */
export function cellId(lat: number, lon: number): number | null {
  const iLat = Math.floor((lat - GRID.lat0) / GRID.cell);
  const iLon = Math.floor((lon - GRID.lon0) / GRID.cell);
  if (iLat < 0 || iLat >= GRID.nlat || iLon < 0 || iLon >= GRID.nlon) return null;
  return iLat * GRID.nlon + iLon;
}

export function cellCenter(id: number): { lat: number; lon: number } {
  const iLat = Math.floor(id / GRID.nlon);
  const iLon = id % GRID.nlon;
  return { lat: GRID.lat0 + (iLat + 0.5) * GRID.cell, lon: GRID.lon0 + (iLon + 0.5) * GRID.cell };
}

/** The id of the 1 degree point tile containing a position, e.g. `t_-35_-59`. */
export function tileId(lat: number, lon: number): string {
  return `t_${Math.floor(lat)}_${Math.floor(lon)}`;
}

// ---- Building shapes -----------------------------------------------------------

export function rectangle(south: number, west: number, north: number, east: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  };
}

/** A circle on the sphere as a polygon of `steps` points, each `km` from the center. */
export function circle(lat: number, lon: number, km: number, steps = 128): Polygon {
  const rad = Math.PI / 180;
  const distance = km / EARTH_RADIUS_KM;
  const sinLat = Math.sin(lat * rad);
  const cosLat = Math.cos(lat * rad);
  const ring: Position[] = [];
  for (let i = 0; i < steps; i++) {
    const bearing = (-2 * Math.PI * i) / steps; // counter-clockwise, as GeoJSON wants outer rings
    const sinLat2 = sinLat * Math.cos(distance) + cosLat * Math.sin(distance) * Math.cos(bearing);
    const lon2 =
      lon * rad +
      Math.atan2(Math.sin(bearing) * Math.sin(distance) * cosLat, Math.cos(distance) - sinLat * sinLat2);
    ring.push([lon2 / rad, Math.asin(sinLat2) / rad]);
  }
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

// ---- Point in polygon ----------------------------------------------------------

function polygonsOf(shape: Shape): Position[][][] {
  return shape.type === 'Polygon' ? [shape.coordinates] : shape.coordinates;
}

/** Even-odd test over all rings of one polygon, so holes are outside. */
function polygonContains(rings: Position[][], lon: number, lat: number): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < xi + ((lat - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
    }
  }
  return inside;
}

export function containsPoint(shape: Shape, lon: number, lat: number): boolean {
  return polygonsOf(shape).some((rings) => polygonContains(rings, lon, lat));
}

interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Bounding box of one polygon (its outer ring), or of several polygons together. */
function boundsOf(...polygons: Position[][][]): Bounds {
  const box = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity };
  for (const rings of polygons) {
    for (const [lon, lat] of rings[0] ?? []) {
      if (lon < box.west) box.west = lon;
      if (lon > box.east) box.east = lon;
      if (lat < box.south) box.south = lat;
      if (lat > box.north) box.north = lat;
    }
  }
  return box;
}

// ---- Cell selection ------------------------------------------------------------

/**
 * The grid cells whose centers lie inside the shape (plan section 6.2).
 *
 * A shape that holds no cell center (smaller than a cell, or a thin sliver) is
 * stood for by the one cell containing the center of its bounding box, with
 * `tooSmall` set so the page can say so. Parts of a shape off the grid add nothing.
 */
export function cellsInShape(shape: Shape): CellSelection {
  const { lat0, lon0, cell, nlat, nlon } = GRID;
  const picked = new Uint8Array(CELL_COUNT);
  let count = 0;
  const crossings: number[] = [];

  for (const rings of polygonsOf(shape)) {
    const box = boundsOf(rings);
    // Rows of cell centers between the polygon's south and north edges.
    const firstRow = Math.max(0, Math.ceil((box.south - lat0) / cell - 0.5 - EDGE_EPSILON));
    const lastRow = Math.min(nlat - 1, Math.floor((box.north - lat0) / cell - 0.5 + EDGE_EPSILON));
    for (let row = firstRow; row <= lastRow; row++) {
      const lat = lat0 + (row + 0.5) * cell;
      // Where this row of centers crosses the polygon's edges; inside is between odd and even crossings.
      crossings.length = 0;
      for (const ring of rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [xi, yi] = ring[i];
          const [xj, yj] = ring[j];
          if (yi > lat !== yj > lat) crossings.push(xi + ((lat - yi) * (xj - xi)) / (yj - yi));
        }
      }
      crossings.sort((a, b) => a - b);
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        const firstCol = Math.max(0, Math.ceil((crossings[k] - lon0) / cell - 0.5 - EDGE_EPSILON));
        const lastCol = Math.min(nlon - 1, Math.floor((crossings[k + 1] - lon0) / cell - 0.5 + EDGE_EPSILON));
        for (let col = firstCol; col <= lastCol; col++) {
          const id = row * nlon + col;
          if (picked[id] === 0) {
            picked[id] = 1;
            count++;
          }
        }
      }
    }
  }

  if (count === 0) {
    const box = boundsOf(...polygonsOf(shape));
    if (box.east - box.west > cell || box.north - box.south > cell) {
      // Longer than a cell but narrower than the gap between two centers: the cells it passes through.
      count = cellsAlongOutline(shape, picked);
      if (count > 0) return { cells: pickedCells(picked, count), tooSmall: false, thin: true };
    }
    const center = cellId((box.south + box.north) / 2, (box.west + box.east) / 2);
    return center === null
      ? { cells: new Uint32Array(0), tooSmall: false, thin: false }
      : { cells: Uint32Array.of(center), tooSmall: true, thin: false };
  }

  return { cells: pickedCells(picked, count), tooSmall: false, thin: false };
}

/** The ids marked in `picked`, ascending. */
function pickedCells(picked: Uint8Array, count: number): Uint32Array {
  const cells = new Uint32Array(count);
  for (let id = 0, next = 0; next < count; id++) {
    if (picked[id] === 1) cells[next++] = id;
  }
  return cells;
}

/**
 * Marks in `picked` every grid cell that the outline of `shape` passes
 * through, walking each edge in steps of an eighth of a cell, and returns how
 * many cells were marked. A cell the edge only clips at a corner, for less
 * than a step, can be missed.
 */
function cellsAlongOutline(shape: Shape, picked: Uint8Array): number {
  const step = GRID.cell / 8;
  let count = 0;
  const mark = (lat: number, lon: number) => {
    const id = cellId(lat, lon);
    if (id !== null && picked[id] === 0) {
      picked[id] = 1;
      count++;
    }
  };
  for (const rings of polygonsOf(shape)) {
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i++) {
        const [x1, y1] = ring[i - 1];
        const [x2, y2] = ring[i];
        const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step));
        for (let k = 0; k <= steps; k++) mark(y1 + ((y2 - y1) * k) / steps, x1 + ((x2 - x1) * k) / steps);
      }
    }
  }
  return count;
}

/**
 * A fast test for many positions against one shape, with the same answers as
 * containsPoint(). Used to pick an area's hotspots out of whole point tiles.
 *
 * Every grid cell is sorted once: wholly inside, wholly outside, or crossed by
 * an edge. Only positions in a crossed cell (or off the grid) take the full
 * point-in-polygon test.
 */
export function shapeMatcher(shape: Shape): (lon: number, lat: number) => boolean {
  const { lat0, lon0, cell, nlat, nlon } = GRID;
  const OUTSIDE = 0;
  const INSIDE = 1;
  const CROSSED = 2;
  const kind = new Uint8Array(CELL_COUNT);

  const centers = cellsInShape(shape);
  // A stand-in cell (the center cell of a tiny shape, or a cell a thin shape crosses) is not wholly inside.
  if (!centers.tooSmall && !centers.thin) for (const id of centers.cells) kind[id] = INSIDE;

  // A cell that no edge's bounding box touches lies wholly on one side, so its center speaks for it.
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
  for (const rings of polygonsOf(shape)) {
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i++) {
        const [x1, y1] = ring[i - 1];
        const [x2, y2] = ring[i];
        const rowFrom = Math.floor((Math.min(y1, y2) - lat0) / cell);
        const rowTo = Math.floor((Math.max(y1, y2) - lat0) / cell);
        const colFrom = Math.floor((Math.min(x1, x2) - lon0) / cell);
        const colTo = Math.floor((Math.max(x1, x2) - lon0) / cell);
        if (rowTo < 0 || rowFrom >= nlat || colTo < 0 || colFrom >= nlon) continue;
        for (let row = clamp(rowFrom, nlat - 1); row <= clamp(rowTo, nlat - 1); row++) {
          for (let col = clamp(colFrom, nlon - 1); col <= clamp(colTo, nlon - 1); col++) {
            kind[row * nlon + col] = CROSSED;
          }
        }
      }
    }
  }

  return (lon, lat) => {
    const id = cellId(lat, lon);
    if (id === null || kind[id] === CROSSED) return containsPoint(shape, lon, lat);
    return kind[id] !== OUTSIDE;
  };
}

// ---- Coverage ------------------------------------------------------------------

const GRID_BOX = rectangle(GRID.lat0, GRID.lon0, GRID_NORTH, GRID_EAST);

/** Area in square degrees. Only used to compare a shape with a part of itself. */
function planarArea(shape: Shape): number {
  let total = 0;
  for (const rings of polygonsOf(shape)) {
    rings.forEach((ring, ringIndex) => {
      let twice = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        twice += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      }
      total += ((ringIndex === 0 ? 1 : -1) * Math.abs(twice)) / 2;
    });
  }
  return total;
}

/**
 * The outline of the country: the provinces joined into one shape.
 *
 * Simplified province borders leave slivers between neighbours. Those show up
 * as holes in the joined shape and are filled, so a shape drawn across a
 * provincial border is not reported as partly outside. With no provinces the
 * grid box is returned.
 */
export function coverageOf(provinces: Shape[]): Shape {
  if (provinces.length === 0) return GRID_BOX;
  const joined =
    provinces.length === 1 ? provinces[0] : union(featureCollection(provinces.map((p) => feature(p))))?.geometry;
  if (!joined) return GRID_BOX;
  const outerRings = polygonsOf(joined).map((rings) => [rings[0]]);
  return outerRings.length === 1
    ? { type: 'Polygon', coordinates: outerRings[0] }
    : { type: 'MultiPolygon', coordinates: outerRings };
}

/**
 * Cuts a shape to the area the data covers and says what happened.
 *
 * `coverage` is the country outline from coverageOf(). Without it the grid box
 * is used, which also holds sea and neighbouring countries where the data is
 * empty, so pass the outline whenever the provinces are loaded.
 */
export function clipToCoverage(shape: Shape, coverage: Shape = GRID_BOX): CoverageResult {
  const covered = intersect(featureCollection([feature(shape), feature(coverage)]));
  if (!covered) return { shape: null, status: 'outside' };
  const whole = planarArea(shape);
  if (whole > 0 && planarArea(covered.geometry) >= whole * (1 - 1e-9)) return { shape, status: 'inside' };
  return { shape: covered.geometry, status: 'clipped' };
}

// ---- Point tiles ---------------------------------------------------------------

/** Does the segment a-b pass through the closed rectangle? (Liang-Barsky clipping.) */
function segmentTouchesBox(a: Position, b: Position, box: Bounds): boolean {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let enter = 0;
  let leave = 1;
  const edges: Array<[number, number]> = [
    [-dx, a[0] - box.west],
    [dx, box.east - a[0]],
    [-dy, a[1] - box.south],
    [dy, box.north - a[1]],
  ];
  for (const [direction, room] of edges) {
    if (direction === 0) {
      if (room < 0) return false;
    } else {
      const t = room / direction;
      if (direction < 0) enter = Math.max(enter, t);
      else leave = Math.min(leave, t);
      if (enter > leave) return false;
    }
  }
  return true;
}

function polygonTouchesBox(rings: Position[][], box: Bounds): boolean {
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      if (segmentTouchesBox(ring[i - 1], ring[i], box)) return true;
    }
  }
  // No edge passes through the box, so the box is wholly inside or wholly outside.
  return polygonContains(rings, (box.west + box.east) / 2, (box.south + box.north) / 2);
}

/**
 * Ids of the 1 degree point tiles the shape touches, south to north, then west
 * to east. A tile that only shares an edge with the shape's bounding box is not
 * counted. The list can name tiles that hold no hotspots; compare with
 * `meta.tiles` before fetching.
 */
export function tilesForShape(shape: Shape): string[] {
  const tiles = new Set<string>();
  for (const rings of polygonsOf(shape)) {
    const box = boundsOf(rings);
    if (!(box.west <= box.east)) continue; // an empty ring
    const firstLat = Math.floor(box.south);
    const lastLat = Math.max(firstLat, Math.ceil(box.north) - 1);
    const firstLon = Math.floor(box.west);
    const lastLon = Math.max(firstLon, Math.ceil(box.east) - 1);
    for (let lat = firstLat; lat <= lastLat; lat++) {
      for (let lon = firstLon; lon <= lastLon; lon++) {
        const tile = { west: lon, south: lat, east: lon + 1, north: lat + 1 };
        if (polygonTouchesBox(rings, tile)) tiles.add(`${lat}:${lon}`);
      }
    }
  }
  return [...tiles]
    .map((key) => key.split(':').map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([lat, lon]) => `t_${lat}_${lon}`);
}
