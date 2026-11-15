// Statistics computed in the browser (plan sections 4.8 and 4.9): the baseline
// of a month, its category and rank, the fire season, yearly totals and the
// trend. Pure functions over a monthly series of 287 numbers.
//
// Nothing here returns NaN or Infinity: where a number cannot be given the
// result says why (a `null`, a status or a reason) and the page words it.

import { satelliteName, type Meta, type Validation } from './data';

/** The first year of every series. `month_idx` 0 is January of this year. */
export const FIRST_YEAR = 2003;
/** Below this baseline median, fire is too rare for a ratio (section 4.8). */
export const RARE_MEDIAN = 5;
/** Below this median yearly total, fire is too rare for a trend (section 4.9). */
export const RARE_YEARLY_TOTAL = 12;
/** The fewest complete years a trend is computed on. */
export const MIN_TREND_YEARS = 10;
/** Significance level of the trend test. */
export const TREND_ALPHA = 0.05;
/** A fire season holds at least this share of the yearly total. */
const SEASON_SHARE = 0.8;

type Series = ArrayLike<number>;

// ---- Months ----------------------------------------------------------------------

/** `month` is 1 to 12. */
export function monthIdx(year: number, month: number): number {
  return (year - FIRST_YEAR) * 12 + (month - 1);
}

export function yearOfIdx(idx: number): number {
  return FIRST_YEAR + Math.floor(idx / 12);
}

/** 1 to 12. */
export function monthOfIdx(idx: number): number {
  return (idx % 12) + 1;
}

// ---- Which months can be trusted -------------------------------------------------

/** What the data covers, read once from meta.json with completenessFromMeta(). */
export interface Completeness {
  /** `month_idx` of months with coverage below 0.9: hatched, never ranked, left out of baselines. */
  incomplete: ReadonlySet<number>;
  /** The last year with data for all twelve months. Baselines and trends stop here. */
  lastCompleteYear: number;
  /** The last month with any data. Later months have none. */
  lastMonthIdx: number;
  /** The current month when the data ends before its last day, with that last day D. */
  partial: { monthIdx: number; lastDay: number } | null;
}

export function completenessFromMeta(meta: Pick<Meta, 'data_end_date' | 'incomplete_months' | 'mtd'>): Completeness {
  const [year, month, day] = meta.data_end_date.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lastMonthIdx = monthIdx(year, month);
  const endsMonth = day >= daysInMonth;
  return {
    incomplete: new Set(meta.incomplete_months.map((entry) => entry.month_idx)),
    lastCompleteYear: month === 12 && endsMonth ? year : year - 1,
    lastMonthIdx,
    partial: endsMonth ? null : { monthIdx: lastMonthIdx, lastDay: day },
  };
}

// ---- Which satellite carries a month ---------------------------------------------

/** One satellite's run of months in the harmonized series. */
export interface Carrier {
  /** `A`, `N` or `N20`. */
  sat: string;
  /** For example `S-NPP VIIRS`. */
  name: string;
  fromIdx: number;
  /** Last `month_idx` carried; `null` for the current carrier. */
  toIdx: number | null;
  /** Typical error of the carrier's harmonized values, in percent; `null` for Aqua, the reference. */
  typicalErrorPct: number | null;
}

function idxOfMonth(text: unknown): number | null {
  const match = typeof text === 'string' ? /^(\d{4})-(\d{2})$/.exec(text) : null;
  return match ? monthIdx(Number(match[1]), Number(match[2])) : null;
}

/**
 * The carriers of the series in order, from `meta.series`. Files written before
 * that field existed (or with a list this app cannot read) fall back to two
 * carriers split at `switch_month`, S-NPP taking the top-level typical error.
 */
export function seriesCarriers(meta: Pick<Meta, 'switch_month' | 'typical_error_pct' | 'series'>): Carrier[] {
  const listed: Carrier[] = [];
  for (const entry of meta.series ?? []) {
    const fromIdx = idxOfMonth(entry.from);
    const toIdx = entry.to === null ? null : idxOfMonth(entry.to);
    if (fromIdx === null || (entry.to !== null && toIdx === null)) return fallbackCarriers(meta);
    const error = entry.typical_error_pct;
    listed.push({
      sat: String(entry.sat),
      name: String(entry.name),
      fromIdx,
      toIdx,
      typicalErrorPct: typeof error === 'number' && Number.isFinite(error) ? error : null,
    });
  }
  return listed.length >= 2 ? listed : fallbackCarriers(meta);
}

function fallbackCarriers(meta: Pick<Meta, 'switch_month' | 'typical_error_pct'>): Carrier[] {
  const switchIdx = idxOfMonth(meta.switch_month) ?? monthIdx(2012, 2);
  const error = meta.typical_error_pct;
  return [
    { sat: 'A', name: 'Aqua MODIS', fromIdx: 0, toIdx: switchIdx - 1, typicalErrorPct: null },
    {
      sat: 'N',
      name: 'S-NPP VIIRS',
      fromIdx: switchIdx,
      toIdx: null,
      typicalErrorPct: Number.isFinite(error) ? error : null,
    },
  ];
}

/** The VIIRS satellites among the carriers, as short names in order: `S-NPP`, `NOAA-20`. */
export function viirsSatellites(carriers: Carrier[]): string[] {
  return carriers.filter((carrier) => carrier.sat !== 'A').map((carrier) => satelliteName(carrier.sat).satellite);
}

/** The carrier of a month, or `null` for a month before the series starts. */
export function carrierForMonth(carriers: Carrier[], idx: number): Carrier | null {
  return carriers.find((c) => idx >= c.fromIdx && (c.toIdx === null || idx <= c.toIdx)) ?? null;
}

// ---- Typical error of a harmonized count -----------------------------------------

/** Counts from `from` up (to the next band) had this median absolute error on the test years, in percent. */
export interface ErrorBand {
  from: number;
  mape: number;
}

/** The error bands of validation.json (`1-4`, `5-19`, `20+`), ascending. Empty when the file has none. */
export function errorBands(validation: Pick<Validation, 'error_by_count'> | null): ErrorBand[] {
  const bands: ErrorBand[] = [];
  for (const entry of validation?.error_by_count ?? []) {
    const from = /^(\d+)(-\d+|\+)$/.exec(String(entry.band))?.[1];
    if (from === undefined || !Number.isFinite(entry.mape)) return [];
    bands.push({ from: Number(from), mape: entry.mape });
  }
  return bands.sort((a, b) => a.from - b.from);
}

/** The satellite whose test produced the error bands of validation.json. */
const ERROR_BANDS_SAT = 'N';

/** What can be said about the error of one harmonized count. */
export type TypicalError =
  /**
   * Typical error in percent, for a count of this size. `carrier` names the
   * satellite when the figure is that satellite's own test result, and is
   * `null` when the figure was measured on another one.
   */
  | { kind: 'pct'; pct: number; carrier: string | null }
  /** Fewer than 5 hotspots: too small to rate, so no percentage. */
  | { kind: 'tooSmall' };

/**
 * The typical error of a harmonized count: the test-year error of counts of
 * its size (20 or more, 5 to 19). Below 5 no percentage is given. `null` for
 * Aqua months, the reference the others are measured against. Without bands
 * the carrier's own typical error stands in.
 *
 * The bands were measured on S-NPP. For a month carried by another satellite
 * the band figure is still the best there is, but it is not that satellite's
 * result, so it is given without a name.
 */
export function typicalError(value: number, carrier: Carrier | null, bands: ErrorBand[]): TypicalError | null {
  if (!carrier || carrier.typicalErrorPct === null) return null;
  if (!(value >= RARE_MEDIAN)) return { kind: 'tooSmall' };
  let pct = carrier.typicalErrorPct;
  let own = true;
  for (const band of bands) {
    if (value >= band.from) {
      pct = band.mape;
      own = carrier.sat === ERROR_BANDS_SAT;
    }
  }
  return { kind: 'pct', pct, carrier: own ? carrier.name : null };
}

// ---- Baseline, category, rank ----------------------------------------------------

export interface Baseline {
  median: number;
  q1: number;
  q3: number;
  /** The baseline values, ascending. */
  values: number[];
}

/** Quantile of ascending values, interpolating linearly between ranks. */
export function quantile(sorted: ArrayLike<number>, p: number): number {
  const position = (sorted.length - 1) * p;
  const below = Math.floor(position);
  const above = Math.min(below + 1, sorted.length - 1);
  return sorted[below] + (sorted[above] - sorted[below]) * (position - below);
}

/** Median, quartiles and sorted values; `null` when there are no values. */
export function summarize(values: number[]): Baseline | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { median: quantile(sorted, 0.5), q1: quantile(sorted, 0.25), q3: quantile(sorted, 0.75), values: sorted };
}

/**
 * The value of one calendar month in every year that may serve as a baseline:
 * 2003 to the last complete year, without the target's own year and without
 * incomplete months. `valueOf` gives the value for a year.
 */
function baselineValues(valueOf: (year: number) => number, targetIdx: number, c: Completeness): number[] {
  const targetYear = yearOfIdx(targetIdx);
  const month = monthOfIdx(targetIdx);
  const values: number[] = [];
  for (let year = FIRST_YEAR; year <= c.lastCompleteYear; year++) {
    if (year === targetYear || c.incomplete.has(monthIdx(year, month))) continue;
    const value = valueOf(year);
    if (Number.isFinite(value)) values.push(value);
  }
  return values;
}

/**
 * The baseline of a month (section 4.8): the same month in every other complete
 * year, excluding incomplete months. `null` when no year is left to compare with.
 */
export function baseline(series: Series, targetIdx: number, c: Completeness): Baseline | null {
  const month = monthOfIdx(targetIdx);
  return summarize(baselineValues((year) => series[monthIdx(year, month)], targetIdx, c));
}

export type Category = 'record_high' | 'well_above' | 'above' | 'near' | 'below';

export function categorize(value: number, b: Baseline): Category {
  if (value > b.values[b.values.length - 1]) return 'record_high';
  if (value > b.q3 + 1.5 * (b.q3 - b.q1)) return 'well_above';
  if (value > b.q3) return 'above';
  if (value >= b.q1) return 'near';
  return 'below';
}

/** Rank of a value among itself and the baseline; 1 is the highest. Ties share the better rank. */
export function rank(value: number, b: Baseline): number {
  let higher = 0;
  for (const other of b.values) if (other > value) higher++;
  return higher + 1;
}

// ---- One month, assessed ---------------------------------------------------------

/** The two series of an area that an assessment needs. */
export interface AreaSeries {
  /** 287 monthly values. */
  monthly: Series;
  /** Days 1 to D of the current month, one value per year from 2003; empty when there is no partial month. */
  mtd: Series;
}

export interface MonthAssessment {
  monthIdx: number;
  /**
   * `complete`: a full month. `partial`: the current month, compared on days 1 to D.
   * `incomplete`: the satellite missed too many days to compare. `nodata`: after the end of the data.
   */
  status: 'complete' | 'partial' | 'incomplete' | 'nodata';
  /** D, the last day with data, when the status is `partial`. */
  partialDay: number | null;
  /** The month's value; for a partial month, the value of days 1 to D. */
  value: number;
  baseline: Baseline | null;
  /** 1 is the highest. `null` without a baseline. */
  rank: number | null;
  /** Value divided by the baseline median. `null` when fire is rare or there is no baseline. */
  ratio: number | null;
  /** True when the baseline median is below 5: "usually almost no fire here this month". */
  rare: boolean;
  category: Category | null;
}

/**
 * Compares one month of an area with its baseline (section 4.8).
 *
 * The partial current month is compared on month-to-date values, days 1 to D
 * of the same month in past years. An incomplete month gets no rank and no
 * category, so missing data is never read as "below normal".
 */
export function assessMonth(area: AreaSeries, targetIdx: number, c: Completeness): MonthAssessment {
  const blank = {
    monthIdx: targetIdx,
    partialDay: null,
    baseline: null,
    rank: null,
    ratio: null,
    rare: false,
    category: null,
  };
  if (targetIdx > c.lastMonthIdx) return { ...blank, status: 'nodata', value: 0 };

  const monthly = Number(area.monthly[targetIdx]);
  if (c.incomplete.has(targetIdx)) return { ...blank, status: 'incomplete', value: finite(monthly) };

  const isPartial = c.partial?.monthIdx === targetIdx;
  let value = finite(monthly);
  let base: Baseline | null;
  if (isPartial) {
    // Without month-to-date values there is nothing fair to compare a part-month with.
    const hasMtd = area.mtd.length > 0;
    if (hasMtd) value = finite(Number(area.mtd[yearOfIdx(targetIdx) - FIRST_YEAR]));
    base = hasMtd ? summarize(baselineValues((year) => area.mtd[year - FIRST_YEAR], targetIdx, c)) : null;
  } else {
    base = baseline(area.monthly, targetIdx, c);
  }

  const assessed = {
    ...blank,
    status: isPartial ? ('partial' as const) : ('complete' as const),
    partialDay: isPartial ? c.partial!.lastDay : null,
    value,
  };
  if (!base) return assessed;
  const rare = base.median < RARE_MEDIAN;
  return {
    ...assessed,
    baseline: base,
    rank: rank(value, base),
    ratio: rare ? null : value / base.median,
    rare,
    category: categorize(value, base),
  };
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

// ---- Fire season -----------------------------------------------------------------

/** A run of months, 1 to 12. `start` is after `end` when the season wraps over New Year. */
export interface Season {
  start: number;
  end: number;
}

/** The median of each calendar month over the complete years, skipping incomplete months. */
export function monthlyMedians(series: Series, c: Completeness): number[] {
  return Array.from({ length: 12 }, (_, m) => {
    const values: number[] = [];
    for (let year = FIRST_YEAR; year <= c.lastCompleteYear; year++) {
      const idx = monthIdx(year, m + 1);
      if (!c.incomplete.has(idx) && Number.isFinite(series[idx])) values.push(series[idx]);
    }
    return summarize(values)?.median ?? 0;
  });
}

/**
 * The fire season from twelve monthly medians (section 4.8): the shortest run
 * of consecutive months, wrapping December to January, that holds at least 80%
 * of the year. Of equally short runs the fullest wins, then the earliest.
 * `null` when the medians sum to less than 12: no clear fire season.
 */
export function seasonFromMedians(medians: ArrayLike<number>): Season | null {
  let total = 0;
  for (let m = 0; m < 12; m++) total += medians[m];
  if (!(total >= RARE_YEARLY_TOTAL)) return null;
  const needed = SEASON_SHARE * total - 1e-9;
  for (let length = 1; length <= 12; length++) {
    let best = -1;
    let bestSum = -Infinity;
    for (let start = 0; start < 12; start++) {
      let sum = 0;
      for (let k = 0; k < length; k++) sum += medians[(start + k) % 12];
      if (sum >= needed && sum > bestSum + 1e-9) {
        best = start;
        bestSum = sum;
      }
    }
    if (best >= 0) return { start: best + 1, end: ((best + length - 1) % 12) + 1 };
  }
  return null;
}

export function fireSeason(series: Series, c: Completeness): Season | null {
  return seasonFromMedians(monthlyMedians(series, c));
}

/** A run of more months than this holds 80% of the year only because fire is spread out: not a season. */
export const MAX_SEASON_MONTHS = 6;

/** The number of months in a season, counting across New Year. */
export function seasonLength(season: Season): number {
  return ((season.end - season.start + 12) % 12) + 1;
}

/** The calendar month (1 to 12) with the highest median; the earlier one on a tie. `null` when there is no fire. */
export function peakMonth(medians: ArrayLike<number>): number | null {
  let peak: number | null = null;
  let top = 0;
  for (let m = 0; m < 12; m++) {
    if (medians[m] > top) {
      top = medians[m];
      peak = m + 1;
    }
  }
  return peak;
}

// ---- Yearly totals and trend -----------------------------------------------------

export interface YearValue {
  year: number;
  value: number;
  /** False when a month of the year is incomplete, and for the current year. */
  complete: boolean;
}

/** The total of each year from 2003 to the last year with data. */
export function yearlyTotals(series: Series, c: Completeness): YearValue[] {
  const totals: YearValue[] = [];
  for (let year = FIRST_YEAR; year <= yearOfIdx(c.lastMonthIdx); year++) {
    let value = 0;
    let complete = year <= c.lastCompleteYear;
    for (let idx = monthIdx(year, 1); idx <= Math.min(monthIdx(year, 12), c.lastMonthIdx); idx++) {
      value += finite(Number(series[idx]));
      if (c.incomplete.has(idx)) complete = false;
    }
    totals.push({ year, value, complete });
  }
  return totals;
}

/** Complementary error function, fractional error below 1.2e-7 (Numerical Recipes, erfcc). */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const poly =
    -1.26551223 +
    t *
      (1.00002368 +
        t *
          (0.37409196 +
            t *
              (0.09678418 +
                t *
                  (-0.18628806 +
                    t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
  const result = t * Math.exp(-z * z + poly);
  return x >= 0 ? result : 2 - result;
}

/**
 * Two-sided Mann-Kendall test with tie correction and continuity correction,
 * normal approximation. `s` is the count of rising pairs minus falling pairs.
 */
export function mannKendall(values: ArrayLike<number>): { s: number; z: number; p: number } {
  const n = values.length;
  let s = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) s += Math.sign(values[j] - values[i]);
  }
  const tieSizes = new Map<number, number>();
  for (let i = 0; i < n; i++) tieSizes.set(values[i], (tieSizes.get(values[i]) ?? 0) + 1);
  let variance = n * (n - 1) * (2 * n + 5);
  for (const size of tieSizes.values()) variance -= size * (size - 1) * (2 * size + 5);
  variance /= 18;
  if (s === 0 || !(variance > 0)) return { s, z: 0, p: 1 };
  const z = (s - Math.sign(s)) / Math.sqrt(variance);
  return { s, z, p: Math.min(1, erfc(Math.abs(z) / Math.SQRT2)) };
}

export type Trend =
  | {
      /** Theil-Sen slope, MODIS-equivalent hotspots per year. */
      slope: number;
      /** The fitted line's value at the first complete year: the median of (value - slope x years since then). */
      startValue: number;
      /**
       * The slope over ten years as a percentage of `startValue`. `null` when
       * the line starts below 12 hotspots a year, where a percentage would
       * mean little; the slope itself is reported then.
       */
      pctPerDecade: number | null;
      /** Two-sided Mann-Kendall p-value. */
      p: number;
      /** `none` when the trend is not significant at 0.05. */
      direction: 'rising' | 'falling' | 'none';
      /** First and last complete year the trend is computed on. */
      fromYear: number;
      toYear: number;
    }
  /** `short`: fewer than 10 complete years. `rare`: median yearly total below 12. */
  | { reason: 'rare' | 'short' };

/**
 * The trend of yearly totals over complete years only (section 4.9): Theil-Sen
 * slope, Mann-Kendall significance. Slopes are taken per calendar year, so a
 * skipped incomplete year does not bend them.
 *
 * The percentage per decade is taken against where the fitted line starts,
 * not against the median: against the median a steep decline could read as
 * more than 100% a decade, sustained for two decades.
 */
export function trend(years: YearValue[]): Trend {
  const complete = years
    .filter((y) => y.complete && Number.isFinite(y.value))
    .sort((a, b) => a.year - b.year);
  if (complete.length < MIN_TREND_YEARS) return { reason: 'short' };
  const values = complete.map((y) => y.value);
  const median = summarize(values)!.median;
  if (median < RARE_YEARLY_TOTAL) return { reason: 'rare' };

  const slopes: number[] = [];
  for (let i = 0; i < complete.length; i++) {
    for (let j = i + 1; j < complete.length; j++) {
      slopes.push((complete[j].value - complete[i].value) / (complete[j].year - complete[i].year));
    }
  }
  const slope = summarize(slopes)!.median;
  const firstYear = complete[0].year;
  const startValue = summarize(complete.map((y) => y.value - slope * (y.year - firstYear)))!.median;
  const { p } = mannKendall(values);
  const significant = p < TREND_ALPHA;
  return {
    slope,
    startValue,
    pctPerDecade: startValue >= RARE_YEARLY_TOTAL ? ((slope * 10) / startValue) * 100 : null,
    p,
    direction: significant && slope > 0 ? 'rising' : significant && slope < 0 ? 'falling' : 'none',
    fromYear: complete[0].year,
    toYear: complete[complete.length - 1].year,
  };
}
