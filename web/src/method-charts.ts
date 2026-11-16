// The charts of the "How it works" page (plan section 6.9). They draw what
// validation.json holds and nothing else.

import { line, scaleLinear, scaleLog } from 'd3';
import { formatCount } from './calendar';
import type { ProvinceBias, Validation } from './data';
import { h, svg } from './dom';
import {
  BAR_LIGHT,
  HARMONIZED_COLOR,
  INK,
  RAW_COLOR,
  LINE,
  MUTED,
  drawResponsive,
  flowLegend,
  label,
  textWidth,
  type LegendEntry,
} from './drawing';

/** Three hues that stay apart for colour-blind readers; the lines also differ in dash. */
export const AQUA_COLOR = INK;
export { HARMONIZED_COLOR, RAW_COLOR };

export interface ChartText {
  /** The chart's spoken label. */
  label: string;
  /** Width in px. Default: the width of the element. */
  width?: number;
}

// ---- Lines over a shared x axis --------------------------------------------------

export interface Series {
  name: string;
  color: string;
  /** SVG dash pattern; solid when left out. */
  dash?: string;
  /** One value per x position; `null` where the series has none. */
  values: Array<number | null>;
}

export interface LineChartInput extends ChartText {
  series: Series[];
  /** The text under some x positions. */
  xTicks: Array<{ index: number; text: string }>;
  /** Number of x positions. */
  count: number;
}

function lineSwatch(doc: Document, series: Pick<Series, 'color' | 'dash'>): LegendEntry['draw'] {
  return (parent, x, y) =>
    parent.append(
      svg(doc, 'line', {
        x1: x,
        x2: x + 22,
        y1: y + 6,
        y2: y + 6,
        stroke: series.color,
        'stroke-width': 2.5,
        'stroke-dasharray': series.dash ?? null,
      }),
    );
}

/** Several lines over the same x positions, with a y axis from zero and a legend. */
export function renderLines(element: HTMLElement, input: LineChartInput): void {
  drawResponsive(
    element,
    (width) => {
      const doc = element.ownerDocument;
      const left = 44;
      const right = 12;
      const top = 10;
      const plot = width < 480 ? 170 : 220;
      const max = Math.max(1, ...input.series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
      const x = (index: number) => left + (index * (width - left - right)) / Math.max(1, input.count - 1);
      const y = scaleLinear().domain([0, max]).nice(4).range([top + plot, top]);

      const root = svg(doc, 'svg', { xmlns: 'http://www.w3.org/2000/svg', width, role: 'img', class: 'chart-svg', 'aria-label': input.label });
      for (const tick of y.ticks(4)) {
        root.append(
          svg(doc, 'line', { x1: left, x2: width - right, y1: y(tick), y2: y(tick), stroke: tick === 0 ? LINE : '#e7e4dc', 'stroke-width': 1 }),
          label(doc, formatCount(tick), { x: left - 6, y: y(tick) + 3.5, 'text-anchor': 'end', 'font-size': 10, fill: MUTED }),
        );
      }
      for (const tick of input.xTicks) {
        root.append(label(doc, tick.text, { x: x(tick.index), y: top + plot + 15, 'text-anchor': 'middle', 'font-size': 10, fill: MUTED }));
      }
      for (const series of input.series) {
        const path = line<number | null>()
          .defined((value) => value !== null)
          .x((_, index) => x(index))
          .y((value) => y(value ?? 0))(series.values);
        root.append(
          svg(doc, 'path', {
            d: path ?? '',
            fill: 'none',
            stroke: series.color,
            'stroke-width': 2.5,
            'stroke-dasharray': series.dash ?? null,
            'stroke-linejoin': 'round',
            class: 'series-line',
          }),
        );
      }
      const legendTop = top + plot + 28;
      const entries = input.series.map((series) => ({ text: series.name, width: 22, draw: lineSwatch(doc, series) }));
      const height = legendTop + flowLegend(root, entries, legendTop, width);
      root.setAttribute('height', String(height));
      root.setAttribute('viewBox', `0 0 ${width} ${height}`);
      element.replaceChildren(root);
    },
    input.width,
  );
}

// ---- The test: Aqua against VIIRS, province-months, log axes -----------------------

export interface ScatterText extends ChartText {
  axisAqua: string;
  axisViirs: string;
  harmonized: string;
  naive: string;
  line: string;
}

export function renderTestScatter(element: HTMLElement, pairs: Validation['test_pairs'], text: ScatterText): void {
  drawResponsive(
    element,
    (width) => {
      const doc = element.ownerDocument;
      const left = 54;
      const right = 12;
      const top = 10;
      const plot = Math.min(width - left - right, 340);
      const values = pairs.flatMap((pair) => [pair.aqua, pair.harmonized, pair.naive]).filter((value) => value > 0);
      const low = 10 ** Math.floor(Math.log10(Math.min(...values, 10)));
      const high = 10 ** Math.ceil(Math.log10(Math.max(...values, 100)));
      const x = scaleLog().domain([low, high]).range([left, left + plot]);
      const y = scaleLog().domain([low, high]).range([top + plot, top]);

      const root = svg(doc, 'svg', { xmlns: 'http://www.w3.org/2000/svg', width, role: 'img', class: 'chart-svg', 'aria-label': text.label });
      for (let decade = low; decade <= high * 1.0001; decade *= 10) {
        root.append(
          svg(doc, 'line', { x1: left, x2: left + plot, y1: y(decade), y2: y(decade), stroke: '#e7e4dc', 'stroke-width': 1 }),
          svg(doc, 'line', { x1: x(decade), x2: x(decade), y1: top, y2: top + plot, stroke: '#e7e4dc', 'stroke-width': 1 }),
          label(doc, formatCount(decade), { x: left - 6, y: y(decade) + 3.5, 'text-anchor': 'end', 'font-size': 10, fill: MUTED }),
          label(doc, formatCount(decade), { x: x(decade), y: top + plot + 14, 'text-anchor': 'middle', 'font-size': 10, fill: MUTED }),
        );
      }
      root.append(
        svg(doc, 'line', { x1: x(low), y1: y(low), x2: x(high), y2: y(high), stroke: INK, 'stroke-width': 1, class: 'pair-line' }),
        label(doc, text.axisAqua, { x: left + plot / 2, y: top + plot + 30, 'text-anchor': 'middle', 'font-size': 10.5 }),
        label(doc, text.axisViirs, {
          x: 12,
          y: top + plot / 2,
          'text-anchor': 'middle',
          'font-size': 10.5,
          transform: `rotate(-90 12 ${top + plot / 2})`,
        }),
      );
      // The naive stitch first, so the harmonized dots lie on top.
      for (const pair of pairs) {
        if (pair.aqua > 0 && pair.naive > 0) {
          root.append(svg(doc, 'circle', { cx: x(pair.aqua), cy: y(pair.naive), r: 2.5, fill: 'none', stroke: RAW_COLOR, 'stroke-width': 1, class: 'pair-naive' }));
        }
      }
      for (const pair of pairs) {
        if (pair.aqua > 0 && pair.harmonized > 0) {
          root.append(svg(doc, 'circle', { cx: x(pair.aqua), cy: y(pair.harmonized), r: 2.5, fill: HARMONIZED_COLOR, 'fill-opacity': 0.75, class: 'pair-harmonized' }));
        }
      }
      const entries: LegendEntry[] = [
        { text: text.harmonized, width: 10, draw: (parent, lx, ly) => parent.append(svg(doc, 'circle', { cx: lx + 5, cy: ly + 6, r: 3.5, fill: HARMONIZED_COLOR })) },
        { text: text.naive, width: 10, draw: (parent, lx, ly) => parent.append(svg(doc, 'circle', { cx: lx + 5, cy: ly + 6, r: 3.5, fill: 'none', stroke: RAW_COLOR, 'stroke-width': 1.5 })) },
        { text: text.line, width: 22, draw: lineSwatch(doc, { color: INK }) },
      ];
      const legendTop = top + plot + 44;
      const height = legendTop + flowLegend(root, entries, legendTop, width);
      root.setAttribute('height', String(height));
      root.setAttribute('viewBox', `0 0 ${width} ${height}`);
      element.replaceChildren(root);
    },
    text.width,
  );
}

// ---- Bias by province ------------------------------------------------------------

export interface BiasRow extends ProvinceBias {
  /** True when the bias is beyond the limit (15%). */
  beyond: boolean;
}

export interface BiasText extends ChartText {
  /** The limit as a fraction, e.g. 0.15. */
  limit: number;
  /** A fraction as a signed percentage: for the numbers on the bars (no decimals) and for spoken labels. */
  short(bias: number): string;
  spoken(row: BiasRow): string;
}

/** One horizontal bar per province, from the most over to the most under, around a zero line. */
export function renderProvinceBias(element: HTMLElement, rows: BiasRow[], text: BiasText): void {
  drawResponsive(
    element,
    (width) => {
      const doc = element.ownerDocument;
      const names = Math.min(150, Math.max(...rows.map((row) => textWidth(row.name, 11))) + 8);
      const numbers = 40;
      const rowHeight = 20;
      const top = 6;
      const reach = Math.max(text.limit * 1.2, ...rows.map((row) => Math.abs(row.bias)));
      const x = scaleLinear().domain([-reach, reach]).range([names + numbers, width - numbers]);
      const height = top + rows.length * rowHeight + 6;
      const root = svg(doc, 'svg', { xmlns: 'http://www.w3.org/2000/svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'group', class: 'chart-svg', 'aria-label': text.label });

      for (const guide of [-text.limit, text.limit]) {
        root.append(svg(doc, 'line', { x1: x(guide), x2: x(guide), y1: top, y2: height - 6, stroke: MUTED, 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
      }
      rows.forEach((row, i) => {
        const y = top + i * rowHeight;
        const from = Math.min(x(0), x(row.bias));
        const group = svg(doc, 'g', { class: 'bias-bar', role: 'img', 'aria-label': text.spoken(row), 'data-beyond': String(row.beyond) });
        group.append(
          svg(doc, 'title', {}, text.spoken(row)),
          label(doc, row.name, { x: names, y: y + 14, 'text-anchor': 'end', 'font-weight': row.beyond ? 600 : 400 }),
          svg(doc, 'rect', { x: from, y: y + 4, width: Math.max(1, Math.abs(x(row.bias) - x(0))), height: rowHeight - 8, fill: row.beyond ? INK : BAR_LIGHT }),
          label(doc, text.short(row.bias), {
            x: row.bias >= 0 ? x(row.bias) + 4 : x(row.bias) - 4,
            y: y + 14,
            'text-anchor': row.bias >= 0 ? 'start' : 'end',
            'font-size': 10.5,
            'font-weight': row.beyond ? 600 : 400,
          }),
        );
        root.append(group);
      });
      root.append(svg(doc, 'line', { x1: x(0), x2: x(0), y1: top, y2: height - 6, stroke: INK, 'stroke-width': 1 }));
      element.replaceChildren(root);
    },
    text.width,
  );
}

// ---- Yearly ratio of Aqua to harmonized VIIRS --------------------------------------

export interface RatioText extends ChartText {
  /** First and last test year, shaded. */
  testYears: [number, number];
  /** A ratio written out, for the points' tooltips. */
  point(year: number, ratio: number): string;
}

export function renderRatio(element: HTMLElement, ratios: Validation['yearly_ratio'], text: RatioText): void {
  drawResponsive(
    element,
    (width) => {
      const doc = element.ownerDocument;
      const left = 40;
      const right = 12;
      const top = 10;
      const plot = width < 480 ? 150 : 180;
      const band = (width - left - right) / ratios.length;
      const x = (index: number) => left + (index + 0.5) * band;
      const low = Math.min(0.9, ...ratios.map((entry) => entry.ratio));
      const high = Math.max(1.1, ...ratios.map((entry) => entry.ratio));
      const y = scaleLinear().domain([low, high]).nice(4).range([top + plot, top]);
      const height = top + plot + 24;
      const root = svg(doc, 'svg', { xmlns: 'http://www.w3.org/2000/svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', class: 'chart-svg', 'aria-label': text.label });

      const first = ratios.findIndex((entry) => entry.year === text.testYears[0]);
      const last = ratios.findIndex((entry) => entry.year === text.testYears[1]);
      if (first >= 0 && last >= first) {
        root.append(svg(doc, 'rect', { x: left + first * band, y: top, width: (last - first + 1) * band, height: plot, fill: '#eceae3', class: 'test-years' }));
      }
      for (const tick of y.ticks(4)) {
        const isOne = Math.abs(tick - 1) < 1e-9;
        root.append(
          svg(doc, 'line', { x1: left, x2: width - right, y1: y(tick), y2: y(tick), stroke: isOne ? INK : '#e7e4dc', 'stroke-width': 1 }),
          label(doc, tick.toFixed(2), { x: left - 6, y: y(tick) + 3.5, 'text-anchor': 'end', 'font-size': 10, fill: MUTED }),
        );
      }
      const everyYear = band >= 30;
      ratios.forEach((entry, index) => {
        if (everyYear || entry.year % 2 === 0) {
          root.append(label(doc, String(entry.year), { x: x(index), y: top + plot + 15, 'text-anchor': 'middle', 'font-size': 10, fill: MUTED }));
        }
      });
      const path = line<Validation['yearly_ratio'][number]>()
        .x((_, index) => x(index))
        .y((entry) => y(entry.ratio))(ratios);
      root.append(svg(doc, 'path', { d: path ?? '', fill: 'none', stroke: INK, 'stroke-width': 2, class: 'series-line' }));
      ratios.forEach((entry, index) => {
        root.append(
          svg(doc, 'circle', { cx: x(index), cy: y(entry.ratio), r: 3, fill: INK, class: 'ratio-point' }, svg(doc, 'title', {}, text.point(entry.year, entry.ratio))),
        );
      });
      element.replaceChildren(root);
    },
    text.width,
  );
}

/** A plain table: a caption, header rows, and body rows whose first cell is a row header. */
export function table(owner: Node, caption: string, head: Array<Array<{ text: string; span?: number; rows?: number }>>, body: string[][]): HTMLTableElement {
  return h(
    owner,
    'table',
    { class: 'method-table' },
    h(owner, 'caption', {}, caption),
    h(
      owner,
      'thead',
      {},
      ...head.map((row) =>
        h(owner, 'tr', {}, ...row.map((cell) => h(owner, 'th', { scope: cell.span ? 'colgroup' : 'col', colspan: cell.span ?? null, rowspan: cell.rows ?? null }, cell.text))),
      ),
    ),
    h(
      owner,
      'tbody',
      {},
      ...body.map((row) => h(owner, 'tr', {}, ...row.map((cell, i) => (i === 0 ? h(owner, 'th', { scope: 'row' }, cell) : h(owner, 'td', {}, cell))))),
    ),
  );
}
