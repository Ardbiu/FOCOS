// What the record says about an area's trend, three ways: harmonized, raw, and
// harmonized with a province's known gap to MODIS removed. Nothing here changes
// a count that the app shows; these are checks on the trend.
import { describe, expect, it } from 'vitest';
import { extremeBandBias, nationalTrendCheck, provinceFindings, trendFrom, tallyTrends, trendClass, trendWithoutBias, yearSoFar } from '../src/findings';
import { monthIdx, trend, yearlyTotals, type Completeness, type YearValue } from '../src/stats';

const completeness: Completeness = {
  incomplete: new Set<number>(),
  lastCompleteYear: 2025,
  lastMonthIdx: 286,
  partial: { monthIdx: 286, lastDay: 14 },
};

/** A monthly series, Jan 2003 to Nov 2026, that holds `yearly(year)` spread evenly over each year. */
function series(yearly: (year: number) => number): number[] {
  return Array.from({ length: 287 }, (_, idx) => yearly(2003 + Math.floor(idx / 12)) / 12);
}

const years = (yearly: (year: number) => number): YearValue[] =>
  Array.from({ length: 23 }, (_, i) => ({ year: 2003 + i, value: yearly(2003 + i), complete: true }));

/** Steady fire with a little wobble, so no trend. */
const steady = (year: number) => 1200 + ((year * 7) % 5) * 20 - 40;
/** The same fire, counted 5 times over from 2012 on: what a sharper sensor does to raw counts. */
const jump = (year: number) => steady(year) * (year >= 2012 ? 5 : 1);
/** Fire that really falls, 30 a year from 1500. */
const falling = (year: number) => 1500 - 30 * (year - 2003);

describe('trendClass', () => {
  it('names a trend by its direction, or by why there is none', () => {
    expect(trendClass(trend(years(falling)))).toBe('falling');
    expect(trendClass(trend(years((year) => 500 + 40 * (year - 2003))))).toBe('rising');
    expect(trendClass(trend(years(steady)))).toBe('none');
    expect(trendClass(trend(years(() => 3)))).toBe('rare');
    expect(trendClass(trend(years(steady).slice(0, 5)))).toBe('short');
  });
});

describe('tallyTrends', () => {
  it('counts the areas by what their trend says', () => {
    const tally = tallyTrends([
      trend(years(falling)),
      trend(years(falling)),
      trend(years(steady)),
      trend(years(jump)),
      trend(years(() => 3)),
      trend(years(steady).slice(0, 5)),
    ]);
    expect(tally).toEqual({ rising: 1, falling: 2, none: 1, unrated: 2, total: 6 });
  });
});

describe('trendWithoutBias', () => {
  it('takes a known gap out of the VIIRS years and leaves the MODIS years alone', () => {
    // A record that ran 68% high from 2012 on reads as a rise; with the gap removed, the rise is gone.
    const inflated = years((year) => steady(year) * (year >= 2012 ? 1.68 : 1));
    expect(trendClass(trend(inflated))).toBe('rising');
    const adjusted = trendWithoutBias(inflated, 2012, 0.68);
    expect(trendClass(adjusted)).toBe('none');
    // The same numbers as the steady record, to rounding.
    const plain = trend(years(steady));
    if ('reason' in adjusted || 'reason' in plain) throw new Error('no trend');
    expect(adjusted.slope).toBeCloseTo(plain.slope, 6);
    expect(adjusted.startValue).toBeCloseTo(plain.startValue, 6);
  });

  it('works the other way for a record that ran low', () => {
    // A real fall of 30 a year, read 20% low from 2012 on: the fall is still there once that is undone.
    const low = years((year) => falling(year) * (year >= 2012 ? 0.8 : 1));
    const adjusted = trendWithoutBias(low, 2012, -0.2);
    expect(trendClass(adjusted)).toBe('falling');
    if ('reason' in adjusted) throw new Error('no trend');
    expect(adjusted.slope).toBeCloseTo(-30, 6);
  });

  it('does not touch the totals it is given', () => {
    const totals = years(steady);
    const before = JSON.stringify(totals);
    trendWithoutBias(totals, 2012, 0.5);
    expect(JSON.stringify(totals)).toBe(before);
  });
});

describe('provinceFindings', () => {
  const areas = [
    { id: '58', name: 'Neuquén', monthly: series((year) => steady(year) * (year >= 2012 ? 1.68 : 1)), raw: series(jump), mtd: [] },
    { id: '14', name: 'Córdoba', monthly: series((year) => falling(year) * (year >= 2012 ? 0.79 : 1)), raw: series(jump), mtd: [] },
    { id: '30', name: 'Entre Ríos', monthly: series(steady), raw: series(jump), mtd: [] },
    { id: '02', name: 'Ciudad', monthly: series(() => 3), raw: series(() => 9), mtd: [] },
  ];
  const biases = [
    { prov: '58', name: 'Neuquén', aqua: 100, harmonized: 168, bias: 0.68 },
    { prov: '14', name: 'Córdoba', aqua: 100, harmonized: 79, bias: -0.21 },
    { prov: '30', name: 'Entre Ríos', aqua: 100, harmonized: 103, bias: 0.03 },
  ];
  const found = provinceFindings(areas, completeness, 2012, biases);
  const of = (id: string) => found.find((row) => row.id === id)!;

  it('gives each area its harmonized trend and the trend of its raw counts', () => {
    expect(found.map((row) => row.id)).toEqual(['58', '14', '30', '02']);
    expect(trendClass(of('30').harmonized)).toBe('none');
    expect(trendClass(of('30').raw)).toBe('rising');
    expect(trendClass(of('14').harmonized)).toBe('falling');
    expect(trendClass(of('14').raw)).toBe('rising');
    // They are the app's own trends of the app's own yearly totals.
    expect(of('14').harmonized).toEqual(trend(yearlyTotals(areas[1].monthly, completeness)));
  });

  it('re-tests the trend of a province that ran more than 15% off MODIS, and says whether it holds', () => {
    // Neuquén: the rise is the gap. It does not hold.
    expect(of('58').bias).toBe(0.68);
    expect(trendClass(of('58').harmonized)).toBe('rising');
    expect(trendClass(of('58').adjusted!)).toBe('none');
    expect(of('58').holds).toBe(false);
    // Córdoba: read 21% low, and still falling once that is undone.
    expect(trendClass(of('14').adjusted!)).toBe('falling');
    expect(of('14').holds).toBe(true);
  });

  it('runs no check where the gap is within 15%, where there is no test figure, or where there is no trend to check', () => {
    expect(of('30').bias).toBe(0.03);
    expect(of('30').adjusted).toBeNull();
    expect(of('30').holds).toBeNull();
    expect(of('02').bias).toBeNull();
    expect(of('02').holds).toBeNull();
    // A province with too little fire has nothing to re-test, whatever its gap.
    const rare = provinceFindings([areas[3]], completeness, 2012, [{ prov: '02', name: 'Ciudad', aqua: 2, harmonized: 4, bias: 1 }]);
    expect(rare[0].adjusted).toBeNull();
    expect(rare[0].holds).toBeNull();
  });

  it('leaves the current, partial year out, as every trend does', () => {
    const spike = series(steady);
    for (let idx = monthIdx(2026, 1); idx < 287; idx++) spike[idx] = 99999;
    const [row] = provinceFindings([{ id: '30', name: 'Entre Ríos', monthly: spike, raw: spike, mtd: [] }], completeness, 2012, []);
    expect(trendClass(row.harmonized)).toBe('none');
  });
});

describe('yearSoFar', () => {
  /** 100 a month in every year, and `now` a month in 2026; month to date is 10 in every year and `nowMtd` in 2026. */
  const monthly = (now: number) => Array.from({ length: 287 }, (_, idx) => (idx >= monthIdx(2026, 1) ? now : 100));
  const mtd = (nowMtd: number) => Array.from({ length: 24 }, (_, i) => (i === 23 ? nowMtd : 10));

  it('adds the full months of the year and the days of the current month, and compares the same span in earlier years', () => {
    // 2026: ten full months of 50, and 5 in November to the 14th. Every earlier year: ten months of 100, and 10.
    const result = yearSoFar({ monthly: monthly(50), mtd: mtd(5) }, completeness)!;
    expect(result.year).toBe(2026);
    expect(result.throughMonth).toBe(11);
    expect(result.throughDay).toBe(14);
    expect(result.value).toBe(505);
    expect(result.usual).toBe(1010);
    expect(result.ratio).toBeCloseTo(0.5, 12);
    expect(result.earlier).toHaveLength(23);
    // Lower than every earlier year: last of 24.
    expect(result.rank).toBe(24);
  });

  it('ranks the year among all years, 1 for the highest', () => {
    expect(yearSoFar({ monthly: monthly(300), mtd: mtd(40) }, completeness)!.rank).toBe(1);
  });

  it('gives no ratio where there is usually almost no fire by that date', () => {
    const quiet = { monthly: Array.from({ length: 287 }, () => 0.5), mtd: Array.from({ length: 24 }, () => 0) };
    const result = yearSoFar(quiet, completeness)!;
    expect(result.usual).toBe(5);
    expect(result.ratio).toBeNull();
  });

  it('counts whole months only when the data ends with a month', () => {
    const endOfOctober: Completeness = { incomplete: new Set(), lastCompleteYear: 2025, lastMonthIdx: monthIdx(2026, 10), partial: null };
    const result = yearSoFar({ monthly: monthly(50), mtd: [] }, endOfOctober)!;
    expect(result.throughMonth).toBe(10);
    expect(result.throughDay).toBeNull();
    expect(result.value).toBe(500);
    expect(result.usual).toBe(1000);
  });

  it('has nothing to say once the year is complete, or when a month of this year is incomplete', () => {
    const endOfYear: Completeness = { incomplete: new Set(), lastCompleteYear: 2025, lastMonthIdx: monthIdx(2025, 12), partial: null };
    expect(yearSoFar({ monthly: monthly(50), mtd: [] }, endOfYear)).toBeNull();
    const gap: Completeness = { ...completeness, incomplete: new Set([monthIdx(2026, 3)]) };
    expect(yearSoFar({ monthly: monthly(50), mtd: mtd(5) }, gap)).toBeNull();
  });

  it('leaves an earlier year with an incomplete month out of the comparison', () => {
    const gap: Completeness = { ...completeness, incomplete: new Set([monthIdx(2010, 9)]) };
    expect(yearSoFar({ monthly: monthly(50), mtd: mtd(5) }, gap)!.earlier).toHaveLength(22);
  });
});

describe('extremeBandBias', () => {
  const levels = [
    { band: '0.5-2x', n: 199, bias: 0.025, mape: 17 },
    { band: '5-10x', n: 30, bias: -0.087, mape: 12 },
    { band: '10x+', n: 13, bias: -0.107, mape: 14 },
  ];

  it('takes the figure of the band the month falls in: 5 to 10 times, or 10 times and more', () => {
    expect(extremeBandBias(levels, 7.6)).toEqual({ band: '5-10x', bias: -0.087 });
    expect(extremeBandBias(levels, 12.6)).toEqual({ band: '10x+', bias: -0.107 });
    expect(extremeBandBias(levels, 10)).toEqual({ band: '10x+', bias: -0.107 });
  });

  it('has nothing to say below 5 times, or when the file lacks the band', () => {
    expect(extremeBandBias(levels, 4.9)).toBeNull();
    expect(extremeBandBias([levels[0], levels[1]], 12)).toBeNull();
    expect(extremeBandBias(undefined, 8)).toBeNull();
    expect(extremeBandBias([{ band: '5-10x', n: 0, bias: -0.2, mape: 1 }], 8)).toBeNull();
  });
});

describe('nationalTrendCheck', () => {
  // Falling by 1,000 a year to 2011, then flat: a step, not a steady decline.
  const yearly = Array.from({ length: 24 }, (_, i) => {
    const year = 2003 + i;
    const level = year <= 2011 ? 60000 - (year - 2003) * 1000 : 45000 + ((year * 7919) % 5) * 100;
    return { year, aqua: year <= 2025 ? level * 0.95 : 900, viirs_raw: null, viirs_harmonized: null, series: level, raw_series: null };
  });

  it('gives the trend of Aqua alone beside the harmonized one, and both over the VIIRS years alone', () => {
    const check = nationalTrendCheck(yearly, 2025, 2012)!;
    expect(check.fromYear).toBe(2003);
    expect(check.toYear).toBe(2025);
    expect(trendClass(check.aqua)).toBe('falling');
    expect(trendClass(check.harmonized)).toBe('falling');
    expect(check.recentFrom).toBe(2012);
    expect(trendClass(check.aquaRecent)).toBe('none');
    expect(trendClass(check.harmonizedRecent)).toBe('none');
    // The year still running (2026) is left out.
    expect('reason' in check.aqua ? null : check.aqua.toYear).toBe(2025);
  });

  it('has nothing to say without Aqua values', () => {
    expect(nationalTrendCheck(yearly.map((row) => ({ ...row, aqua: null })), 2025, 2012)).toBeNull();
    expect(nationalTrendCheck(undefined, 2025, 2012)).toBeNull();
  });
});

describe('trendFrom', () => {
  it('fits the trend on the years from a given year on only', () => {
    // Falling to 2011, flat after: falling over all years, no significant trend from 2012.
    const totals = Array.from({ length: 23 }, (_, i) => ({
      year: 2003 + i,
      value: 2003 + i <= 2011 ? 6000 - i * 300 : 3300 + ((i * 37) % 7) * 10,
      complete: true,
    }));
    expect(trendClass(trend(totals))).toBe('falling');
    const recent = trendFrom(totals, 2012);
    expect(trendClass(recent)).toBe('none');
    expect('reason' in recent ? null : recent.fromYear).toBe(2012);
  });
});
