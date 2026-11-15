import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { areaShape, resolveArea } from '../src/area';
import { buildCalendarModel, type CalendarInput } from '../src/calendar';
import { isoDate, loadMeta, loadTile, type Meta } from '../src/data';
import {
  CALENDAR_COLUMNS,
  HOTSPOT_COLUMNS,
  MAX_DOTS,
  MAX_TILES,
  areaSlug,
  calendarCsv,
  hotspotsCsv,
  monthDots,
  type ExportInfo,
} from '../src/exports';
import { containsPoint, rectangle, type Shape } from '../src/geo';
import { monthIdx, monthOfIdx, yearOfIdx, type Completeness } from '../src/stats';
import { serveSample, type SampleServer } from './helpers/sample-server';

// The sample holds two provinces: 18 Corrientes in tiles t_-29_-59 and t_-29_-58, 42 La Pampa in t_-37_-66.
let server: SampleServer;
let meta: Meta;
let corrientes: Shape;
let info: ExportInfo;

beforeEach(async () => {
  server = serveSample();
  meta = await loadMeta();
  corrientes = (await areaShape(await resolveArea({ kind: 'province', id: '18' }, 'harmonized')))!;
  info = { areaName: 'Corrientes', areaSlug: 'corrientes', drawn: false, meta, lang: 'en' };
  server.requests.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const pointRequests = () => server.requests.filter((path) => path.startsWith('points/'));

/** The parts of a CSV: the `#` lines, the column header, and the data rows. */
async function parse(blob: Blob): Promise<{ comments: string[]; header: string; rows: string[][] }> {
  const lines = (await blob.text()).split('\n');
  expect(lines[lines.length - 1]).toBe(''); // ends with a newline
  lines.pop();
  const firstData = lines.findIndex((line) => !line.startsWith('#'));
  return {
    comments: lines.slice(0, firstData),
    header: lines[firstData],
    rows: lines.slice(firstData + 1).map((line) => line.split(',')),
  };
}

describe('hotspotsCsv', () => {
  it('starts with # metadata lines, then exactly the columns of section 6.6', async () => {
    const result = await hotspotsCsv(corrientes, '2020-08-01', '2020-08-31', info);
    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.blob.type).toBe('text/csv;charset=utf-8');
    const { comments, header } = await parse(result.blob);
    expect(comments).toEqual([
      '# Focos: satellite fire detections with MODIS-equivalent weights',
      '# Area: Corrientes',
      '# Date range: 2020-08-01 to 2020-08-31 (local dates)',
      '# Data through: 2026-11-14',
      '# Calibration: C2, tuned on 2012-2019 and tested on 2020-2021',
      '# Typical error: 18%, the median absolute error of province-months of 20 or more hotspots in the test years (half came closer, half not)',
      '# Data source: NASA FIRMS active fire detections, MODIS (Aqua) and VIIRS (S-NPP, NOAA-20)',
      '# Site: https://ardbiu.github.io/FOCOS/',
      '# Built with Claude, an AI assistant (Anthropic); “How SI was used” in the README at https://github.com/Ardbiu/FOCOS says what it did',
      '# modis_equivalent_weight: the share of one MODIS-equivalent hotspot that the detection stands for. Its sum over a province and a month is the count in the calendar. It is 0 for detections outside the harmonized series.',
    ]);
    expect(header).toBe(
      'latitude,longitude,local_date,daynight,satellite,instrument,confidence,frp_mw,in_harmonized_series,modis_equivalent_weight',
    );
    expect(HOTSPOT_COLUMNS.join(',')).toBe(header);
    expect(result.fileName).toBe('focos_hotspots_corrientes_2020-08-01_2020-08-31.csv');
  });

  it('does not promise that the weights of a drawn area add up to its calendar', async () => {
    // The calendar of a drawn area is summed on the 5 km grid; the CSV holds the exact detections inside the shape.
    const circle = { ...info, areaName: '25 km around -28.5, -57.9', areaSlug: 'circle_-28.5_-57.9_25km', drawn: true };
    const result = await hotspotsCsv(rectangle(-28.7, -58.1, -28.3, -57.7), '2020-08-01', '2020-08-31', circle);
    if (result.status !== 'ok') throw new Error(result.status);
    const { comments } = await parse(result.blob);
    expect(comments[comments.length - 1]).toBe(
      '# modis_equivalent_weight: the share of one MODIS-equivalent hotspot that the detection stands for. It is 0 for detections outside the harmonized series. The calendar of a drawn area or a circle is summed on a grid of about 5 km, so the sum of these weights can differ from the count the calendar shows.',
    );
    const spanish = await hotspotsCsv(rectangle(-28.7, -58.1, -28.3, -57.7), '2020-08-01', '2020-08-31', { ...circle, lang: 'es' });
    if (spanish.status !== 'ok') throw new Error(spanish.status);
    expect((await parse(spanish.blob)).comments.pop()).toContain('grilla de unos 5 km');
  });

  it('names in its source line only the satellites that carry the record', async () => {
    const twoCarriers = { ...info, meta: { ...meta, series: [meta.series![0], { ...meta.series![1], to: null }] } };
    const result = await hotspotsCsv(corrientes, '2020-08-01', '2020-08-31', twoCarriers);
    if (result.status !== 'ok') throw new Error(result.status);
    expect((await parse(result.blob)).comments[6]).toBe(
      '# Data source: NASA FIRMS active fire detections, MODIS (Aqua) and VIIRS (S-NPP)',
    );
  });

  it('keeps only the rows inside the shape and the date range', async () => {
    const result = await hotspotsCsv(corrientes, '2020-08-10', '2020-09-05', info);
    if (result.status !== 'ok') throw new Error(result.status);
    const { rows } = await parse(result.blob);
    expect(rows.length).toBe(result.rows);
    expect(rows.length).toBeGreaterThan(50);
    for (const row of rows) {
      expect(row).toHaveLength(10);
      expect(row[2] >= '2020-08-10' && row[2] <= '2020-09-05').toBe(true);
      expect(containsPoint(corrientes, Number(row[1]), Number(row[0]))).toBe(true);
    }
    // The same rows, counted straight from the tiles.
    let expected = 0;
    for (const id of ['t_-29_-59', 't_-29_-58']) {
      const tile = await loadTile(id);
      for (let i = 0; i < tile.count; i++) {
        const date = isoDate(tile.day[i]);
        if (date >= '2020-08-10' && date <= '2020-09-05' && containsPoint(corrientes, tile.lon[i], tile.lat[i])) expected++;
      }
    }
    expect(rows.length).toBe(expected);
    // A box around half the province gives fewer rows, all inside the box.
    const west = await hotspotsCsv(rectangle(-29, -59, -28, -58), '2020-08-10', '2020-09-05', info);
    if (west.status !== 'ok') throw new Error(west.status);
    expect(west.rows).toBeGreaterThan(0);
    expect(west.rows).toBeLessThan(rows.length);
    for (const row of (await parse(west.blob)).rows) expect(Number(row[1])).toBeLessThan(-58);
  });

  it('writes each column the way the header says', async () => {
    const result = await hotspotsCsv(corrientes, '2011-12-01', '2012-03-31', info);
    if (result.status !== 'ok') throw new Error(result.status);
    const { rows } = await parse(result.blob);
    for (const row of rows) {
      expect(row[0]).toMatch(/^-?\d+\.\d{5}$/);
      expect(row[1]).toMatch(/^-?\d+\.\d{5}$/);
      expect(row[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(['D', 'N']).toContain(row[3]);
      expect(['Aqua MODIS', 'S-NPP VIIRS']).toContain(`${row[4]} ${row[5]}`);
      expect(row[6]).toMatch(row[5] === 'MODIS' ? /^\d{1,3}$/ : /^[nh]$/);
      expect(row[7]).toMatch(/^\d+\.\d$/);
      expect(row[9]).toMatch(/^\d+\.\d{6}$/);
      // The series rule: Aqua carries the record through January 2012, S-NPP from February.
      const inSeries = row[4] === 'Aqua' ? row[2] <= '2012-01-31' : row[2] >= '2012-02-01';
      expect(row[8]).toBe(inSeries ? '1' : '0');
      if (!inSeries) expect(row[9]).toBe('0.000000');
    }
    expect(rows.some((row) => row[4] === 'Aqua' && row[8] === '0')).toBe(true);
    expect(rows.some((row) => row[4] === 'S-NPP' && row[8] === '0')).toBe(true);
  });

  it('names NOAA-20 where it carries the record', async () => {
    const result = await hotspotsCsv(corrientes, '2026-11-01', '2026-11-14', info);
    if (result.status !== 'ok') throw new Error(result.status);
    const { rows } = await parse(result.blob);
    expect(rows.some((row) => `${row[4]} ${row[5]}` === 'NOAA-20 VIIRS' && row[8] === '1')).toBe(true);
    expect(rows.some((row) => row[4] === 'S-NPP')).toBe(false);
  });

  it('has weights that sum to the calendar cell for a province and month (within 0.5%)', async () => {
    const summary = server.json('summary/provinces.json').areas[1];
    for (const [year, month] of [[2008, 8], [2020, 8], [2022, 2]]) {
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const from = `${year}-${String(month).padStart(2, '0')}-01`;
      const to = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
      const result = await hotspotsCsv(corrientes, from, to, info);
      if (result.status !== 'ok') throw new Error(result.status);
      const { rows } = await parse(result.blob);
      const weights = rows.reduce((sum, row) => sum + Number(row[9]), 0);
      const cell = summary.monthly[monthIdx(year, month)];
      expect(cell).toBeGreaterThan(10);
      expect(Math.abs(weights - cell) / cell).toBeLessThan(0.005);
      // In-series rows are also the raw count of the Raw view.
      expect(rows.filter((row) => row[8] === '1')).toHaveLength(summary.raw[monthIdx(year, month)]);
    }
  });

  it('returns tooLarge, without fetching, when the area touches more than 80 point tiles', async () => {
    // Every tile of a 10 x 10 degree block exists.
    const tiles: string[] = [];
    for (let lat = -40; lat < -30; lat++) for (let lon = -70; lon < -60; lon++) tiles.push(`t_${lat}_${lon}`);
    const big = { ...info, meta: { ...meta, tiles } };
    expect(MAX_TILES).toBe(80);
    expect(await hotspotsCsv(rectangle(-40, -70, -30, -60), '2020-01-01', '2020-12-31', big)).toEqual({
      status: 'tooLarge',
      tiles: 100,
      limit: 80,
    });
    expect(pointRequests()).toEqual([]);
    // 80 tiles is still allowed (and here every fetch fails, which is another matter).
    const eighty = await hotspotsCsv(rectangle(-40, -70, -30, -62), '2020-01-01', '2020-12-31', big);
    expect(eighty.status).toBe('error');
  });

  it('counts only the tiles that exist', async () => {
    // The same block over the sample, where three tiles exist and one lies in this box.
    const result = await hotspotsCsv(rectangle(-40, -70, -30, -60), '2017-01-01', '2017-01-31', info);
    expect(result.status).toBe('ok');
    expect(pointRequests()).toEqual(['points/t_-37_-66.csv.gz']);
  });

  it('names the tile that failed, and succeeds on a retry', async () => {
    const tile = server.files.get('points/t_-29_-58.csv.gz')!;
    server.files.set('points/t_-29_-58.csv.gz', { status: 503 });
    const failed = await hotspotsCsv(corrientes, '2020-08-01', '2020-08-31', info);
    expect(failed).toMatchObject({ status: 'error', tileId: 't_-29_-58' });
    if (failed.status !== 'error') throw new Error(failed.status);
    expect(failed.message).toContain('t_-29_-58');
    server.files.set('points/t_-29_-58.csv.gz', tile);
    const retried = await hotspotsCsv(corrientes, '2020-08-01', '2020-08-31', info);
    expect(retried.status).toBe('ok');
    // The tile that had loaded is not fetched again.
    expect(server.count('points/t_-29_-59.csv.gz')).toBe(1);
    expect(server.count('points/t_-29_-58.csv.gz')).toBe(2);
  });

  it('gives a file with the header and no rows when nothing burned', async () => {
    const result = await hotspotsCsv(rectangle(-28.2, -58.6, -28.15, -58.55), '2004-05-01', '2004-05-02', info);
    if (result.status !== 'ok') throw new Error(result.status);
    expect(result.rows).toBe(0);
    const { header, rows } = await parse(result.blob);
    expect(header).toBe(HOTSPOT_COLUMNS.join(','));
    expect(rows).toEqual([]);
  });

  it('writes the metadata in Spanish and keeps the column names', async () => {
    const result = await hotspotsCsv(corrientes, '2020-08-01', '2020-08-31', { ...info, lang: 'es' });
    if (result.status !== 'ok') throw new Error(result.status);
    const { comments, header } = await parse(result.blob);
    expect(comments[1]).toBe('# Área: Corrientes');
    expect(comments[3]).toBe('# Datos hasta: 2026-11-14');
    expect(header).toBe(HOTSPOT_COLUMNS.join(','));
  });
});

describe('calendarCsv', () => {
  const completeness: Completeness = {
    incomplete: new Set([monthIdx(2010, 9)]),
    lastCompleteYear: 2025,
    lastMonthIdx: 286,
    partial: { monthIdx: 286, lastDay: 14 },
  };
  // August burns (100 a month, 300 in 2020), March has almost no fire, the rest sits at 20.5.
  const monthly = Array.from({ length: 287 }, (_, idx) => {
    const [year, month] = [yearOfIdx(idx), monthOfIdx(idx)];
    if (month === 8) return year === 2020 ? 300 : 100;
    if (month === 3) return 2;
    if (month === 11 && year === 2026) return 30;
    return 20.5;
  });
  const input = (overrides: Partial<CalendarInput> = {}): CalendarInput => ({
    monthly,
    raw: monthly.map((value) => value * 4),
    mtd: Array.from({ length: 24 }, (_, y) => (y === 23 ? 30 : 10)),
    completeness,
    carriers: [
      { sat: 'A', name: 'Aqua MODIS', fromIdx: 0, toIdx: 108, typicalErrorPct: null },
      { sat: 'N', name: 'S-NPP VIIRS', fromIdx: 109, toIdx: null, typicalErrorPct: 17 },
    ],
    errorBands: [],
    view: 'harmonized',
    mode: 'count',
    yearFrom: 2003,
    yearTo: 2026,
    sel: null,
    ...overrides,
  });
  const cordoba = (): ExportInfo => ({ areaName: 'Córdoba', areaSlug: 'cordoba', drawn: false, meta, lang: 'en' });

  it('starts with # metadata lines, then exactly the columns of section 6.6', async () => {
    const { blob, fileName } = calendarCsv(buildCalendarModel(input({ yearFrom: 2010, yearTo: 2020 })), cordoba());
    const { comments, header } = await parse(blob);
    expect(comments).toEqual([
      '# Focos: MODIS-equivalent fire calendar',
      '# Area: Córdoba',
      '# Date range: 2010-01 to 2020-12',
      '# Data through: 2026-11-14',
      '# Calibration: C2, tuned on 2012-2019 and tested on 2020-2021',
      '# Typical error: 18%, the median absolute error of province-months of 20 or more hotspots in the test years (half came closer, half not)',
      '# Data source: NASA FIRMS active fire detections, MODIS (Aqua) and VIIRS (S-NPP, NOAA-20)',
      '# Site: https://ardbiu.github.io/FOCOS/',
      '# Built with Claude, an AI assistant (Anthropic); “How SI was used” in the README at https://github.com/Ardbiu/FOCOS says what it did',
      '# category: record_high, well_above, above, near or below the usual level for the month; rare where that level is below 5 hotspots (no ratio); empty where the month is not compared.',
    ]);
    expect(header).toBe('year,month,modis_equivalent_hotspots,baseline_median,ratio_to_median,category,data_complete');
    expect(CALENDAR_COLUMNS.join(',')).toBe(header);
    expect(fileName).toBe('focos_calendar_cordoba_2010_2020.csv');
    expect(blob.type).toBe('text/csv;charset=utf-8');
  });

  it('has one row per month with data in the years shown', async () => {
    const { rows } = await parse(calendarCsv(buildCalendarModel(input()), cordoba()).blob);
    expect(rows).toHaveLength(287); // no row for December 2026, which has no data
    expect(rows[0].slice(0, 2)).toEqual(['2003', '1']);
    expect(rows[286].slice(0, 2)).toEqual(['2026', '11']);
    const ten = await parse(calendarCsv(buildCalendarModel(input({ yearFrom: 2010, yearTo: 2020 })), cordoba()).blob);
    expect(ten.rows).toHaveLength(11 * 12);
  });

  it('gives the value, the baseline median, the ratio, the category and whether the month is complete', async () => {
    const { rows } = await parse(calendarCsv(buildCalendarModel(input()), cordoba()).blob);
    const row = (year: number, month: number) => rows[monthIdx(year, month)].join(',');
    expect(row(2020, 8)).toBe('2020,8,300,100,3.00,record_high,true');
    expect(row(2019, 8)).toBe('2019,8,100,100,1.00,near,true');
    expect(row(2019, 1)).toBe('2019,1,20.5,20.5,1.00,near,true');
    // Usually almost no fire: no ratio.
    expect(row(2019, 3)).toBe('2019,3,2,2,,rare,true');
    // Incomplete data: the count, and nothing compared.
    expect(row(2010, 9)).toBe('2010,9,20.5,,,,false');
    // The partial month: days 1 to 14 against days 1 to 14.
    expect(row(2026, 11)).toBe('2026,11,30,10,3.00,record_high,false');
    for (const cells of rows) expect(cells.join(',')).not.toMatch(/NaN|undefined|Infinity|null/);
  });

  it('is always the harmonized series', () => {
    expect(() => calendarCsv(buildCalendarModel(input({ view: 'raw' })), cordoba())).toThrow(/harmonized/);
  });
});

describe('monthDots', () => {
  const august2020 = monthIdx(2020, 8);

  it('gives the positions of the month\'s in-series hotspots inside the shape', async () => {
    const result = await monthDots(corrientes, august2020, meta);
    if (result.status !== 'ok') throw new Error(result.status);
    const summary = server.json('summary/provinces.json').areas[1];
    expect(result.total).toBe(summary.raw[august2020]);
    expect(result.count).toBe(result.total);
    expect(result.lat).toHaveLength(result.count);
    for (let i = 0; i < result.count; i++) expect(containsPoint(corrientes, result.lon[i], result.lat[i])).toBe(true);
    // What the detections weigh: their MODIS-equivalent weights, summed, are the calendar's count.
    expect(result.weight).toBeCloseTo(summary.monthly[august2020], 0);
  });

  it('caps the dots, spread over the whole area, and says how many there are', async () => {
    expect(MAX_DOTS).toBe(20000);
    const all = await monthDots(corrientes, august2020, meta);
    const some = await monthDots(corrientes, august2020, meta, { limit: 25 });
    if (all.status !== 'ok' || some.status !== 'ok') throw new Error('expected dots');
    expect(some.total).toBe(all.total);
    expect(some.count).toBe(25);
    expect(some.lat).toHaveLength(25);
    // Not just the first 25: both tiles of the province are represented.
    const west = Array.from(some.lon).filter((lon) => lon < -58).length;
    expect(west).toBeGreaterThan(0);
    expect(west).toBeLessThan(25);
  });

  it('has no dots for a month without fire in the shape', async () => {
    const result = await monthDots(rectangle(-28.2, -58.6, -28.15, -58.55), monthIdx(2004, 5), meta);
    expect(result).toMatchObject({ status: 'ok', count: 0, total: 0 });
  });

  it('returns tooLarge or names a failed tile, like the CSV', async () => {
    const tiles: string[] = [];
    for (let lat = -40; lat < -30; lat++) for (let lon = -70; lon < -60; lon++) tiles.push(`t_${lat}_${lon}`);
    expect(await monthDots(rectangle(-40, -70, -30, -60), august2020, { ...meta, tiles })).toEqual({
      status: 'tooLarge',
      tiles: 100,
      limit: 80,
    });
    server.files.set('points/t_-29_-59.csv.gz', new TypeError('Failed to fetch'));
    expect(await monthDots(corrientes, august2020, meta)).toMatchObject({ status: 'error', tileId: 't_-29_-59' });
  });
});

describe('areaSlug', () => {
  it('makes a file-name part from the area', () => {
    expect(areaSlug({ kind: 'province', id: '14' }, 'Córdoba')).toBe('cordoba');
    expect(areaSlug({ kind: 'province', id: 'AR' }, 'Argentina')).toBe('argentina');
    expect(areaSlug({ kind: 'province', id: '94' }, 'Tierra del Fuego, Antártida e Islas del Atlántico Sur')).toBe(
      'tierra-del-fuego-antartida-e-islas-del-atlantico-sur',
    );
    expect(areaSlug({ kind: 'province', id: '62' }, 'Río Negro')).toBe('rio-negro');
    expect(areaSlug({ kind: 'circle', lat: -31.4, lon: -64.2, km: 25 }, null)).toBe('circle_-31.4_-64.2_25km');
    expect(areaSlug({ kind: 'polygon', ring: [[-64, -31], [-63, -31], [-63, -30]] }, null)).toBe('drawn-area');
  });
});
