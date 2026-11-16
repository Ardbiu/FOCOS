// @vitest-environment jsdom
//
// The page, started on the sample data set with the map replaced by a recorder.
// These tests stand in for the plan's "check by hand" steps.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startApp, type App, type StartOptions } from '../src/app';
import { clearDataCache } from '../src/data';
import type { Area } from '../src/state';
import { completenessFromMeta, monthIdx, trend, yearlyTotals } from '../src/stats';
import { trendClass, trendFrom } from '../src/findings';
import { byId, choose, click, isHidden, mountPage, setValue, text } from './helpers/page';
import { serveSample, type SampleServer } from './helpers/sample-server';

const map = vi.hoisted(() => ({
  init: [] as unknown[][],
  areas: [] as unknown[][],
  dots: [] as unknown[][],
  languages: [] as unknown[][],
  trends: [] as unknown[],
  resized: 0,
  cleared: 0,
  listener: null as null | ((area: unknown) => void),
}));

vi.mock('../src/map', () => ({
  initMap: (...args: unknown[]) => void map.init.push(args),
  setArea: (...args: unknown[]) => void map.areas.push(args),
  onAreaChange: (listener: (area: unknown) => void) => void (map.listener = listener),
  showDots: (...args: unknown[]) => void map.dots.push(args),
  clearDots: () => void map.cleared++,
  setMapLanguage: (...args: unknown[]) => void map.languages.push(args),
  setProvinceTrends: (tones: unknown) => void map.trends.push(tones),
  refreshMapSize: () => void map.resized++,
}));

let server: SampleServer;
let app: App | null = null;
/** Files the page handed to the browser to save, and drawings it asked to turn into a PNG. */
let saved: Array<{ blob: Blob; fileName: string }> = [];
let pictures: SVGSVGElement[] = [];
let pngFails = false;
/** What the page put on the clipboard; `null` makes the clipboard refuse. */
let clipboard: string[] | null = [];

async function start(hash = '', options: StartOptions = {}): Promise<App> {
  mountPage(hash);
  app = startApp(document, {
    save: (blob, fileName) => void saved.push({ blob, fileName }),
    toPng: async (drawing) => {
      pictures.push(drawing);
      if (pngFails) throw new Error('no canvas');
      return new Blob(['png'], { type: 'image/png' });
    },
    copy: async (value) => {
      if (clipboard === null) throw new Error('clipboard blocked');
      clipboard.push(value);
    },
    ...options,
  });
  await app.idle();
  return app;
}

beforeEach(() => {
  server = serveSample();
  map.init.length = 0;
  map.areas.length = 0;
  map.trends.length = 0;
  map.dots.length = 0;
  map.languages.length = 0;
  map.resized = 0;
  map.cleared = 0;
  map.listener = null;
  saved = [];
  pictures = [];
  pngFails = false;
  clipboard = [];
});

afterEach(() => {
  app?.destroy();
  app = null;
  vi.unstubAllGlobals();
});

describe('start', () => {
  it('opens on all of Argentina, in English', async () => {
    await start();
    expect(document.documentElement.lang).toBe('en');
    expect(text('area-title')).toBe('Argentina');
    expect(byId<HTMLSelectElement>('province').value).toBe('AR');
    expect(Array.from(byId<HTMLSelectElement>('province').options).map((o) => [o.value, o.textContent])).toEqual([
      ['AR', 'All of Argentina'],
      ['18', 'Corrientes'],
      ['42', 'La Pampa'],
    ]);
    expect(location.hash).toBe('');
    expect(isHidden('area-notice')).toBe(true);
    expect(isHidden('load-status')).toBe(true);
  });

  it('fills the static text from the language file and names the data end date', async () => {
    await start();
    expect(document.querySelector('h1')!.textContent).toBe('Focos');
    expect(text('tagline').length).toBeGreaterThan(20);
    expect(text('data-through')).toBe('Data through 2026-11-14');
    for (const element of document.querySelectorAll('[data-i18n]')) {
      expect(element.textContent, element.getAttribute('data-i18n')!).not.toBe('');
      expect(element.textContent).not.toBe(element.getAttribute('data-i18n'));
    }
  });

  it('says in one plain line, under the name, why the two sensors need harmonizing', async () => {
    await start();
    expect(text('lede')).toBe(
      'MODIS and VIIRS count fires differently. Focos converts VIIRS to MODIS-equivalent hotspots, tested on years it never saw, so every year since 2003 can be compared.',
    );
    expect(byId('lede').closest('header')).not.toBeNull();
    click('lang-es');
    await app!.idle();
    expect(text('lede')).toMatch(/^MODIS y VIIRS cuentan los incendios de distinta manera/);
  });

  it('opens in Spanish when the address says so', async () => {
    await start('lang=es');
    expect(document.documentElement.lang).toBe('es');
    expect(byId<HTMLSelectElement>('province').options[0].textContent).toBe('Toda la Argentina');
    expect(text('data-through')).toBe('Datos hasta 2026-11-14');
  });

  it('gives the map the provinces and the starting area', async () => {
    await start('area=prov:18');
    expect(map.init).toHaveLength(1);
    expect((map.init[0][1] as { features: unknown[] }).features).toHaveLength(2);
    expect(map.areas[map.areas.length - 1][0]).toEqual({ kind: 'province', id: '18' });
  });
});

describe('choosing an area', () => {
  it('by province', async () => {
    await start();
    setValue('province', '18');
    await app!.idle();
    expect(text('area-title')).toBe('Corrientes');
    expect(location.hash).toBe('#area=prov:18');
    expect(app!.state().area).toEqual({ kind: 'province', id: '18' });
    setValue('province', 'AR');
    await app!.idle();
    expect(text('area-title')).toBe('Argentina');
    expect(location.hash).toBe('');
  });

  it('by point and radius', async () => {
    await start();
    setValue('circle-lat', '-28.5');
    setValue('circle-lon', '-57.9');
    setValue('circle-km', '30');
    byId<HTMLFormElement>('circle-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await app!.idle();
    expect(location.hash).toBe('#area=circle:-28.5,-57.9,30');
    expect(text('area-title')).toBe('30 km around -28.5, -57.9');
    expect(byId<HTMLSelectElement>('province').value).toBe('');
    expect(text('area-notice')).toBe('Drawn areas and circles are resolved at about 5 km.');
    expect(map.areas[map.areas.length - 1][0]).toEqual({ kind: 'circle', lat: -28.5, lon: -57.9, km: 30 });
  });

  it('clamps the radius and says so', async () => {
    await start();
    setValue('circle-lat', '-28.5');
    setValue('circle-lon', '-57.9');
    setValue('circle-km', '900');
    byId<HTMLFormElement>('circle-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await app!.idle();
    expect(app!.state().area).toEqual({ kind: 'circle', lat: -28.5, lon: -57.9, km: 300 });
    expect(byId<HTMLInputElement>('circle-km').value).toBe('300');
    expect(text('circle-message')).toBe('The radius was set to 300 km (allowed: 5 to 300).');
  });

  it('refuses a point with no latitude or longitude', async () => {
    await start();
    setValue('circle-lat', '');
    setValue('circle-lon', 'abc');
    byId<HTMLFormElement>('circle-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await app!.idle();
    expect(app!.state().area).toEqual({ kind: 'province', id: 'AR' });
    expect(text('circle-message')).toMatch(/^Enter a latitude/);
  });

  it('by drawing on the map', async () => {
    await start();
    const drawn: Area = { kind: 'polygon', ring: [[-58.3, -28.7], [-57.5, -28.7], [-57.5, -28.3], [-58.3, -28.3]] };
    map.listener!(drawn);
    await app!.idle();
    expect(app!.state().area).toEqual(drawn);
    expect(location.hash).toBe('#area=poly:-28.7,-58.3;-28.7,-57.5;-28.3,-57.5;-28.3,-58.3');
    expect(text('area-title')).toBe('Drawn area');
  });

  it('by clicking a province on the map', async () => {
    await start();
    map.listener!({ kind: 'province', id: '42' });
    await app!.idle();
    expect(text('area-title')).toBe('La Pampa');
    expect(byId<HTMLSelectElement>('province').value).toBe('42');
  });
});

describe('areas at the edge of the country', () => {
  it('says when part of the area is outside Argentina', async () => {
    await start('area=poly:-28.7,-59.5;-28.7,-58.2;-28.3,-58.2;-28.3,-59.5');
    expect(text('area-notice')).toContain('Part of this area is outside Argentina.');
    expect(isHidden('results-body')).toBe(false);
  });

  it('shows "outside coverage" instead of results for an area outside Argentina', async () => {
    await start('area=circle:-33,-61.5,25');
    expect(text('area-notice')).toMatch(/^This area is outside Argentina/);
    expect(isHidden('results-body')).toBe(true);
  });

  it('says when the area is smaller than a grid cell', async () => {
    await start('area=poly:-28.51,-57.91;-28.51,-57.9;-28.5,-57.9;-28.5,-57.91');
    expect(text('area-notice')).toContain('smaller than one grid cell');
  });

  it('says when a long, narrow area holds no cell center and the cells it crosses stand for it', async () => {
    await start('area=poly:-28.498,-57.95;-28.498,-57.65;-28.492,-57.65;-28.492,-57.95');
    expect(text('area-notice')).toContain('narrower than one grid cell');
    expect(text('area-notice')).not.toContain('smaller than one grid cell');
    expect(isHidden('results-body')).toBe(false);
  });

  it('falls back to the nation for a province it does not know', async () => {
    await start('area=prov:99');
    expect(text('area-title')).toBe('Argentina');
    expect(location.hash).toBe('');
  });
});

describe('years and CSV dates', () => {
  it('starts on the full range of years with data', async () => {
    await start();
    expect([byId<HTMLInputElement>('year-from').value, byId<HTMLInputElement>('year-to').value]).toEqual(['2003', '2026']);
    expect([byId<HTMLInputElement>('year-from').min, byId<HTMLInputElement>('year-to').max]).toEqual(['2003', '2026']);
    expect(text('year-range-label')).toBe('2003–2026');
  });

  it('keeps the year range in the address and in order', async () => {
    await start();
    setValue('year-from', '2010');
    setValue('year-to', '2020');
    expect(location.hash).toBe('#years=2010-2020');
    expect(text('year-range-label')).toBe('2010–2020');
    // Dragging the first year past the last one moves the last one along.
    setValue('year-from', '2022');
    expect(app!.state()).toMatchObject({ yearFrom: 2022, yearTo: 2022 });
    expect(byId<HTMLInputElement>('year-to').value).toBe('2022');
  });

  it('the CSV dates follow the year range until the user picks dates', async () => {
    await start();
    expect([byId<HTMLInputElement>('date-from').value, byId<HTMLInputElement>('date-to').value]).toEqual([
      '2003-01-01',
      '2026-11-14',
    ]);
    expect(byId<HTMLInputElement>('date-to').max).toBe('2026-11-14');
    setValue('year-from', '2010');
    setValue('year-to', '2020');
    expect([byId<HTMLInputElement>('date-from').value, byId<HTMLInputElement>('date-to').value]).toEqual([
      '2010-01-01',
      '2020-12-31',
    ]);
    setValue('date-from', '2015-03-01');
    expect(location.hash).toBe('#years=2010-2020&from=2015-03-01');
    setValue('year-from', '2012');
    expect(byId<HTMLInputElement>('date-from').value).toBe('2015-03-01');
    // Clearing a picker goes back to following the year range.
    setValue('date-from', '');
    expect(app!.state().dateFrom).toBeNull();
    expect(byId<HTMLInputElement>('date-from').value).toBe('2012-01-01');
  });

  it('restores years and dates from the address', async () => {
    await start('years=2015-2025&from=2020-01-01&to=2020-12-31');
    expect([byId<HTMLInputElement>('year-from').value, byId<HTMLInputElement>('year-to').value]).toEqual(['2015', '2025']);
    expect([byId<HTMLInputElement>('date-from').value, byId<HTMLInputElement>('date-to').value]).toEqual([
      '2020-01-01',
      '2020-12-31',
    ]);
  });
});

/** The calendar's cells, and one of them by year and month. */
const calendarCells = () => Array.from(document.querySelectorAll<SVGGElement>('#calendar g.cal-cell'));
const calendarCell = (year: number, month: number) =>
  document.querySelector<SVGGElement>(`#calendar g.cal-cell[data-idx="${monthIdx(year, month)}"]`)!;
const fillOf = (cell: SVGGElement) => cell.querySelector('rect')!.getAttribute('fill');
const radio = (name: string, value: string) =>
  document.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)!;
const submitCircle = (lat: string, lon: string, km: string) => {
  setValue('circle-lat', lat);
  setValue('circle-lon', lon);
  setValue('circle-km', km);
  byId<HTMLFormElement>('circle-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
};

describe('the calendar', () => {
  it('shows every year of the national record, with the 2011/2012 divider', async () => {
    await start();
    expect(calendarCells()).toHaveLength(24 * 12);
    expect(document.querySelector('#calendar .cal-divider')!.textContent).toBe('MODIS above, VIIRS harmonized below');
    expect(calendarCell(2026, 11).dataset.status).toBe('partial');
    expect(calendarCell(2026, 12).dataset.status).toBe('nodata');
    expect(calendarCell(2010, 9).dataset.status).toBe('incomplete');
    expect(byId('calendar').innerHTML).not.toMatch(/NaN|undefined|Infinity/);
    expect(radio('view', 'harmonized').checked).toBe(true);
    expect(radio('mode', 'count').checked).toBe(true);
  });

  it('is produced by each of the three ways of choosing an area', async () => {
    await start();
    const national = calendarCell(2020, 8).getAttribute('aria-label');

    setValue('province', '18');
    await app!.idle();
    const province = calendarCell(2020, 8).getAttribute('aria-label');
    expect(province).not.toBe(national);
    expect(byId('calendar').querySelector('svg')!.getAttribute('aria-label')).toContain('Corrientes');

    submitCircle('-28.5', '-57.9', '30');
    await app!.idle();
    const circle = calendarCell(2020, 8).getAttribute('aria-label');
    expect(circle).not.toBe(province);
    expect(calendarCells()).toHaveLength(24 * 12);
    // The loading line is gone, not just out of sight.
    expect(isHidden('load-status')).toBe(true);
    expect(text('load-status')).toBe('');

    map.listener!({ kind: 'polygon', ring: [[-65.8, -36.8], [-65.2, -36.8], [-65.2, -36.2], [-65.8, -36.2]] });
    await app!.idle();
    expect(calendarCell(2020, 8).getAttribute('aria-label')).not.toBe(circle);
    expect(calendarCells()).toHaveLength(24 * 12);
  });

  it('follows the year range', async () => {
    await start();
    setValue('year-from', '2015');
    setValue('year-to', '2020');
    expect(calendarCells()).toHaveLength(6 * 12);
    expect(document.querySelector('#calendar .cal-divider')).toBeNull();
  });

  it('switches to anomaly mode and back, keeping the mode in the address', async () => {
    await start();
    const counted = fillOf(calendarCell(2022, 2));
    choose('mode', 'anomaly');
    expect(location.hash).toBe('#mode=anomaly');
    expect(fillOf(calendarCell(2022, 2))).not.toBe(counted);
    expect(document.querySelector('#calendar svg')!.textContent).toContain('Compared with the usual level for the month');
    choose('mode', 'count');
    expect(location.hash).toBe('');
    expect(fillOf(calendarCell(2022, 2))).toBe(counted);
  });

  it('switches to the Raw view: banner, divider, raw counts, anomaly mode off', async () => {
    await start('mode=anomaly');
    expect(isHidden('raw-banner')).toBe(true);
    const harmonized = calendarCell(2020, 8).getAttribute('aria-label')!;
    choose('view', 'raw');
    await app!.idle();
    expect(location.hash).toBe('#mode=anomaly&view=raw');
    expect(isHidden('raw-banner')).toBe(false);
    // The banner sits over the yearly totals as well as the calendar, so it names the years, not "above" and "below".
    expect(text('raw-banner')).toContain('MODIS up to 2011 and raw VIIRS from 2012 are not comparable');
    expect(document.querySelector('#calendar .cal-divider')!.textContent).toBe('MODIS above, raw VIIRS below: not comparable');
    expect(calendarCell(2020, 8).getAttribute('aria-label')).toContain('raw detections');
    expect(calendarCell(2020, 8).getAttribute('aria-label')).not.toBe(harmonized);
    expect(radio('mode', 'anomaly').disabled).toBe(true);
    expect(radio('mode', 'count').checked).toBe(true);
    // Back to Harmonized: the anomaly mode the address asked for returns.
    choose('view', 'harmonized');
    await app!.idle();
    expect(isHidden('raw-banner')).toBe(true);
    expect(radio('mode', 'anomaly').disabled).toBe(false);
    expect(radio('mode', 'anomaly').checked).toBe(true);
    expect(calendarCell(2020, 8).getAttribute('aria-label')).toBe(harmonized);
  });

  it('loads the raw grid for a drawn area only when the Raw view is opened', async () => {
    await start('area=circle:-28.5,-57.9,30');
    expect(server.count('grid/raw.bin.gz')).toBe(0);
    choose('view', 'raw');
    await app!.idle();
    expect(server.count('grid/raw.bin.gz')).toBe(1);
    expect(calendarCell(2020, 8).getAttribute('aria-label')).toContain('raw detection');
    expect(isHidden('load-status')).toBe(true);
  });

  it('shows the same numbers as a table on request', async () => {
    await start();
    expect(isHidden('calendar-table')).toBe(true);
    click('table-toggle');
    expect(byId('table-toggle').getAttribute('aria-pressed')).toBe('true');
    expect(isHidden('calendar-table')).toBe(false);
    expect(isHidden('calendar')).toBe(true);
    expect(byId('calendar-table').querySelectorAll('tbody tr')).toHaveLength(24);
    expect(byId('calendar-table').querySelector('caption')!.textContent).toBe('MODIS-equivalent hotspots per month, Argentina');
    click('table-toggle');
    expect(isHidden('calendar-table')).toBe(true);
    expect(isHidden('calendar')).toBe(false);
  });

  it('says before any click that the whole country is too large for detections on the map or in the CSV', async () => {
    await start();
    expect(text('cell-detail')).toBe(
      'Select a month to see its numbers here. To see its satellite detections on the map, choose a province or draw an area.',
    );
    expect(isHidden('hotspots-hint')).toBe(false);
    expect(text('hotspots-hint')).toBe('For the whole country the hotspots CSV would be too large: choose a province or draw an area first.');
    setValue('province', '18');
    await app!.idle();
    expect(text('cell-detail')).toBe('Select a month to see its numbers here and its satellite detections on the map.');
    expect(isHidden('hotspots-hint')).toBe(true);
  });

  it('selects a month on click, says what it holds, and lets it go on a second click', async () => {
    await start();
    click(calendarCell(2022, 2).querySelector('rect')!);
    await app!.idle();
    expect(location.hash).toBe('#sel=2022-02');
    expect(calendarCell(2022, 2).getAttribute('aria-pressed')).toBe('true');
    expect(text('cell-detail')).toMatch(/^Feb 2022 · \d+ MODIS-equivalent hotspots · Usual level for this month/);
    click(calendarCell(2022, 2).querySelector('rect')!);
    await app!.idle();
    expect(location.hash).toBe('');
    expect(calendarCell(2022, 2).getAttribute('aria-pressed')).toBe('false');
  });

  it('restores the selected month from the address and drops it when the area changes', async () => {
    await start('area=prov:18&sel=2022-02');
    expect(calendarCell(2022, 2).getAttribute('aria-pressed')).toBe('true');
    setValue('province', '42');
    await app!.idle();
    expect(app!.state().sel).toBeNull();
    expect(location.hash).toBe('#area=prov:42');
  });

  it('uses the error bands of validation.json once it has loaded, and works without it', async () => {
    await start();
    // The sample's validation.json is empty: the carrier's own typical error is used.
    expect(calendarCell(2020, 8).getAttribute('aria-label')).toContain('In the test, a count this size typically came within 18% of MODIS (S-NPP VIIRS)');
    app!.destroy();
    server.files.set(
      'validation.json',
      JSON.stringify({ error_by_count: [{ band: '1-4', n: 9, mape: 120 }, { band: '5-19', n: 9, mape: 44 }, { band: '20+', n: 9, mape: 16 }] }),
    );
    clearDataCache();
    await start();
    expect(calendarCell(2020, 8).getAttribute('aria-label')).toContain('In the test, a count this size typically came within 16% of MODIS (S-NPP VIIRS)');
    app!.destroy();
    server.files.set('validation.json', { status: 404 });
    clearDataCache();
    await start();
    expect(calendarCell(2020, 8).getAttribute('aria-label')).toContain('within 18% of MODIS (S-NPP VIIRS)');
  });
});

describe('the verdict, the test line and the caution', () => {
  it('opens on the nation: its long-term trend first, then the latest month', async () => {
    await start();
    expect(text('verdict-label')).toBe('Long-term trend');
    expect(text('verdict-text')).toBe('Rising about 33% per decade since 2003 (p = 0.004). Since 2012 alone, no significant trend.');
    expect(text('verdict-more')).toBe(
      'Fire here is spread over most of the year and peaks in January. Nov 1–14, 2026 is 2.3× the usual level, the highest Nov 1–14 since 2003.',
    );
    expect(isHidden('verdict-card')).toBe(false);
  });

  it('follows the selected month and the selected area', async () => {
    await start('area=prov:18');
    const latest = text('verdict-text');
    click(calendarCell(2022, 2).querySelector('rect')!);
    await app!.idle();
    expect(text('verdict-label')).toBe('Selected month');
    expect(text('verdict-text')).toBe(
      'Fire here is spread over most of the year and peaks in August. Feb 2022 is 7.6× the usual level, the highest February since 2003.',
    );
    expect(text('verdict-text')).not.toBe(latest);
    click(calendarCell(2010, 9).querySelector('rect')!);
    await app!.idle();
    expect(text('verdict-text')).toContain('Sep 2010 has incomplete satellite data');
  });

  it('leads with the long-term trend where there is a clear one, and puts the latest month under it', async () => {
    await start('area=prov:42');
    expect(text('verdict-label')).toBe('Long-term trend');
    expect(text('verdict-text')).toBe('Rising about 32% per decade since 2003 (p = 0.006). Since 2012 alone, no significant trend.');
    expect(text('verdict-more')).toMatch(/^Fire season here runs Nov–Feb and peaks in January\. Nov 1–14, 2026 /);
    // The sentence is in the headline: it is not said again under the yearly chart.
    expect(isHidden('trend-text')).toBe(true);
    // A headline wraps: the p-value stays in one piece, never "(p" at the end of one line and "= 0.006)" on the next.
    expect(byId('verdict-text').textContent).toBe('Rising about 32% per decade since 2003 (p\u00a0=\u00a00.006). Since 2012 alone, no significant trend.');
  });

  it('leads with the latest month where there is no clear trend, and says so under it', async () => {
    await start('area=prov:18');
    expect(text('verdict-label')).toBe('Latest month');
    expect(text('verdict-text')).toMatch(/^Fire here is spread over most of the year and peaks in August\. Nov 1–14, 2026 /);
    expect(text('verdict-more')).toBe('No significant trend since 2003.');
    expect(isHidden('trend-text')).toBe(true);
  });

  it('leads with a selected month whatever the trend, because the reader asked about that month', async () => {
    await start('area=prov:42&sel=2017-01');
    expect(text('verdict-label')).toBe('Selected month');
    expect(text('verdict-text')).toContain('Jan 2017 is 3.3× the usual level, the highest January since 2003.');
    expect(text('verdict-more')).toBe('Rising about 32% per decade since 2003 (p = 0.006). Since 2012 alone, no significant trend.');
    // Letting the month go brings the trend back to the top.
    click(calendarCell(2017, 1).querySelector('rect')!);
    await app!.idle();
    expect(text('verdict-label')).toBe('Long-term trend');
    expect(text('verdict-text')).toBe('Rising about 32% per decade since 2003 (p = 0.006). Since 2012 alone, no significant trend.');
  });

  it('puts the answer first: headline, switch, yearly totals, then the calendar and the seasonal profile', async () => {
    await start('area=prov:42');
    const order = [
      byId('verdict-card'),
      byId('test-line'),
      radio('view', 'harmonized'),
      byId('raw-banner'),
      byId('yearly'),
      byId('calendar'),
      byId('seasonal'),
      byId('download-calendar'),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // The switch belongs to the whole panel now, not to the calendar; the colour mode stays with the calendar.
    expect(radio('view', 'raw').closest('.calendar-card')).toBeNull();
    expect(radio('mode', 'count').closest('.calendar-card')).not.toBeNull();
    // One line next to the switch says what Raw is for, with the year of the sensor switch from the data.
    expect(text('view-hint')).toBe('Raw shows the counts before harmonization, with the jump at the sensor switch in 2012.');
  });

  it('draws the trend over the yearly totals where it is clear, and says what the line is', async () => {
    await start('area=prov:42');
    expect(document.querySelector('#yearly line.trend-line')).not.toBeNull();
    expect(isHidden('trend-line-hint')).toBe(false);
    expect(text('trend-line-hint')).toBe('Blue line: the trend, fitted to the complete years.');
    // No clear trend, no line.
    setValue('province', '18');
    await app!.idle();
    expect(document.querySelector('#yearly line.trend-line')).toBeNull();
    expect(isHidden('trend-line-hint')).toBe(true);
    // Raw counts: the rise is the change of sensor, so no line there either, and the sentence under the chart says so.
    setValue('province', '42');
    await app!.idle();
    choose('view', 'raw');
    await app!.idle();
    expect(document.querySelector('#yearly line.trend-line')).toBeNull();
    expect(isHidden('trend-line-hint')).toBe(true);
    expect(isHidden('trend-text')).toBe(false);
    expect(text('trend-text')).toMatch(/^Raw counts: .* This includes the sensor switch in 2012\.$/);
  });

  it('says beside the trend what the raw counts would have said', async () => {
    await start('area=prov:18');
    expect(isHidden('raw-trend')).toBe(false);
    expect(text('raw-trend')).toBe('Stitched without harmonizing, raw counts would show: rising about 297% per decade since 2003 (p < 0.001).');
    // In Spanish too.
    click('lang-es');
    await app!.idle();
    expect(text('raw-trend')).toBe('Empalmados sin armonizar, los conteos mostrarían: en aumento, cerca de un 297 % por década desde 2003 (p < 0,001).');
    click('lang-en');
    await app!.idle();
    // A drawn area's raw counts are only loaded for the Raw view: until then the line is left out.
    submitCircle('-28.5', '-57.9', '30');
    await app!.idle();
    expect(isHidden('raw-trend')).toBe(true);
  });

  it('says beside a clear trend when the years since the switch alone show none', async () => {
    // The sample's La Pampa rises over 2003–2025; from 2012 alone it may not. The line says which.
    await start('area=prov:42');
    const summary = server.json('summary/provinces.json');
    const c = completenessFromMeta(server.json('meta.json'));
    const totals = yearlyTotals(summary.areas[2].monthly, c);
    const recentNone = trendClass(trend(totals)) !== 'none' && trendClass(trendFrom(totals, 2012)) === 'none';
    expect(text('verdict-text').endsWith(' Since 2012 alone, no significant trend.')).toBe(recentNone);
    // A synthetic step: falling to 2011, flat after.
    app!.destroy();
    const step = summary.areas[2].monthly.map((_value: number, idx: number) => (idx < 108 ? 60 - Math.floor(idx / 12) * 4 : 20 + (idx % 3)));
    server.files.set('summary/provinces.json', JSON.stringify({ areas: [summary.areas[0], summary.areas[1], { ...summary.areas[2], monthly: step }] }));
    clearDataCache();
    await start('area=prov:42');
    expect(text('verdict-text')).toMatch(/^Falling about \d+% per decade since 2003 \(p [=<] [\d.]+\)\. Since 2012 alone, no significant trend\.$/);
    click('lang-es');
    await app!.idle();
    expect(text('verdict-text')).toMatch(/ Si se toma solo desde 2012, no hay tendencia significativa\.$/);
  });

  it('never leads, not even on the first paint, with a trend that fails its check', async () => {
    const validation = JSON.stringify({
      test_years: [2020, 2021],
      province_bias: [{ prov: '42', name: 'La Pampa', aqua: 100, harmonized: 168, bias: 0.68 }],
    });
    // validation.json arrives after the series: the page waits for it before the first headline.
    server.files.set('validation.json', () => new Promise((resolve) => setTimeout(() => resolve(validation), 40)));
    clearDataCache();
    mountPage('area=prov:42');
    const labels: string[] = [];
    const observer = new MutationObserver(() => labels.push(text('verdict-label')));
    observer.observe(byId('verdict-label'), { childList: true, characterData: true, subtree: true });
    app = startApp(document, { save: () => undefined, toPng: async () => new Blob([]), copy: async () => undefined });
    await app.idle();
    observer.disconnect();
    expect(labels.length).toBeGreaterThan(0);
    expect(labels).not.toContain('Long-term trend');
    expect(text('verdict-label')).toBe('Latest month');
  });

  it('does not wait long for a validation.json that hangs, and applies it when it comes', async () => {
    let deliver: (body: string) => void = () => undefined;
    server.files.set('validation.json', () => new Promise((resolve) => (deliver = resolve)));
    clearDataCache();
    mountPage('area=prov:42');
    app = startApp(document, { save: () => undefined, toPng: async () => new Blob([]), copy: async () => undefined, validationWaitMs: 20 });
    await app.drawn();
    expect(text('verdict-label')).toBe('Long-term trend'); // nothing is known about a gap yet
    deliver(JSON.stringify({ test_years: [2020, 2021], province_bias: [{ prov: '42', name: 'La Pampa', aqua: 100, harmonized: 168, bias: 0.68 }] }));
    await app.idle();
    expect(text('verdict-label')).toBe('Latest month');
    expect(isHidden('caution')).toBe(false);
  });

  it('re-tests the trend of a province that ran far from MODIS in the test, and says whether it holds', async () => {
    server.files.set(
      'validation.json',
      JSON.stringify({
        test_years: [2020, 2021],
        province_bias: [
          { prov: '18', name: 'Corrientes', aqua: 100, harmonized: 168, bias: 0.68 },
          { prov: '42', name: 'La Pampa', aqua: 100, harmonized: 116, bias: 0.16 },
        ],
      }),
    );
    clearDataCache();
    // Corrientes shows no trend, with or without the 68%.
    await start('area=prov:18');
    expect(isHidden('caution')).toBe(false);
    expect(isHidden('caution-check')).toBe(false);
    expect(text('caution-check')).toBe('With that gap removed from every VIIRS year, there is still no significant trend.');
    expect(text('verdict-more')).toBe('No significant trend since 2003.');
    // La Pampa rises; with 16% taken out it still rises.
    setValue('province', '42');
    await app!.idle();
    expect(text('verdict-text')).toBe('Rising about 32% per decade since 2003 (p = 0.006). Since 2012 alone, no significant trend.');
    expect(text('caution-check')).toMatch(
      /^With that gap removed from every VIIRS year, the trend holds: rising about \d+% per decade since 2003 \(p [=<] [\d.]+\)\.$/,
    );
    // Had it run 68% high, the rise would not survive. No count changes: it is a check, not a correction.
    app!.destroy();
    server.files.set(
      'validation.json',
      JSON.stringify({ test_years: [2020, 2021], province_bias: [{ prov: '42', name: 'La Pampa', aqua: 100, harmonized: 168, bias: 0.68 }] }),
    );
    clearDataCache();
    await start('area=prov:42');
    // A trend that does not survive its own check is not a headline: the month leads, and the trend is said under it.
    expect(text('verdict-label')).toBe('Latest month');
    expect(text('verdict-text')).toMatch(/^Fire season here runs Nov–Feb and peaks in January\. /);
    expect(text('verdict-more')).toBe('Rising about 32% per decade since 2003 (p = 0.006). Since 2012 alone, no significant trend.');
    expect(document.querySelectorAll('#yearly g.year-bar')).toHaveLength(24);
    expect(text('caution-check')).toMatch(
      /^With that gap removed from every VIIRS year, the trend would read: (no significant trend since 2003|falling about \d+% per decade since 2003 \(p [=<] [\d.]+\))\.$/,
    );
    // No caution, no check: the nation, a drawn area, and Raw view.
    setValue('province', 'AR');
    await app!.idle();
    expect(isHidden('caution-check')).toBe(true);
    setValue('province', '42');
    await app!.idle();
    choose('view', 'raw');
    await app!.idle();
    expect(isHidden('caution-check')).toBe(true);
  });

  it('says how months as far above their usual level read in the test, without judging this one', async () => {
    server.files.set(
      'validation.json',
      JSON.stringify({
        test_years: [2020, 2021],
        bias_by_level: [
          { band: '0.5-2x', n: 300, bias: 0.02, mape: 20 },
          { band: '5-10x', n: 10, bias: -0.1, mape: 15 },
          { band: '10x+', n: 5, bias: -0.16, mape: 18 },
        ],
      }),
    );
    clearDataCache();
    // Corrientes, February 2022: 7.6 times the usual level.
    await start('area=prov:18&sel=2022-02');
    expect(text('verdict-text')).toContain('Feb 2022 is 7.6× the usual level');
    expect(isHidden('extreme-note')).toBe(false);
    expect(text('extreme-note')).toBe(
      'On average, months at 5 to 10 times their usual level read about 10% low in the test; single months varied around that.',
    );
    // An ordinary month carries no such note.
    click(calendarCell(2021, 6).querySelector('rect')!);
    await app!.idle();
    expect(isHidden('extreme-note')).toBe(true);
    // Nor do raw counts, which the test did not rate.
    click(calendarCell(2022, 2).querySelector('rect')!);
    await app!.idle();
    expect(isHidden('extreme-note')).toBe(false);
    choose('view', 'raw');
    await app!.idle();
    expect(isHidden('extreme-note')).toBe(true);
  });

  it('says nothing about extreme months when the test file has no figure for them', async () => {
    await start('area=prov:18&sel=2022-02'); // the sample's validation.json is empty
    expect(isHidden('extreme-note')).toBe(true);
  });

  it('runs no check for a province within 15% of MODIS', async () => {
    server.files.set(
      'validation.json',
      JSON.stringify({ test_years: [2020, 2021], province_bias: [{ prov: '42', name: 'La Pampa', aqua: 100, harmonized: 104, bias: 0.04 }] }),
    );
    clearDataCache();
    await start('area=prov:42');
    expect(isHidden('caution')).toBe(true);
    expect(isHidden('caution-check')).toBe(true);
  });

  it('states the held-out test under the verdict, with a link to the method page', async () => {
    await start();
    expect(text('test-line')).toBe(
      'Tested on 2020–2021, years the method never saw: a province’s monthly count typically came within 18% of MODIS (naive stitch: 310% off). Errors are larger for small areas and small counts. How it works',
    );
    expect(byId('test-line').querySelector('a')!.getAttribute('href')).toBe('method.html');
  });

  it('switches the verdict and the seasonal profile off in Raw view, and keeps the test line', async () => {
    await start();
    choose('view', 'raw');
    await app!.idle();
    expect(isHidden('verdict-card')).toBe(true);
    expect(isHidden('seasonal-card')).toBe(true);
    expect(isHidden('test-line')).toBe(false);
    choose('view', 'harmonized');
    await app!.idle();
    expect(isHidden('verdict-card')).toBe(false);
    expect(isHidden('seasonal-card')).toBe(false);
  });

  it('warns about a province that ran far from MODIS in the test, and only there', async () => {
    await start('area=prov:18');
    expect(isHidden('caution')).toBe(true); // the sample's validation.json is empty
    app!.destroy();
    server.files.set(
      'validation.json',
      JSON.stringify({
        test_years: [2020, 2021],
        province_bias: [
          { prov: '18', name: 'Corrientes', aqua: 100, harmonized: 168, bias: 0.68 },
          { prov: '42', name: 'La Pampa', aqua: 100, harmonized: 104, bias: 0.04 },
        ],
      }),
    );
    clearDataCache();
    await start('area=prov:18');
    expect(isHidden('caution')).toBe(false);
    expect(text('caution')).toBe('In Corrientes the harmonized record ran 68% above MODIS in the 2020–2021 test.');
    setValue('province', '42');
    await app!.idle();
    expect(isHidden('caution')).toBe(true);
    setValue('province', 'AR');
    await app!.idle();
    expect(isHidden('caution')).toBe(true);
    setValue('province', '18');
    await app!.idle();
    expect(isHidden('caution')).toBe(false);
    choose('view', 'raw');
    await app!.idle();
    expect(isHidden('caution')).toBe(true);
    submitCircle('-28.5', '-57.9', '30');
    await app!.idle();
    expect(isHidden('caution')).toBe(true);
  });
});

describe('the provinces’ trends on the map', () => {
  type Tones = { tones: Record<string, { tone: string; unsure: boolean }>; legend: Record<string, string> } | null;
  const shown = () => map.trends[map.trends.length - 1] as Tones;

  it('colours the provinces by their harmonized trend while the whole country is selected', async () => {
    await start();
    expect(shown()!.tones).toEqual({ '18': { tone: 'none', unsure: false }, '42': { tone: 'rising', unsure: false } });
    expect(shown()!.legend).toEqual({
      title: 'Trend since 2003',
      falling: 'Falling',
      none: 'No significant trend',
      rising: 'Rising',
      unrated: 'Too little fire',
      unsure: 'Dashed: the trend fails its check',
    });
  });

  it('takes the colours off for a single province, a drawn area and raw counts, and puts them back for the country', async () => {
    await start();
    setValue('province', '18');
    await app!.idle();
    expect(shown()).toBeNull();
    setValue('province', 'AR');
    await app!.idle();
    expect(shown()).not.toBeNull();
    choose('view', 'raw');
    await app!.idle();
    expect(shown()).toBeNull();
    choose('view', 'harmonized');
    await app!.idle();
    submitCircle('-28.5', '-57.9', '30');
    await app!.idle();
    expect(shown()).toBeNull();
  });

  it('marks a province whose trend fails its check, and writes the legend in Spanish on request', async () => {
    server.files.set(
      'validation.json',
      JSON.stringify({ test_years: [2020, 2021], province_bias: [{ prov: '42', name: 'La Pampa', aqua: 100, harmonized: 168, bias: 0.68 }] }),
    );
    clearDataCache();
    await start();
    expect(shown()!.tones['42']).toEqual({ tone: 'rising', unsure: true });
    click('lang-es');
    await app!.idle();
    expect(shown()!.legend.title).toBe('Tendencia desde 2003');
    expect(shown()!.legend.unsure).toBe('Punteado: la tendencia no supera su comprobación');
  });
});

describe('the yearly totals and the calendar point at each other', () => {
  const bar = (year: number) => document.querySelector<SVGGElement>(`#yearly g.year-bar[data-year="${year}"]`)!;
  const row = (year: number) => document.querySelector<SVGGElement>(`#calendar g.cal-row[data-year="${year}"]`)!;
  const linked = () => Array.from(document.querySelectorAll('#yearly .linked, #calendar .linked')).map((e) => e.getAttribute('data-year'));
  const point = (target: Element, type: 'pointerover' | 'pointerout', to: Element | null = null) =>
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: to }));

  it('marks a year’s row in the calendar while its bar is pointed at, and lets go when the pointer leaves', async () => {
    await start('area=prov:42');
    expect(linked()).toEqual([]);
    point(bar(2017).querySelector('rect')!, 'pointerover');
    expect(row(2017).classList.contains('linked')).toBe(true);
    expect(bar(2017).classList.contains('linked')).toBe(true);
    expect(linked()).toEqual(['2017', '2017']);
    // To the next bar: the mark moves with it.
    point(bar(2017).querySelector('rect')!, 'pointerout', bar(2018).querySelector('rect'));
    point(bar(2018).querySelector('rect')!, 'pointerover');
    expect(linked()).toEqual(['2018', '2018']);
    point(bar(2018).querySelector('rect')!, 'pointerout', byId('yearly'));
    expect(linked()).toEqual([]);
  });

  it('marks a year’s bar while a month of that year is pointed at in the calendar, or has the keyboard focus', async () => {
    await start('area=prov:42');
    point(calendarCell(2010, 9).querySelector('rect')!, 'pointerover');
    expect(bar(2010).classList.contains('linked')).toBe(true);
    expect(row(2010).classList.contains('linked')).toBe(true);
    point(calendarCell(2010, 9).querySelector('rect')!, 'pointerout', null);
    expect(linked()).toEqual([]);
    calendarCell(2021, 3).dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(linked()).toEqual(['2021', '2021']);
    calendarCell(2021, 3).dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(linked()).toEqual([]);
  });

  it('keeps no mark through a redraw, and marks nothing for a year the calendar does not show', async () => {
    await start('area=prov:42&years=2015-2020');
    point(bar(2008).querySelector('rect')!, 'pointerover');
    expect(bar(2008).classList.contains('linked')).toBe(true);
    expect(document.querySelector('#calendar .linked')).toBeNull();
    choose('mode', 'anomaly');
    await app!.idle();
    expect(linked()).toEqual([]);
  });
});

describe('yearly totals, trend and seasonal profile', () => {
  const bars = () => Array.from(document.querySelectorAll<SVGGElement>('#yearly g.year-bar'));

  it('draws a bar for every year, labels the top three and hatches the years that are not complete', async () => {
    await start();
    expect(bars()).toHaveLength(24);
    expect(document.querySelectorAll('#yearly .year-bar-label')).toHaveLength(3);
    const hatched = Array.from(document.querySelectorAll('#yearly .year-bar-hatch')).map((h) => h.parentElement!.dataset.year);
    expect(hatched).toEqual(['2010', '2019', '2026']);
    expect(bars()[0].getAttribute('aria-label')).toMatch(/^2003: \d+ MODIS-equivalent hotspots$/);
  });

  it('gives the trend of the harmonized series in a sentence, in the headline', async () => {
    await start('area=prov:42');
    expect(text('verdict-text')).toBe('Rising about 32% per decade since 2003 (p = 0.006). Since 2012 alone, no significant trend.');
    setValue('province', '18');
    await app!.idle();
    expect(text('verdict-more')).toBe('No significant trend since 2003.');
  });

  it('follows the switch: in Raw view the bars and the trend are those of the raw counts', async () => {
    await start('area=prov:18');
    const harmonized = bars()[20].getAttribute('aria-label');
    choose('view', 'raw');
    await app!.idle();
    expect(bars()[20].getAttribute('aria-label')).toMatch(/raw detections$/);
    expect(bars()[20].getAttribute('aria-label')).not.toBe(harmonized);
    expect(text('trend-text')).toBe(
      'Raw counts: rising about 297% per decade since 2003 (p < 0.001). This includes the sensor switch in 2012.',
    );
  });

  it('says how the year so far compares with the same date in earlier years', async () => {
    await start();
    expect(isHidden('year-so-far')).toBe(false);
    expect(text('year-so-far')).toMatch(
      /^2026 up to Nov 14: [\d,]+ MODIS-equivalent hotspots, \d+\.\d× the usual total by that date, the (highest|lowest|\d+(st|nd|rd|th) highest) since 2003\.$/,
    );
    // It is the same span the app's own numbers give: ten full months and November to the 14th.
    const area = server.json('summary/provinces.json').areas[0];
    const expected = area.monthly.slice(monthIdx(2026, 1), monthIdx(2026, 11)).reduce((sum: number, value: number) => sum + value, 0) + area.mtd[23];
    expect(text('year-so-far')).toContain(`: ${Math.round(expected).toLocaleString('en-US')} MODIS-equivalent hotspots`);
    click('lang-es');
    await app!.idle();
    expect(text('year-so-far')).toMatch(/^2026 hasta el 14 de nov: /);
  });

  it('draws the seasonal profile for the latest year, or the year of the selected month', async () => {
    await start();
    const year = () => document.querySelector('#seasonal svg')!.getAttribute('aria-label');
    expect(year()).toContain('with 2026.');
    expect(document.querySelectorAll('#seasonal circle.profile-point')).toHaveLength(11);
    click(calendarCell(2022, 2).querySelector('rect')!);
    await app!.idle();
    expect(year()).toContain('with 2022.');
    expect(document.querySelectorAll('#seasonal circle.profile-point')).toHaveLength(12);
  });

  it('explains instead of drawing empty charts where there is no fire', async () => {
    const summary = server.json('summary/provinces.json');
    const zeros = { monthly: new Array(287).fill(0), raw: new Array(287).fill(0), mtd: new Array(24).fill(0) };
    server.files.set('summary/provinces.json', JSON.stringify({ areas: [summary.areas[0], { ...summary.areas[1], ...zeros }, summary.areas[2]] }));
    await start('area=prov:18');
    expect(text('yearly')).toBe('No hotspots were recorded in this area.');
    expect(text('seasonal')).toBe('No hotspots were recorded in this area.');
    expect(text('verdict-more')).toBe('Too little fire here to assess a trend.');
    expect(isHidden('trend-line-hint')).toBe(true);
    expect(text('verdict-text')).toBe(
      'There is no clear fire season here. Nov 1–14, 2026 has no hotspots. Usually almost no fire here this month.',
    );
    expect(document.querySelector('#calendar .calendar-empty')).not.toBeNull();
    expect(byId('results').innerHTML).not.toMatch(/NaN|undefined|Infinity/);
  });
});

describe('on a narrow screen', () => {
  // A phone: the browser says the screen is not 60rem wide.
  beforeEach(() => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query }));
  });
  const details = () => byId<HTMLDetailsElement>('map-details');
  const open = async () => {
    details().open = true;
    details().dispatchEvent(new Event('toggle'));
    await app!.idle();
  };

  it('puts the province list and the results first and keeps the map folded away', async () => {
    await start();
    expect(details().open).toBe(false);
    expect(text('map-summary')).toBe('Draw on the map or pick a point');
    // The map, with Leaflet behind it, is not even loaded until it is asked for.
    expect(map.init).toHaveLength(0);
    expect(server.requests).not.toContain('provinces.geojson');
    expect(text('verdict-more')).toContain('Nov 1–14, 2026 is 2.3× the usual level');
    expect(calendarCells()).toHaveLength(24 * 12);
    // In the page, the province list comes before the folded map, and the results after it.
    const order = ['province', 'map-details', 'verdict-card', 'calendar'].map((id) => byId(id));
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('loads the map when the reader opens it, with the area and the dots already chosen', async () => {
    await start('area=prov:18&sel=2020-08');
    expect(map.init).toHaveLength(0);
    expect(map.dots).toHaveLength(0);
    await open();
    expect(map.init).toHaveLength(1);
    expect(map.areas[map.areas.length - 1][0]).toEqual({ kind: 'province', id: '18' });
    expect(map.dots).toHaveLength(1);
    expect(text('dots-status')).toMatch(/^\d+ satellite detections of Aug 2020 on the map\. Weighted, /);
  });

  it('loads the map once, and tells it when its box is shown again', async () => {
    await start();
    await open();
    details().open = false;
    details().dispatchEvent(new Event('toggle'));
    await open();
    expect(map.init).toHaveLength(1);
    expect(map.resized).toBeGreaterThan(0);
  });

  it('still takes a point and radius from the form inside', async () => {
    await start();
    await open();
    submitCircle('-28.5', '-57.9', '30');
    await app!.idle();
    expect(text('area-title')).toBe('30 km around -28.5, -57.9');
  });
});

describe('on a wide screen', () => {
  it('opens the map panel at once', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: true, media: query }));
    await start();
    expect(byId<HTMLDetailsElement>('map-details').open).toBe(true);
    expect(map.init).toHaveLength(1);
  });
});

describe('page title and description', () => {
  it('names the page in the language of the reader', async () => {
    document.head.innerHTML = '<meta name="description" content="">';
    await start();
    expect(document.title).toBe('Focos: a fire calendar for Argentina');
    expect(document.querySelector('meta[name="description"]')!.getAttribute('content')).toMatch(/^See when any area of Argentina burns/);
    click('lang-es');
    await app!.idle();
    expect(document.title).toBe('Focos: un calendario de incendios para la Argentina');
    expect(document.querySelector('meta[name="description"]')!.getAttribute('content')).toMatch(/^Mirá cuándo se quema/);
  });
});

describe('languages', () => {
  it('switches to Spanish and back with the toggle, and keeps the choice in the address', async () => {
    await start('area=prov:42');
    expect(byId('lang-en').getAttribute('aria-pressed')).toBe('true');
    expect(byId('lang-es').getAttribute('aria-pressed')).toBe('false');
    click('lang-es');
    await app!.idle();
    expect(document.documentElement.lang).toBe('es');
    expect(location.hash).toBe('#area=prov:42&lang=es');
    expect(byId('lang-es').getAttribute('aria-pressed')).toBe('true');
    expect(text('tagline')).toBe('Un solo calendario de incendios para la Argentina con MODIS y VIIRS, desde 2003');
    expect(text('verdict-label')).toBe('Tendencia de largo plazo');
    expect(text('verdict-text')).toBe('En aumento, cerca de un 32 % por década desde 2003 (p = 0,006). Si se toma solo desde 2012, no hay tendencia significativa.');
    expect(text('verdict-more')).toMatch(/^La temporada de incendios aquí va de nov a feb y alcanza su máximo en enero\. 1–14 nov 2026: /);
    expect(text('view-hint')).toBe(
      '«Sin armonizar» muestra los conteos antes de la armonización, con el salto del cambio de sensor en 2012.',
    );
    expect(text('trend-line-hint')).toBe('Línea azul: la tendencia, ajustada a los años completos.');
    expect(document.querySelector('#calendar .cal-divider')!.textContent).toBe('MODIS arriba, VIIRS armonizado abajo');
    expect(byId<HTMLSelectElement>('province').options[0].textContent).toBe('Toda la Argentina');
    expect(text('data-through')).toBe('Datos hasta 2026-11-14');
    expect(map.languages[map.languages.length - 1][0]).toBe('es');
    expect(byId<HTMLAnchorElement>('method-link').getAttribute('href')).toBe('method.html#lang=es');
    // The link under the verdict goes to the Spanish method page as well.
    expect(byId('test-line').querySelector('a')!.getAttribute('href')).toBe('method.html#lang=es');

    click('lang-en');
    await app!.idle();
    expect(document.documentElement.lang).toBe('en');
    expect(location.hash).toBe('#area=prov:42');
    expect(text('verdict-text')).toBe('Rising about 32% per decade since 2003 (p = 0.006). Since 2012 alone, no significant trend.');
    expect(byId<HTMLAnchorElement>('method-link').getAttribute('href')).toBe('method.html');
  });

  it('leaves no English behind in Spanish, and no Spanish in English', async () => {
    await start('lang=es');
    const spanish = Array.from(document.querySelectorAll('[data-i18n]')).map((element) => element.textContent);
    click('lang-en');
    await app!.idle();
    const english = Array.from(document.querySelectorAll('[data-i18n]')).map((element) => element.textContent);
    // Every fixed text changes, apart from names that are the same in both languages
    // (the language buttons, which the intro has too).
    const same = english.filter((value, i) => value === spanish[i]);
    expect([...new Set(same)].sort()).toEqual(['EN', 'ES']);
  });
});

describe('messages in Spanish', () => {
  it('names the file or the tile that failed, with no English detail', async () => {
    mountPage('lang=es');
    server.files.set('meta.json', { status: 503 });
    app = startApp(document);
    await app.idle();
    expect(text('load-status')).toBe('No se pudieron cargar los datos (meta.json). Reintentar');
    app.destroy();

    clearDataCache();
    server.files.set('meta.json', JSON.stringify(server.json('meta.json')));
    server.files.set('points/t_-29_-59.csv.gz', new TypeError('Failed to fetch'));
    await start('area=prov:18&lang=es&sel=2020-08');
    expect(text('dots-status')).toBe('No se pudieron cargar las detecciones (tesela t_-29_-59). Reintentar');
    click('download-hotspots');
    await app!.idle();
    expect(text('download-status')).toBe('No se pudieron cargar las detecciones (tesela t_-29_-59). Reintentar');
  });
});

describe('the satellites named in the footer', () => {
  it('are those that carry the record in the data, no more', async () => {
    await start();
    expect(text('footer-firms')).toBe('Fire data: NASA FIRMS active fire detections from MODIS (Aqua) and VIIRS (S-NPP, NOAA-20).');
    app!.destroy();
    clearDataCache();
    const meta = server.json('meta.json');
    server.files.set('meta.json', JSON.stringify({ ...meta, series: [meta.series[0], { ...meta.series[1], to: null }] }));
    await start();
    expect(text('footer-firms')).toBe('Fire data: NASA FIRMS active fire detections from MODIS (Aqua) and VIIRS (S-NPP).');
  });
});

describe('the use of AI, as the Space Apps rules ask', () => {
  it('is credited in the footer, in both languages, with a pointer to the README', async () => {
    await start();
    expect(text('footer-si')).toBe('Designing and building was assisted with Claude, an AI assistant (Anthropic)');
    click('lang-es');
    await app!.idle();
    expect(text('footer-si')).toBe('El diseño y la construcción contaron con la ayuda de Claude, un asistente de IA (Anthropic)');
  });
});

describe('copy link', () => {
  it('copies an address that restores the area, the dates, the mode, the language and the selected month', async () => {
    await start('area=prov:18&years=2010-2022&mode=anomaly&lang=es&sel=2022-02');
    click('copy-link');
    await app!.idle();
    expect(clipboard).toEqual([location.href]);
    expect(clipboard![0]).toContain('#area=prov:18&years=2010-2022&mode=anomaly&lang=es&sel=2022-02');
    expect(text('link-status')).toBe('Enlace copiado.');
  });

  it('shows the link to copy by hand when the clipboard is not available', async () => {
    await start('area=prov:18');
    clipboard = null;
    click('copy-link');
    await app!.idle();
    expect(text('link-status')).toBe(`Copy this link: ${location.href}`);
  });
});

describe('stories', () => {
  const stories = () => Array.from(document.querySelectorAll<HTMLAnchorElement>('#stories a.story'));

  it('offers the stories the data holds, each with a caption computed from the data', async () => {
    await start();
    expect(stories().map((story) => story.querySelector('.story-title')!.textContent)).toEqual([
      'La Pampa grasslands',
      'Corrientes wetlands',
    ]);
    expect(stories()[1].querySelector('.story-caption')!.textContent).toBe(
      'Feb 2022 is 7.6× the usual level, the highest February since 2003.',
    );
    expect(stories()[1].getAttribute('href')).toBe('#area=prov:18&sel=2022-02');
  });

  it('opens the province with the month selected', async () => {
    await start();
    click(stories()[0]);
    await app!.idle();
    expect(text('area-title')).toBe('La Pampa');
    expect(location.hash).toBe('#area=prov:42&sel=2017-01');
    expect(text('verdict-label')).toBe('Selected month');
    expect(text('verdict-text')).toContain('Jan 2017 is 3.3× the usual level, the highest January since 2003.');
    expect(calendarCell(2017, 1).getAttribute('aria-pressed')).toBe('true');
  });

  it('follows the language', async () => {
    await start('lang=es');
    expect(stories()[1].querySelector('.story-title')!.textContent).toBe('Esteros de Corrientes');
    expect(stories()[1].getAttribute('href')).toBe('#area=prov:18&lang=es&sel=2022-02');
    click(stories()[1]);
    await app!.idle();
    expect(document.documentElement.lang).toBe('es');
    expect(text('area-title')).toBe('Corrientes');
  });
});

describe('downloads', () => {
  const lines = async (blob: Blob) => (await blob.text()).split('\n');

  it('saves the calendar as a CSV of the harmonized series, whatever the view', async () => {
    await start('area=prov:18&years=2010-2020');
    click('download-calendar');
    await app!.idle();
    expect(saved.map((file) => file.fileName)).toEqual(['focos_calendar_corrientes_2010_2020.csv']);
    const csv = await lines(saved[0].blob);
    expect(csv[0]).toBe('# Focos: MODIS-equivalent fire calendar');
    expect(csv[1]).toBe('# Area: Corrientes');
    expect(csv[2]).toBe('# Date range: 2010-01 to 2020-12');
    expect(csv.find((line) => !line.startsWith('#'))).toBe(
      'year,month,modis_equivalent_hotspots,baseline_median,ratio_to_median,category,data_complete',
    );
    expect(csv.filter((line) => /^\d{4},/.test(line))).toHaveLength(11 * 12);
    expect(text('download-status')).toBe('Saved focos_calendar_corrientes_2010_2020.csv.');

    choose('view', 'raw');
    await app!.idle();
    click('download-calendar');
    await app!.idle();
    expect(await saved[1].blob.text()).toBe(await saved[0].blob.text());
  });

  it('saves the calendar as a PNG with a title and a footer', async () => {
    await start('area=prov:18&years=2010-2020&mode=anomaly');
    click('download-png');
    await app!.idle();
    expect(saved.map((file) => file.fileName)).toEqual(['focos_calendar_corrientes_2010_2020.png']);
    expect(saved[0].blob.type).toBe('image/png');
    const words = Array.from(pictures[0].querySelectorAll('text')).map((node) => node.textContent);
    expect(words[0]).toBe('Corrientes · 2010–2020 · MODIS-equivalent hotspots per month, colored by anomaly');
    expect(words[words.length - 1]).toBe('Focos · data: NASA FIRMS · built with AI (Claude)');
    expect(words).toContain('Compared with the usual level for the month');
    expect(pictures[0].getAttribute('width')).toBe('1200');
    expect(pictures[0].querySelectorAll('g.cal-cell')).toHaveLength(11 * 12);
  });

  it('says so when the browser cannot make the picture', async () => {
    pngFails = true;
    await start();
    click('download-png');
    await app!.idle();
    expect(saved).toEqual([]);
    expect(text('download-status')).toBe('The picture could not be made in this browser.');
  });

  it('saves the hotspots of the area for the CSV dates', async () => {
    await start('area=prov:18');
    setValue('date-from', '2020-08-01');
    setValue('date-to', '2020-08-31');
    click('download-hotspots');
    await app!.idle();
    expect(saved.map((file) => file.fileName)).toEqual(['focos_hotspots_corrientes_2020-08-01_2020-08-31.csv']);
    const csv = await lines(saved[0].blob);
    expect(csv[1]).toBe('# Area: Corrientes');
    expect(csv[2]).toBe('# Date range: 2020-08-01 to 2020-08-31 (local dates)');
    const rows = csv.filter((line) => /^-\d/.test(line));
    expect(rows.length).toBeGreaterThan(100);
    expect(text('download-status')).toBe(
      `Saved ${rows.length.toLocaleString('en')} satellite detections to focos_hotspots_corrientes_2020-08-01_2020-08-31.csv.`,
    );
  });

  it('follows the year range when no dates are picked, and works for a drawn area', async () => {
    await start('area=circle:-28.5,-57.9,30&years=2015-2016');
    click('download-hotspots');
    await app!.idle();
    expect(saved.map((file) => file.fileName)).toEqual(['focos_hotspots_circle_-28.5_-57.9_30km_2015-01-01_2016-12-31.csv']);
    expect((await lines(saved[0].blob))[1]).toBe('# Area: 30 km around -28.5, -57.9');
  });

  it('refuses an area that touches too many point tiles, with a clear message', async () => {
    await start('area=prov:18', { limits: { tiles: 1 } });
    server.requests.length = 0;
    click('download-hotspots');
    await app!.idle();
    expect(saved).toEqual([]);
    expect(text('download-status')).toBe(
      'The hotspots CSV is made for a province or a drawn area, and this one holds too many detections for one file. Choose a province, or draw a smaller area.',
    );
    expect(server.requests.filter((path) => path.startsWith('points/'))).toEqual([]);
  });

  it('names a tile that failed to load and recovers on retry', async () => {
    await start('area=prov:18');
    const tile = server.files.get('points/t_-29_-58.csv.gz')!;
    server.files.set('points/t_-29_-58.csv.gz', { status: 503 });
    click('download-hotspots');
    await app!.idle();
    expect(saved).toEqual([]);
    expect(text('download-status')).toBe('The detections could not be loaded (tile t_-29_-58). Try again');
    server.files.set('points/t_-29_-58.csv.gz', tile);
    click(byId('download-status').querySelector('button')!);
    await app!.idle();
    expect(saved).toHaveLength(1);
    expect(text('download-status')).toMatch(/^Saved [\d,]+ satellite detections to focos_hotspots_corrientes_/);
    expect(byId('download-status').querySelector('button')).toBeNull();
  });
});

describe('the hotspots of a selected month, as dots on the map', () => {
  const lastDots = () => map.dots[map.dots.length - 1][0] as { count: number; lat: Float64Array };

  it('shows the dots of the month when a cell is clicked and takes them away when it is let go', async () => {
    await start('area=prov:18');
    expect(isHidden('dots-status')).toBe(true);
    click(calendarCell(2020, 8).querySelector('rect')!);
    await app!.idle();
    const expected = server.json('summary/provinces.json').areas[1].raw[monthIdx(2020, 8)];
    expect(lastDots().count).toBe(expected);
    // These are raw detections, not the calendar's MODIS-equivalent hotspots, and the line says so.
    expect(text('dots-status')).toMatch(
      new RegExp(`^${expected} satellite detections of Aug 2020 on the map\\. Weighted, the month’s detections add up to about [\\d,.]+ MODIS-equivalent hotspots\\.$`),
    );
    click(calendarCell(2020, 8).querySelector('rect')!);
    await app!.idle();
    expect(map.cleared).toBeGreaterThan(0);
    expect(isHidden('dots-status')).toBe(true);
  });

  it('shows the dots of a month selected in the address once the map is there', async () => {
    await start('area=prov:42&sel=2017-01');
    expect(map.dots).toHaveLength(1);
    expect(lastDots().count).toBe(server.json('summary/provinces.json').areas[2].raw[monthIdx(2017, 1)]);
    expect(text('dots-status')).toMatch(/^\d+ satellite detections of Jan 2017 on the map\. Weighted, /);
  });

  it('says that a drawn area’s calendar is counted on the grid, so the weighed detections can differ from it', async () => {
    await start('area=circle:-28.5,-57.9,30&sel=2020-08');
    expect(text('dots-status')).toMatch(/Weighted, the month’s detections add up to about .* The calendar of a drawn area is counted on the 5 km grid, so it can differ\.$/);
  });

  it('caps the dots and says how many there are', async () => {
    await start('area=prov:18&sel=2020-08', { limits: { dots: 10 } });
    const total = server.json('summary/provinces.json').areas[1].raw[monthIdx(2020, 8)];
    expect(lastDots().count).toBe(10);
    expect(text('dots-status')).toMatch(new RegExp(`^Showing 10 of ${total} satellite detections of Aug 2020\\. Weighted, the month’s detections add up to about `));
  });

  it('says when a month has no hotspots, when the area is too large, and when a tile fails', async () => {
    await start('area=prov:42&sel=2010-07');
    expect(text('dots-status')).toMatch(
      /^(No satellite detections in Jul 2010 in this area\.|\d+ satellite detections? of Jul 2010 on the map\.)$/,
    );
    app!.destroy();

    await start('area=prov:18&sel=2020-08', { limits: { tiles: 1 } });
    expect(map.dots).toHaveLength(0);
    expect(text('dots-status')).toBe('This area has too many detections to draw on the map. Choose a province, or draw a smaller area, to see them.');
    app!.destroy();

    clearDataCache();
    const tile = server.files.get('points/t_-29_-59.csv.gz')!;
    server.files.set('points/t_-29_-59.csv.gz', new TypeError('Failed to fetch'));
    await start('area=prov:18&sel=2020-08');
    expect(map.dots).toHaveLength(0);
    expect(text('dots-status')).toBe('The detections could not be loaded (tile t_-29_-59). Try again');
    server.files.set('points/t_-29_-59.csv.gz', tile);
    click(byId('dots-status').querySelector('button')!);
    await app!.idle();
    expect(map.dots).toHaveLength(1);
    expect(text('dots-status')).toMatch(/^\d+ satellite detections of Aug 2020 on the map\. Weighted, /);
  });

  it('does not hold the page up while the detections download', async () => {
    // The tiles of Corrientes are slow to arrive.
    const tile = server.files.get('points/t_-29_-59.csv.gz') as Uint8Array;
    let deliver: (bytes: Uint8Array) => void = () => {};
    server.files.set('points/t_-29_-59.csv.gz', () => new Promise<Uint8Array>((resolve) => (deliver = resolve)));
    mountPage('area=prov:18&sel=2020-08');
    app = startApp(document);
    await app.drawn();
    expect(text('area-title')).toBe('Corrientes');
    expect(text('dots-status')).toBe('Loading the satellite detections of Aug 2020…');
    // Meanwhile another province, a story or any control answers at once.
    setValue('province', '42');
    await app.drawn();
    expect(text('area-title')).toBe('La Pampa');
    expect(calendarCells()).toHaveLength(24 * 12);
    expect(isHidden('dots-status')).toBe(true);
    // Even the detections of another month arrive while the first download is still stalled.
    click(calendarCell(2017, 1).querySelector('rect')!);
    await vi.waitFor(() => expect(text('dots-status')).toMatch(/^\d+ satellite detections of Jan 2017 on the map\. Weighted, /));
    // When the slow tile finally arrives, its dots are not drawn over the new area.
    const drawn = map.dots.length;
    deliver(tile);
    await app.idle();
    expect(map.dots).toHaveLength(drawn);
    expect(text('dots-status')).toMatch(/of Jan 2017 on the map\. Weighted, /);
  });

  it('clears the dots when the area changes', async () => {
    await start('area=prov:18&sel=2020-08');
    const cleared = map.cleared;
    setValue('province', '42');
    await app!.idle();
    expect(map.cleared).toBeGreaterThan(cleared);
    expect(isHidden('dots-status')).toBe(true);
  });

  it('shows the same detections in Raw view', async () => {
    await start('area=prov:18&sel=2020-08');
    const harmonized = lastDots().count;
    choose('view', 'raw');
    await app!.idle();
    expect(lastDots().count).toBe(harmonized);
  });
});

describe('data that ends on the last day of a year', () => {
  // Today's real export: no partial month, no month-to-date layer, nothing in 2026.
  beforeEach(() => {
    const meta = server.json('meta.json');
    server.files.set('meta.json', JSON.stringify({ ...meta, data_end_date: '2025-12-31', mtd: null, series: meta.series.slice(0, 2).map((c: object, i: number) => (i === 1 ? { ...c, to: null } : c)) }));
    const summary = server.json('summary/provinces.json');
    server.files.set(
      'summary/provinces.json',
      JSON.stringify({ areas: summary.areas.map((area: { monthly: number[]; raw: number[] }) => ({
        ...area,
        monthly: area.monthly.map((v, i) => (i > 275 ? 0 : v)),
        raw: area.raw.map((v, i) => (i > 275 ? 0 : v)),
        mtd: [],
      })) }),
    );
  });

  it('stops the calendar and the controls at 2025 and has no partial month', async () => {
    await start();
    expect(calendarCells()).toHaveLength(23 * 12);
    expect(calendarCells().map((cell) => cell.dataset.status)).not.toContain('partial');
    expect(calendarCells().map((cell) => cell.dataset.status)).not.toContain('nodata');
    expect(byId<HTMLInputElement>('year-to').max).toBe('2025');
    expect(byId<HTMLInputElement>('date-to').value).toBe('2025-12-31');
    expect(text('data-through')).toBe('Data through 2025-12-31');
    expect(byId('calendar').innerHTML).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('ignores a selected month after the end of the data', async () => {
    await start('sel=2026-03');
    expect(app!.state().sel).toBeNull();
    expect(text('cell-detail')).toMatch(/^Select a month to see its numbers here\. /);
  });
});

describe('the address', () => {
  it('is followed when it changes', async () => {
    await start();
    history.replaceState(null, '', '#area=prov:42');
    window.dispatchEvent(new Event('hashchange'));
    await app!.idle();
    expect(text('area-title')).toBe('La Pampa');
    expect(byId<HTMLSelectElement>('province').value).toBe('42');
  });
});

describe('when the data cannot be loaded', () => {
  it('says so, offers a retry, and recovers', async () => {
    mountPage();
    server.files.set('meta.json', { status: 503 });
    app = startApp(document);
    await app.idle();
    expect(isHidden('load-status')).toBe(false);
    expect(text('load-status')).toContain('could not be loaded');
    expect(isHidden('results-body')).toBe(true);
    server.files.set('meta.json', JSON.stringify(server.json('meta.json')));
    click(byId('load-status').querySelector('button')!);
    await app.idle();
    expect(isHidden('load-status')).toBe(true);
    expect(text('area-title')).toBe('Argentina');
  });

  it('keeps the page alive when the grid for a drawn area fails, and recovers on retry', async () => {
    mountPage('area=circle:-28.5,-57.9,25');
    const grid = server.files.get('grid/monthly.bin.gz')!;
    server.files.set('grid/monthly.bin.gz', new TypeError('Failed to fetch'));
    app = startApp(document);
    await app.idle();
    expect(text('load-status')).toContain('could not be loaded');
    server.files.set('grid/monthly.bin.gz', grid);
    click(byId('load-status').querySelector('button')!);
    await app.idle();
    expect(isHidden('load-status')).toBe(true);
    expect(isHidden('results-body')).toBe(false);
  });
});

describe('the intro', () => {
  it('draws the nation’s yearly hotspots, stitched and harmonized, for the complete years', async () => {
    await start();
    const c = completenessFromMeta(server.json('meta.json'));
    const years = c.lastCompleteYear - 2003 + 1;
    expect(document.querySelectorAll('#intro-chart rect.intro-bar-raw')).toHaveLength(years);
    expect(document.querySelectorAll('#intro-chart rect.intro-bar-focos')).toHaveLength(years);
    expect(text('intro-chart-title')).toBe(`Hotspots per year, all of Argentina, 2003–${c.lastCompleteYear}`);
  });

  it('quotes the held-out test and credits the data, as the page below does', async () => {
    await start();
    expect(text('intro-test')).toBe(text('test-line-text'));
    expect(text('intro-credit')).toContain(text('footer-firms'));
    expect(text('intro-credit')).toContain(text('data-through'));
  });

  it('switches the whole page to Spanish from its own buttons', async () => {
    await start();
    click('intro-lang-es');
    await app!.idle();
    expect(app!.state().lang).toBe('es');
    expect(byId('intro-lang-es').getAttribute('aria-pressed')).toBe('true');
    expect(byId('intro-lang-en').getAttribute('aria-pressed')).toBe('false');
    expect(byId('lang-es').getAttribute('aria-pressed')).toBe('true');
    expect(text('intro-heading')).toBe('Un calendario de incendios para la Argentina, un solo registro desde 2003.');
    expect(text('intro-chart-title')).toContain('Focos por año');
    click('intro-lang-en');
    await app!.idle();
    expect(app!.state().lang).toBe('en');
  });
});
