import type { MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  CELL_COUNT,
  GRID,
  cellCenter,
  cellId,
  cellsInShape,
  circle,
  clipToCoverage,
  containsPoint,
  coverageOf,
  rectangle,
  shapeMatcher,
  tileId,
  tilesForShape,
  type Shape,
} from '../src/geo';

/** Every cell whose center passes the plain point-in-polygon test. Slow, used as the reference. */
function cellsByBruteForce(shape: Shape): number[] {
  const cells: number[] = [];
  for (let id = 0; id < CELL_COUNT; id++) {
    const { lat, lon } = cellCenter(id);
    if (containsPoint(shape, lon, lat)) cells.push(id);
  }
  return cells;
}

function bounds(shape: Shape) {
  const positions = (shape.type === 'Polygon' ? [shape.coordinates] : shape.coordinates).flat(2);
  const lons = positions.map((p) => p[0]);
  const lats = positions.map((p) => p[1]);
  return { west: Math.min(...lons), east: Math.max(...lons), south: Math.min(...lats), north: Math.max(...lats) };
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(a));
}

describe('grid constants and ids (plan section 5)', () => {
  it('pins the grid', () => {
    expect(GRID).toEqual({ lat0: -56.0, lon0: -74.0, cell: 0.05, nlat: 700, nlon: 420 });
    expect(CELL_COUNT).toBe(294000);
  });

  it('computes cell ids like the pipeline does', () => {
    expect(cellId(-56.0, -74.0)).toBe(0);
    expect(cellId(-55.96, -73.96)).toBe(0);
    expect(cellId(-55.94, -73.96)).toBe(420);
    expect(cellId(-20.0, -60.0)).toBeNull();
    expect(cellId(-56.01, -60.0)).toBeNull();
    expect(cellId(-40.0, -74.01)).toBeNull();
    expect(cellId(-40.0, -53.0)).toBeNull();
    expect(cellId(-21.01, -53.01)).toBe(699 * 420 + 419);
  });

  it('gives the center of a cell', () => {
    expect(cellCenter(0).lat).toBeCloseTo(-55.975, 9);
    expect(cellCenter(0).lon).toBeCloseTo(-73.975, 9);
    expect(cellCenter(421).lat).toBeCloseTo(-55.925, 9);
    expect(cellCenter(421).lon).toBeCloseTo(-73.925, 9);
    const { lat, lon } = cellCenter(123456);
    expect(cellId(lat, lon)).toBe(123456);
  });

  it('names point tiles by the floor of latitude and longitude', () => {
    expect(tileId(-34.6, -58.4)).toBe('t_-35_-59');
    expect(tileId(-35.0, -59.0)).toBe('t_-35_-59');
    expect(tileId(-34.0001, -58.0001)).toBe('t_-35_-59');
  });
});

describe('containsPoint', () => {
  const square = rectangle(-30, -60, -29, -59);

  it('tests a polygon', () => {
    expect(containsPoint(square, -59.5, -29.5)).toBe(true);
    expect(containsPoint(square, -58.9, -29.5)).toBe(false);
    expect(containsPoint(square, -59.5, -30.1)).toBe(false);
  });

  it('respects holes', () => {
    const ring: Polygon = {
      type: 'Polygon',
      coordinates: [square.coordinates[0], rectangle(-29.7, -59.7, -29.3, -59.3).coordinates[0]],
    };
    expect(containsPoint(ring, -59.5, -29.5)).toBe(false);
    expect(containsPoint(ring, -59.9, -29.5)).toBe(true);
  });

  it('tests every part of a multipolygon', () => {
    const two: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [square.coordinates, rectangle(-40, -70, -39, -69).coordinates],
    };
    expect(containsPoint(two, -59.5, -29.5)).toBe(true);
    expect(containsPoint(two, -69.5, -39.5)).toBe(true);
    expect(containsPoint(two, -65, -35)).toBe(false);
  });
});

describe('cellsInShape', () => {
  it('returns four cells for a rectangle covering exactly four cell centers', () => {
    const selection = cellsInShape(rectangle(-56.0, -74.0, -55.9, -73.9));
    expect(selection.cells).toBeInstanceOf(Uint32Array);
    expect(Array.from(selection.cells)).toEqual([0, 1, 420, 421]);
    expect(selection.tooSmall).toBe(false);
  });

  it('counts a cell only when its center is inside', () => {
    // Covers most of four cells but only one center (-39.975, -64.975).
    const selection = cellsInShape(rectangle(-39.99, -64.99, -39.93, -64.93));
    expect(Array.from(selection.cells)).toEqual([cellId(-39.975, -64.975)]);
    expect(selection.tooSmall).toBe(false);
  });

  it('returns the one cell containing the center of a shape smaller than a cell, flagged tooSmall', () => {
    // A 0.01 degree square that contains no cell center.
    const selection = cellsInShape(rectangle(-34.61, -58.41, -34.6, -58.4));
    expect(Array.from(selection.cells)).toEqual([cellId(-34.605, -58.405)]);
    expect(selection.tooSmall).toBe(true);
  });

  it('returns the cells a long thin shape passes through when it holds no cell center, flagged thin, not tooSmall', () => {
    // A strip 0.6° long and 0.006° wide, between two rows of cell centers (-30.025 and -29.975).
    const strip = rectangle(-29.998, -60.29, -29.992, -59.71);
    const selection = cellsInShape(strip);
    expect(selection.tooSmall).toBe(false);
    expect(selection.thin).toBe(true);
    const expected = Array.from({ length: 12 }, (_, k) => cellId(-29.995, -60.275 + k * 0.05)!);
    expect(Array.from(selection.cells)).toEqual(expected);
    // A diagonal sliver: every cell it passes through, and none it does not touch.
    const diagonal: Polygon = {
      type: 'Polygon',
      // On the line lat = lon + 30.325, which keeps 0.017° from every cell center.
      coordinates: [[[-60.29, -29.965], [-60.01, -29.685], [-60.01, -29.683], [-60.29, -29.963], [-60.29, -29.965]]],
    };
    const crossed = cellsInShape(diagonal);
    expect(crossed.thin).toBe(true);
    expect(crossed.cells.length).toBeGreaterThanOrEqual(6);
    expect(crossed.cells).toContain(cellId(-29.96, -60.28)!);
    expect(crossed.cells).toContain(cellId(-29.69, -60.02)!);
    expect(crossed.cells).not.toContain(cellId(-29.69, -60.28)!);
  });

  it('keeps a shape smaller than a cell in both directions as tooSmall, not thin', () => {
    const selection = cellsInShape(rectangle(-34.61, -58.41, -34.6, -58.4));
    expect(selection.thin).toBe(false);
  });

  it('takes the cells that the parts of a spread-out multipolygon touch, not a cell between them', () => {
    // Two specks 0.2° apart, neither holding a cell center. The cell midway lies in neither.
    const specks: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        rectangle(-34.61, -58.41, -34.6, -58.4).coordinates,
        rectangle(-34.61, -58.21, -34.6, -58.2).coordinates,
      ],
    };
    const selection = cellsInShape(specks);
    expect(selection.thin).toBe(true);
    expect(selection.tooSmall).toBe(false);
    expect(selection.cells).toContain(cellId(-34.605, -58.405)!);
    expect(selection.cells).toContain(cellId(-34.605, -58.205)!);
    expect(selection.cells).not.toContain(cellId(-34.605, -58.305)!);
  });

  it('returns nothing for a shape whose center is off the grid', () => {
    const selection = cellsInShape(rectangle(-10.01, -58.41, -10.0, -58.4));
    expect(selection.cells).toHaveLength(0);
    expect(selection.tooSmall).toBe(false);
  });

  it('ignores the parts of a shape that lie off the grid', () => {
    // One degree past the north-east corner of the grid: only the corner cell's block is on it.
    const selection = cellsInShape(rectangle(-21.1, -53.1, -20.0, -52.0));
    expect(Array.from(selection.cells)).toEqual([
      698 * 420 + 418,
      698 * 420 + 419,
      699 * 420 + 418,
      699 * 420 + 419,
    ]);
  });

  it('agrees with a plain point-in-polygon test on an irregular polygon', () => {
    const shape: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-65.85, -36.8],
          [-65.3, -36.9],
          [-65.1, -36.45],
          [-65.52, -36.52], // a notch, so the shape is concave
          [-65.35, -36.1],
          [-65.8, -36.2],
          [-65.85, -36.8],
        ],
      ],
    };
    const selection = cellsInShape(shape);
    expect(selection.cells.length).toBeGreaterThan(100);
    expect(Array.from(selection.cells)).toEqual(cellsByBruteForce(shape));
  });

  it('leaves out the cells in a hole and joins the parts of a multipolygon', () => {
    const outer = rectangle(-30, -60, -29, -59);
    const hole = rectangle(-29.7, -59.7, -29.3, -59.3);
    const withHole: Polygon = { type: 'Polygon', coordinates: [outer.coordinates[0], hole.coordinates[0]] };
    expect(cellsInShape(outer).cells).toHaveLength(400);
    expect(cellsInShape(withHole).cells).toHaveLength(400 - 64);

    const overlapping: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [outer.coordinates, rectangle(-29.5, -59.5, -28.5, -58.5).coordinates],
    };
    // 400 + 400 minus the 100 shared cells, each counted once, in ascending order.
    const cells = Array.from(cellsInShape(overlapping).cells);
    expect(cells).toHaveLength(700);
    expect(cells).toEqual([...cells].sort((a, b) => a - b));
    expect(new Set(cells).size).toBe(700);
  });
});

describe('circle', () => {
  const shape = circle(-31.4, -64.2, 25);

  it('is a closed ring whose points are all the radius away from the center', () => {
    const ring = shape.coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(ring.length).toBeGreaterThanOrEqual(65);
    for (const [lon, lat] of ring) expect(haversineKm(-31.4, -64.2, lat, lon)).toBeCloseTo(25, 3);
    expect(containsPoint(shape, -64.2, -31.4)).toBe(true);
  });

  it('selects about as many cells as its area holds', () => {
    const cellAreaKm2 = (0.05 * 111.195) ** 2 * Math.cos((31.4 * Math.PI) / 180);
    const expected = (Math.PI * 25 * 25) / cellAreaKm2;
    const { cells, tooSmall } = cellsInShape(shape);
    expect(tooSmall).toBe(false);
    expect(Math.abs(cells.length - expected)).toBeLessThan(0.1 * expected);
  });
});

describe('clipToCoverage', () => {
  it('reports a shape inside the grid box as inside and leaves it alone', () => {
    const shape = rectangle(-35, -60, -34, -59);
    const result = clipToCoverage(shape);
    expect(result.status).toBe('inside');
    expect(result.shape).toBe(shape);
  });

  it('reports a shape fully outside as outside', () => {
    const result = clipToCoverage(rectangle(10, 10, 11, 11));
    expect(result.status).toBe('outside');
    expect(result.shape).toBeNull();
  });

  it('clips a shape that is partly outside and says so', () => {
    // Half of this box is east of the grid's eastern edge (-53).
    const result = clipToCoverage(rectangle(-30, -54, -29, -52));
    expect(result.status).toBe('clipped');
    const box = bounds(result.shape!);
    expect(box.west).toBeCloseTo(-54, 9);
    expect(box.east).toBeCloseTo(-53, 9);
    expect(box.south).toBeCloseTo(-30, 9);
    expect(box.north).toBeCloseTo(-29, 9);
    expect(cellsInShape(result.shape!).cells).toHaveLength(20 * 20);
  });

  it('clips a circle that crosses the edge of the grid', () => {
    const result = clipToCoverage(circle(-21.1, -60, 50));
    expect(result.status).toBe('clipped');
    expect(bounds(result.shape!).north).toBeLessThanOrEqual(-21 + 1e-9);
  });

  describe('against the outline of the country', () => {
    const west = rectangle(-30, -60, -29, -59);
    const east = rectangle(-30, -57, -29, -56);
    const country = coverageOf([west, east]);

    it('reports inside, clipped and outside against the provinces rather than the box', () => {
      expect(clipToCoverage(rectangle(-29.8, -59.8, -29.2, -59.2), country).status).toBe('inside');
      // Between the two provinces: inside the grid box, but not in the country.
      const between = clipToCoverage(rectangle(-29.8, -58.8, -29.2, -57.2), country);
      expect(between.status).toBe('outside');
      expect(between.shape).toBeNull();
    });

    it('keeps only the part of a shape that lies in the country', () => {
      const result = clipToCoverage(rectangle(-29.8, -59.5, -29.2, -56.5), country);
      expect(result.status).toBe('clipped');
      expect(result.shape!.type).toBe('MultiPolygon');
      expect(containsPoint(result.shape!, -59.25, -29.5)).toBe(true);
      expect(containsPoint(result.shape!, -56.75, -29.5)).toBe(true);
      expect(containsPoint(result.shape!, -58.0, -29.5)).toBe(false);
      // 0.6 degrees tall, 0.5 degrees wide on each side: 12 x 10 cells, twice.
      expect(cellsInShape(result.shape!).cells).toHaveLength(240);
    });
  });
});

describe('coverageOf', () => {
  it('joins neighbouring provinces into one outline', () => {
    const outline = coverageOf([rectangle(-30, -60, -29, -59), rectangle(-30, -59, -29, -58)]);
    expect(outline.type).toBe('Polygon');
    expect(bounds(outline)).toEqual({ west: -60, east: -58, south: -30, north: -29 });
    // A shape across the shared border is inside, not clipped.
    expect(clipToCoverage(rectangle(-29.8, -59.5, -29.2, -58.5), outline).status).toBe('inside');
  });

  it('fills the slivers that simplified borders leave between provinces', () => {
    // Four provinces around a small gap in the middle.
    const outline = coverageOf([
      rectangle(-30, -60, -29, -59.01),
      rectangle(-30, -58.99, -29, -58),
      rectangle(-29.4, -59.01, -29, -58.99),
      rectangle(-30, -59.01, -29.6, -58.99),
    ]);
    expect(outline.type).toBe('Polygon');
    expect((outline as Polygon).coordinates).toHaveLength(1);
    expect(clipToCoverage(rectangle(-29.8, -59.5, -29.2, -58.5), outline).status).toBe('inside');
  });

  it('accepts a single province and a multipolygon province', () => {
    const one = rectangle(-30, -60, -29, -59);
    expect(coverageOf([one])).toEqual(one);
    const multi: MultiPolygon = { type: 'MultiPolygon', coordinates: [one.coordinates] };
    expect(clipToCoverage(rectangle(-29.8, -59.8, -29.2, -59.2), coverageOf([multi])).status).toBe('inside');
  });

  it('falls back to the grid box when there are no provinces', () => {
    expect(bounds(coverageOf([]))).toEqual({ west: -74, east: -53, south: -56, north: -21 });
  });
});

describe('tilesForShape', () => {
  it('returns 4 tiles for a 1.5 x 1.5 degree box aligned to whole degrees', () => {
    expect(tilesForShape(rectangle(-35.0, -60.0, -33.5, -58.5))).toEqual([
      't_-35_-60',
      't_-35_-59',
      't_-34_-60',
      't_-34_-59',
    ]);
  });

  it('returns 9 tiles for the same box shifted off the whole degrees', () => {
    const tiles = tilesForShape(rectangle(-35.25, -60.25, -33.75, -58.75));
    expect(tiles).toHaveLength(9);
    expect(tiles).toEqual([
      't_-36_-61',
      't_-36_-60',
      't_-36_-59',
      't_-35_-61',
      't_-35_-60',
      't_-35_-59',
      't_-34_-61',
      't_-34_-60',
      't_-34_-59',
    ]);
  });

  it('returns the one tile of a small shape', () => {
    expect(tilesForShape(rectangle(-34.7, -58.5, -34.5, -58.3))).toEqual(['t_-35_-59']);
    expect(tilesForShape(circle(-34.6, -58.4, 5))).toEqual(['t_-35_-59']);
  });

  it('skips tiles that the bounding box covers but the shape does not touch', () => {
    // A thin L: up the west side, then along the north side of a 3 x 3 tile bounding box.
    const corner: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-62.6, -39.5],
          [-62.4, -39.5],
          [-62.4, -37.6],
          [-60.5, -37.6],
          [-60.5, -37.4],
          [-62.6, -37.4],
          [-62.6, -39.5],
        ],
      ],
    };
    expect(tilesForShape(corner)).toEqual(['t_-40_-63', 't_-39_-63', 't_-38_-63', 't_-38_-62', 't_-38_-61']);
  });

  it('includes a tile that lies wholly inside the shape', () => {
    const tiles = tilesForShape(rectangle(-36.5, -61.5, -33.5, -58.5));
    expect(tiles).toHaveLength(16);
    expect(tiles).toContain('t_-35_-60');
  });
});

describe('shapeMatcher', () => {
  /** A seeded stream of positions in and around a box. */
  function positions(count: number, south: number, west: number, north: number, east: number): Array<[number, number]> {
    let seed = 42;
    const next = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    return Array.from({ length: count }, () => [west + next() * (east - west), south + next() * (north - south)]);
  }

  function agrees(shape: Shape, points: Array<[number, number]>): number {
    const matches = shapeMatcher(shape);
    let inside = 0;
    for (const [lon, lat] of points) {
      const expected = containsPoint(shape, lon, lat);
      if (matches(lon, lat) !== expected) throw new Error(`disagrees at ${lon}, ${lat}`);
      if (expected) inside++;
    }
    return inside;
  }

  it('gives the same answer as the plain point-in-polygon test for a rectangle', () => {
    const inside = agrees(rectangle(-35, -60, -34, -59), positions(5000, -35.5, -60.5, -33.5, -58.5));
    expect(inside).toBeGreaterThan(1000);
    expect(inside).toBeLessThan(1500);
  });

  it('agrees on a concave polygon with a hole, right up to its edges', () => {
    const shape: Polygon = {
      type: 'Polygon',
      coordinates: [
        [
          [-65.85, -36.8],
          [-65.3, -36.9],
          [-65.1, -36.45],
          [-65.52, -36.52],
          [-65.35, -36.1],
          [-65.8, -36.2],
          [-65.85, -36.8],
        ],
        rectangle(-36.7, -65.7, -36.6, -65.6).coordinates[0],
      ],
    };
    expect(agrees(shape, positions(20000, -37, -66, -36, -65))).toBeGreaterThan(3000);
  });

  it('agrees on a multipolygon and on an outline with thousands of points', () => {
    const two: MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [rectangle(-30, -60, -29, -59).coordinates, circle(-29.5, -57.5, 40, 2000).coordinates],
    };
    expect(agrees(two, positions(20000, -30.5, -60.5, -28.5, -56.5))).toBeGreaterThan(3000);
  });

  it('agrees on a shape smaller than a cell and on positions off the grid', () => {
    const speck = rectangle(-34.61, -58.41, -34.6, -58.4);
    expect(agrees(speck, positions(20000, -34.62, -58.42, -34.59, -58.39))).toBeGreaterThan(1000);
    const far = rectangle(-10, -40, -9, -39); // north-east of the grid
    expect(agrees(far, positions(2000, -10.5, -40.5, -8.5, -38.5))).toBeGreaterThan(300);
    const edge = rectangle(-22, -54, -20, -52); // across the grid's corner
    expect(agrees(edge, positions(5000, -22.5, -54.5, -19.5, -51.5))).toBeGreaterThan(1500);
  });

  it('answers a hundred thousand positions against a detailed outline quickly', () => {
    const outline = circle(-31.4, -64.2, 150, 4000);
    const points = positions(100000, -33.5, -66.5, -29.5, -62);
    const matches = shapeMatcher(outline);
    const started = performance.now();
    let inside = 0;
    for (const [lon, lat] of points) if (matches(lon, lat)) inside++;
    expect(performance.now() - started).toBeLessThan(1500);
    expect(inside).toBeGreaterThan(30000);
  });
});
