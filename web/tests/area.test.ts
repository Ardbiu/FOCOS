import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { areaShape, resolveArea } from '../src/area';
import { cellsInShape, containsPoint } from '../src/geo';
import { NATION } from '../src/state';
import { serveSample, type SampleServer } from './helpers/sample-server';

// The sample holds two provinces: 18 Corrientes (around -28.5, -57.9) and 42 La Pampa (around -36.5, -65.5).
let server: SampleServer;
beforeEach(() => {
  server = serveSample();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const gridRequests = () => server.requests.filter((path) => path.startsWith('grid/'));

describe('resolveArea: the nation and provinces', () => {
  it('takes the nation from the summary, without loading the grid', async () => {
    const summary = server.json('summary/provinces.json').areas[0];
    const data = await resolveArea(NATION, 'harmonized');
    expect(data).toMatchObject({ area: NATION, kind: 'nation', name: 'Argentina', coverage: 'inside', tooSmall: false });
    expect(Array.from(data.monthly)).toEqual(summary.monthly);
    expect(Array.from(data.raw!)).toEqual(summary.raw);
    expect(Array.from(data.mtd)).toEqual(summary.mtd);
    expect(gridRequests()).toEqual([]);
    expect(server.requests).not.toContain('provinces.geojson');
  });

  it('takes a province from the summary', async () => {
    const summary = server.json('summary/provinces.json').areas[1];
    const data = await resolveArea({ kind: 'province', id: '18' }, 'raw');
    expect(data).toMatchObject({ kind: 'province', name: 'Corrientes', coverage: 'inside' });
    expect(Array.from(data.monthly)).toEqual(summary.monthly);
    expect(Array.from(data.raw!)).toEqual(summary.raw);
    expect(gridRequests()).toEqual([]);
  });

  it('falls back to the nation for a province that does not exist', async () => {
    const data = await resolveArea({ kind: 'province', id: '99' }, 'harmonized');
    expect(data.area).toEqual(NATION);
    expect(data.kind).toBe('nation');
  });

  it('gives the outline of a province, and of the country, when asked', async () => {
    const province = await resolveArea({ kind: 'province', id: '42' }, 'harmonized');
    const shape = (await areaShape(province))!;
    expect(shape.type).toBe('MultiPolygon');
    expect(containsPoint(shape, -65.5, -36.5)).toBe(true);
    const country = (await areaShape(await resolveArea(NATION, 'harmonized')))!;
    expect(containsPoint(country, -65.5, -36.5)).toBe(true);
    expect(containsPoint(country, -57.9, -28.5)).toBe(true);
    expect(containsPoint(country, -60, -33)).toBe(false);
  });
});

describe('resolveArea: drawn shapes and circles', () => {
  const circle = { kind: 'circle', lat: -28.5, lon: -57.9, km: 25 } as const;

  it('sums the grid cells whose centers are inside a circle', async () => {
    const data = await resolveArea(circle, 'harmonized');
    expect(data).toMatchObject({ kind: 'custom', name: null, coverage: 'inside', tooSmall: false });
    expect(data.monthly).toHaveLength(287);
    expect(data.mtd).toHaveLength(24);
    const total = Array.from(data.monthly).reduce((a, b) => a + b, 0);
    const province = server.json('summary/provinces.json').areas[1].monthly.reduce((a: number, b: number) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(province);
    expect(data.cellCount).toBe(cellsInShape(data.shape!).cells.length);
    expect(containsPoint(data.shape!, -57.9, -28.5)).toBe(true);
  });

  it('loads the raw grid only for the Raw view', async () => {
    const harmonized = await resolveArea(circle, 'harmonized');
    expect(harmonized.raw).toBeNull();
    expect(server.count('grid/raw.bin.gz')).toBe(0);
    const raw = await resolveArea(circle, 'raw');
    expect(raw.raw).toHaveLength(287);
    expect(server.count('grid/raw.bin.gz')).toBe(1);
    // Raw counts pixels, so it is at least as large as the harmonized sum.
    const total = (values: ArrayLike<number>) => Array.from(values).reduce((a, b) => a + b, 0);
    expect(total(raw.raw!)).toBeGreaterThan(total(raw.monthly));
  });

  it('clips a shape that is partly outside the country and says so', async () => {
    // A box across the western border of the sample Corrientes.
    const data = await resolveArea(
      { kind: 'polygon', ring: [[-59.5, -28.7], [-58.2, -28.7], [-58.2, -28.3], [-59.5, -28.3]] },
      'harmonized',
    );
    expect(data.coverage).toBe('clipped');
    expect(containsPoint(data.shape!, -58.3, -28.5)).toBe(true);
    expect(containsPoint(data.shape!, -59.2, -28.5)).toBe(false);
    expect(Array.from(data.monthly).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('reports a shape outside the country as outside, without loading the grid', async () => {
    const data = await resolveArea(
      { kind: 'polygon', ring: [[-62, -33.5], [-61, -33.5], [-61, -32.5], [-62, -32.5]] },
      'harmonized',
    );
    expect(data).toMatchObject({ kind: 'custom', coverage: 'outside', shape: null, tooSmall: false });
    expect(data.monthly).toHaveLength(0);
    expect(gridRequests()).toEqual([]);
  });

  it('flags a shape smaller than a grid cell', async () => {
    const data = await resolveArea(
      { kind: 'polygon', ring: [[-57.91, -28.51], [-57.9, -28.51], [-57.9, -28.5], [-57.91, -28.5]] },
      'harmonized',
    );
    expect(data.tooSmall).toBe(true);
    expect(data.cellCount).toBe(1);
    expect(data.coverage).toBe('inside');
  });

  it('resolves a long, narrow shape to the cells it passes through', async () => {
    const data = await resolveArea(
      { kind: 'polygon', ring: [[-57.94, -28.498], [-57.66, -28.498], [-57.66, -28.492], [-57.94, -28.492]] },
      'harmonized',
    );
    expect(data.tooSmall).toBe(false);
    expect(data.thin).toBe(true);
    expect(data.cellCount).toBe(6);
  });

  it('passes on a failed grid load, and works on the next try', async () => {
    server.files.set('grid/monthly.bin.gz', { status: 503 });
    await expect(resolveArea(circle, 'harmonized')).rejects.toThrow(/grid\/monthly\.bin\.gz/);
    server.files.set('grid/monthly.bin.gz', server.files.get('grid/raw.bin.gz')!);
    expect((await resolveArea(circle, 'harmonized')).monthly).toHaveLength(287);
  });
});
