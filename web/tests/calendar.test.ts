import { rgb } from 'd3';
import { describe, expect, it } from 'vitest';
import {
  NODATA_COLOR,
  RARE_COLOR,
  ZERO_COLOR,
  anomalyLevel,
  buildCalendarModel,
  calendarLayout,
  colorForAnomaly,
  colorForCount,
  describeCell,
  formatCount,
  inkOn,
  type CalendarInput,
} from '../src/calendar';
import { wrapText } from '../src/drawing';
import { monthIdx, monthOfIdx, yearOfIdx, type Carrier, type Completeness, type ErrorBand } from '../src/stats';

const MONTHS = 287;

/** Data through 2026-11-14, with September 2010 incomplete. */
const completeness: Completeness = {
  incomplete: new Set([monthIdx(2010, 9)]),
  lastCompleteYear: 2025,
  lastMonthIdx: 286,
  partial: { monthIdx: 286, lastDay: 14 },
};

const carriers: Carrier[] = [
  { sat: 'A', name: 'Aqua MODIS', fromIdx: 0, toIdx: 108, typicalErrorPct: null },
  { sat: 'N', name: 'S-NPP VIIRS', fromIdx: 109, toIdx: 285, typicalErrorPct: 17.27 },
  { sat: 'N20', name: 'NOAA-20 VIIRS', fromIdx: 286, toIdx: null, typicalErrorPct: 18.04 },
];

/** Test-year error by the size of the count, as validation.json gives it. */
const errorBands: ErrorBand[] = [
  { from: 1, mape: 124 },
  { from: 5, mape: 43.3 },
  { from: 20, mape: 17 },
];

function seriesOf(value: (year: number, month: number) => number): number[] {
  return Array.from({ length: MONTHS }, (_, idx) => value(yearOfIdx(idx), monthOfIdx(idx)));
}

// August burns (100 a month, 300 in 2020), March has almost no fire (2), the rest sits at 20.
// November 2026 has 30 by day 14; past Novembers had 10 by day 14.
const monthly = seriesOf((year, month) => {
  if (month === 8) return year === 2020 ? 300 : 100;
  if (month === 3) return 2;
  if (month === 11 && year === 2026) return 30;
  return 20;
});
const raw = monthly.map((value, idx) => (idx >= 109 ? value * 4 : value * 1.25));
const mtd = Array.from({ length: 24 }, (_, y) => (y === 23 ? 30 : 10));

function input(overrides: Partial<CalendarInput> = {}): CalendarInput {
  return {
    monthly,
    raw,
    mtd,
    completeness,
    carriers,
    errorBands,
    view: 'harmonized',
    mode: 'count',
    yearFrom: 2003,
    yearTo: 2026,
    sel: null,
    ...overrides,
  };
}

const luminance = (color: string) => {
  const { r, g, b } = rgb(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

describe('formatCount', () => {
  it('shortens thousands', () => {
    expect(formatCount(1234)).toBe('1.2k');
    expect(formatCount(87)).toBe('87');
  });

  it('keeps cell labels to four characters or fewer', () => {
    const cases: Array<[number, string]> = [
      [0, '0'],
      [0.04, '0'],
      [4.6, '4.6'],
      [3, '3'],
      [9.96, '10'],
      [87.4, '87'],
      [999.4, '999'],
      [999.6, '1k'],
      [1000, '1k'],
      [9949, '9.9k'],
      [9950, '10k'],
      [19552, '20k'],
      [167274, '167k'],
      [999499, '999k'],
      [999500, '1M'],
      [1234567, '1.2M'],
    ];
    for (const [value, label] of cases) {
      expect(formatCount(value), String(value)).toBe(label);
      expect(label.length).toBeLessThanOrEqual(4);
    }
  });

  it('never prints NaN or a negative count', () => {
    expect(formatCount(Number.NaN)).toBe('');
    expect(formatCount(Number.POSITIVE_INFINITY)).toBe('');
    expect(formatCount(-3)).toBe('0');
  });
});

describe('colorForCount', () => {
  it('draws zero in light gray', () => {
    expect(colorForCount(0, 100)).toBe(ZERO_COLOR);
    expect(colorForCount(Number.NaN, 100)).toBe(ZERO_COLOR);
    expect(colorForCount(0.5, 100)).not.toBe(ZERO_COLOR);
  });

  it('runs from light to dark as the count grows, so more ink means more fire', () => {
    const tones = [1, 10, 25, 50, 100].map((value) => luminance(colorForCount(value, 100)));
    for (let i = 1; i < tones.length; i++) expect(tones[i]).toBeLessThan(tones[i - 1]);
    expect(luminance(colorForCount(1, 100))).toBeGreaterThan(190);
    expect(luminance(colorForCount(100, 100))).toBeLessThan(60);
  });

  it('is a square-root scale that stops at the top of the scale', () => {
    expect(colorForCount(25, 100)).toBe(colorForCount(1, 4)); // both half-way along the ramp
    expect(colorForCount(1000, 100)).toBe(colorForCount(100, 100));
  });

  it('still gives a colour when the scale is empty', () => {
    expect(colorForCount(3, 0)).toBe(colorForCount(100, 100));
    expect(colorForCount(3, 0)).toMatch(/^(#[0-9a-f]{6}|rgb\(\d+, \d+, \d+\))$/);
  });
});

describe('anomaly colours', () => {
  it('is gray when the baseline median is below 5', () => {
    expect(colorForAnomaly(100, 4.9)).toBe(RARE_COLOR);
    expect(colorForAnomaly(0, 0)).toBe(RARE_COLOR);
    expect(anomalyLevel(100, 4.9)).toBeNull();
    expect(colorForAnomaly(100, 5)).not.toBe(RARE_COLOR);
  });

  it('is the log2 of the ratio to the median, clamped to -2 and +2', () => {
    expect(anomalyLevel(20, 10)).toBe(1);
    expect(anomalyLevel(10, 10)).toBe(0);
    expect(anomalyLevel(5, 10)).toBe(-1);
    expect(anomalyLevel(1000, 10)).toBe(2);
    expect(anomalyLevel(1, 100)).toBe(-2);
    expect(anomalyLevel(0, 100)).toBe(-2); // log2(0) must not leak out as -Infinity
    expect(colorForAnomaly(1000, 10)).toBe(colorForAnomaly(40, 10));
    expect(colorForAnomaly(0, 100)).toBe(colorForAnomaly(25, 100));
  });

  it('is orange above the usual level, purple below and pale at it', () => {
    const above = rgb(colorForAnomaly(40, 10));
    const below = rgb(colorForAnomaly(2.5, 10));
    expect(above.r).toBeGreaterThan(above.b + 60);
    expect(below.b).toBeGreaterThan(below.r + 30);
    expect(luminance(colorForAnomaly(10, 10))).toBeGreaterThan(220);
  });
});

describe('inkOn', () => {
  it('prints black on light fills and white on dark ones', () => {
    expect(inkOn(ZERO_COLOR)).toBe('#000000');
    expect(inkOn(colorForCount(1, 100))).toBe('#000000');
    expect(inkOn(colorForCount(100, 100))).toBe('#ffffff');
    expect(inkOn(colorForAnomaly(10, 10))).toBe('#000000');
    expect(inkOn(colorForAnomaly(1000, 10))).toBe('#ffffff');
  });
});

describe('calendarLayout', () => {
  it('prints numbers in cells that are at least 34 px wide', () => {
    const wide = calendarLayout(720, 24, true);
    expect(wide.cellWidth).toBeGreaterThanOrEqual(34);
    expect(wide.showNumbers).toBe(true);
    const phone = calendarLayout(343, 24, true);
    expect(phone.cellWidth).toBeLessThan(34);
    expect(phone.cellWidth).toBeGreaterThan(14);
    expect(phone.showNumbers).toBe(false);
  });

  it('fits everything inside the width and grows with the number of rows', () => {
    for (const width of [343, 600, 720, 1200]) {
      const layout = calendarLayout(width, 24, true);
      expect(layout.barsX + layout.barsWidth).toBeLessThanOrEqual(width + 0.001);
      expect(layout.gridX + 12 * layout.cellWidth + 11 * layout.gap).toBeLessThanOrEqual(layout.barsX);
    }
    expect(calendarLayout(720, 24, true).height).toBeGreaterThan(calendarLayout(720, 10, false).height);
  });
});

describe('wrapText', () => {
  it('breaks a legend title into lines that fit a phone', () => {
    const title = 'Raw detections per month, on the color scale of the harmonized view';
    expect(wrapText(title, 11, 1200)).toEqual([title]);
    const lines = wrapText(title, 11, 309);
    expect(lines.length).toBe(2);
    expect(lines.join(' ')).toBe(title);
    for (const line of lines) expect(line.length * 11 * 0.56).toBeLessThanOrEqual(309);
    expect(wrapText('', 11, 100)).toEqual([]);
  });
});

describe('buildCalendarModel', () => {
  it('has one row per year, oldest first, with twelve cells and the year total', () => {
    const model = buildCalendarModel(input());
    expect(model.rows.map((row) => row.year)).toEqual(Array.from({ length: 24 }, (_, i) => 2003 + i));
    for (const row of model.rows) expect(row.cells.map((cell) => cell.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(model.rows[0].total).toBe(10 * 20 + 2 + 100);
    expect(model.rows[0].totalLabel).toBe('302');
    expect(model.rows[0].complete).toBe(true);
    expect(model.rows.find((row) => row.year === 2010)!.complete).toBe(false);
    expect(model.rows[23].complete).toBe(false);
    expect(model.maxTotal).toBe(10 * 20 + 2 + 300);
  });

  it('follows the year range and stops at the last year with data', () => {
    expect(buildCalendarModel(input({ yearFrom: 2010, yearTo: 2012 })).rows.map((row) => row.year)).toEqual([2010, 2011, 2012]);
    const ended: Completeness = { incomplete: new Set(), lastCompleteYear: 2025, lastMonthIdx: 275, partial: null };
    const model = buildCalendarModel(input({ completeness: ended, mtd: [] }));
    expect(model.rows[model.rows.length - 1].year).toBe(2025);
    expect(model.rows).toHaveLength(23);
  });

  it('marks incomplete, partial and no-data cells as hatched, and no others', () => {
    const model = buildCalendarModel(input());
    const cell = (year: number, month: number) => model.rows.find((row) => row.year === year)!.cells[month - 1];
    expect(cell(2010, 9)).toMatchObject({ status: 'incomplete', hatched: true });
    expect(cell(2026, 11)).toMatchObject({ status: 'partial', hatched: true, value: 30 });
    expect(cell(2026, 12)).toMatchObject({ status: 'nodata', hatched: true });
    expect(cell(2020, 8)).toMatchObject({ status: 'complete', hatched: false });
    const hatched = model.rows.flatMap((row) => row.cells).filter((c) => c.hatched);
    expect(hatched.map((c) => c.monthIdx)).toEqual([monthIdx(2010, 9), 286, 287]);
  });

  it('never draws a month without data as zero fire', () => {
    const model = buildCalendarModel(input());
    const december = model.rows[23].cells[11];
    expect(december.fill).toBe(NODATA_COLOR);
    expect(december.fill).not.toBe(ZERO_COLOR);
    expect(december.label).toBe('');
    expect(december.assessment).toBeNull();
    // The year total covers the months with data only.
    expect(model.rows[23].total).toBe(8 * 20 + 2 + 100 + 30);
  });

  it('colours counts on the area-wide 98th percentile, whatever years are shown', () => {
    const model = buildCalendarModel(input());
    expect(model.scaleMax).toBe(100); // 23 Augusts of 100 or more sit above the 98th percentile of 287 months
    const august = model.rows[0].cells[7];
    expect(august).toMatchObject({ value: 100, label: '100', fill: colorForCount(100, 100), ink: '#ffffff' });
    expect(model.rows[0].cells[2].fill).toBe(colorForCount(2, 100));
    expect(buildCalendarModel(input({ yearFrom: 2020, yearTo: 2020 })).scaleMax).toBe(100);
  });

  it('colours anomalies against each month\'s baseline', () => {
    const model = buildCalendarModel(input({ mode: 'anomaly' }));
    const cell = (year: number, month: number) => model.rows.find((row) => row.year === year)!.cells[month - 1];
    expect(model.mode).toBe('anomaly');
    expect(model.anomalyEnabled).toBe(true);
    expect(cell(2020, 8).fill).toBe(colorForAnomaly(300, 100));
    expect(cell(2019, 8).fill).toBe(colorForAnomaly(100, 100));
    expect(cell(2019, 3).fill).toBe(RARE_COLOR); // usually almost no fire in March
    expect(cell(2010, 9).fill).toBe(RARE_COLOR); // incomplete: not compared
    expect(cell(2026, 11).fill).toBe(colorForAnomaly(30, 10)); // days 1 to 14 against days 1 to 14
    expect(cell(2020, 8).assessment).toMatchObject({ ratio: 3, rank: 1, category: 'record_high' });
  });

  it('switches anomaly mode off in Raw view and labels the divider as not comparable', () => {
    const model = buildCalendarModel(input({ view: 'raw', mode: 'anomaly' }));
    expect(model.view).toBe('raw');
    expect(model.anomalyEnabled).toBe(false);
    expect(model.mode).toBe('count');
    expect(model.divider).toEqual({ afterYear: 2011, labelKey: 'divider.raw' });
    expect(model.season).toBeNull();
    const august2020 = model.rows.find((row) => row.year === 2020)!.cells[7];
    expect(august2020.value).toBe(1200);
    expect(august2020.assessment).toBeNull();
    expect(august2020.error).toBeNull();
    // Raw counts are drawn on the harmonized scale, so the jump at 2012 shows.
    expect(model.scaleMax).toBe(100);
    expect(model.rows[0].cells[0].fill).toBe(colorForCount(25, 100));
    expect(model.rows[20].cells[0].fill).toBe(colorForCount(80, 100));
  });

  it('puts the divider between 2011 and 2012 only when both are shown', () => {
    expect(buildCalendarModel(input()).divider).toEqual({ afterYear: 2011, labelKey: 'divider.harmonized' });
    expect(buildCalendarModel(input({ yearFrom: 2012 })).divider).toBeNull();
    expect(buildCalendarModel(input({ yearTo: 2011 })).divider).toBeNull();
    expect(buildCalendarModel(input({ yearFrom: 2011, yearTo: 2012 })).divider).not.toBeNull();
  });

  it('carries a fire season of up to six months, for the bracket', () => {
    // In the default series 80% of the year takes nine months: too long a run to bracket as a season.
    expect(buildCalendarModel(input()).season).toBeNull();
    const winter = monthly.map((_, idx) => ([7, 8, 9].includes(monthOfIdx(idx)) ? 500 : 5));
    expect(buildCalendarModel(input({ monthly: winter })).season).toEqual({ start: 7, end: 9 });
    const halfYear = monthly.map((_, idx) => (monthOfIdx(idx) <= 6 ? 100 : 1));
    expect(buildCalendarModel(input({ monthly: halfYear })).season).toEqual({ start: 1, end: 5 });
  });

  it('carries the selected cell and each month\'s carrier', () => {
    const model = buildCalendarModel(input({ sel: monthIdx(2020, 8) }));
    const cells = model.rows.flatMap((row) => row.cells);
    expect(cells.filter((c) => c.selected).map((c) => c.monthIdx)).toEqual([monthIdx(2020, 8)]);
    expect(cells[0]).toMatchObject({ carrier: 'Aqua MODIS', error: null });
    expect(cells[109]).toMatchObject({ carrier: 'S-NPP VIIRS', error: { kind: 'pct', pct: 17, carrier: 'S-NPP VIIRS' } });
    expect(cells[110]).toMatchObject({ carrier: 'S-NPP VIIRS', error: { kind: 'tooSmall' } }); // March: 2 hotspots
    // The bands are S-NPP's: a NOAA-20 month takes the figure without a satellite's name.
    expect(cells[286]).toMatchObject({ carrier: 'NOAA-20 VIIRS', error: { kind: 'pct', pct: 17, carrier: null } });
  });

  it('says when the shown years hold no fire at all', () => {
    const zeros = new Array(MONTHS).fill(0);
    const model = buildCalendarModel(input({ monthly: zeros, raw: zeros, mtd: new Array(24).fill(0) }));
    expect(model.empty).toBe(true);
    expect(model.scaleMax).toBeGreaterThan(0);
    expect(model.maxTotal).toBe(0);
    expect(buildCalendarModel(input()).empty).toBe(false);
  });
});

describe('describeCell', () => {
  const model = buildCalendarModel(input());
  const cell = (year: number, month: number, from = model) => from.rows.find((row) => row.year === year)!.cells[month - 1];

  it('gives the count, the usual level, the ratio, the rank, the category and the typical error', () => {
    expect(describeCell(cell(2020, 8), 'en')).toEqual([
      'Aug 2020',
      '300 MODIS-equivalent hotspots',
      'Usual level for this month (median): 100',
      '3.0× the usual level',
      'The highest August since 2003',
      'Record for this month',
      'In the test, a count this size typically came within 17% of MODIS (S-NPP VIIRS)',
    ]);
    expect(describeCell(cell(2020, 8), 'es')).toEqual([
      'Ago 2020',
      '300 focos equivalentes a MODIS',
      'Nivel habitual de este mes (mediana): 100',
      '3,0 veces el nivel habitual',
      'El valor más alto para agosto desde 2003',
      'Récord para este mes',
      'En la prueba, un conteo de este tamaño quedó típicamente a menos de 17 % de MODIS (S-NPP VIIRS)',
    ]);
  });

  it('has no typical error for months carried by Aqua', () => {
    expect(describeCell(cell(2005, 8), 'en')).toEqual([
      'Aug 2005',
      '100 MODIS-equivalent hotspots',
      'Usual level for this month (median): 100',
      '1.0× the usual level',
      'The 2nd highest August since 2003',
      'Near normal',
    ]);
  });

  it('says fire is rare instead of giving a ratio, and ranks no count below 5 there', () => {
    expect(describeCell(cell(2019, 3), 'en')).toEqual([
      'Mar 2019',
      '2 MODIS-equivalent hotspots',
      'Usual level for this month (median): 2',
      'Usually almost no fire here this month',
      'Too few hotspots to rate the typical error',
    ]);
    expect(describeCell(cell(2019, 3), 'es')[4]).toBe('Muy pocos focos para estimar el error típico');
  });

  it('gives the typical error of counts of the same size', () => {
    // Twelve hotspots a month instead of twenty: the 5 to 19 band.
    const smaller = buildCalendarModel(input({ monthly: monthly.map((value) => (value === 20 ? 12 : value)) }));
    expect(describeCell(cell(2015, 5, smaller), 'en')).toContain('In the test, a count this size typically came within 43% of MODIS (S-NPP VIIRS)');
    expect(describeCell(cell(2015, 8, smaller), 'en')).toContain('In the test, a count this size typically came within 17% of MODIS (S-NPP VIIRS)');
  });

  it('falls back to the carrier\'s typical error when validation.json has no bands', () => {
    const plain = buildCalendarModel(input({ errorBands: [] }));
    expect(describeCell(cell(2020, 8, plain), 'en')).toContain('In the test, a count this size typically came within 17% of MODIS (S-NPP VIIRS)');
    expect(describeCell(cell(2026, 11, plain), 'en')).toContain('In the test, a count this size typically came within 18% of MODIS (NOAA-20 VIIRS)');
  });

  it('explains the partial month, an incomplete month and a month without data', () => {
    expect(describeCell(cell(2026, 11), 'en')).toEqual([
      'Nov 1–14, 2026',
      '30 MODIS-equivalent hotspots',
      'Usual level for this month (median): 10',
      '3.0× the usual level',
      'The highest Nov 1–14 since 2003',
      'Record for this month',
      'In the test, a count this size typically came within 17% of MODIS',
      'Month so far (days 1–14), compared with the same days in other years',
    ]);
    expect(describeCell(cell(2010, 9), 'en')).toEqual([
      'Sep 2010',
      '20 MODIS-equivalent hotspots',
      'Incomplete satellite data: not compared with other years',
    ]);
    expect(describeCell(cell(2026, 12), 'en')).toEqual(['Dec 2026', 'No data yet']);
    expect(describeCell(cell(2026, 12), 'es')).toEqual(['Dic 2026', 'Todavía sin datos']);
  });

  it('speaks of one day when the partial month has a single day of data', () => {
    const firstDay: Completeness = { ...completeness, partial: { monthIdx: 286, lastDay: 1 } };
    const early = buildCalendarModel(input({ completeness: firstDay }));
    const lines = describeCell(cell(2026, 11, early), 'en');
    expect(lines[0]).toBe('Nov 1, 2026');
    expect(lines[lines.length - 1]).toBe('Month so far (day 1), compared with the same day in other years');
    expect(describeCell(cell(2026, 11, early), 'es')[0]).toBe('1 nov 2026');
    const rawLines = describeCell(cell(2026, 11, buildCalendarModel(input({ completeness: firstDay, view: 'raw' }))), 'en');
    expect(rawLines[rawLines.length - 1]).toBe('Month so far (day 1)');
  });

  it('describes Raw view cells as raw detections that are not comparable', () => {
    const rawModel = buildCalendarModel(input({ view: 'raw' }));
    expect(describeCell(cell(2020, 8, rawModel), 'en')).toEqual([
      'Aug 2020',
      '1,200 raw detections',
      'Raw counts are not comparable across 2012',
    ]);
    expect(describeCell(cell(2026, 11, rawModel), 'en')).toEqual([
      'Nov 1–14, 2026',
      '120 raw detections',
      'Raw counts are not comparable across 2012',
      'Month so far (days 1–14)',
    ]);
    expect(describeCell(cell(2020, 8, rawModel), 'es')).toEqual([
      'Ago 2020',
      '1200 detecciones sin armonizar',
      'Los conteos sin armonizar no son comparables antes y después de 2012',
    ]);
  });

  it('never contains NaN, whatever the cell', () => {
    for (const from of [model, buildCalendarModel(input({ view: 'raw' })), buildCalendarModel(input({ mode: 'anomaly' }))]) {
      for (const c of from.rows.flatMap((row) => row.cells)) {
        for (const lang of ['en', 'es'] as const) {
          expect(describeCell(c, lang).join(' | ')).not.toMatch(/NaN|Infinity|undefined|null|\{/);
        }
      }
    }
  });
});
