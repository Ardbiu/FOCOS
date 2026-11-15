// The verdict card's text (plan section 6.5): one sentence on the fire season
// and one on the selected month, built from templates in the language files.
//
// The verdict always describes the harmonized series; the Raw view never
// feeds it (section 4.10).

import type { Meta, Validation } from './data';
import { BIAS_CHECK_LIMIT, type YearSoFar } from './findings';
import { formatNumber, t, tCount, type Lang } from './i18n';
import {
  FIRST_YEAR,
  MAX_SEASON_MONTHS,
  RARE_MEDIAN,
  monthOfIdx,
  seasonLength,
  yearOfIdx,
  type MonthAssessment,
  type Season,
  type Trend,
} from './stats';

export interface VerdictInput {
  /** From fireSeason(); `null` when the area has no clear fire season. */
  season: Season | null;
  /** From peakMonth(): the month that usually burns most, 1 to 12. */
  peak?: number | null;
  /** From assessMonth(). */
  month: MonthAssessment;
}

/** For example: "Fire season here runs Jul–Oct. Nov 1–14, 2026 is 2.1× the usual level, the 3rd highest since 2003." */
export function verdict(input: VerdictInput, lang: Lang): string {
  return `${seasonSentence(input.season, lang, input.peak)} ${monthSentence(input.month, lang)}`;
}

function monthName(month: number, lang: Lang): string {
  return t(lang, `months.short.${month - 1}`);
}

/** The text with its first letter in upper case, by the rules of the language. */
export function capitalize(sentence: string, lang: Lang): string {
  return sentence.charAt(0).toLocaleUpperCase(lang) + sentence.slice(1);
}

/**
 * The fire-season sentence. A run of more than six months is not called a
 * season: the sentence says fire is spread over most of the year. `peak` is
 * the month that usually burns most; it is named when it adds something.
 */
export function seasonSentence(season: Season | null, lang: Lang, peak?: number | null): string {
  if (!season) return t(lang, 'verdict.season.none');
  const peakName = peak ? t(lang, `months.long.${peak - 1}`) : null;
  if (seasonLength(season) > MAX_SEASON_MONTHS) {
    return peakName ? t(lang, 'verdict.season.spread', { peak: peakName }) : t(lang, 'verdict.season.spreadOnly');
  }
  if (season.start === season.end) {
    return t(lang, 'verdict.season.single', { month: monthName(season.start, lang) });
  }
  const months = { start: monthName(season.start, lang), end: monthName(season.end, lang) };
  return peakName
    ? t(lang, 'verdict.season.rangePeak', { ...months, peak: peakName })
    : t(lang, 'verdict.season.range', months);
}

/** "Nov 2026" for a full month, "Nov 1–14, 2026" for the partial current month ("Nov 1, 2026" on its first day). */
export function periodLabel(month: Pick<MonthAssessment, 'monthIdx' | 'partialDay'>, lang: Lang): string {
  const params = { month: monthName(monthOfIdx(month.monthIdx), lang), year: yearOfIdx(month.monthIdx) };
  return month.partialDay === null
    ? t(lang, 'period.month', params)
    : tCount(lang, 'period.partial', month.partialDay, { params });
}

/** A count of MODIS-equivalent hotspots with its unit; one decimal below ten, none from ten up. */
export function hotspotsText(value: number, lang: Lang): string {
  return tCount(lang, 'unit.hotspots', roundCount(value), { shown: countText(value, lang) });
}

/** A count rounded for reading: one decimal below ten, none from ten up. */
export function roundCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
}

/** A count rounded for an "about": three significant figures from 1,000 up (2,186 → 2,190), as roundCount() below. */
export function aboutCount(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value < 1000) return roundCount(value);
  const step = 10 ** (Math.floor(Math.log10(value)) - 2);
  return Math.round(value / step) * step;
}

/** A count written in full, with the digits of the language: `12,345` or `4.6`. */
export function countText(value: number, lang: Lang): string {
  return formatNumber(lang, roundCount(value), 1);
}

/**
 * "the highest August", "the 3rd highest Nov 1–14" or "the lowest August", for
 * a month that has a rank. A month is ranked only against the same calendar
 * month (or the same days of it) in other years, so the phrase names it: a
 * bare "the highest" would read as the highest of all months. Without
 * `monthIdx` (the year so far) it is "the highest", "the 3rd highest", "the lowest".
 */
export function rankPhrase(
  month: Pick<MonthAssessment, 'rank' | 'baseline'> & Partial<Pick<MonthAssessment, 'monthIdx' | 'partialDay'>>,
  value: number,
  lang: Lang,
): string {
  const what = month.monthIdx === undefined ? null : rankedMonth(month.monthIdx, month.partialDay ?? null, lang);
  const key = (name: string) => `verdict.rank.${name}${what === null ? '' : 'Of'}`;
  if (month.rank === 1) return t(lang, key('highest'), { what: what ?? '' });
  if (month.baseline && value < month.baseline.values[0]) return t(lang, key('lowest'), { what: what ?? '' });
  return t(lang, key('nth'), {
    ordinal: tCount(lang, 'ordinal', month.rank ?? 0, { type: 'ordinal' }),
    what: what ?? '',
  });
}

/** What a month is ranked as: "August", or the days of a partial month, "Nov 1–14". */
function rankedMonth(monthIdx: number, partialDay: number | null, lang: Lang): string {
  const number = monthOfIdx(monthIdx);
  if (partialDay === null) return t(lang, `months.long.${number - 1}`);
  return tCount(lang, 'verdict.rank.whatPartial', partialDay, {
    params: { month: t(lang, `months.short.${number - 1}`), monthLong: t(lang, `months.long.${number - 1}`) },
  });
}

/**
 * One sentence on how the month compares with the same month in other years
 * (section 4.8). Where fire is rare it gives the count and the rank, with no
 * ratio; a month with incomplete data is not compared at all.
 */
export function monthSentence(month: MonthAssessment, lang: Lang): string {
  const period = periodLabel(month, lang);
  const value = Number.isFinite(month.value) ? month.value : 0;
  const isZero = roundCount(value) === 0;
  const since = FIRST_YEAR;

  let sentence: string;
  if (month.status === 'nodata') {
    sentence = t(lang, 'verdict.month.noData', { period });
  } else if (month.status === 'incomplete') {
    sentence = t(lang, 'verdict.month.incomplete', { period });
  } else if (!month.baseline || month.rank === null) {
    sentence = t(lang, 'verdict.month.noBaseline', { period, count: hotspotsText(value, lang) });
  } else if (month.rare || month.ratio === null || !Number.isFinite(month.ratio)) {
    // Below 5 hotspots a count is too small to rate, so it is not ranked either.
    sentence = isZero
      ? t(lang, 'verdict.month.rareZero', { period })
      : roundCount(value) < RARE_MEDIAN
        ? t(lang, 'verdict.month.rareSmall', { period, count: hotspotsText(value, lang) })
        : t(lang, 'verdict.month.rare', {
            period,
            count: hotspotsText(value, lang),
            rank: rankPhrase(month, value, lang),
            since,
          });
  } else if (isZero) {
    sentence = t(lang, 'verdict.month.zero', { period, median: countText(month.baseline.median, lang) });
  } else {
    sentence = t(lang, 'verdict.month.ratio', {
      period,
      ratio: formatNumber(lang, month.ratio, 1, 1),
      rank: rankPhrase(month, value, lang),
      since,
    });
  }
  return capitalize(sentence, lang);
}

// ---- Trend card, test line and caution -------------------------------------------

/** The band of the test where a province counts as off: more than 15% from MODIS. */
const BIAS_CAUTION = BIAS_CHECK_LIMIT;

/** "p = 0.004" or "p < 0.001", in the digits of the language. */
export function pValue(p: number, lang: Lang): string {
  if (p < 0.001) return t(lang, 'trend.pBelow', { p: formatNumber(lang, 0.001, 3, 3) });
  const decimals = p < 0.01 ? 3 : 2;
  return t(lang, 'trend.pEquals', { p: formatNumber(lang, p, decimals, decimals) });
}

/**
 * The trend card's sentence (plan sections 4.9 and 6.5), for example "Rising
 * about 18% per decade since 2003 (p = 0.01)." With `raw` it is the trend of
 * the raw counts, marked as including the sensor switch.
 */
export function trendSentence(trend: Trend, lang: Lang, options: { raw?: boolean; switchYear?: number } = {}): string {
  const sentence = plainTrend(trend, lang, options.raw === true);
  if (!options.raw || 'reason' in trend) return sentence;
  return t(lang, 'trend.raw', { sentence: lowerFirst(sentence, lang), year: options.switchYear ?? 2012 });
}

/** The trend in a sentence of its own. With `rawUnits` a change per year is counted in detections, not hotspots. */
function plainTrend(trend: Trend, lang: Lang, rawUnits: boolean): string {
  if ('reason' in trend) return t(lang, `trend.${trend.reason}`);
  const from = trend.fromYear;
  let sentence = t(lang, 'trend.none', { from });
  if (trend.direction !== 'none' && Number.isFinite(trend.p)) {
    const p = pValue(trend.p, lang);
    if (trend.pctPerDecade !== null && Number.isFinite(trend.pctPerDecade)) {
      sentence = t(lang, `trend.${trend.direction}`, { pct: formatNumber(lang, Math.abs(trend.pctPerDecade)), from, p });
    } else if (trend.pctPerDecade === null && Number.isFinite(trend.slope)) {
      // The fitted line starts from almost nothing, so the change is given in counts per year.
      const perYear = roundCount(Math.abs(trend.slope));
      const amount = tCount(lang, rawUnits ? 'trend.unit.detections' : 'trend.unit.hotspots', perYear, {
        shown: formatNumber(lang, perYear, 1),
      });
      sentence = t(lang, `trend.${trend.direction}PerYear`, { amount, from, p });
    }
  }
  return sentence;
}

export function lowerFirst(sentence: string, lang: Lang): string {
  return sentence.charAt(0).toLocaleLowerCase(lang) + sentence.slice(1);
}

/**
 * The year so far in a sentence: "2026 up to Nov 12: 17,380 MODIS-equivalent
 * hotspots, 0.6× the usual level by that date, the lowest since 2003."
 */
export function yearSoFarSentence(soFar: YearSoFar, lang: Lang): string {
  const month = monthName(soFar.throughMonth, lang);
  const date = soFar.throughDay === null ? t(lang, 'ytd.monthEnd', { month }) : t(lang, 'ytd.day', { month, day: soFar.throughDay });
  const rank = rankPhrase(
    { rank: soFar.rank, baseline: { median: soFar.usual, q1: soFar.usual, q3: soFar.usual, values: soFar.earlier } },
    soFar.value,
    lang,
  );
  const params = { year: soFar.year, date, count: hotspotsText(soFar.value, lang), rank, since: FIRST_YEAR };
  if (soFar.ratio !== null) return t(lang, 'ytd.ratio', { ...params, ratio: formatNumber(lang, soFar.ratio, 1, 1) });
  return roundCount(soFar.value) < RARE_MEDIAN ? t(lang, 'ytd.rareSmall', params) : t(lang, 'ytd.rare', params);
}

/** A trend in a few words, for a table: "Rising, 32% per decade", "No significant trend", "Too little fire". */
export function trendShort(trend: Trend, lang: Lang): string {
  if ('reason' in trend) return t(lang, `trendShort.${trend.reason}`);
  if (trend.direction === 'none') return t(lang, 'trendShort.none');
  return trend.pctPerDecade !== null && Number.isFinite(trend.pctPerDecade)
    ? t(lang, `trendShort.${trend.direction}`, { pct: formatNumber(lang, Math.abs(trend.pctPerDecade)) })
    : t(lang, `trendShort.${trend.direction}Plain`);
}

/**
 * A trend set inside another sentence. `trend.rawWouldSay`: what the raw
 * counts say, beside the harmonized trend. `robust.holds` and
 * `robust.changes`: the harmonized trend once a province's known gap to MODIS
 * is removed, for a trend that stays the same and for one that does not.
 */
export function framedTrend(
  frame: 'trend.rawWouldSay' | 'robust.holds' | 'robust.changes',
  trend: Trend,
  lang: Lang,
  options: { raw?: boolean } = {},
): string {
  // "The trend holds: no significant trend" would be a riddle.
  if (frame === 'robust.holds' && !('reason' in trend) && trend.direction === 'none') return t(lang, 'robust.holdsNone');
  return t(lang, frame, { sentence: lowerFirst(plainTrend(trend, lang, options.raw === true), lang) });
}

/** The line under the verdict: the held-out test in one sentence, with the numbers of meta.json rounded. */
export function testLine(meta: Pick<Meta, 'calibration' | 'typical_error_pct' | 'naive_error_pct'>, lang: Lang): string {
  return t(lang, 'testLine.text', {
    from: meta.calibration.test_years[0],
    to: meta.calibration.test_years[1],
    error: formatNumber(lang, meta.typical_error_pct),
    naive: formatNumber(lang, meta.naive_error_pct),
  });
}

/**
 * One calm line for a province whose harmonized total ran more than 15% from
 * MODIS on the test years; `null` for every other area.
 */
export function biasCaution(
  validation: Pick<Validation, 'test_years' | 'province_bias'> | null,
  provinceId: string,
  lang: Lang,
): string | null {
  const entry = validation?.province_bias?.find((province) => province.prov === provinceId);
  if (!validation || !entry || !(Math.abs(entry.bias) > BIAS_CAUTION)) return null;
  return t(lang, entry.bias > 0 ? 'caution.above' : 'caution.below', {
    name: entry.name,
    pct: formatNumber(lang, Math.abs(entry.bias) * 100),
    from: validation.test_years[0],
    to: validation.test_years[1],
  });
}
