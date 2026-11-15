// The two charts beside the calendar (plan section 6.5): yearly totals as bars,
// above it, and the seasonal profile, below it. Each has a model that can be checked without a
// screen and a drawing function that turns the model into an SVG.

import { area, line, scaleLinear } from 'd3';
import { formatCount, type CellStatus } from './calendar';
import type { Layer } from './data';
import { h, svg } from './dom';
import {
  BAND,
  BAR,
  BAR_LIGHT,
  HIGHLIGHT,
  INK,
  LINE,
  MUTED,
  TREND,
  drawResponsive,
  flowLegend,
  hatchPatterns,
  label,
  textWidth,
  type LegendEntry,
} from './drawing';
import { t, tCount, type Lang } from './i18n';
import {
  FIRST_YEAR,
  monthIdx,
  monthOfIdx,
  summarize,
  yearOfIdx,
  type Completeness,
  type Trend,
  type YearValue,
} from './stats';
import { capitalize, countText, hotspotsText, roundCount } from './verdict';

export interface ChartOptions {
  lang: Lang;
  /** The area's name, for the chart's spoken label. */
  areaName: string;
  /** Width in px. Default: the width of the element. */
  width?: number;
}

/** "520 MODIS-equivalent hotspots", or "2,080 raw detections" in Raw view. */
function countWithUnit(value: number, view: Layer, lang: Lang): string {
  return view === 'raw'
    ? tCount(lang, 'cell.raw', roundCount(value), { shown: countText(value, lang) })
    : hotspotsText(value, lang);
}

/**
 * Replaces a chart with one line of text, so an empty chart is never left
 * unexplained. It is registered like a drawing, so a later change of width
 * redraws this line and not the chart that was there before.
 */
function explainEmpty(element: HTMLElement, text: string, width?: number): void {
  drawResponsive(element, () => element.replaceChildren(h(element, 'p', { class: 'chart-empty' }, text)), width);
}

// ---- Yearly totals ---------------------------------------------------------------

export interface YearBar {
  year: number;
  value: number;
  /** Height as a share of the tallest bar. */
  share: number;
  /** The total, printed above the bar for the top three years. */
  label: string | null;
  /** True for the current year and for a year with an incomplete month. */
  hatched: boolean;
}

/**
 * The fitted trend as a line over the bars: where it starts and ends. The
 * years are whole unless the line was cut off where it reaches zero.
 */
export interface TrendLine {
  fromYear: number;
  fromValue: number;
  toYear: number;
  toValue: number;
}

/**
 * The line of a clear trend, from the first to the last complete year, kept
 * above zero. `null` for a trend that is not clear or could not be assessed,
 * and for raw counts, whose rise is the change of sensor.
 */
function trendLine(fitted: Trend | null | undefined, view: Layer): TrendLine | null {
  if (!fitted || view === 'raw' || 'reason' in fitted || fitted.direction === 'none') return null;
  const { slope, startValue } = fitted;
  const endValue = startValue + slope * (fitted.toYear - fitted.fromYear);
  if (!Number.isFinite(endValue) || (startValue < 0 && endValue < 0)) return null;
  /** The year in which the fitted line stands at zero. */
  const zeroYear = fitted.fromYear - startValue / slope;
  return {
    fromYear: startValue < 0 ? zeroYear : fitted.fromYear,
    fromValue: Math.max(0, startValue),
    toYear: endValue < 0 ? zeroYear : fitted.toYear,
    toValue: Math.max(0, endValue),
  };
}

export interface YearlyBarsModel {
  view: Layer;
  bars: YearBar[];
  max: number;
  /** The year with the largest total. */
  topYear: number | null;
  /** The first year of VIIRS, for the marker; `null` when the years on both sides are not shown. */
  switchYear: number | null;
  /** The fitted trend, when it is clear; see `trendLine`. */
  trendLine: TrendLine | null;
  empty: boolean;
}

export function yearlyBarsModel(
  totals: YearValue[],
  options: { view: Layer; switchYear: number; trend?: Trend | null },
): YearlyBarsModel {
  const max = totals.reduce((top, year) => Math.max(top, year.value), 0);
  const ranked = totals
    .filter((year) => year.value > 0)
    .sort((a, b) => b.value - a.value || a.year - b.year)
    .slice(0, 3)
    .map((year) => year.year);
  const hasBothSides =
    totals.some((year) => year.year === options.switchYear - 1) && totals.some((year) => year.year === options.switchYear);
  return {
    view: options.view,
    bars: totals.map((year) => ({
      year: year.year,
      value: year.value,
      share: max > 0 ? year.value / max : 0,
      label: ranked.includes(year.year) ? formatCount(year.value) : null,
      hatched: !year.complete,
    })),
    max,
    topYear: ranked[0] ?? null,
    switchYear: hasBothSides ? options.switchYear : null,
    trendLine: max > 0 ? trendLine(options.trend, options.view) : null,
    empty: max === 0,
  };
}

/** Draws the yearly totals, top three labelled, incomplete years hatched. Follows the element's width. */
export function renderYearlyBars(element: HTMLElement, model: YearlyBarsModel, options: ChartOptions): void {
  const lang = options.lang;
  if (model.empty) {
    explainEmpty(element, t(lang, 'yearly.empty'), options.width);
    return;
  }
  drawResponsive(
    element,
    (width) => {
      const doc = element.ownerDocument;
      const prefix = element.id || 'yearly';
      // Under the year numbers, when the switch is in view, a line names each era: MODIS, then VIIRS.
      const eras = model.switchYear !== null;
      const bottom = eras ? 40 : 20;
      const height = (width < 480 ? 150 : 200) + bottom;
      const top = 30;
      const plot = height - top - bottom;
      const yearY = top + plot + 14;
      const band = width / model.bars.length;
      // The scale ends at the tallest bar, or at the trend line where that starts or ends higher.
      const fitted = model.trendLine;
      const scaleTop = Math.max(model.max, fitted?.fromValue ?? 0, fitted?.toValue ?? 0);
      const toHeight = (value: number) => (value / scaleTop) * plot;
      const barWidth = Math.max(2, band * 0.72);
      const root = svg(doc, 'svg', {
        xmlns: 'http://www.w3.org/2000/svg',
        width,
        height,
        viewBox: `0 0 ${width} ${height}`,
        role: 'group',
        class: 'chart-svg',
        'aria-label': t(lang, 'yearly.label', {
          area: options.areaName,
          from: model.bars[0].year,
          to: model.bars[model.bars.length - 1].year,
          top: model.topYear ?? '',
        }),
      });
      root.append(hatchPatterns(doc, prefix));
      root.append(svg(doc, 'line', { x1: 0, x2: width, y1: top + plot, y2: top + plot, stroke: LINE, 'stroke-width': 1 }));

      // Year labels: every year when there is room, otherwise every fifth.
      const everyYear = band >= 28;
      let labelLift = 0;
      model.bars.forEach((bar, i) => {
        const x = i * band + (band - barWidth) / 2;
        const barHeight = toHeight(bar.value);
        const y = top + plot - barHeight;
        const text = t(lang, bar.hatched ? 'yearly.barPartial' : 'yearly.bar', {
          year: bar.year,
          count: countWithUnit(bar.value, model.view, lang),
        });
        const group = svg(doc, 'g', { class: 'year-bar', 'data-year': bar.year, role: 'img', 'aria-label': text });
        group.append(svg(doc, 'title', {}, text));
        const box = { x, y, width: barWidth, height: Math.max(barHeight, bar.value > 0 ? 1 : 0) };
        group.append(svg(doc, 'rect', { ...box, fill: bar.hatched ? BAR_LIGHT : BAR }));
        if (bar.hatched && box.height > 0) {
          group.append(svg(doc, 'rect', { ...box, class: 'year-bar-hatch', fill: `url(#${prefix}-hatch)` }));
        }
        if (bar.label) {
          // Two labelled neighbours on a narrow chart: lift the second so the numbers do not collide.
          const crowded = model.bars[i - 1]?.label && band < textWidth(bar.label, 10.5) + 6;
          labelLift = crowded && labelLift === 0 ? 11 : 0;
          group.append(
            label(doc, bar.label, {
              x: x + barWidth / 2,
              y: Math.max(10, y - 4 - labelLift),
              'text-anchor': 'middle',
              'font-size': 10.5,
              'font-weight': 600,
              class: 'year-bar-label',
            }),
          );
        } else {
          labelLift = 0;
        }
        root.append(group);
        if (everyYear || bar.year % 5 === 0) {
          root.append(label(doc, String(bar.year), { x: i * band + band / 2, y: yearY, 'text-anchor': 'middle', 'font-size': 10, fill: MUTED }));
        }
      });

      if (fitted) {
        // Over the bars, with a light edge so that it shows against them.
        const text = t(lang, 'yearly.trendTitle');
        const x = (year: number) => (year - model.bars[0].year + 0.5) * band;
        const ends = {
          x1: x(fitted.fromYear),
          y1: top + plot - toHeight(fitted.fromValue),
          x2: x(fitted.toYear),
          y2: top + plot - toHeight(fitted.toValue),
          'stroke-linecap': 'round',
        };
        root.append(
          svg(
            doc,
            'g',
            { class: 'trend', role: 'img', 'aria-label': text },
            svg(doc, 'title', {}, text),
            svg(doc, 'line', { ...ends, stroke: '#ffffff', 'stroke-width': 5, 'stroke-opacity': 0.85 }),
            svg(doc, 'line', { ...ends, class: 'trend-line', stroke: TREND, 'stroke-width': 2.5 }),
          ),
        );
      }

      if (model.switchYear !== null) {
        // The two eras: a thin line under each one's years, its name centred below.
        const split = model.bars.findIndex((bar) => bar.year === model.switchYear);
        const names = [
          { from: 0, to: split, text: t(lang, 'yearly.eraModis') },
          { from: split, to: model.bars.length, text: t(lang, model.view === 'raw' ? 'yearly.eraViirsRaw' : 'yearly.eraViirs') },
        ];
        for (const era of names) {
          const lineY = yearY + 7;
          root.append(
            svg(doc, 'line', { x1: era.from * band + 3, x2: era.to * band - 3, y1: lineY, y2: lineY, stroke: LINE, 'stroke-width': 1, class: 'year-era-line' }),
            label(doc, era.text, {
              x: ((era.from + era.to) / 2) * band,
              y: lineY + 12,
              'text-anchor': 'middle',
              'font-size': 10.5,
              fill: MUTED,
              class: 'year-era',
            }),
          );
        }
      }

      if (model.switchYear !== null) {
        const index = model.bars.findIndex((bar) => bar.year === model.switchYear);
        const x = index * band;
        const text = t(lang, 'yearly.switch', { year: model.switchYear });
        const fitsRight = x + 5 + textWidth(text, 10) <= width;
        root.append(
          svg(doc, 'line', { x1: x, x2: x, y1: 4, y2: top + plot, stroke: INK, 'stroke-width': 1, 'stroke-dasharray': '3 3' }),
          label(doc, text, {
            x: fitsRight ? x + 5 : x - 5,
            y: 10,
            'text-anchor': fitsRight ? 'start' : 'end',
            'font-size': 10,
            fill: MUTED,
            class: 'year-switch',
            stroke: '#ffffff',
            'stroke-width': 3,
            'paint-order': 'stroke',
          }),
        );
      }
      element.replaceChildren(root);
    },
    options.width,
  );
}

// ---- Seasonal profile ------------------------------------------------------------

export interface SeasonalProfileModel {
  /** For each calendar month: the median and quartiles over the complete years. */
  months: Array<{ month: number; median: number; q1: number; q3: number }>;
  /** The complete years the medians cover. */
  fromYear: number;
  toYear: number;
  /** The year drawn as a line. */
  year: number;
  /** That year's months with data. A partial or incomplete month is flagged. */
  points: Array<{ month: number; value: number; status: CellStatus }>;
  /**
   * For the current, partial month: the usual level of the same days (1 to
   * `day`) in the other complete years, the fair comparison for its point.
   * `null` for any other year, or without month-to-date values.
   */
  partialUsual: { month: number; day: number; value: number } | null;
  /** The top of the scale. */
  max: number;
  empty: boolean;
}

/**
 * `mtd` holds days 1 to D of the current month, one value per year from 2003
 * (empty when there is no partial month). It gives the partial month a usual
 * level of its own; a part of a month is never scaled up to a whole one.
 */
export function seasonalProfileModel(
  monthly: ArrayLike<number>,
  c: Completeness,
  year: number,
  mtd: ArrayLike<number> = [],
): SeasonalProfileModel {
  const lastYear = yearOfIdx(c.lastMonthIdx);
  const shown = Math.min(Math.max(year, FIRST_YEAR), lastYear);
  const value = (idx: number) => (Number.isFinite(monthly[idx]) ? Number(monthly[idx]) : 0);

  const months = Array.from({ length: 12 }, (_, m) => {
    const values: number[] = [];
    for (let y = FIRST_YEAR; y <= c.lastCompleteYear; y++) {
      const idx = monthIdx(y, m + 1);
      if (!c.incomplete.has(idx)) values.push(value(idx));
    }
    const stats = summarize(values);
    return { month: m + 1, median: stats?.median ?? 0, q1: stats?.q1 ?? 0, q3: stats?.q3 ?? 0 };
  });

  const points: SeasonalProfileModel['points'] = [];
  for (let m = 1; m <= 12; m++) {
    const idx = monthIdx(shown, m);
    if (idx > c.lastMonthIdx) break;
    const status: CellStatus = c.incomplete.has(idx) ? 'incomplete' : c.partial?.monthIdx === idx ? 'partial' : 'complete';
    points.push({ month: m, value: value(idx), status });
  }

  let partialUsual: SeasonalProfileModel['partialUsual'] = null;
  if (c.partial && yearOfIdx(c.partial.monthIdx) === shown && mtd.length > 0) {
    const month = monthOfIdx(c.partial.monthIdx);
    const values: number[] = [];
    for (let y = FIRST_YEAR; y <= c.lastCompleteYear; y++) {
      if (y === shown || c.incomplete.has(monthIdx(y, month))) continue;
      const value = Number(mtd[y - FIRST_YEAR]);
      if (Number.isFinite(value)) values.push(value);
    }
    const usual = summarize(values);
    if (usual) partialUsual = { month, day: c.partial.lastDay, value: usual.median };
  }

  const max = Math.max(...months.map((month) => month.q3), ...points.map((point) => point.value), partialUsual?.value ?? 0, 0);
  return {
    months,
    fromYear: FIRST_YEAR,
    toYear: c.lastCompleteYear,
    year: shown,
    points,
    partialUsual,
    max: max > 0 ? max : 1,
    empty: max === 0,
  };
}

/** Draws the seasonal profile: the Q1 to Q3 band, the median, and the selected year. */
export function renderSeasonalProfile(element: HTMLElement, model: SeasonalProfileModel, options: ChartOptions): void {
  const lang = options.lang;
  if (model.empty) {
    explainEmpty(element, t(lang, 'seasonal.empty'), options.width);
    return;
  }
  drawResponsive(
    element,
    (width) => {
      const doc = element.ownerDocument;
      const left = 36;
      const right = 8;
      const top = 10;
      const plot = width < 480 ? 130 : 160;
      const band = (width - left - right) / 12;
      const x = (month: number) => left + (month - 0.5) * band;
      const y = scaleLinear().domain([0, model.max]).nice(4).range([top + plot, top]);

      const root = svg(doc, 'svg', {
        xmlns: 'http://www.w3.org/2000/svg',
        width,
        role: 'group',
        class: 'chart-svg',
        'aria-label': t(lang, 'seasonal.label', { area: options.areaName, year: model.year }),
      });

      for (const tick of y.ticks(4)) {
        root.append(
          svg(doc, 'line', { x1: left, x2: width - right, y1: y(tick), y2: y(tick), stroke: tick === 0 ? LINE : '#e7e4dc', 'stroke-width': 1 }),
          label(doc, formatCount(tick), { x: left - 6, y: y(tick) + 3.5, 'text-anchor': 'end', 'font-size': 10, fill: MUTED }),
        );
      }
      const wide = band >= 30;
      for (let m = 1; m <= 12; m++) {
        const name = t(lang, `months.short.${m - 1}`);
        root.append(
          label(doc, wide ? capitalize(name, lang) : name.charAt(0).toLocaleUpperCase(lang), {
            x: x(m),
            y: top + plot + 15,
            'text-anchor': 'middle',
            'font-size': 10,
            fill: MUTED,
          }),
        );
      }

      const bandPath = area<SeasonalProfileModel['months'][number]>()
        .x((d) => x(d.month))
        .y0((d) => y(d.q1))
        .y1((d) => y(d.q3))(model.months);
      const medianPath = line<SeasonalProfileModel['months'][number]>()
        .x((d) => x(d.month))
        .y((d) => y(d.median))(model.months);
      root.append(
        svg(doc, 'path', { d: bandPath ?? '', fill: BAND, class: 'profile-band' }),
        svg(doc, 'path', { d: medianPath ?? '', fill: 'none', stroke: BAR, 'stroke-width': 1.5, class: 'profile-median' }),
      );

      // The selected year: a solid line between complete months, dashed towards a partial or incomplete one.
      for (let i = 1; i < model.points.length; i++) {
        const [a, b] = [model.points[i - 1], model.points[i]];
        const solid = a.status === 'complete' && b.status === 'complete';
        root.append(
          svg(doc, 'line', {
            x1: x(a.month),
            y1: y(a.value),
            x2: x(b.month),
            y2: y(b.value),
            stroke: HIGHLIGHT,
            'stroke-width': 2,
            'stroke-dasharray': solid ? null : '3 3',
            class: 'profile-year',
          }),
        );
      }
      for (const point of model.points) {
        const open = point.status !== 'complete';
        const text = t(lang, 'seasonal.point', {
          month: capitalize(t(lang, `months.short.${point.month - 1}`), lang),
          year: model.year,
          count: hotspotsText(point.value, lang),
        });
        root.append(
          svg(
            doc,
            'circle',
            {
              cx: x(point.month),
              cy: y(point.value),
              r: 3,
              fill: open ? '#ffffff' : HIGHLIGHT,
              stroke: HIGHLIGHT,
              'stroke-width': 1.5,
              class: 'profile-point',
              'data-status': point.status,
            },
            svg(doc, 'title', {}, text),
          ),
        );
      }

      // The partial month's own usual level: a short dark mark across its column.
      const partial = model.partialUsual;
      const partialText = partial
        ? t(lang, 'seasonal.partialUsual', { month: t(lang, `months.short.${partial.month - 1}`), day: partial.day })
        : '';
      if (partial) {
        const half = Math.min(10, band * 0.32);
        root.append(
          svg(
            doc,
            'line',
            {
              x1: x(partial.month) - half,
              x2: x(partial.month) + half,
              y1: y(partial.value),
              y2: y(partial.value),
              stroke: INK,
              'stroke-width': 2,
              class: 'profile-partial-usual',
            },
            svg(doc, 'title', {}, `${partialText}: ${countText(partial.value, lang)}`),
          ),
        );
      }

      const entries: LegendEntry[] = [
        {
          text: t(lang, 'seasonal.median', { from: model.fromYear, to: model.toYear }),
          width: 18,
          draw: (parent, lx, ly) => parent.append(svg(doc, 'line', { x1: lx, x2: lx + 18, y1: ly + 6, y2: ly + 6, stroke: BAR, 'stroke-width': 1.5 })),
        },
        {
          text: t(lang, 'seasonal.band'),
          width: 18,
          draw: (parent, lx, ly) => parent.append(svg(doc, 'rect', { x: lx, y: ly + 1, width: 18, height: 10, fill: BAND })),
        },
        {
          text: t(lang, 'seasonal.year', { year: model.year }),
          width: 18,
          draw: (parent, lx, ly) =>
            parent.append(
              svg(doc, 'line', { x1: lx, x2: lx + 18, y1: ly + 6, y2: ly + 6, stroke: HIGHLIGHT, 'stroke-width': 2 }),
              svg(doc, 'circle', { cx: lx + 9, cy: ly + 6, r: 3, fill: HIGHLIGHT }),
            ),
        },
      ];
      if (model.points.some((point) => point.status !== 'complete')) {
        entries.push({
          text: t(lang, 'seasonal.open'),
          width: 10,
          draw: (parent, lx, ly) =>
            parent.append(svg(doc, 'circle', { cx: lx + 5, cy: ly + 6, r: 3, fill: '#ffffff', stroke: HIGHLIGHT, 'stroke-width': 1.5 })),
        });
      }
      if (partial) {
        entries.push({
          text: partialText,
          width: 18,
          draw: (parent, lx, ly) => parent.append(svg(doc, 'line', { x1: lx + 3, x2: lx + 15, y1: ly + 6, y2: ly + 6, stroke: INK, 'stroke-width': 2 })),
        });
      }
      const legendTop = top + plot + 28;
      const height = legendTop + flowLegend(root, entries, legendTop, width);
      root.setAttribute('height', String(height));
      root.setAttribute('viewBox', `0 0 ${width} ${height}`);
      element.replaceChildren(root);
    },
    options.width,
  );
}
