// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { buildCalendarModel, calendarSvg, renderCalendar, renderTable, type CalendarInput } from '../src/calendar';
import { svgMarkup } from '../src/exports';
import { monthIdx, monthOfIdx, yearOfIdx, type Completeness } from '../src/stats';

const completeness: Completeness = {
  incomplete: new Set([monthIdx(2010, 9)]),
  lastCompleteYear: 2025,
  lastMonthIdx: 286,
  partial: { monthIdx: 286, lastDay: 14 },
};
const monthly = Array.from({ length: 287 }, (_, idx) => {
  const [year, month] = [yearOfIdx(idx), monthOfIdx(idx)];
  if (month === 8) return year === 2020 ? 3000 : 1000;
  if (month === 3) return 2;
  return 200;
});
const input = (overrides: Partial<CalendarInput> = {}): CalendarInput => ({
  monthly,
  raw: monthly.map((value, idx) => (idx >= 109 ? value * 4 : value)),
  mtd: new Array(24).fill(90),
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

let box: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="calendar"></div>';
  box = document.getElementById('calendar')!;
});

const cells = () => Array.from(box.querySelectorAll<SVGGElement>('g.cal-cell'));
const cell = (year: number, month: number) => box.querySelector<SVGGElement>(`g.cal-cell[data-idx="${monthIdx(year, month)}"]`)!;
const key = (target: Element, name: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
const options = { lang: 'en' as const, areaName: 'Córdoba' };

describe('renderCalendar', () => {
  it('draws one cell per month of every shown year, oldest year on top', () => {
    renderCalendar(box, buildCalendarModel(input()), options);
    expect(cells()).toHaveLength(24 * 12);
    const years = Array.from(box.querySelectorAll('g.cal-row > text:first-child')).map((text) => text.textContent);
    expect(years[0]).toBe('2003');
    expect(years[23]).toBe('2026');
    renderCalendar(box, buildCalendarModel(input({ yearFrom: 2015, yearTo: 2020 })), options);
    expect(cells()).toHaveLength(6 * 12);
  });

  it('never prints NaN, undefined or Infinity', () => {
    for (const overrides of [{}, { mode: 'anomaly' as const }, { view: 'raw' as const }, { monthly: new Array(287).fill(0) }]) {
      renderCalendar(box, buildCalendarModel(input(overrides)), options);
      expect(box.innerHTML).not.toMatch(/NaN|undefined|Infinity/);
    }
  });

  it('hatches incomplete and partial months over their colour, and months without data over white', () => {
    renderCalendar(box, buildCalendarModel(input()), options);
    expect(cell(2010, 9).querySelector('.cal-hatch')!.getAttribute('fill')).toBe('url(#calendar-hatch)');
    expect(cell(2026, 11).querySelector('.cal-hatch')!.getAttribute('fill')).toBe('url(#calendar-hatch)');
    expect(cell(2026, 12).querySelector('.cal-hatch')!.getAttribute('fill')).toBe('url(#calendar-nodata)');
    expect(cell(2026, 12).querySelector('rect')!.getAttribute('fill')).toBe('#ffffff');
    expect(cell(2020, 8).querySelector('.cal-hatch')).toBeNull();
    expect(box.querySelector('pattern#calendar-hatch')).not.toBeNull();
    expect(box.querySelector('pattern#calendar-nodata')).not.toBeNull();
    // A month without data cannot be selected and prints no number.
    expect(cell(2026, 12).getAttribute('role')).toBe('img');
    expect(cell(2026, 12).querySelector('text')).toBeNull();
  });

  it('prints numbers when the cells are at least 34 px wide, and not on a phone', () => {
    renderCalendar(box, buildCalendarModel(input()), { ...options, width: 720 });
    expect(cell(2020, 8).querySelector('.cal-number')!.textContent).toBe('3k');
    expect(cell(2003, 3).querySelector('.cal-number')!.textContent).toBe('2');
    renderCalendar(box, buildCalendarModel(input()), { ...options, width: 343 });
    expect(box.querySelector('.cal-number')).toBeNull();
    expect(box.querySelector('svg')!.getAttribute('width')).toBe('343');
  });

  it('labels the divider between 2011 and 2012 for the view', () => {
    renderCalendar(box, buildCalendarModel(input()), options);
    expect(box.querySelector('.cal-divider')!.textContent).toBe('MODIS above, VIIRS harmonized below');
    renderCalendar(box, buildCalendarModel(input({ view: 'raw' })), options);
    expect(box.querySelector('.cal-divider')!.textContent).toBe('MODIS above, raw VIIRS below: not comparable');
    renderCalendar(box, buildCalendarModel(input({ yearFrom: 2015 })), options);
    expect(box.querySelector('.cal-divider')).toBeNull();
  });

  it('brackets the fire season, in two pieces when it wraps, and not in Raw view', () => {
    const season = (overrides: Partial<CalendarInput>) => {
      renderCalendar(box, buildCalendarModel(input(overrides)), options);
      return Array.from(box.querySelectorAll('path')).filter((path) => path.getAttribute('d')!.startsWith('M'));
    };
    const winter = monthly.map((_, idx) => ([7, 8, 9].includes(monthOfIdx(idx)) ? 500 : 1));
    expect(season({ monthly: winter })).toHaveLength(1);
    const summer = monthly.map((_, idx) => ([12, 1, 2].includes(monthOfIdx(idx)) ? 500 : 1));
    expect(season({ monthly: summer })).toHaveLength(2);
    expect(season({ monthly: winter, view: 'raw' })).toHaveLength(0);
    expect(season({ monthly: new Array(287).fill(0) })).toHaveLength(0);
    // Fire spread over most of the year is not bracketed as a season.
    expect(season({})).toHaveLength(0);
  });

  it('gives each cell a spoken label and reports the selected one', () => {
    renderCalendar(box, buildCalendarModel(input({ sel: monthIdx(2020, 8) })), options);
    expect(cell(2020, 8).getAttribute('aria-label')).toBe(
      'Aug 2020. 3,000 MODIS-equivalent hotspots. Usual level for this month (median): 1,000. 3.0× the usual level. The highest August since 2003. Record for this month. In the test, a count this size typically came within 17% of MODIS (S-NPP VIIRS)',
    );
    expect(cell(2020, 8).getAttribute('aria-pressed')).toBe('true');
    expect(cell(2020, 8).querySelector('.cal-selected')).not.toBeNull();
    expect(cell(2020, 7).getAttribute('aria-pressed')).toBe('false');
    expect(box.querySelector('svg')!.getAttribute('aria-label')).toContain('Fire calendar for Córdoba, 2003 to 2026.');
  });

  it('reports a click on a month, and ignores one on a month without data', () => {
    const picked: number[] = [];
    renderCalendar(box, buildCalendarModel(input()), { ...options, onSelect: (idx) => picked.push(idx) });
    cell(2020, 8).querySelector('rect')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    cell(2026, 12).querySelector('rect')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(picked).toEqual([monthIdx(2020, 8)]);
  });

  it('is one tab stop; arrow keys move between months and Enter selects', () => {
    const picked: number[] = [];
    renderCalendar(box, buildCalendarModel(input()), { ...options, onSelect: (idx) => picked.push(idx) });
    const stops = cells().filter((c) => c.getAttribute('tabindex') === '0');
    expect(stops.map((c) => c.dataset.idx)).toEqual(['286']); // the latest month with data
    stops[0].focus();
    key(document.activeElement!, 'ArrowLeft');
    expect((document.activeElement as SVGGElement).dataset.idx).toBe('285');
    key(document.activeElement!, 'ArrowUp');
    expect((document.activeElement as SVGGElement).dataset.idx).toBe('273');
    key(document.activeElement!, 'ArrowDown');
    key(document.activeElement!, 'ArrowRight');
    key(document.activeElement!, 'ArrowRight'); // December 2026 has no data: stay
    expect((document.activeElement as SVGGElement).dataset.idx).toBe('286');
    expect(cells().filter((c) => c.getAttribute('tabindex') === '0')).toHaveLength(1);
    key(document.activeElement!, 'Enter');
    key(document.activeElement!, ' ');
    expect(picked).toEqual([286, 286]);
  });

  it('starts the tab stop on the selected month and keeps focus through a redraw', () => {
    renderCalendar(box, buildCalendarModel(input({ sel: monthIdx(2015, 6) })), options);
    expect(cells().filter((c) => c.getAttribute('tabindex') === '0').map((c) => c.dataset.idx)).toEqual([
      String(monthIdx(2015, 6)),
    ]);
    cell(2012, 2).focus();
    renderCalendar(box, buildCalendarModel(input({ mode: 'anomaly' })), options);
    expect((document.activeElement as SVGGElement).dataset.idx).toBe(String(monthIdx(2012, 2)));
  });

  it('shows a tooltip on focus and on hover, and hides it again', () => {
    renderCalendar(box, buildCalendarModel(input()), options);
    const tooltip = box.querySelector<HTMLElement>('.cal-tooltip')!;
    expect(tooltip.hidden).toBe(true);
    cell(2020, 8).focus();
    expect(tooltip.hidden).toBe(false);
    expect(Array.from(tooltip.children).map((line) => line.textContent)).toEqual([
      'Aug 2020',
      '3,000 MODIS-equivalent hotspots',
      'Usual level for this month (median): 1,000',
      '3.0× the usual level',
      'The highest August since 2003',
      'Record for this month',
      'In the test, a count this size typically came within 17% of MODIS (S-NPP VIIRS)',
    ]);
    key(cell(2020, 8), 'Escape');
    expect(tooltip.hidden).toBe(true);
    cell(2005, 8).querySelector('rect')!.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.firstElementChild!.textContent).toBe('Aug 2005');
    expect(tooltip.textContent).not.toContain('Typical error'); // an Aqua month
    cell(2005, 8).querySelector('rect')!.dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
    expect(tooltip.hidden).toBe(true);
  });

  it('has a legend for each mode', () => {
    const legend = (overrides: Partial<CalendarInput>) => {
      renderCalendar(box, buildCalendarModel(input(overrides)), options);
      return Array.from(box.querySelectorAll('svg text')).map((text) => text.textContent);
    };
    expect(legend({})).toEqual(
      expect.arrayContaining(['MODIS-equivalent hotspots per month', 'None', '≥ 1k', 'Incomplete or partial month', 'No data']),
    );
    expect(legend({ mode: 'anomaly' })).toEqual(
      expect.arrayContaining(['Compared with the usual level for the month', '¼×', 'usual', '4×', 'Usually almost no fire']),
    );
    expect(legend({ view: 'raw' })).toEqual(
      expect.arrayContaining(['Raw detections per month, on the color scale of the harmonized view']),
    );
  });

  it('starts the count scale at "1" only where 1 is below its middle tick, and at "> 0" on a scale of less than four', () => {
    const ticks = () => Array.from(box.querySelectorAll('svg text')).map((text) => text.textContent);
    renderCalendar(box, buildCalendarModel(input()), options);
    expect(ticks()).toContain('1');
    // A city with almost no fire: the top of its scale is below 1, so a "1" on the left would sit above the rest.
    const tiny = new Array(287).fill(0).map((_, i) => (i % 12 === 7 ? 0.8 : 0.2));
    renderCalendar(box, buildCalendarModel(input({ monthly: tiny, raw: tiny })), options);
    expect(ticks()).not.toContain('1');
    expect(ticks()).toContain('> 0');
    expect(ticks()).toContain('≥ 0.8');
  });

  it('says so when there is no fire at all, instead of showing a blank calendar', () => {
    const zeros = new Array(287).fill(0);
    renderCalendar(box, buildCalendarModel(input({ monthly: zeros, raw: zeros, mtd: new Array(24).fill(0) })), options);
    expect(box.querySelector('.calendar-empty')!.textContent).toBe('No hotspots were recorded in this area in these years.');
    expect(cells()).toHaveLength(24 * 12);
  });

  it('draws in Spanish', () => {
    renderCalendar(box, buildCalendarModel(input()), { lang: 'es', areaName: 'Córdoba' });
    expect(box.querySelector('.cal-divider')!.textContent).toBe('MODIS arriba, VIIRS armonizado abajo');
    expect(cell(2020, 8).getAttribute('aria-label')).toContain('3000 focos equivalentes a MODIS');
  });
});

describe('calendarSvg for the PNG download', () => {
  it('carries a title, a footer and a white background, with every style inline', () => {
    const drawing = calendarSvg(document, buildCalendarModel(input()), {
      lang: 'en',
      width: 1200,
      idPrefix: 'export',
      frame: { title: 'Focos · Córdoba · 2003–2026', footer: 'Focos · data: NASA FIRMS' },
    });
    const texts = Array.from(drawing.querySelectorAll('text')).map((text) => text.textContent);
    expect(texts[0]).toBe('Focos · Córdoba · 2003–2026');
    expect(texts[texts.length - 1]).toBe('Focos · data: NASA FIRMS');
    expect(drawing.querySelector('.frame-background')!.getAttribute('fill')).toBe('#ffffff');
    expect(Number(drawing.getAttribute('height'))).toBeGreaterThan(600);
    expect(drawing.getAttribute('viewBox')).toBe(`0 0 1200 ${drawing.getAttribute('height')}`);
    for (const text of drawing.querySelectorAll('text')) expect(text.getAttribute('font-family')).toContain('system-ui');
    expect(drawing.querySelector('pattern#export-hatch')).not.toBeNull();
  });
});

describe('svgMarkup', () => {
  it('serializes the drawing as a standalone SVG document', () => {
    const drawing = calendarSvg(document, buildCalendarModel(input()), { lang: 'en', width: 1200, idPrefix: 'export' });
    const markup = svgMarkup(drawing);
    expect(markup.startsWith('<svg')).toBe(true);
    expect(markup).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(markup).toContain('width="1200"');
    expect(markup).toContain('MODIS above, VIIRS harmonized below');
    expect(markup).not.toMatch(/NaN|undefined/);
    // The copy is independent of the page's drawing.
    expect(drawing.parentNode).toBeNull();
  });
});

describe('renderTable', () => {
  it('shows the same numbers as a table with headers for screen readers', () => {
    renderTable(box, buildCalendarModel(input()), options);
    const table = box.querySelector('table')!;
    expect(table.querySelector('caption')!.textContent).toBe('MODIS-equivalent hotspots per month, Córdoba');
    expect(Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent)).toEqual([
      'Year', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', 'Year total',
    ]);
    const rows = Array.from(table.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(24);
    const row = (year: number) => rows.find((tr) => tr.querySelector('th')!.textContent === String(year))!;
    expect(row(2020).querySelector('th')!.getAttribute('scope')).toBe('row');
    expect(Array.from(row(2020).querySelectorAll('td')).map((td) => td.textContent)).toEqual([
      '200', '200', '2', '200', '200', '200', '200', '3,000', '200', '200', '200', '200', '5,002',
    ]);
    expect(row(2010).querySelectorAll('td')[8].textContent).toBe('200 * (incomplete satellite data)');
    expect(row(2026).querySelectorAll('td')[10].textContent).toBe('200 † (month so far)');
    expect(row(2026).querySelectorAll('td')[11].textContent).toBe('– (no data yet)');
    expect(box.querySelector('.table-notes')!.textContent).toBe(
      '* incomplete satellite data · † month so far (days 1–14) · – no data yet',
    );
  });

  it('adds the ratio in anomaly mode and follows the Raw view', () => {
    renderTable(box, buildCalendarModel(input({ mode: 'anomaly', yearFrom: 2020, yearTo: 2020 })), options);
    const cellsOf2020 = Array.from(box.querySelectorAll('tbody td')).map((td) => td.textContent);
    expect(cellsOf2020[7]).toBe('3,000 (3.0×)');
    expect(cellsOf2020[2]).toBe('2'); // usually almost no fire: no ratio
    expect(box.querySelector('.table-notes')).toBeNull();
    renderTable(box, buildCalendarModel(input({ view: 'raw', yearFrom: 2020, yearTo: 2020 })), options);
    expect(box.querySelector('caption')!.textContent).toBe('Raw detections per month (not comparable across 2012), Córdoba');
    expect(box.querySelectorAll('tbody td')[7].textContent).toBe('12,000');
  });

  it('is written in the language asked for', () => {
    renderTable(box, buildCalendarModel(input({ yearFrom: 2020, yearTo: 2020 })), { lang: 'es', areaName: 'Córdoba' });
    expect(box.querySelector('thead')!.textContent).toContain('AñoEneFeb');
    expect(box.querySelectorAll('tbody td')[7].textContent).toBe('3000');
  });
});
