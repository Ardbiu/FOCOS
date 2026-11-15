import { gzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSample } from '../scripts/make-sample-data.mjs';
import {
  CONF_HIGH,
  CONF_NOMINAL,
  DataError,
  SAT_AQUA,
  SAT_NOAA20,
  SAT_SNPP,
  clearDataCache,
  confidenceText,
  dayNumber,
  decodeGrid,
  isoDate,
  loadGrid,
  loadMeta,
  loadMtd,
  loadProvinceShapes,
  loadProvinces,
  loadRawGrid,
  loadTile,
  loadValidation,
  mtdForCells,
  parseTile,
  satCode,
  satelliteName,
  seriesForCells,
  setFetchTimeout,
  type Meta,
} from '../src/data';
import { cellsInShape, rectangle, tileId } from '../src/geo';

// ---- A tiny static file server behind fetch --------------------------------------

type Served = Uint8Array | string | { status: number } | Error;
// Files are requested relative to the site base. Vitest always runs with base "/";
// the build uses "/FOCOS/" (checked on vite.config.ts in the smoke test).
const DATA_PREFIX = `${import.meta.env.BASE_URL}data/`;
let served: Map<string, Served>;
let requests: string[];

beforeEach(() => {
  clearDataCache();
  served = new Map();
  requests = [];
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    requests.push(url);
    const item = url.startsWith(DATA_PREFIX) ? served.get(url.slice(DATA_PREFIX.length)) : undefined;
    if (item === undefined) return new Response('not found', { status: 404 });
    if (item instanceof Error) throw item;
    if (typeof item === 'object' && 'status' in item) return new Response('', { status: item.status });
    return new Response(item as BodyInit);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const requestsFor = (path: string) => requests.filter((url) => url === DATA_PREFIX + path).length;

// ---- Fixtures --------------------------------------------------------------------

type Triple = [cell: number, value: number, index: number];

/** Section 5 layout: uint32 N, N x uint32 cell_id, N x float32 value, N x uint16 index. */
function gridBytes(triples: Triple[]): Uint8Array {
  const n = triples.length;
  const view = new DataView(new ArrayBuffer(4 + 10 * n));
  view.setUint32(0, n, true);
  triples.forEach(([cell, value, index], i) => {
    view.setUint32(4 + 4 * i, cell, true);
    view.setFloat32(4 + 4 * n + 4 * i, value, true);
    view.setUint16(4 + 8 * n + 2 * i, index, true);
  });
  return new Uint8Array(view.buffer);
}

const gz = (bytes: Uint8Array | string) =>
  gzipSync(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);

const META: Meta = {
  version: 1,
  generated_utc: '2026-11-13T02:00:00Z',
  country: 'Argentina',
  data_end_date: '2026-11-14',
  switch_month: '2012-02',
  grid: { lat0: -56.0, lon0: -74.0, cell: 0.05, nlat: 700, nlon: 420 },
  month_count: 287,
  calibration: { candidate: 'C2', train_years: [2012, 2019], test_years: [2020, 2021] },
  typical_error_pct: 18.4,
  naive_error_pct: 310.0,
  incomplete_months: [{ month_idx: 120, coverage: 0.71, sensor: 'A' }],
  tiles: ['t_-35_-59'],
  mtd: { month: 11, last_day: 14 },
};

const TILE_CSV = [
  'lat,lon,date,dn,sat,conf,frp,s,w',
  '-34.60012,-58.40034,2011-08-15,D,A,67,23.4,1,0.5000',
  '-34.12345,-58.99999,2020-01-31,N,N,n,3.1,1,0.2050',
  '-34.50000,-58.50000,2012-01-25,D,N,h,12.0,0,0.0000',
  '',
].join('\n');

// ---- Tests -----------------------------------------------------------------------

describe('decodeGrid', () => {
  it('decodes the binary grid to known triples', () => {
    const grid = decodeGrid(
      gridBytes([
        [5, 1.5, 0],
        [421, 0.25, 109],
        [293999, 1234.5, 286],
      ]),
    );
    expect(grid.count).toBe(3);
    expect(Array.from(grid.cells)).toEqual([5, 421, 293999]);
    expect(Array.from(grid.values)).toEqual([1.5, 0.25, 1234.5]);
    expect(Array.from(grid.index)).toEqual([0, 109, 286]);
    expect(grid.cells).toBeInstanceOf(Uint32Array);
    expect(grid.values).toBeInstanceOf(Float32Array);
    expect(grid.index).toBeInstanceOf(Uint16Array);
  });

  it('reads the exact little-endian byte layout of section 5', () => {
    // N = 1 | cell 42 | value 1.5 (0x3FC00000) | month_idx 109
    const bytes = Uint8Array.of(1, 0, 0, 0, 42, 0, 0, 0, 0x00, 0x00, 0xc0, 0x3f, 109, 0);
    const grid = decodeGrid(bytes);
    expect([grid.count, grid.cells[0], grid.values[0], grid.index[0]]).toEqual([1, 42, 1.5, 109]);
  });

  it('decodes a view into a larger buffer', () => {
    const padded = new Uint8Array(3 + 14);
    padded.set(gridBytes([[7, 2.5, 3]]), 3);
    const grid = decodeGrid(padded.subarray(3));
    expect([grid.cells[0], grid.values[0], grid.index[0]]).toEqual([7, 2.5, 3]);
  });

  it('decodes an empty grid', () => {
    const grid = decodeGrid(gridBytes([]));
    expect(grid.count).toBe(0);
    expect(grid.cells).toHaveLength(0);
  });

  it('rejects bytes whose length does not match the count', () => {
    const bytes = gridBytes([[5, 1.5, 0]]);
    expect(() => decodeGrid(bytes.subarray(0, 13))).toThrow(DataError);
    expect(() => decodeGrid(Uint8Array.of(1, 2))).toThrow(DataError);
  });
});

describe('grid loaders', () => {
  it('loadGrid, loadRawGrid and loadMtd each fetch and gunzip their own file', async () => {
    served.set('grid/monthly.bin.gz', gz(gridBytes([[10, 1.5, 0]])));
    served.set('grid/raw.bin.gz', gz(gridBytes([[10, 6, 0]])));
    served.set('grid/mtd.bin.gz', gz(gridBytes([[10, 0.75, 23]])));
    expect(Array.from((await loadGrid()).values)).toEqual([1.5]);
    expect(Array.from((await loadRawGrid()).values)).toEqual([6]);
    const mtd = await loadMtd();
    expect([mtd.cells[0], mtd.values[0], mtd.index[0]]).toEqual([10, 0.75, 23]);
    expect(DATA_PREFIX).toBe('/data/');
    expect(requests).toEqual(['/data/grid/monthly.bin.gz', '/data/grid/raw.bin.gz', '/data/grid/mtd.bin.gz']);
  });

  it('also reads a file the server has already decompressed', async () => {
    served.set('grid/monthly.bin.gz', gridBytes([[10, 1.5, 0]]));
    expect(Array.from((await loadGrid()).cells)).toEqual([10]);
  });

  it('fetches each file once', async () => {
    served.set('grid/monthly.bin.gz', gz(gridBytes([[10, 1.5, 0]])));
    const [first, second] = await Promise.all([loadGrid(), loadGrid()]);
    expect(await loadGrid()).toBe(first);
    expect(second).toBe(first);
    expect(requestsFor('grid/monthly.bin.gz')).toBe(1);
  });

  it('names the file when a grid is missing or malformed', async () => {
    await expect(loadGrid()).rejects.toThrow(/grid\/monthly\.bin\.gz.*404/);
    served.set('grid/raw.bin.gz', gz('<!doctype html><title>Focos</title>'));
    await expect(loadRawGrid()).rejects.toThrow(/grid\/raw\.bin\.gz/);
  });
});

describe('JSON loaders', () => {
  it('loadMeta returns meta.json', async () => {
    served.set('meta.json', JSON.stringify(META));
    const meta = await loadMeta();
    expect(meta).toEqual(META);
    expect(requests).toEqual([`${DATA_PREFIX}meta.json`]);
  });

  it('loadMeta refuses a grid or month count other than the contract', async () => {
    served.set('meta.json', JSON.stringify({ ...META, grid: { ...META.grid, cell: 0.1 } }));
    await expect(loadMeta()).rejects.toThrow(/meta\.json.*grid/);
    clearDataCache();
    served.set('meta.json', JSON.stringify({ ...META, month_count: 288 }));
    await expect(loadMeta()).rejects.toThrow(/meta\.json.*month_count/);
  });

  it('loadMeta reports a response that is not JSON', async () => {
    served.set('meta.json', '<!doctype html><title>Focos</title>');
    const error = await loadMeta().catch((e) => e);
    expect(error).toBeInstanceOf(DataError);
    expect(error.kind).toBe('format');
    expect(error.file).toBe('meta.json');
  });

  it('loadProvinces returns the areas, nation first', async () => {
    const areas = [
      { id: 'AR', name: 'Argentina', monthly: [1, 2], raw: [3, 4], mtd: [5] },
      { id: '06', name: 'Buenos Aires', monthly: [1, 1], raw: [2, 2], mtd: [] },
    ];
    served.set('summary/provinces.json', JSON.stringify({ areas }));
    expect(await loadProvinces()).toEqual(areas);
    expect(requests).toEqual([`${DATA_PREFIX}summary/provinces.json`]);
  });

  it('loadProvinces refuses a summary that does not start with the nation', async () => {
    served.set('summary/provinces.json', JSON.stringify({ areas: [{ id: '06', name: 'Buenos Aires' }] }));
    await expect(loadProvinces()).rejects.toThrow(/summary\/provinces\.json/);
  });

  it('loadMeta keeps the optional list of series carriers', async () => {
    const series = [
      { sat: 'A', name: 'Aqua MODIS', from: '2003-01', to: '2012-01', typical_error_pct: null },
      { sat: 'N', name: 'S-NPP VIIRS', from: '2012-02', to: null, typical_error_pct: 17.3 },
    ];
    served.set('meta.json', JSON.stringify({ ...META, series }));
    expect((await loadMeta()).series).toEqual(series);
    clearDataCache();
    served.set('meta.json', JSON.stringify(META));
    expect((await loadMeta()).series).toBeUndefined();
  });

  it('loadProvinceShapes and loadValidation return their files', async () => {
    const shapes = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { id: '06', name: 'Buenos Aires' },
          geometry: { type: 'Polygon', coordinates: [[[-60, -35], [-59, -35], [-59, -34], [-60, -35]]] },
        },
      ],
    };
    served.set('provinces.geojson', JSON.stringify(shapes));
    served.set('validation.json', '{}');
    expect(await loadProvinceShapes()).toEqual(shapes);
    expect(await loadValidation()).toEqual({});
  });

  it('does not remember a failure, so a retry can succeed', async () => {
    served.set('meta.json', { status: 503 });
    await expect(loadMeta()).rejects.toThrow(/meta\.json.*503/);
    served.set('meta.json', JSON.stringify(META));
    expect((await loadMeta()).version).toBe(1);
    expect(requestsFor('meta.json')).toBe(2);
  });
});

describe('point tiles', () => {
  it('parses the pinned columns into typed columns', () => {
    const tile = parseTile('t_-35_-59', TILE_CSV);
    expect(tile.id).toBe('t_-35_-59');
    expect(tile.count).toBe(3);
    expect(Array.from(tile.lat)).toEqual([-34.60012, -34.12345, -34.5]);
    expect(Array.from(tile.lon)).toEqual([-58.40034, -58.99999, -58.5]);
    expect(Array.from(tile.day).map(isoDate)).toEqual(['2011-08-15', '2020-01-31', '2012-01-25']);
    expect(Array.from(tile.night)).toEqual([0, 1, 0]);
    expect(Array.from(tile.sat)).toEqual([SAT_AQUA, SAT_SNPP, SAT_SNPP]);
    expect(Array.from(tile.conf)).toEqual([67, CONF_NOMINAL, CONF_HIGH]);
    expect(Array.from(tile.conf).map(confidenceText)).toEqual(['67', 'n', 'h']);
    expect(Array.from(tile.frp).map((v) => v.toFixed(1))).toEqual(['23.4', '3.1', '12.0']);
    expect(Array.from(tile.s)).toEqual([1, 1, 0]);
    expect(Array.from(tile.w).map((v) => v.toFixed(4))).toEqual(['0.5000', '0.2050', '0.0000']);
  });

  it('reads NOAA-20 rows and never fails on a satellite code it does not know', () => {
    const csv = [
      'lat,lon,date,dn,sat,conf,frp,s,w',
      '-34.60012,-58.40034,2011-08-15,D,A,67,23.4,1,0.500000',
      '-34.12345,-58.99999,2020-01-31,N,N,n,3.1,1,0.205000',
      '-34.50000,-58.50000,2026-11-01,D,N20,h,12.0,1,0.183333',
      '-34.50000,-58.50000,2027-01-01,D,X9,n,1.0,0,0.000000',
      '-34.50000,-58.50000,2027-01-02,D,N20,n,1.0,1,0.400000',
    ].join('\n');
    const tile = parseTile('t_-35_-59', csv);
    expect(tile.count).toBe(5);
    expect(Array.from(tile.sat).map(satCode)).toEqual(['A', 'N', 'N20', 'X9', 'N20']);
    expect([tile.sat[0], tile.sat[1], tile.sat[2]]).toEqual([SAT_AQUA, SAT_SNPP, SAT_NOAA20]);
    expect(tile.w[2]).toBeCloseTo(0.183333, 6);
    // An empty satellite field is still a broken row.
    expect(() => parseTile('t_-35_-59', csv.replace(',X9,', ',,'))).toThrow(/row 4/);
  });

  it('names satellites the way the app and the CSV show them', () => {
    expect(satelliteName('A')).toEqual({ satellite: 'Aqua', instrument: 'MODIS', label: 'Aqua MODIS' });
    expect(satelliteName('N')).toEqual({ satellite: 'S-NPP', instrument: 'VIIRS', label: 'S-NPP VIIRS' });
    expect(satelliteName('N20')).toEqual({ satellite: 'NOAA-20', instrument: 'VIIRS', label: 'NOAA-20 VIIRS' });
    // Anything that is not Aqua is treated as VIIRS.
    expect(satelliteName('X9')).toEqual({ satellite: 'X9', instrument: 'VIIRS', label: 'X9 VIIRS' });
  });

  it('parses a tile with a header and no rows', () => {
    expect(parseTile('t_-35_-59', 'lat,lon,date,dn,sat,conf,frp,s,w\n').count).toBe(0);
  });

  it('refuses a tile with the wrong columns or a broken row, naming the tile', () => {
    expect(() => parseTile('t_-35_-59', 'latitude,longitude\n1,2\n')).toThrow(/t_-35_-59/);
    expect(() => parseTile('t_-35_-59', '<!doctype html>')).toThrow(DataError);
    const broken = 'lat,lon,date,dn,sat,conf,frp,s,w\n-34.6,-58.4,2011-08-15,D,A,67\n';
    expect(() => parseTile('t_-35_-59', broken)).toThrow(/t_-35_-59.*row 1/);
  });

  it('loadTile fetches points/{id}.csv.gz', async () => {
    served.set('points/t_-35_-59.csv.gz', gz(TILE_CSV));
    const tile = await loadTile('t_-35_-59');
    expect(tile.count).toBe(3);
    expect(requests).toEqual([`${DATA_PREFIX}points/t_-35_-59.csv.gz`]);
  });

  it('a failed tile fetch rejects with the tile id in the message', async () => {
    const missing = await loadTile('t_-40_-70').catch((e) => e);
    expect(missing).toBeInstanceOf(DataError);
    expect(missing.message).toContain('t_-40_-70');
    expect(missing.kind).toBe('fetch');
    expect(missing.tileId).toBe('t_-40_-70');

    served.set('points/t_-41_-71.csv.gz', new TypeError('Failed to fetch'));
    const offline = await loadTile('t_-41_-71').catch((e) => e);
    expect(offline).toBeInstanceOf(DataError);
    expect(offline.message).toContain('t_-41_-71');
    expect(offline.tileId).toBe('t_-41_-71');
  });

  it('a tile that failed can be loaded again once it is reachable', async () => {
    served.set('points/t_-35_-59.csv.gz', new TypeError('Failed to fetch'));
    await expect(loadTile('t_-35_-59')).rejects.toThrow(/t_-35_-59/);
    served.set('points/t_-35_-59.csv.gz', gz(TILE_CSV));
    expect((await loadTile('t_-35_-59')).count).toBe(3);
  });
});

describe('a request that never answers', () => {
  afterEach(() => {
    setFetchTimeout(null);
  });

  it('is given up after the timeout, names the file, and can be tried again', async () => {
    // A server that accepts the request and then says nothing, until the request is aborted.
    let aborted = 0;
    vi.stubGlobal('fetch', (_input: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted++;
          reject(init.signal!.reason ?? new Error('aborted'));
        });
      }),
    );
    setFetchTimeout(30);
    const started = Date.now();
    const failed = await loadTile('t_-35_-59').catch((e) => e);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(failed).toBeInstanceOf(DataError);
    expect(failed.kind).toBe('fetch');
    expect(failed.tileId).toBe('t_-35_-59');
    expect(failed.message).toContain('t_-35_-59');
    expect(aborted).toBe(1);
    await expect(loadMeta()).rejects.toThrow(/meta\.json/);

    // The failure is not kept: once the server answers, the same call works.
    vi.stubGlobal('fetch', async () => new Response(gz(TILE_CSV) as BodyInit));
    expect((await loadTile('t_-35_-59')).count).toBe(3);
  });

  it('gives every request a time limit by default', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', async (_input: unknown, init?: { signal?: AbortSignal }) => {
      signal = init?.signal;
      return new Response(JSON.stringify(META));
    });
    await loadMeta();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  });
});

describe('seriesForCells', () => {
  const cells = Uint32Array.of(10, 11);

  beforeEach(() => {
    served.set('meta.json', JSON.stringify(META));
    served.set(
      'grid/monthly.bin.gz',
      gz(
        gridBytes([
          [10, 1.5, 0],
          [10, 2, 5],
          [11, 0.5, 0],
          [99, 100, 0], // not selected
          [11, 0.25, 286],
        ]),
      ),
    );
    served.set(
      'grid/raw.bin.gz',
      gz(
        gridBytes([
          [10, 6, 0],
          [11, 3, 109],
          [99, 400, 109], // not selected
        ]),
      ),
    );
    served.set(
      'grid/mtd.bin.gz',
      gz(
        gridBytes([
          [10, 0.5, 0],
          [11, 1.25, 23],
          [10, 0.25, 23],
          [99, 9, 23], // not selected
        ]),
      ),
    );
  });

  it('sums the harmonized grid over the cells, month by month', async () => {
    const series = await seriesForCells(cells, 'harmonized');
    expect(series).toBeInstanceOf(Float32Array);
    expect(series).toHaveLength(287);
    expect(series[0]).toBe(2);
    expect(series[5]).toBe(2);
    expect(series[286]).toBe(0.25);
    expect(series.reduce((a, b) => a + b, 0)).toBe(4.25);
    // The raw grid is only fetched when the Raw view asks for it.
    expect(requestsFor('grid/raw.bin.gz')).toBe(0);
  });

  it('returns sums from the raw grid only when the layer is raw', async () => {
    const series = await seriesForCells(cells, 'raw');
    expect(series).toHaveLength(287);
    expect(series[0]).toBe(6);
    expect(series[109]).toBe(3);
    expect(series.reduce((a, b) => a + b, 0)).toBe(9);
    expect(requestsFor('grid/raw.bin.gz')).toBe(1);
    expect(requestsFor('grid/monthly.bin.gz')).toBe(0);
  });

  it('returns zeros for cells with no fire and for no cells', async () => {
    expect((await seriesForCells(Uint32Array.of(12345), 'harmonized')).every((v) => v === 0)).toBe(true);
    const none = await seriesForCells(new Uint32Array(0), 'harmonized');
    expect(none).toHaveLength(287);
    expect(none.every((v) => v === 0)).toBe(true);
  });

  it('mtdForCells sums the month-to-date grid, one number per year', async () => {
    const mtd = await mtdForCells(cells);
    expect(mtd).toBeInstanceOf(Float32Array);
    expect(mtd).toHaveLength(24);
    expect(mtd[0]).toBe(0.5);
    expect(mtd[23]).toBe(1.5);
    expect(mtd.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it('mtdForCells is empty when the data ends on the last day of a month', async () => {
    served.set('meta.json', JSON.stringify({ ...META, data_end_date: '2025-12-31', mtd: null }));
    served.set('grid/mtd.bin.gz', gz(gridBytes([])));
    expect(await mtdForCells(cells)).toHaveLength(0);
  });
});

describe('dates', () => {
  it('turns a local date into a day number and back', () => {
    expect(dayNumber('1970-01-01')).toBe(0);
    expect(dayNumber('1970-01-02')).toBe(1);
    expect(dayNumber('2012-02-01') - dayNumber('2012-01-31')).toBe(1);
    expect(dayNumber('2024-03-01') - dayNumber('2024-02-28')).toBe(2);
    expect(isoDate(dayNumber('2026-11-14'))).toBe('2026-11-14');
    expect(isoDate(dayNumber('2003-01-01'))).toBe('2003-01-01');
  });
});

describe('with the sample data set (scripts/make-sample-data.mjs)', () => {
  // The generated files, served from memory: this does not read public/data.
  const sample = buildSample();
  const sampleJson = (path: string) => JSON.parse(new TextDecoder().decode(sample.get(path)));

  beforeEach(() => {
    for (const [path, bytes] of sample) served.set(path, bytes);
  });

  it('loads every file of the contract', async () => {
    const meta = await loadMeta();
    expect(meta.month_count).toBe(287);
    expect((await loadProvinces()).map((area) => area.id)).toEqual(['AR', '18', '42']);
    expect((await loadProvinceShapes()).features.map((f) => f.properties.id)).toEqual(['18', '42']);
    expect(await loadValidation()).toEqual({});
    expect((await loadGrid()).count).toBeGreaterThan(0);
    expect((await loadRawGrid()).count).toBe((await loadGrid()).count);
    expect((await loadMtd()).count).toBeGreaterThan(0);
    for (const id of meta.tiles) {
      const tile = await loadTile(id);
      expect(tile.count).toBeGreaterThan(0);
      for (let i = 0; i < tile.count; i++) expect(tileId(tile.lat[i], tile.lon[i])).toBe(id);
    }
  });

  it('a box around a province gives that province from the grid, in both layers', async () => {
    const corrientes = sampleJson('summary/provinces.json').areas[1];
    const { cells } = cellsInShape(rectangle(-29, -59, -28, -57));
    const harmonized = await seriesForCells(cells, 'harmonized');
    const raw = await seriesForCells(cells, 'raw');
    const mtd = await mtdForCells(cells);
    for (let m = 0; m < 287; m++) {
      expect(harmonized[m]).toBeCloseTo(corrientes.monthly[m], 2);
      expect(raw[m]).toBe(corrientes.raw[m]);
    }
    for (let y = 0; y < 24; y++) expect(mtd[y]).toBeCloseTo(corrientes.mtd[y], 2);
  });

  it('the province outline itself selects nearly the same fire, at grid resolution', async () => {
    const shapes = await loadProvinceShapes();
    const areas = await loadProvinces();
    for (const feature of shapes.features) {
      const exact = areas.find((area) => area.id === feature.properties.id)!;
      const fromGrid = await seriesForCells(cellsInShape(feature.geometry).cells, 'harmonized');
      const total = (values: ArrayLike<number>) => Array.from(values).reduce((a, b) => a + b, 0);
      expect(total(fromGrid)).toBeGreaterThan(0.9 * total(exact.monthly));
      expect(total(fromGrid)).toBeLessThanOrEqual(total(exact.monthly) + 0.01);
    }
  });

  it('the hotspots of a tile add up to the grid for the same box and month', async () => {
    // Tile t_-37_-66 holds all of the sample's La Pampa; January 2017 is its busiest month.
    const monthIdx = (2017 - 2003) * 12;
    const tile = await loadTile('t_-37_-66');
    let weights = 0;
    let pixels = 0;
    for (let i = 0; i < tile.count; i++) {
      if (isoDate(tile.day[i]).startsWith('2017-01') && tile.s[i] === 1) {
        weights += tile.w[i];
        pixels++;
      }
    }
    const { cells } = cellsInShape(rectangle(-37, -66, -36, -65));
    expect(weights).toBeGreaterThan(10);
    expect((await seriesForCells(cells, 'harmonized'))[monthIdx]).toBeCloseTo(weights, 2);
    expect((await seriesForCells(cells, 'raw'))[monthIdx]).toBe(pixels);
  });
});
