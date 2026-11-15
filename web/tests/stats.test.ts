import { describe, expect, it } from 'vitest';
import {
  FIRST_YEAR,
  assessMonth,
  baseline,
  carrierForMonth,
  categorize,
  completenessFromMeta,
  errorBands,
  fireSeason,
  mannKendall,
  monthIdx,
  monthOfIdx,
  monthlyMedians,
  peakMonth,
  quantile,
  rank,
  seasonFromMedians,
  seasonLength,
  seriesCarriers,
  summarize,
  trend,
  typicalError,
  yearOfIdx,
  yearlyTotals,
  type Completeness,
  type YearValue,
} from '../src/stats';

const MONTHS = 287;

/** Data through 2026-11-14: 2025 is the last complete year and November 2026 is partial. */
function completeness(incomplete: number[] = []): Completeness {
  return {
    incomplete: new Set(incomplete),
    lastCompleteYear: 2025,
    lastMonthIdx: 286,
    partial: { monthIdx: 286, lastDay: 14 },
  };
}

/** A 287-month series from a function of (year, month 1 to 12). */
function seriesOf(value: (year: number, month: number) => number): number[] {
  return Array.from({ length: MONTHS }, (_, idx) => value(yearOfIdx(idx), monthOfIdx(idx)));
}

/** Yearly totals for consecutive complete years starting in 2003. */
function years(values: number[], incompleteYears: number[] = []): YearValue[] {
  return values.map((value, i) => ({
    year: FIRST_YEAR + i,
    value,
    complete: !incompleteYears.includes(FIRST_YEAR + i),
  }));
}

function hasNoNaN(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (value !== null && typeof value === 'object') return Object.values(value).every(hasNoNaN);
  return true;
}

describe('month index', () => {
  it('follows the data contract', () => {
    expect(FIRST_YEAR).toBe(2003);
    expect(monthIdx(2003, 1)).toBe(0);
    expect(monthIdx(2012, 2)).toBe(109);
    expect(monthIdx(2026, 11)).toBe(286);
    expect([yearOfIdx(0), monthOfIdx(0)]).toEqual([2003, 1]);
    expect([yearOfIdx(109), monthOfIdx(109)]).toEqual([2012, 2]);
    expect([yearOfIdx(286), monthOfIdx(286)]).toEqual([2026, 11]);
  });
});

describe('completenessFromMeta', () => {
  const incomplete_months = [{ month_idx: 92, coverage: 0.7, sensor: 'A' as const }];

  it('reads a partial current month', () => {
    const c = completenessFromMeta({
      data_end_date: '2026-11-14',
      incomplete_months,
      mtd: { month: 11, last_day: 14 },
    });
    expect(c.lastCompleteYear).toBe(2025);
    expect(c.lastMonthIdx).toBe(286);
    expect(c.partial).toEqual({ monthIdx: 286, lastDay: 14 });
    expect([...c.incomplete]).toEqual([92]);
  });

  it('reads data that ends on the last day of a year', () => {
    const c = completenessFromMeta({ data_end_date: '2025-12-31', incomplete_months: [], mtd: null });
    expect(c.lastCompleteYear).toBe(2025);
    expect(c.lastMonthIdx).toBe(275);
    expect(c.partial).toBeNull();
  });

  it('reads data that ends on the last day of another month, leap years included', () => {
    const feb = completenessFromMeta({ data_end_date: '2026-02-28', incomplete_months: [], mtd: null });
    expect(feb.lastCompleteYear).toBe(2025);
    expect(feb.lastMonthIdx).toBe(277);
    expect(feb.partial).toBeNull();
    const leap = completenessFromMeta({
      data_end_date: '2024-02-28',
      incomplete_months: [],
      mtd: { month: 2, last_day: 28 },
    });
    expect(leap.lastCompleteYear).toBe(2023);
    expect(leap.partial).toEqual({ monthIdx: monthIdx(2024, 2), lastDay: 28 });
  });
});

describe('series carriers', () => {
  const base = { switch_month: '2012-02', typical_error_pct: 17.27 };

  it('falls back to switch_month and the top-level error when meta has no series', () => {
    const carriers = seriesCarriers(base);
    expect(carriers).toEqual([
      { sat: 'A', name: 'Aqua MODIS', fromIdx: 0, toIdx: 108, typicalErrorPct: null },
      { sat: 'N', name: 'S-NPP VIIRS', fromIdx: 109, toIdx: null, typicalErrorPct: 17.27 },
    ]);
    expect(carrierForMonth(carriers, 0)!.sat).toBe('A');
    expect(carrierForMonth(carriers, 108)!.sat).toBe('A');
    expect(carrierForMonth(carriers, 109)!.sat).toBe('N');
    expect(carrierForMonth(carriers, 286)).toMatchObject({ sat: 'N', typicalErrorPct: 17.27 });
  });

  it('reads the carriers in order from meta.series, each with its own typical error', () => {
    const carriers = seriesCarriers({
      ...base,
      series: [
        { sat: 'A', name: 'Aqua MODIS', from: '2003-01', to: '2012-01', typical_error_pct: null },
        { sat: 'N', name: 'S-NPP VIIRS', from: '2012-02', to: '2026-10', typical_error_pct: 17.3 },
        { sat: 'N20', name: 'NOAA-20 VIIRS', from: '2026-11', to: null, typical_error_pct: 18.0 },
      ],
    });
    expect(carriers.map((c) => [c.sat, c.fromIdx, c.toIdx])).toEqual([
      ['A', 0, 108],
      ['N', 109, 285],
      ['N20', 286, null],
    ]);
    expect(carrierForMonth(carriers, 50)).toMatchObject({ name: 'Aqua MODIS', typicalErrorPct: null });
    expect(carrierForMonth(carriers, 285)).toMatchObject({ name: 'S-NPP VIIRS', typicalErrorPct: 17.3 });
    expect(carrierForMonth(carriers, 286)).toMatchObject({ name: 'NOAA-20 VIIRS', typicalErrorPct: 18.0 });
  });

  it('ignores a malformed series list rather than failing', () => {
    expect(seriesCarriers({ ...base, series: [] })).toHaveLength(2);
    expect(seriesCarriers({ ...base, series: [{ sat: 'N', name: 'S-NPP VIIRS', from: 'soon', to: null, typical_error_pct: 1 }] })).toHaveLength(2);
    expect(carrierForMonth(seriesCarriers(base), -1)).toBeNull();
  });
});

describe('typical error by the size of the count', () => {
  const snpp = { sat: 'N', name: 'S-NPP VIIRS', fromIdx: 109, toIdx: 285, typicalErrorPct: 16.98 };
  const noaa20 = { sat: 'N20', name: 'NOAA-20 VIIRS', fromIdx: 286, toIdx: null, typicalErrorPct: 17.45 };
  const aqua = { sat: 'A', name: 'Aqua MODIS', fromIdx: 0, toIdx: 108, typicalErrorPct: null };
  const bands = errorBands({
    error_by_count: [
      { band: '1-4', n: 63, mape: 124.04 },
      { band: '5-19', n: 107, mape: 43.27 },
      { band: '20+', n: 331, mape: 16.98 },
    ],
  });

  it('reads the bands of validation.json', () => {
    expect(bands).toEqual([
      { from: 1, mape: 124.04 },
      { from: 5, mape: 43.27 },
      { from: 20, mape: 16.98 },
    ]);
    expect(errorBands(null)).toEqual([]);
    expect(errorBands({})).toEqual([]);
    expect(errorBands({ error_by_count: [{ band: 'many', n: 1, mape: 10 }] })).toEqual([]);
  });

  it('uses the band of the count: 20 or more, 5 to 19', () => {
    expect(typicalError(300, snpp, bands)).toEqual({ kind: 'pct', pct: 16.98, carrier: 'S-NPP VIIRS' });
    expect(typicalError(20, snpp, bands)).toEqual({ kind: 'pct', pct: 16.98, carrier: 'S-NPP VIIRS' });
    expect(typicalError(19.9, snpp, bands)).toEqual({ kind: 'pct', pct: 43.27, carrier: 'S-NPP VIIRS' });
    expect(typicalError(5, snpp, bands)).toEqual({ kind: 'pct', pct: 43.27, carrier: 'S-NPP VIIRS' });
  });

  it('gives no percentage below 5: the count is too small to rate', () => {
    expect(typicalError(4.9, snpp, bands)).toEqual({ kind: 'tooSmall' });
    expect(typicalError(0, snpp, bands)).toEqual({ kind: 'tooSmall' });
    expect(typicalError(3, snpp, [])).toEqual({ kind: 'tooSmall' });
  });

  it('has no typical error for months carried by Aqua, the reference', () => {
    expect(typicalError(300, aqua, bands)).toBeNull();
    expect(typicalError(300, null, bands)).toBeNull();
  });

  it('names a satellite only when the figure is that satellite\'s own', () => {
    // The bands were measured on S-NPP. For a NOAA-20 month the band figure stands, without a name.
    expect(typicalError(300, noaa20, bands)).toEqual({ kind: 'pct', pct: 16.98, carrier: null });
    expect(typicalError(12, noaa20, bands)).toEqual({ kind: 'pct', pct: 43.27, carrier: null });
    expect(typicalError(3, noaa20, bands)).toEqual({ kind: 'tooSmall' });
    // Without bands the figure is NOAA-20's own test result, so it carries NOAA-20's name.
    expect(typicalError(300, noaa20, [])).toEqual({ kind: 'pct', pct: 17.45, carrier: 'NOAA-20 VIIRS' });
  });

  it('falls back to the carrier\'s own typical error when there are no bands', () => {
    expect(typicalError(300, snpp, [])).toEqual({ kind: 'pct', pct: 16.98, carrier: 'S-NPP VIIRS' });
    expect(typicalError(12, snpp, [])).toEqual({ kind: 'pct', pct: 16.98, carrier: 'S-NPP VIIRS' });
  });
});

describe('quantile and summarize', () => {
  it('interpolates linearly between ranks', () => {
    expect(quantile([10, 20, 30, 40, 50], 0.25)).toBe(20);
    expect(quantile([10, 20, 30, 40, 50], 0.5)).toBe(30);
    expect(quantile([10, 20, 30, 40, 50], 0.75)).toBe(40);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(quantile([7], 0.75)).toBe(7);
  });

  it('summarizes values into median, quartiles and the sorted values', () => {
    expect(summarize([50, 10, 40, 20, 30])).toEqual({ median: 30, q1: 20, q3: 40, values: [10, 20, 30, 40, 50] });
    expect(summarize([])).toBeNull();
  });
});

describe('baseline', () => {
  // August of year Y holds Y - 2000; every other month holds 1000.
  const series = seriesOf((year, month) => (month === 8 ? year - 2000 : 1000));

  it('takes the same month in every other year up to the last complete year', () => {
    const b = baseline(series, monthIdx(2010, 8), completeness())!;
    const expected = Array.from({ length: 23 }, (_, i) => i + 3).filter((v) => v !== 10); // 2003..2025 without 2010
    expect(b.values).toEqual(expected);
    expect(b.values).not.toContain(26); // August 2026 is in the current year
    expect(b.median).toBe(14.5);
  });

  it('uses every complete year for a month of the current year', () => {
    const b = baseline(series, monthIdx(2026, 8), completeness())!;
    expect(b.values).toEqual(Array.from({ length: 23 }, (_, i) => i + 3));
    expect(b.median).toBe(14);
    expect(b.q1).toBe(8.5);
    expect(b.q3).toBe(19.5);
  });

  it('excludes a baseline month flagged incomplete', () => {
    const b = baseline(series, monthIdx(2010, 8), completeness([monthIdx(2006, 8), monthIdx(2020, 8)]))!;
    expect(b.values).toHaveLength(20);
    expect(b.values).not.toContain(6);
    expect(b.values).not.toContain(20);
    // An incomplete month in another calendar month changes nothing.
    const other = baseline(series, monthIdx(2010, 8), completeness([monthIdx(2006, 9)]))!;
    expect(other.values).toHaveLength(22);
  });

  it('is null when no year is left to compare with', () => {
    const everyAugust = Array.from({ length: 24 }, (_, y) => monthIdx(FIRST_YEAR + y, 8));
    expect(baseline(series, monthIdx(2010, 8), completeness(everyAugust))).toBeNull();
  });
});

describe('categorize and rank', () => {
  const b = summarize([10, 20, 30, 40, 50])!;

  it('names the category of a value against the baseline quartiles', () => {
    expect([b.q1, b.q3]).toEqual([20, 40]);
    expect(categorize(60, b)).toBe('record_high');
    expect(categorize(45, b)).toBe('above');
    expect(categorize(30, b)).toBe('near');
    expect(categorize(15, b)).toBe('below');
  });

  it('treats the quartiles themselves as near normal and a tie with the record as not a record', () => {
    expect(categorize(20, b)).toBe('near');
    expect(categorize(40, b)).toBe('near');
    expect(categorize(50, b)).toBe('above');
  });

  it('names a value well above normal when it passes Q3 + 1.5 x IQR without beating the record', () => {
    const wide = summarize([10, 20, 30, 40, 200])!;
    expect(wide.q3 + 1.5 * (wide.q3 - wide.q1)).toBe(70);
    expect(categorize(100, wide)).toBe('well_above');
    expect(categorize(70, wide)).toBe('above');
    expect(categorize(201, wide)).toBe('record_high');
  });

  it('ranks a value among the baseline, 1 being the highest', () => {
    expect(rank(60, b)).toBe(1);
    expect(rank(50, b)).toBe(1);
    expect(rank(45, b)).toBe(2);
    expect(rank(30, b)).toBe(3);
    expect(rank(5, b)).toBe(6);
  });
});

describe('assessMonth', () => {
  it('assesses a complete month against its baseline', () => {
    const series = seriesOf((year, month) => (month === 8 ? (year === 2020 ? 66 : 30) : 0));
    const result = assessMonth({ monthly: series, mtd: [] }, monthIdx(2020, 8), completeness());
    expect(result).toMatchObject({
      monthIdx: monthIdx(2020, 8),
      status: 'complete',
      partialDay: null,
      value: 66,
      rank: 1,
      ratio: 2.2,
      rare: false,
      category: 'record_high',
    });
    expect(result.baseline!.median).toBe(30);
    expect(result.baseline!.values).toHaveLength(22);
  });

  it('gives no ratio and no NaN where fire is rare (baseline all zeros, value 3)', () => {
    const series = seriesOf((year, month) => (year === 2015 && month === 6 ? 3 : 0));
    const result = assessMonth({ monthly: series, mtd: [] }, monthIdx(2015, 6), completeness());
    expect(result.baseline!.median).toBe(0);
    expect(result.rare).toBe(true);
    expect(result.ratio).toBeNull();
    expect(result.value).toBe(3);
    expect(result.rank).toBe(1);
    expect(hasNoNaN(result)).toBe(true);
  });

  it('gives no ratio below a median of 5 and a ratio from 5 up', () => {
    const at = (median: number) =>
      assessMonth(
        { monthly: seriesOf((year, month) => (month === 3 ? (year === 2015 ? 12 : median) : 0)), mtd: [] },
        monthIdx(2015, 3),
        completeness(),
      );
    expect(at(4.9).rare).toBe(true);
    expect(at(4.9).ratio).toBeNull();
    expect(at(5).rare).toBe(false);
    expect(at(5).ratio).toBe(2.4);
  });

  it('compares the partial current month on month-to-date values, not full months', () => {
    // Every past November had 100 hotspots, 45 of them by day 14. This year has 50 by day 14.
    const monthly = seriesOf((year, month) => (month === 11 ? (year === 2026 ? 50 : 100) : 0));
    const mtd = Array.from({ length: 24 }, (_, y) => (y === 23 ? 50 : 45));
    const result = assessMonth({ monthly, mtd }, 286, completeness());
    expect(result.status).toBe('partial');
    expect(result.partialDay).toBe(14);
    expect(result.value).toBe(50);
    expect(result.baseline!.values).toEqual(new Array(23).fill(45));
    expect(result.baseline!.median).toBe(45);
    expect(result.ratio).toBeCloseTo(50 / 45, 12);
    expect(result.category).toBe('record_high'); // against full months it would read "below normal"
    expect(result.rank).toBe(1);
  });

  it('leaves incomplete past Novembers out of the month-to-date baseline', () => {
    const monthly = seriesOf((_, month) => (month === 11 ? 100 : 0));
    const mtd = Array.from({ length: 24 }, (_, y) => (y === 5 ? 1 : 45));
    const result = assessMonth({ monthly, mtd }, 286, completeness([monthIdx(2008, 11)]));
    expect(result.baseline!.values).toEqual(new Array(22).fill(45));
  });

  it('does not compare a partial month when there are no month-to-date values', () => {
    const monthly = seriesOf((year, month) => (month === 11 ? (year === 2026 ? 50 : 100) : 0));
    const result = assessMonth({ monthly, mtd: [] }, 286, completeness());
    expect(result).toMatchObject({ status: 'partial', partialDay: 14, value: 50, baseline: null, category: null });
    expect(result.rank).toBeNull();
    expect(result.ratio).toBeNull();
  });

  it('does not rank or categorize a month with incomplete data', () => {
    const series = seriesOf((year, month) => (month === 9 ? (year === 2010 ? 4 : 30) : 0));
    const result = assessMonth({ monthly: series, mtd: [] }, monthIdx(2010, 9), completeness([monthIdx(2010, 9)]));
    expect(result).toEqual({
      monthIdx: monthIdx(2010, 9),
      status: 'incomplete',
      partialDay: null,
      value: 4,
      baseline: null,
      rank: null,
      ratio: null,
      rare: false,
      category: null,
    });
  });

  it('reports no data after the end of the data', () => {
    const ended: Completeness = { incomplete: new Set(), lastCompleteYear: 2025, lastMonthIdx: 275, partial: null };
    const result = assessMonth({ monthly: seriesOf(() => 0), mtd: [] }, monthIdx(2026, 3), ended);
    expect(result.status).toBe('nodata');
    expect(result.category).toBeNull();
    expect(result.rank).toBeNull();
    expect(hasNoNaN(result)).toBe(true);
  });

  it('accepts typed arrays', () => {
    const monthly = Float32Array.from(seriesOf((year, month) => (month === 8 ? (year === 2020 ? 66 : 30) : 0)));
    const result = assessMonth({ monthly, mtd: new Float32Array(0) }, monthIdx(2020, 8), completeness());
    expect(result.ratio).toBeCloseTo(2.2, 6);
  });
});

describe('fire season', () => {
  it('finds the shortest run of months holding at least 80% of the year', () => {
    // Jul to Sep hold 85 of 100.
    expect(seasonFromMedians([0, 0, 0, 0, 0, 5, 20, 40, 25, 10, 0, 0])).toEqual({ start: 7, end: 9 });
  });

  it('wraps from December to January', () => {
    expect(seasonFromMedians([30, 20, 2, 0, 0, 0, 0, 0, 0, 1, 3, 25])).toEqual({ start: 12, end: 2 });
  });

  it('is null when the twelve medians sum to less than 12', () => {
    expect(seasonFromMedians([0, 0, 0, 0, 0, 0, 1, 3, 2, 0, 0, 0])).toBeNull();
    expect(seasonFromMedians([0, 0, 0, 0, 0, 0, 2, 6, 3.9, 0, 0, 0])).toBeNull();
    // Exactly 12 is enough; Aug and Sep hold 10 of it.
    expect(seasonFromMedians([0, 0, 0, 0, 0, 0, 2, 6, 4, 0, 0, 0])).toEqual({ start: 8, end: 9 });
    expect(seasonFromMedians(new Array(12).fill(0))).toBeNull();
  });

  it('can be a single month, and prefers the fuller of two equally short runs', () => {
    expect(seasonFromMedians([0, 0, 0, 0, 0, 0, 0, 50, 0, 0, 0, 0])).toEqual({ start: 8, end: 8 });
    // Apr-May holds 82 of 100 and May-Jun holds 88: both are two months long.
    expect(seasonFromMedians([0, 0, 0, 12, 70, 18, 0, 0, 0, 0, 0, 0])).toEqual({ start: 5, end: 6 });
    // A dead heat goes to the earlier run.
    expect(seasonFromMedians([0, 0, 0, 15, 70, 15, 0, 0, 0, 0, 0, 0])).toEqual({ start: 4, end: 5 });
  });

  it('takes ten months when fire is spread evenly', () => {
    expect(seasonFromMedians(new Array(12).fill(10))).toEqual({ start: 1, end: 10 });
  });

  it('takes the median of each calendar month over complete years, skipping incomplete months', () => {
    // Three complete years. January: 10, 20, 1000.
    const short: Completeness = { incomplete: new Set(), lastCompleteYear: 2005, lastMonthIdx: 40, partial: null };
    const series = seriesOf((year, month) => (month === 1 ? [10, 20, 1000][year - 2003] ?? 5000 : month));
    expect(monthlyMedians(series, short)[0]).toBe(20);
    expect(monthlyMedians(series, short).slice(1)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(monthlyMedians(series, { ...short, incomplete: new Set([monthIdx(2005, 1)]) })[0]).toBe(15);
  });

  it('counts the months of a season, across New Year too', () => {
    expect(seasonLength({ start: 7, end: 9 })).toBe(3);
    expect(seasonLength({ start: 8, end: 8 })).toBe(1);
    expect(seasonLength({ start: 12, end: 2 })).toBe(3);
    expect(seasonLength({ start: 7, end: 1 })).toBe(7);
    expect(seasonLength({ start: 1, end: 12 })).toBe(12);
  });

  it('names the peak month: the highest median, the earlier one on a tie', () => {
    expect(peakMonth([0, 0, 0, 0, 0, 5, 20, 40, 25, 10, 0, 0])).toBe(8);
    expect(peakMonth([30, 20, 2, 0, 0, 0, 0, 0, 0, 1, 3, 30])).toBe(1);
    expect(peakMonth(new Array(12).fill(0))).toBeNull();
  });

  it('reads the season from a series', () => {
    const profile = [0, 0, 0, 0, 0, 5, 20, 40, 25, 10, 0, 0];
    const series = seriesOf((_, month) => profile[month - 1]);
    expect(fireSeason(series, completeness())).toEqual({ start: 7, end: 9 });
    expect(fireSeason(seriesOf(() => 0.5), completeness())).toBeNull();
  });
});

describe('yearlyTotals', () => {
  const series = seriesOf((year, month) => year - 2000 + month / 100);

  it('sums each year and marks the complete ones', () => {
    const totals = yearlyTotals(series, completeness([monthIdx(2010, 9)]));
    expect(totals).toHaveLength(24);
    expect(totals[0]).toEqual({ year: 2003, value: expect.closeTo(36.78, 9), complete: true });
    expect(totals.find((t) => t.year === 2010)!.complete).toBe(false); // one incomplete month
    expect(totals.find((t) => t.year === 2025)!.complete).toBe(true);
    // The current year holds January to November only and is never complete.
    expect(totals[23]).toEqual({ year: 2026, value: expect.closeTo(11 * 26 + 0.66, 9), complete: false });
    expect(totals.filter((t) => t.complete)).toHaveLength(22);
  });

  it('stops at the last year with data', () => {
    const ended: Completeness = { incomplete: new Set(), lastCompleteYear: 2025, lastMonthIdx: 275, partial: null };
    const totals = yearlyTotals(series, ended);
    expect(totals).toHaveLength(23);
    expect(totals.every((t) => t.complete)).toBe(true);
  });
});

describe('trend (plan section 4.9)', () => {
  it('finds a rising trend: slope 2, fitted first-year value 50, 40% per decade, p < 0.001', () => {
    const result = trend(years([50, 52, 54, 56, 58, 60, 62, 64, 66, 68]));
    expect(result).toMatchObject({ slope: 2, startValue: 50, pctPerDecade: 40, direction: 'rising', fromYear: 2003, toYear: 2012 });
    if ('reason' in result) throw new Error('expected a trend');
    expect(result.p).toBeLessThan(0.001);
    expect(result.p).toBeCloseTo(8.303e-5, 7);
  });

  it('gives no percentage for a trend that starts from almost nothing', () => {
    // The fitted value at the first year is 5, below 12: a percentage of it would mean little.
    const result = trend(years([5, 7, 9, 11, 13, 15, 17, 19, 21, 23]));
    expect(result).toMatchObject({ slope: 2, startValue: 5, pctPerDecade: null, direction: 'rising' });
    // The same when the fitted line starts below zero.
    const fromZero = trend(years([0, 0, 0, 1, 20, 45, 60, 85, 100, 125]));
    expect(fromZero).toMatchObject({ pctPerDecade: null, direction: 'rising' });
    if ('reason' in fromZero) throw new Error('expected a trend');
    expect(fromZero.startValue).toBeLessThan(12);
  });

  it('measures a decline against where the fitted line starts, so it cannot pass 100% over the record', () => {
    // From about 1,000 down to about 100 in twenty years: a median-based rate would read as more than 100% a decade.
    const values = Array.from({ length: 21 }, (_, i) => 1000 - 45 * i);
    const result = trend(years(values));
    if ('reason' in result) throw new Error('expected a trend');
    expect(result.slope).toBe(-45);
    expect(result.startValue).toBe(1000);
    expect(result.pctPerDecade).toBeCloseTo(-45, 9);
    expect(((result.slope * 10) / 550) * 100).toBeLessThan(-80); // what dividing by the median (550) gave
  });

  it('finds no trend in 5, 6, 5, 6, ... (S = 5, p about 0.68)', () => {
    const values = [5, 6, 5, 6, 5, 6, 5, 6, 5, 6];
    expect(mannKendall(values).s).toBe(5);
    expect(mannKendall(values).p).toBeCloseTo(0.6761, 4);
    const result = trend(years(values.map((v) => v * 10)));
    if ('reason' in result) throw new Error('expected a trend');
    expect(result.direction).toBe('none');
    expect(result.p).toBeCloseTo(0.6761, 4);
  });

  it('finds a falling trend through noise', () => {
    const result = trend(years([30, 28, 31, 25, 24, 26, 20, 18, 19, 15, 12, 14]));
    if ('reason' in result) throw new Error('expected a trend');
    expect(result.direction).toBe('falling');
    expect(result.slope).toBeCloseTo(-5 / 3, 12);
    expect(result.startValue).toBeCloseTo(30, 9);
    expect(result.pctPerDecade).toBeCloseTo(-55.5556, 4);
    expect(result.p).toBeCloseTo(0.000279, 6);
  });

  it('skips incomplete years: 11 years, one flagged, is computed on the other 10', () => {
    // 50, 52, ... with a bogus low value in the incomplete year 2008.
    const withGap = years([50, 52, 54, 56, 58, 0, 62, 64, 66, 68, 70], [2008]);
    const gap = trend(withGap);
    if ('reason' in gap) throw new Error('expected a trend');
    expect(gap.slope).toBe(2); // slopes are per calendar year, so the gap does not bend them
    expect(gap.startValue).toBe(50); // and the fitted line still starts at the first year's 50
    expect(gap.pctPerDecade).toBe(40);
    expect(gap.direction).toBe('rising');

    // The usual case: the current, partial year comes last.
    const withPartial = trend(years([50, 52, 54, 56, 58, 60, 62, 64, 66, 68, 2], [2013]));
    expect(withPartial).toEqual(trend(years([50, 52, 54, 56, 58, 60, 62, 64, 66, 68])));
  });

  it('reports too little fire when the median yearly total is below 12', () => {
    expect(trend(years([1, 2, 3, 4, 4, 4, 4, 5, 6, 7]))).toEqual({ reason: 'rare' });
    expect(trend(years([11, 11, 11, 11, 11, 11.9, 11.9, 30, 40, 50]))).toEqual({ reason: 'rare' });
    // A median of exactly 12 is enough.
    expect('reason' in trend(years([11, 11, 11, 11, 12, 12, 13, 30, 40, 50]))).toBe(false);
  });

  it('reports too few years with 9 complete years', () => {
    expect(trend(years([50, 52, 54, 56, 58, 60, 62, 64, 66]))).toEqual({ reason: 'short' });
    expect(trend(years([50, 52, 54, 56, 58, 60, 62, 64, 66, 68], [2005]))).toEqual({ reason: 'short' });
    expect(trend([])).toEqual({ reason: 'short' });
  });

  it('never returns NaN, even when every year is the same', () => {
    const flat = trend(years(new Array(12).fill(40)));
    expect(flat).toMatchObject({ slope: 0, startValue: 40, pctPerDecade: 0, p: 1, direction: 'none' });
    expect(hasNoNaN(flat)).toBe(true);
    expect(mannKendall([3, 3, 3])).toEqual({ s: 0, z: 0, p: 1 });
  });

  it('corrects the variance for ties', () => {
    // Two groups of five tied values: Var(S) = (10 * 9 * 25 - 2 * 5 * 4 * 15) / 18 = 91.67
    const { s, z } = mannKendall([5, 6, 5, 6, 5, 6, 5, 6, 5, 6]);
    expect(z).toBeCloseTo((s - 1) / Math.sqrt(1650 / 18), 12);
  });
});
