// Smoke tests for task W1.
//
// Three groups:
//   1. the scaffold (pages, Vite base, deploy workflow, language files);
//   2. the data contract (plan section 5) on whatever sits in public/data,
//      so these must keep passing when the pipeline replaces the sample;
//   3. the sample generator itself, checked in memory, so its sample-only
//      properties (the 2012 jump, the partial month) are not tied to public/data.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildSample } from '../scripts/make-sample-data.mjs';
import viteConfig from '../vite.config';

const webDir = fileURLToPath(new URL('..', import.meta.url));
const repoDir = join(webDir, '..');
const dataDir = join(webDir, 'public', 'data');

const MONTHS = 287;
const YEARS = 24;
const NLAT = 700;
const NLON = 420;
const TILE_HEADER = 'lat,lon,date,dn,sat,conf,frp,s,w';
// lat and lon with 5 decimals, local date, D or N, satellite A, N or N20, confidence 0-100 or n/h,
// frp with 1 decimal, s as 0 or 1, w with 6 decimals.
const TILE_ROW =
  /^-?\d+\.\d{5},-?\d+\.\d{5},\d{4}-\d{2}-\d{2},[DN],(A|N|N20),(\d{1,3}|[nh]),\d+\.\d,[01],\d+\.\d{6}$/;

interface Triples {
  n: number;
  cells: number[];
  values: number[];
  index: number[];
}

/** Decodes the section 5 grid layout: uint32 N, N x uint32, N x float32, N x uint16. */
function decodeGrid(gz: Uint8Array): Triples {
  const raw = gunzipSync(gz);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const n = view.getUint32(0, true);
  expect(raw.byteLength).toBe(4 + 10 * n);
  const cells: number[] = [];
  const values: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < n; i++) {
    cells.push(view.getUint32(4 + 4 * i, true));
    values.push(view.getFloat32(4 + 4 * n + 4 * i, true));
    index.push(view.getUint16(4 + 8 * n + 2 * i, true));
  }
  return { n, cells, values, index };
}

function parseTile(gz: Uint8Array): { header: string; rows: string[] } {
  const lines = new TextDecoder().decode(gunzipSync(gz)).split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return { header: lines[0], rows: lines.slice(1) };
}

function sum(values: ArrayLike<number>, from = 0, to = values.length): number {
  let total = 0;
  for (let i = from; i < to; i++) total += values[i];
  return total;
}

/** Every dotted path to a text in a language file; list items count by position. */
function keysOf(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, child]) => keysOf(child, prefix ? `${prefix}.${key}` : key))
    .sort();
}

describe('scaffold', () => {
  it('has placeholder pages that say Focos', () => {
    for (const page of ['index.html', 'method.html']) {
      const html = readFileSync(join(webDir, page), 'utf8');
      expect(html).toContain('<title>Focos');
      expect(html).toMatch(/<h1[^>]*>Focos<\/h1>/);
      expect(html).toContain('<html lang="en">');
    }
  });

  it('serves from the /FOCOS/ base and builds both pages', () => {
    expect(viteConfig.base).toBe('/FOCOS/');
    const input = viteConfig.build?.rollupOptions?.input as Record<string, string>;
    expect(Object.keys(input).sort()).toEqual(['main', 'method']);
  });

  it('has a Pages workflow that builds web/ and deploys it', () => {
    const yml = readFileSync(join(repoDir, '.github', 'workflows', 'deploy.yml'), 'utf8');
    expect(yml).toContain('working-directory: web');
    expect(yml).toContain('npm ci');
    expect(yml).toContain('npm run build');
    expect(yml).toContain('path: web/dist');
    expect(yml).toMatch(/actions\/upload-pages-artifact@v\d+/);
    expect(yml).toMatch(/actions\/deploy-pages@v\d+/);
    expect(yml).toContain('pages: write');
    expect(yml).toContain('id-token: write');
  });

  it('keeps the English and Spanish language files on the same keys', () => {
    const en = JSON.parse(readFileSync(join(webDir, 'src', 'i18n', 'en.json'), 'utf8'));
    const es = JSON.parse(readFileSync(join(webDir, 'src', 'i18n', 'es.json'), 'utf8'));
    expect(keysOf(en).length).toBeGreaterThan(0);
    expect(keysOf(es)).toEqual(keysOf(en));
  });
});

describe('data contract in public/data (plan section 5)', () => {
  const read = (path: string) => new Uint8Array(readFileSync(join(dataDir, path)));
  const readJson = (path: string) => JSON.parse(readFileSync(join(dataDir, path), 'utf8'));

  it('meta.json has every field with the pinned constants', () => {
    const meta = readJson('meta.json');
    // `series` (the carriers in order) and `gap_fill` (days NOAA-20 stood in for S-NPP) are optional:
    // older files and the sample data lack them.
    expect(Object.keys(meta).filter((key) => key !== 'series' && key !== 'gap_fill').sort()).toEqual(
      [
        'calibration',
        'country',
        'data_end_date',
        'generated_utc',
        'grid',
        'incomplete_months',
        'month_count',
        'mtd',
        'naive_error_pct',
        'switch_month',
        'tiles',
        'typical_error_pct',
        'version',
      ].sort(),
    );
    expect(meta.version).toBe(1);
    expect(meta.country).toBe('Argentina');
    expect(meta.switch_month).toBe('2012-02');
    expect(meta.grid).toEqual({ lat0: -56.0, lon0: -74.0, cell: 0.05, nlat: NLAT, nlon: NLON });
    expect(meta.month_count).toBe(MONTHS);
    expect(meta.generated_utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(meta.data_end_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(meta.calibration.candidate).toMatch(/^C[0-3]$/);
    expect(meta.calibration.train_years).toHaveLength(2);
    expect(meta.calibration.test_years).toHaveLength(2);
    expect(Number.isFinite(meta.typical_error_pct)).toBe(true);
    expect(Number.isFinite(meta.naive_error_pct)).toBe(true);
    for (const entry of meta.incomplete_months) {
      expect(Object.keys(entry).sort()).toEqual(['coverage', 'month_idx', 'sensor']);
      expect(entry.month_idx).toBeGreaterThanOrEqual(0);
      expect(entry.month_idx).toBeLessThan(MONTHS);
      expect(entry.coverage).toBeLessThan(0.9);
      expect(['A', 'N']).toContain(entry.sensor);
    }
    for (const tile of meta.tiles) expect(tile).toMatch(/^t_-?\d+_-?\d+$/);
    if (meta.series !== undefined) {
      const series = meta.series as Array<Record<string, unknown>>;
      expect(series.length).toBeGreaterThanOrEqual(2);
      for (const carrier of series) {
        expect(Object.keys(carrier).sort()).toEqual(['from', 'name', 'sat', 'to', 'typical_error_pct']);
        expect(carrier.from).toMatch(/^\d{4}-\d{2}$/);
      }
      expect(series[0]).toMatchObject({ sat: 'A', from: '2003-01', typical_error_pct: null });
      expect(series[1]).toMatchObject({ sat: 'N', from: meta.switch_month });
      expect(series[series.length - 1].to).toBeNull();
      for (const carrier of series.slice(0, -1)) expect(carrier.to).toMatch(/^\d{4}-\d{2}$/);
    }
    const [year, month, day] = meta.data_end_date.split('-').map(Number);
    const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (day === lastDayOfMonth) {
      expect(meta.mtd).toBeNull();
    } else {
      expect(meta.mtd).toEqual({ month, last_day: day });
    }
  });

  it('the three grid files follow the binary layout', () => {
    for (const [file, indexLimit] of [
      ['grid/monthly.bin.gz', MONTHS],
      ['grid/raw.bin.gz', MONTHS],
      ['grid/mtd.bin.gz', YEARS],
    ] as const) {
      const grid = decodeGrid(read(file));
      // Counted in a plain loop: the real grids hold hundreds of thousands of entries.
      let outOfRange = 0;
      for (let i = 0; i < grid.n; i++) {
        const ok =
          grid.cells[i] < NLAT * NLON &&
          grid.index[i] < indexLimit &&
          Number.isFinite(grid.values[i]) &&
          grid.values[i] > 0;
        if (!ok) outOfRange++;
      }
      expect(outOfRange, `${file}: entries off the grid, past the last month, or not positive`).toBe(0);
    }
    if (readJson('meta.json').mtd === null) {
      expect(decodeGrid(read('grid/mtd.bin.gz')).n).toBe(0);
    }
  });

  it('summary/provinces.json lists the nation first, then provinces', () => {
    const { areas } = readJson('summary/provinces.json');
    const meta = readJson('meta.json');
    expect(areas[0].id).toBe('AR');
    expect(areas.length).toBeGreaterThanOrEqual(3);
    for (const area of areas) {
      expect(Object.keys(area).sort()).toEqual(['id', 'monthly', 'mtd', 'name', 'raw']);
      expect(typeof area.name).toBe('string');
      expect(area.monthly).toHaveLength(MONTHS);
      expect(area.raw).toHaveLength(MONTHS);
      expect(area.mtd).toHaveLength(meta.mtd === null ? 0 : YEARS);
      for (const value of [...area.monthly, ...area.raw, ...area.mtd]) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
    for (const area of areas.slice(1)) expect(area.id).toMatch(/^\d{2}$/);
  });

  it('provinces.geojson carries the same province ids as the summary', () => {
    const geo = readJson('provinces.geojson');
    const { areas } = readJson('summary/provinces.json');
    expect(geo.type).toBe('FeatureCollection');
    for (const feature of geo.features) {
      expect(Object.keys(feature.properties).sort()).toEqual(['id', 'name']);
      expect(['Polygon', 'MultiPolygon']).toContain(feature.geometry.type);
    }
    const geoIds = geo.features.map((f: { properties: { id: string } }) => f.properties.id).sort();
    const summaryIds = areas.slice(1).map((a: { id: string }) => a.id).sort();
    expect(geoIds).toEqual(summaryIds);
  });

  it('every listed point tile exists; the first three have the pinned columns', () => {
    const { tiles } = readJson('meta.json') as { tiles: string[] };
    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) expect(existsSync(join(dataDir, 'points', `${tile}.csv.gz`))).toBe(true);
    for (const tile of tiles.slice(0, 3)) {
      const [, latFloor, lonFloor] = tile.split('_').map(Number);
      const { header, rows } = parseTile(read(`points/${tile}.csv.gz`));
      expect(header).toBe(TILE_HEADER);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        if (!TILE_ROW.test(row)) throw new Error(`bad row in ${tile}: ${row}`);
        const [lat, lon] = row.split(',').map(Number);
        if (Math.floor(lat) !== latFloor || Math.floor(lon) !== lonFloor) {
          throw new Error(`row outside ${tile}: ${row}`);
        }
      }
    }
  });

  it('validation.json is a JSON object', () => {
    const validation = readJson('validation.json');
    expect(validation !== null && typeof validation === 'object' && !Array.isArray(validation)).toBe(true);
  });
});

describe('sample data generator', () => {
  const files = buildSample();
  const json = (path: string) => JSON.parse(new TextDecoder().decode(files.get(path)));
  const meta = json('meta.json');
  const areas = json('summary/provinces.json').areas as Array<{
    id: string;
    name: string;
    monthly: number[];
    raw: number[];
    mtd: number[];
  }>;
  const nation = areas[0];

  interface Point {
    lat: number;
    lon: number;
    date: string;
    monthIdx: number;
    day: number;
    sat: string;
    s: number;
    w: number;
  }
  const points: Point[] = [];
  for (const tile of meta.tiles as string[]) {
    for (const row of parseTile(files.get(`points/${tile}.csv.gz`)!).rows) {
      const [lat, lon, date, , sat, , , s, w] = row.split(',');
      const [year, month, day] = date.split('-').map(Number);
      points.push({
        lat: Number(lat),
        lon: Number(lon),
        date,
        monthIdx: (year - 2003) * 12 + (month - 1),
        day,
        sat,
        s: Number(s),
        w: Number(w),
      });
    }
  }

  it('writes exactly the files of section 5', () => {
    expect([...files.keys()].sort()).toEqual(
      [
        'meta.json',
        'grid/monthly.bin.gz',
        'grid/mtd.bin.gz',
        'grid/raw.bin.gz',
        'summary/provinces.json',
        'provinces.geojson',
        'validation.json',
        ...(meta.tiles as string[]).map((tile) => `points/${tile}.csv.gz`),
      ].sort(),
    );
    expect(meta.tiles.length).toBeGreaterThanOrEqual(2);
    expect(meta.tiles.length).toBeLessThanOrEqual(3);
    expect(json('validation.json')).toEqual({});
  });

  it('is deterministic, so regenerating does not churn the repo', () => {
    const again = buildSample();
    for (const [path, bytes] of files) {
      expect(Buffer.from(again.get(path)!).equals(Buffer.from(bytes)), path).toBe(true);
    }
  });

  it('has the nation plus two provinces over 287 months', () => {
    expect(areas.map((a) => a.id)).toEqual(['AR', '18', '42']);
    for (const area of areas) {
      expect(area.monthly).toHaveLength(MONTHS);
      expect(area.raw).toHaveLength(MONTHS);
      expect(area.mtd).toHaveLength(YEARS);
    }
    expect(json('provinces.geojson').features).toHaveLength(2);
  });

  it('ends on 2026-11-14 with a partial current month', () => {
    expect(meta.data_end_date).toBe('2026-11-14');
    expect(meta.mtd).toEqual({ month: 11, last_day: 14 });
    const lastDate = points.reduce((max, p) => (p.date > max ? p.date : max), '');
    expect(lastDate <= '2026-11-14').toBe(true);
    expect(lastDate >= '2026-11-01').toBe(true);
    expect(nation.monthly[286]).toBeGreaterThan(0);
    // The month-to-date value of the current year is the partial month itself.
    expect(nation.mtd[23]).toBeCloseTo(nation.monthly[286], 3);
    // Earlier years: days 1 to 14 are only part of the full November.
    expect(sum(nation.mtd, 0, 23)).toBeLessThan(
      sum(Array.from({ length: 23 }, (_, y) => nation.monthly[y * 12 + 10])),
    );
  });

  it('has a seasonal pattern, different in each province', () => {
    const profile = (area: { monthly: number[] }) =>
      Array.from({ length: 12 }, (_, m) => sum(Array.from({ length: 23 }, (_, y) => area.monthly[y * 12 + m])));
    const north = profile(areas[1]);
    const south = profile(areas[2]);
    expect(north.indexOf(Math.max(...north))).toBe(7); // August
    expect(north[7]).toBeGreaterThan(4 * north[4]);
    expect([11, 0, 1]).toContain(south.indexOf(Math.max(...south))); // Dec to Feb
    expect(south[0]).toBeGreaterThan(8 * south[6]);
  });

  it('shows the raw series jumping about fourfold from Feb 2012 (month 109)', () => {
    const before = sum(nation.raw, 0, 109) / sum(nation.monthly, 0, 109);
    const after = sum(nation.raw, 109) / sum(nation.monthly, 109);
    expect(before).toBeGreaterThan(1);
    expect(before).toBeLessThan(1.6);
    expect(after).toBeGreaterThan(3.5);
    expect(after).toBeLessThan(4.5);
    // The harmonized series itself has no step at the switch.
    const yearMean = (series: number[], from: number, to: number) => sum(series, from * 12, to * 12) / (to - from);
    const ratio = yearMean(nation.monthly, 10, 15) / yearMean(nation.monthly, 4, 9);
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.6);
  });

  it('follows the series rule: Aqua to 2012-01-31, S-NPP to 2026-10-31, NOAA-20 from 2026-11-01', () => {
    for (const p of points) {
      const inSeries =
        p.sat === 'A'
          ? p.date <= '2012-01-31'
          : p.sat === 'N'
            ? p.date >= '2012-02-01' && p.date <= '2026-10-31'
            : p.sat === 'N20' && p.date >= '2026-11-01';
      expect(p.date >= '2003-01-01').toBe(true);
      expect(p.s).toBe(inSeries ? 1 : 0);
      if (inSeries) expect(p.w).toBeGreaterThan(0);
      else expect(p.w).toBe(0);
    }
    expect(points.some((p) => p.sat === 'A' && p.s === 0)).toBe(true);
    expect(points.some((p) => p.sat === 'N' && p.s === 0)).toBe(true);
    expect(points.some((p) => p.sat === 'N20' && p.s === 1)).toBe(true);
    expect(points.some((p) => p.sat === 'N' && p.date >= '2026-11-01')).toBe(false);
    expect(meta.series.map((carrier: { sat: string }) => carrier.sat)).toEqual(['A', 'N', 'N20']);
  });

  it('writes point rows in the pinned format', () => {
    for (const tile of meta.tiles as string[]) {
      const { header, rows } = parseTile(files.get(`points/${tile}.csv.gz`)!);
      expect(header).toBe(TILE_HEADER);
      const bad = rows.filter((row) => !TILE_ROW.test(row));
      expect(bad.slice(0, 3)).toEqual([]);
    }
  });

  it('flags incomplete months that really have outage days', () => {
    expect(meta.incomplete_months.length).toBeGreaterThanOrEqual(1);
    for (const entry of meta.incomplete_months as Array<{ month_idx: number; coverage: number; sensor: string }>) {
      const year = 2003 + Math.floor(entry.month_idx / 12);
      const month = (entry.month_idx % 12) + 1;
      const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const daysWithData = new Set(
        points.filter((p) => p.monthIdx === entry.month_idx && p.sat === entry.sensor).map((p) => p.day),
      );
      expect(entry.sensor).toBe(entry.month_idx < 109 ? 'A' : 'N');
      expect(daysWithData.size).toBeLessThanOrEqual(Math.round(entry.coverage * days));
      expect(daysWithData.size).toBeGreaterThan(0);
    }
  });

  it('keeps the grids and the summaries consistent with the points', () => {
    const monthly = decodeGrid(files.get('grid/monthly.bin.gz')!);
    const raw = decodeGrid(files.get('grid/raw.bin.gz')!);
    const mtd = decodeGrid(files.get('grid/mtd.bin.gz')!);

    const cellOf = (p: Point) => Math.floor((p.lat + 56) / 0.05) * NLON + Math.floor((p.lon + 74) / 0.05);
    const fromPoints = new Map<string, number>();
    const rawFromPoints = new Map<string, number>();
    const mtdFromPoints = new Map<string, number>();
    const add = (map: Map<string, number>, key: string, value: number) => map.set(key, (map.get(key) ?? 0) + value);
    for (const p of points) {
      if (p.s !== 1) continue;
      add(fromPoints, `${cellOf(p)}:${p.monthIdx}`, p.w);
      add(rawFromPoints, `${cellOf(p)}:${p.monthIdx}`, 1);
      if (p.monthIdx % 12 === 10 && p.day <= 14) add(mtdFromPoints, `${cellOf(p)}:${Math.floor(p.monthIdx / 12)}`, p.w);
    }
    for (const [grid, expected] of [
      [monthly, fromPoints],
      [raw, rawFromPoints],
      [mtd, mtdFromPoints],
    ] as const) {
      expect(grid.n).toBe(expected.size);
      for (let i = 0; i < grid.n; i++) {
        expect(grid.values[i]).toBeCloseTo(expected.get(`${grid.cells[i]}:${grid.index[i]}`) ?? NaN, 3);
      }
    }
    expect(sum(raw.values)).toBe(points.filter((p) => p.s === 1).length);

    // The nation is the sum of the grid, month by month, and the sum of its provinces.
    const gridByMonth = new Array<number>(MONTHS).fill(0);
    for (let i = 0; i < monthly.n; i++) gridByMonth[monthly.index[i]] += monthly.values[i];
    const gridByYear = new Array<number>(YEARS).fill(0);
    for (let i = 0; i < mtd.n; i++) gridByYear[mtd.index[i]] += mtd.values[i];
    for (let m = 0; m < MONTHS; m++) {
      expect(nation.monthly[m]).toBeCloseTo(gridByMonth[m], 2);
      expect(nation.monthly[m]).toBeCloseTo(areas[1].monthly[m] + areas[2].monthly[m], 3);
      expect(nation.raw[m]).toBe(areas[1].raw[m] + areas[2].raw[m]);
    }
    for (let y = 0; y < YEARS; y++) {
      expect(nation.mtd[y]).toBeCloseTo(gridByYear[y], 2);
      expect(nation.mtd[y]).toBeCloseTo(areas[1].mtd[y] + areas[2].mtd[y], 3);
    }
  });
});
