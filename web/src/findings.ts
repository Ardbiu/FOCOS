// What the record says about an area's trend, three ways: harmonized, raw, and
// harmonized with a province's known gap to MODIS removed.
//
// The raw trend shows what stitching MODIS to VIIRS without harmonizing would
// have concluded. The third is a check on the harmonized trend: where a
// province ran well above or below MODIS in the test years, a trend could be
// that gap and not fire. None of this changes a count that the app shows.

import type { AreaSummary, ProvinceBias, Validation } from './data';
import {
  FIRST_YEAR,
  RARE_YEARLY_TOTAL,
  monthIdx,
  monthOfIdx,
  summarize,
  trend,
  yearOfIdx,
  yearlyTotals,
  type Completeness,
  type Trend,
  type YearValue,
} from './stats';

/** A province further than this from MODIS in the test years has its trend re-tested. The app's caution uses the same limit. */
export const BIAS_CHECK_LIMIT = 0.15;

export type TrendClass = 'rising' | 'falling' | 'none' | 'rare' | 'short';

/** A trend by its direction, or by why it has none: no significant trend, too little fire, too few years. */
export function trendClass(fitted: Trend): TrendClass {
  return 'reason' in fitted ? fitted.reason : fitted.direction;
}

export interface TrendTally {
  rising: number;
  falling: number;
  /** Assessed, with no significant trend. */
  none: number;
  /** Too little fire or too few years to assess. */
  unrated: number;
  total: number;
}

export function tallyTrends(trends: Trend[]): TrendTally {
  const tally: TrendTally = { rising: 0, falling: 0, none: 0, unrated: 0, total: trends.length };
  for (const fitted of trends) {
    const kind = trendClass(fitted);
    if (kind === 'rare' || kind === 'short') tally.unrated += 1;
    else tally[kind] += 1;
  }
  return tally;
}

/**
 * The trend of yearly totals once a known gap is taken out of the VIIRS years.
 * `bias` is the fraction by which the harmonized record ran above Aqua in the
 * test years (negative: below); every year from `switchYear` on is divided by
 * `1 + bias`. This assumes the gap of the test years held in every VIIRS year,
 * which nothing proves: it is a check on a trend, never a corrected record.
 */
export function trendWithoutBias(totals: YearValue[], switchYear: number, bias: number): Trend {
  return trend(totals.map((year) => (year.year >= switchYear ? { ...year, value: year.value / (1 + bias) } : year)));
}

export interface ProvinceFinding {
  id: string;
  name: string;
  /** The trend the app shows. */
  harmonized: Trend;
  /** The trend of the raw counts: MODIS, then VIIRS as reported. */
  raw: Trend;
  /** How far the harmonized record ran from Aqua in the test years; `null` where the test has no figure. */
  bias: number | null;
  /** The harmonized trend with that gap removed. Only where the gap is beyond the limit and there is a trend to check. */
  adjusted: Trend | null;
  /** Whether the trend says the same with the gap removed; `null` where no check was run. */
  holds: boolean | null;
}

/** The three trends for each area, in the order given. */
export function provinceFindings(
  areas: AreaSummary[],
  c: Completeness,
  switchYear: number,
  biases: ProvinceBias[] | undefined,
): ProvinceFinding[] {
  return areas.map((area) => {
    const totals = yearlyTotals(area.monthly, c);
    const harmonized = trend(totals);
    const entry = biases?.find((province) => province.prov === area.id);
    const bias = entry && Number.isFinite(entry.bias) ? entry.bias : null;
    const checked = bias !== null && Math.abs(bias) > BIAS_CHECK_LIMIT && !('reason' in harmonized);
    const adjusted = checked ? trendWithoutBias(totals, switchYear, bias) : null;
    return {
      id: area.id,
      name: area.name,
      harmonized,
      raw: trend(yearlyTotals(area.raw, c)),
      bias,
      adjusted,
      holds: adjusted ? trendClass(adjusted) === trendClass(harmonized) : null,
    };
  });
}

/** The trend of the yearly totals from `fromYear` on only, for example over the VIIRS years. */
export function trendFrom(totals: YearValue[], fromYear: number): Trend {
  return trend(totals.filter((year) => year.year >= fromYear));
}

/** The national trend checked two ways: against Aqua alone, and over the VIIRS years alone. */
export interface NationalTrendCheck {
  fromYear: number;
  toYear: number;
  /** Aqua MODIS alone, the same sensor over the whole span. */
  aqua: Trend;
  /** The harmonized national record, from the same yearly totals. */
  harmonized: Trend;
  /** The first VIIRS year: the two trends again from here on. */
  recentFrom: number;
  aquaRecent: Trend;
  harmonizedRecent: Trend;
}

/**
 * Aqua MODIS never changed sensor, so its own yearly totals are a check on the
 * harmonized trend that does not depend on the harmonization. Both are taken
 * from validation.json's national yearly totals, over the complete years, and
 * again from the switch year on. `null` when Aqua has no values.
 */
export function nationalTrendCheck(
  yearly: Validation['yearly_national'] | undefined,
  lastCompleteYear: number,
  switchYear: number,
): NationalTrendCheck | null {
  const rows = (yearly ?? []).filter((row) => row.year <= lastCompleteYear);
  const years = (pick: (row: (typeof rows)[number]) => number | null, from = FIRST_YEAR): YearValue[] =>
    rows
      .filter((row) => row.year >= from && pick(row) !== null && Number.isFinite(pick(row)))
      .map((row) => ({ year: row.year, value: pick(row)!, complete: true }));
  const aqua = years((row) => row.aqua);
  const harmonized = years((row) => row.series);
  if (aqua.length === 0 || harmonized.length === 0) return null;
  return {
    fromYear: Math.min(aqua[0].year, harmonized[0].year),
    toYear: Math.max(aqua[aqua.length - 1].year, harmonized[harmonized.length - 1].year),
    aqua: trend(aqua),
    harmonized: trend(harmonized),
    recentFrom: switchYear,
    aquaRecent: trend(years((row) => row.aqua, switchYear)),
    harmonizedRecent: trend(years((row) => row.series, switchYear)),
  };
}

/** A month at this many times its usual level, or more, counts as extreme: the test has a figure for how such months read. */
export const EXTREME_RATIO = 5;

/**
 * The bias of months at 5 times the usual level or more (the bands `5-10x` and
 * `10x+`), weighted by how many there were. `null` when the file has no such band.
 */
export function extremeMonthBias(levels: Validation['bias_by_level']): number | null {
  const extreme = (levels ?? []).filter((level) => /^(5-10x|10x\+)$/.test(level.band) && level.n > 0);
  const cases = extreme.reduce((sum, level) => sum + level.n, 0);
  return cases > 0 ? extreme.reduce((sum, level) => sum + level.bias * level.n, 0) / cases : null;
}

/**
 * The test's bias for months as unusual as this one: the band `5-10x` for 5
 * to 10 times the usual level, `10x+` from 10 times. `null` below 5 times, or
 * when the file has no cases in that band.
 */
export function extremeBandBias(
  levels: Validation['bias_by_level'],
  ratio: number,
): { band: '5-10x' | '10x+'; bias: number } | null {
  if (!(ratio >= EXTREME_RATIO)) return null;
  const band = ratio >= 10 ? '10x+' : '5-10x';
  const entry = (levels ?? []).find((level) => level.band === band && level.n > 0 && Number.isFinite(level.bias));
  return entry ? { band, bias: entry.bias } : null;
}

/** The current year up to the last day with data, against the same span of every earlier year. */
export interface YearSoFar {
  year: number;
  /** The month the data ends in, 1 to 12, and the day when it ends before the month does. */
  throughMonth: number;
  throughDay: number | null;
  value: number;
  /** The same span in each earlier year that has it complete, ascending. */
  earlier: number[];
  /** Their median. */
  usual: number;
  /** `value / usual`; `null` where there is usually almost no fire by that date. */
  ratio: number | null;
  /** 1 for the highest among this year and the earlier ones. */
  rank: number;
}

/**
 * How the year so far compares with the same date in earlier years: the full
 * months of the year, plus days 1 to D of the current month (`mtd`, one value
 * per year). `null` once the year is complete, when one of its months is
 * incomplete, or with fewer than five earlier years to compare.
 */
export function yearSoFar(series: { monthly: ArrayLike<number>; mtd: ArrayLike<number> }, c: Completeness): YearSoFar | null {
  const year = yearOfIdx(c.lastMonthIdx);
  const throughMonth = monthOfIdx(c.lastMonthIdx);
  if (!c.partial && throughMonth === 12) return null;
  const fullMonths = c.partial ? throughMonth - 1 : throughMonth;
  const span = (y: number): number | null => {
    let value = c.partial ? Number(series.mtd[y - FIRST_YEAR]) : 0;
    for (let month = 1; month <= fullMonths; month++) {
      const idx = monthIdx(y, month);
      if (c.incomplete.has(idx)) return null;
      value += Number(series.monthly[idx]);
    }
    return Number.isFinite(value) ? value : null;
  };
  const value = span(year);
  if (value === null) return null;
  const earlier: number[] = [];
  for (let y = FIRST_YEAR; y < year; y++) {
    const total = span(y);
    if (total !== null) earlier.push(total);
  }
  if (earlier.length < 5) return null;
  earlier.sort((a, b) => a - b);
  const usual = summarize(earlier)!.median;
  return {
    year,
    throughMonth,
    throughDay: c.partial ? c.partial.lastDay : null,
    value,
    earlier,
    usual,
    ratio: usual >= RARE_YEARLY_TOTAL ? value / usual : null,
    rank: 1 + earlier.filter((total) => total > value).length,
  };
}
