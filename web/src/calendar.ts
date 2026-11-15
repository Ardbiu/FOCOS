// The calendar heatmap (plan section 6.4): one row per year, one cell per
// month, a year-total bar at the right.
//
// buildCalendarModel() decides everything that can be decided without a
// screen: values, colours, hatching, the divider, what each cell says. The
// drawing functions turn that model into an SVG (also used for the PNG
// download) and into an HTML table for screen readers.

import { interpolateInferno, interpolatePuOr, rgb } from 'd3';
import type { Layer } from './data';
import { h, svg } from './dom';
import { BAR, BAR_LIGHT, HIGHLIGHT, INK, LINE, MUTED, drawResponsive, hatchPatterns, label, textWidth, wrapText } from './drawing';
import { formatNumber, t, tCount, type Lang } from './i18n';
import {
  FIRST_YEAR,
  MAX_SEASON_MONTHS,
  RARE_MEDIAN,
  assessMonth,
  carrierForMonth,
  fireSeason,
  monthIdx,
  quantile,
  seasonLength,
  typicalError,
  yearOfIdx,
  type Carrier,
  type Completeness,
  type ErrorBand,
  type MonthAssessment,
  type Season,
  type TypicalError,
} from './stats';
import type { Mode } from './state';
import { capitalize, countText, hotspotsText, periodLabel, rankPhrase, roundCount } from './verdict';

// ---- Colours -------------------------------------------------------------------

/** A month with data and no fire. */
export const ZERO_COLOR = '#ebe9e3';
/** Anomaly mode: a month whose usual level is too low to compare with, or that is not compared. */
export const RARE_COLOR = '#d3d0c8';
/** A month after the end of the data. Never the colour of zero fire. */
export const NODATA_COLOR = '#ffffff';

/** The part of the inferno ramp used: pale yellow for the smallest counts, dark purple for the largest. */
const RAMP_LIGHT = 0.97;
const RAMP_DARK = 0.12;
/** How far along the purple-orange ramp one doubling moves a cell. */
const ANOMALY_STEP = 0.21;
const ANOMALY_CLAMP = 2;

/**
 * Count mode: the inferno ramp on a square-root scale from 0 to `scaleMax`
 * (the area's 98th-percentile month), light to dark so more ink means more
 * fire. Zero is light gray.
 */
export function colorForCount(value: number, scaleMax: number): string {
  if (!(value > 0)) return ZERO_COLOR;
  const share = scaleMax > 0 ? Math.sqrt(Math.min(value, scaleMax) / scaleMax) : 1;
  return interpolateInferno(RAMP_LIGHT - share * (RAMP_LIGHT - RAMP_DARK));
}

/**
 * log2(value / median), clamped to -2..+2: how many doublings above or below
 * the usual level. `null` when the median is below 5, where a ratio means little.
 */
export function anomalyLevel(value: number, median: number): number | null {
  if (!(median >= 5)) return null;
  if (!(value > 0)) return -ANOMALY_CLAMP;
  return Math.max(-ANOMALY_CLAMP, Math.min(ANOMALY_CLAMP, Math.log2(value / median)));
}

/** Anomaly mode: orange above the usual level, purple below; gray when the median is below 5. */
export function colorForAnomaly(value: number, median: number): string {
  const level = anomalyLevel(value, median);
  // d3's purple-orange ramp runs from purple (0) to orange (1).
  return level === null ? RARE_COLOR : interpolatePuOr(0.5 + level * ANOMALY_STEP);
}

function relativeLuminance(color: string): number {
  const { r, g, b } = rgb(color);
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Black or white, whichever reads better on the fill. */
export function inkOn(fill: string): '#000000' | '#ffffff' {
  const luminance = relativeLuminance(fill);
  return 1.05 / (luminance + 0.05) > (luminance + 0.05) / 0.05 ? '#ffffff' : '#000000';
}

/** A count short enough for a cell: `87`, `1.2k`, `20k`, `1.2M`. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '';
  const trim = (text: string) => text.replace(/\.0$/, '');
  if (value >= 999_500) return `${trim((value / 1_000_000).toFixed(1))}M`;
  if (value >= 9_950) return `${Math.round(value / 1000)}k`;
  if (value >= 999.5) return `${trim((value / 1000).toFixed(1))}k`;
  if (value >= 9.95) return String(Math.round(value));
  return trim(Math.max(0, value).toFixed(1));
}

// ---- The model -----------------------------------------------------------------

export type CellStatus = 'complete' | 'partial' | 'incomplete' | 'nodata';

export interface CalendarCell {
  /** `month_idx`; December of the last year can lie past the end of the series. */
  monthIdx: number;
  year: number;
  /** 1 to 12. */
  month: number;
  view: Layer;
  /** `nodata`: after the end of the data. `partial`: the current month so far. `incomplete`: too many days missed. */
  status: CellStatus;
  /** D, the last day with data, for the partial month. */
  partialDay: number | null;
  /** The value drawn: harmonized or raw. 0 for a month without data. */
  value: number;
  /** True for incomplete, partial and no-data months. */
  hatched: boolean;
  fill: string;
  /** Text colour that reads on `fill`. */
  ink: string;
  /** The value as printed in the cell; empty for a month without data. */
  label: string;
  /** The comparison with the baseline. `null` in Raw view and for a month without data. */
  assessment: MonthAssessment | null;
  /** The satellite that carries this month, e.g. `S-NPP VIIRS`. */
  carrier: string | null;
  /** What can be said about the error of this count. `null` for Aqua months, in Raw view, and when not compared. */
  error: TypicalError | null;
  selected: boolean;
}

export interface CalendarRow {
  year: number;
  cells: CalendarCell[];
  /** The sum of the months with data. */
  total: number;
  totalLabel: string;
  /** False for the current year and for a year with an incomplete month. */
  complete: boolean;
}

export interface CalendarModel {
  view: Layer;
  /** The mode drawn. Always `count` in Raw view. */
  mode: Mode;
  /** False in Raw view, where anomalies are switched off. */
  anomalyEnabled: boolean;
  rows: CalendarRow[];
  /** The largest year total among the rows; 0 when there is no fire. */
  maxTotal: number;
  /** The top of the count scale: the 98th-percentile month of the harmonized series. */
  scaleMax: number;
  /** The fire season (six months at most), for the bracket above the months. `null` in Raw view or when there is none. */
  season: Season | null;
  /** Where the sensor divider goes and what it says; `null` when the years on either side are not both shown. */
  divider: { afterYear: number; labelKey: 'divider.harmonized' | 'divider.raw' } | null;
  /** D of the partial month, if there is one among the rows. */
  partialDay: number | null;
  /** True when the rows hold no fire at all. */
  empty: boolean;
}

export interface CalendarInput {
  /** 287 harmonized monthly values. */
  monthly: ArrayLike<number>;
  /** 287 raw monthly counts; needed for the Raw view. */
  raw: ArrayLike<number> | null;
  mtd: ArrayLike<number>;
  completeness: Completeness;
  carriers: Carrier[];
  /** From validation.json; empty when it is not loaded. */
  errorBands: ErrorBand[];
  view: Layer;
  mode: Mode;
  yearFrom: number;
  yearTo: number;
  sel: number | null;
}

function finite(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The top of the count scale: the 98th percentile of the months with data, or the maximum, or 1. */
function countScaleMax(monthly: ArrayLike<number>, c: Completeness): number {
  const values: number[] = [];
  for (let idx = 0; idx <= c.lastMonthIdx; idx++) values.push(finite(monthly[idx]));
  values.sort((a, b) => a - b);
  if (values.length === 0) return 1;
  const top = quantile(values, 0.98);
  if (top > 0) return top;
  const max = values[values.length - 1];
  return max > 0 ? max : 1;
}

export function buildCalendarModel(input: CalendarInput): CalendarModel {
  const c = input.completeness;
  const isRaw = input.view === 'raw';
  const mode: Mode = isRaw ? 'count' : input.mode;
  const series = isRaw ? (input.raw ?? []) : input.monthly;
  const scaleMax = countScaleMax(input.monthly, c);

  const lastYear = yearOfIdx(c.lastMonthIdx);
  const yearFrom = Math.min(Math.max(input.yearFrom, FIRST_YEAR), lastYear);
  const yearTo = Math.min(Math.max(input.yearTo, yearFrom), lastYear);

  const cellAt = (year: number, month: number): CalendarCell => {
    const idx = monthIdx(year, month);
    const base = { monthIdx: idx, year, month, view: input.view, selected: input.sel === idx };
    if (idx > c.lastMonthIdx) {
      return {
        ...base,
        status: 'nodata',
        partialDay: null,
        value: 0,
        hatched: true,
        fill: NODATA_COLOR,
        ink: '#000000',
        label: '',
        assessment: null,
        carrier: null,
        error: null,
      };
    }
    const value = finite(series[idx]);
    const status: CellStatus = c.incomplete.has(idx) ? 'incomplete' : c.partial?.monthIdx === idx ? 'partial' : 'complete';
    const assessment = isRaw ? null : assessMonth({ monthly: input.monthly, mtd: input.mtd }, idx, c);
    const carrier = carrierForMonth(input.carriers, idx);

    let fill = colorForCount(value, scaleMax);
    if (mode === 'anomaly') {
      const compared = assessment?.baseline && !assessment.rare && assessment.ratio !== null;
      fill = compared ? colorForAnomaly(assessment!.value, assessment!.baseline!.median) : RARE_COLOR;
    }
    return {
      ...base,
      status,
      partialDay: status === 'partial' ? c.partial!.lastDay : null,
      value,
      hatched: status !== 'complete',
      fill,
      ink: inkOn(fill),
      label: formatCount(value),
      assessment,
      carrier: carrier?.name ?? null,
      error: isRaw || status === 'incomplete' ? null : typicalError(value, carrier, input.errorBands),
    };
  };

  const rows: CalendarRow[] = [];
  for (let year = yearFrom; year <= yearTo; year++) {
    const cells = Array.from({ length: 12 }, (_, m) => cellAt(year, m + 1));
    const total = cells.reduce((sum, cell) => sum + cell.value, 0);
    rows.push({
      year,
      cells,
      total,
      totalLabel: formatCount(total),
      complete: year <= c.lastCompleteYear && cells.every((cell) => cell.status === 'complete'),
    });
  }

  // Only a run of up to six months is bracketed as a season.
  const season = isRaw ? null : fireSeason(input.monthly, c);
  const switchYear = yearOfIdx(input.carriers[1]?.fromIdx ?? monthIdx(2012, 2));
  const maxTotal = rows.reduce((max, row) => Math.max(max, row.total), 0);
  return {
    view: input.view,
    mode,
    anomalyEnabled: !isRaw,
    rows,
    maxTotal,
    scaleMax,
    season: season && seasonLength(season) <= MAX_SEASON_MONTHS ? season : null,
    divider:
      yearFrom < switchYear && yearTo >= switchYear
        ? { afterYear: switchYear - 1, labelKey: isRaw ? 'divider.raw' : 'divider.harmonized' }
        : null,
    partialDay: rows.flatMap((row) => row.cells).find((cell) => cell.status === 'partial')?.partialDay ?? null,
    empty: maxTotal === 0,
  };
}

// ---- What a cell says ----------------------------------------------------------

/**
 * The lines of a cell's tooltip, also read out as its label: the month, the
 * count, and in Harmonized view the usual level, the ratio, the rank, the
 * category and the typical error of a count this size.
 */
export function describeCell(cell: CalendarCell, lang: Lang): string[] {
  const lines = [capitalize(periodLabel(cell, lang), lang)];
  if (cell.status === 'nodata') return [...lines, t(lang, 'cell.nodata')];

  if (cell.view === 'raw') {
    lines.push(tCount(lang, 'cell.raw', roundCount(cell.value), { shown: countText(cell.value, lang) }));
    lines.push(t(lang, 'cell.rawNote'));
    if (cell.status === 'incomplete') lines.push(t(lang, 'cell.incomplete'));
    if (cell.status === 'partial') lines.push(tCount(lang, 'cell.partialRaw', cell.partialDay ?? 0));
    return lines;
  }

  lines.push(hotspotsText(cell.value, lang));
  if (cell.status === 'incomplete') return [...lines, t(lang, 'cell.incomplete')];

  const assessed = cell.assessment;
  if (assessed?.baseline) {
    lines.push(t(lang, 'cell.median', { median: countText(assessed.baseline.median, lang) }));
    const hasRatio = !assessed.rare && assessed.ratio !== null && Number.isFinite(assessed.ratio);
    lines.push(
      hasRatio ? t(lang, 'cell.ratio', { ratio: formatNumber(lang, assessed.ratio!, 1, 1) }) : t(lang, 'cell.rare'),
    );
    // As in the headline: where fire is usually rare, a count below 5 is too small to rank.
    const tooFewToRank = assessed.rare && roundCount(assessed.value) < RARE_MEDIAN;
    if (assessed.rank !== null && roundCount(assessed.value) > 0 && !tooFewToRank) {
      const rank = rankPhrase(assessed, assessed.value, lang);
      lines.push(capitalize(t(lang, 'cell.rank', { rank, since: FIRST_YEAR }), lang));
    }
    if (hasRatio && assessed.category) lines.push(t(lang, `category.${assessed.category}`));
  }
  if (cell.error?.kind === 'pct') {
    const pct = formatNumber(lang, cell.error.pct);
    lines.push(
      cell.error.carrier === null
        ? t(lang, 'cell.errorPlain', { pct })
        : t(lang, 'cell.error', { pct, carrier: cell.error.carrier }),
    );
  } else if (cell.error?.kind === 'tooSmall') {
    lines.push(t(lang, 'cell.errorTooSmall'));
  }
  if (cell.status === 'partial') lines.push(tCount(lang, 'cell.partial', cell.partialDay ?? 0));
  return lines;
}

// ---- Geometry ------------------------------------------------------------------

export interface CalendarLayout {
  width: number;
  /** Height of the heatmap itself: bracket, month names, rows and divider. The legend comes below. */
  height: number;
  /** Left edge and top of the first cell. */
  gridX: number;
  gridY: number;
  cellWidth: number;
  cellHeight: number;
  gap: number;
  /** Left edge and width of the year-total bars. */
  barsX: number;
  barsWidth: number;
  dividerHeight: number;
  /** Counts are printed in the cells when they are at least 34 px wide. */
  showNumbers: boolean;
}

const MIN_NUMBER_CELL = 34;
const YEAR_LABEL_WIDTH = 38;
const HEADER_HEIGHT = 40;
const DIVIDER_HEIGHT = 18;

export function calendarLayout(width: number, rowCount: number, hasDivider: boolean): CalendarLayout {
  const gap = 2;
  const barsGap = 8;
  const barsWidth = Math.min(150, Math.max(48, width * 0.18));
  const gridWidth = Math.max(60, width - YEAR_LABEL_WIDTH - barsGap - barsWidth);
  const cellWidth = (gridWidth - 11 * gap) / 12;
  const showNumbers = cellWidth >= MIN_NUMBER_CELL;
  const cellHeight = showNumbers ? 24 : 20;
  return {
    width,
    height: HEADER_HEIGHT + rowCount * (cellHeight + gap) + (hasDivider ? DIVIDER_HEIGHT : 0),
    gridX: YEAR_LABEL_WIDTH,
    gridY: HEADER_HEIGHT,
    cellWidth,
    cellHeight,
    gap,
    barsX: YEAR_LABEL_WIDTH + gridWidth + barsGap,
    barsWidth,
    dividerHeight: DIVIDER_HEIGHT,
    showNumbers,
  };
}

// ---- Drawing: SVG --------------------------------------------------------------

export interface CalendarSvgOptions {
  lang: Lang;
  width: number;
  /** A prefix that keeps this drawing's pattern ids apart from others on the page. */
  idPrefix?: string;
  /** For the PNG download: a title above and a footer below. */
  frame?: { title: string; footer: string };
}

/** One swatch of the legend, or one gradient with its tick labels. */
type LegendItem =
  | { kind: 'swatch'; text: string; fill: string; pattern?: 'hatch' | 'nodata' }
  | { kind: 'ramp'; colors: string[]; ticks: Array<{ at: number; text: string }> };

function legendItems(model: CalendarModel, lang: Lang): { title: string; items: LegendItem[] } {
  const steps = Array.from({ length: 17 }, (_, i) => i / 16);
  const hatched: LegendItem = { kind: 'swatch', text: t(lang, 'legend.hatched'), fill: RARE_COLOR, pattern: 'hatch' };
  const nodata: LegendItem = { kind: 'swatch', text: t(lang, 'legend.nodata'), fill: NODATA_COLOR, pattern: 'nodata' };
  if (model.mode === 'anomaly') {
    const names = [0, 1, 2, 3, 4].map((i) => t(lang, `legend.ticks.${i}`));
    return {
      title: t(lang, 'legend.anomaly'),
      items: [
        {
          kind: 'ramp',
          colors: steps.map((s) => interpolatePuOr(0.5 + (s * 4 - 2) * ANOMALY_STEP)),
          ticks: names.map((text, i) => ({ at: i / 4, text })),
        },
        { kind: 'swatch', text: t(lang, 'legend.rare'), fill: RARE_COLOR },
        hatched,
        nodata,
      ],
    };
  }
  const max = model.scaleMax;
  return {
    title: t(lang, model.view === 'raw' ? 'legend.raw' : 'legend.count'),
    items: [
      { kind: 'swatch', text: t(lang, 'legend.zero'), fill: ZERO_COLOR },
      {
        kind: 'ramp',
        // Square-root scale: half-way along the ramp is a quarter of the top value.
        colors: steps.map((s) => colorForCount(Math.max(s * s * max, max * 1e-6), max)),
        ticks: [
          // The left end is the smallest count above zero. "1" names it, unless 1 is past the middle tick.
          { at: 0, text: max / 4 >= 1 ? '1' : t(lang, 'legend.aboveZero') },
          { at: 0.5, text: formatCount(max / 4) },
          { at: 1, text: t(lang, 'legend.atLeast', { value: formatCount(max) }) },
        ],
      },
      hatched,
      nodata,
    ],
  };
}

/** Draws the legend from (0, y) and returns its height. Items flow onto new lines as the width runs out. */
function drawLegend(parent: SVGElement, model: CalendarModel, options: CalendarSvgOptions, y: number, prefix: string): number {
  const { title, items } = legendItems(model, options.lang);
  const width = options.width;
  const titleLines = wrapText(title, 11, width);
  titleLines.forEach((line, i) => parent.append(label(parent, line, { x: 0, y: y + 11 + i * 14, fill: MUTED })));
  let x = 0;
  let top = y + 20 + (titleLines.length - 1) * 14;
  const lineHeight = 30;
  for (const item of items) {
    const rampWidth = Math.min(180, width - 4);
    const itemWidth = item.kind === 'ramp' ? rampWidth + 20 : 12 + 5 + textWidth(item.text, 11) + 16;
    if (x > 0 && x + itemWidth > width) {
      x = 0;
      top += lineHeight;
    }
    if (item.kind === 'swatch') {
      parent.append(svg(parent, 'rect', { x, y: top, width: 12, height: 12, rx: 2, fill: item.fill, stroke: LINE, 'stroke-width': 0.5 }));
      if (item.pattern) {
        parent.append(svg(parent, 'rect', { x, y: top, width: 12, height: 12, rx: 2, fill: `url(#${prefix}-${item.pattern})` }));
      }
      parent.append(label(parent, item.text, { x: x + 17, y: top + 10 }));
    } else {
      const gradientId = `${prefix}-ramp`;
      parent.append(
        svg(
          parent,
          'linearGradient',
          { id: gradientId, x1: 0, x2: 1, y1: 0, y2: 0 },
          ...item.colors.map((color, i) =>
            svg(parent, 'stop', { offset: `${(i / (item.colors.length - 1)) * 100}%`, 'stop-color': color }),
          ),
        ),
        svg(parent, 'rect', { x, y: top, width: rampWidth, height: 12, rx: 2, fill: `url(#${gradientId})` }),
      );
      for (const tick of item.ticks) {
        const anchor = tick.at === 0 ? 'start' : tick.at === 1 ? 'end' : 'middle';
        parent.append(label(parent, tick.text, { x: x + tick.at * rampWidth, y: top + 24, 'text-anchor': anchor, 'font-size': 10, fill: MUTED }));
      }
    }
    x += itemWidth;
  }
  return top + lineHeight - y;
}

/** The fire-season bracket above the month names; two pieces when the season wraps over New Year. */
function drawSeason(parent: SVGElement, season: Season, layout: CalendarLayout, lang: Lang): void {
  const pieces = season.start <= season.end ? [[season.start, season.end]] : [[season.start, 12], [1, season.end]];
  const step = layout.cellWidth + layout.gap;
  let widest = { x1: 0, x2: 0 };
  for (const [from, to] of pieces) {
    const x1 = layout.gridX + (from - 1) * step;
    const x2 = layout.gridX + (to - 1) * step + layout.cellWidth;
    parent.append(svg(parent, 'path', { d: `M${x1} 19V14H${x2}V19`, fill: 'none', stroke: INK, 'stroke-width': 1.5 }));
    if (x2 - x1 > widest.x2 - widest.x1) widest = { x1, x2 };
  }
  const text = t(lang, 'calendar.fireSeason');
  if (widest.x2 - widest.x1 >= textWidth(text, 10)) {
    parent.append(label(parent, text, { x: (widest.x1 + widest.x2) / 2, y: 10, 'text-anchor': 'middle', 'font-size': 10 }));
  }
}

/**
 * The calendar as a self-contained SVG: every colour and font is an attribute,
 * so the same drawing can be saved as a picture.
 */
export function calendarSvg(doc: Document, model: CalendarModel, options: CalendarSvgOptions): SVGSVGElement {
  const lang = options.lang;
  const prefix = options.idPrefix ?? 'calendar';
  const layout = calendarLayout(options.width, model.rows.length, model.divider !== null);
  const titleHeight = options.frame ? 34 : 0;
  const root = svg(doc, 'svg', { xmlns: 'http://www.w3.org/2000/svg', width: options.width });
  root.append(hatchPatterns(doc, prefix));
  if (options.frame) {
    root.append(svg(doc, 'rect', { x: 0, y: 0, width: options.width, height: 10, fill: 'none', class: 'frame-background' }));
    root.append(label(doc, options.frame.title, { x: 0, y: 20, 'font-size': 15, 'font-weight': 600 }));
  }
  const body = svg(doc, 'g', { transform: `translate(0 ${titleHeight})` });
  root.append(body);

  // Month names, the fire-season bracket and the heading of the bars.
  const step = layout.cellWidth + layout.gap;
  const wideMonths = layout.cellWidth >= 28;
  for (let m = 0; m < 12; m++) {
    const name = t(lang, `months.short.${m}`);
    const text = wideMonths ? capitalize(name, lang) : name.charAt(0).toLocaleUpperCase(lang);
    body.append(label(doc, text, { x: layout.gridX + m * step + layout.cellWidth / 2, y: 33, 'text-anchor': 'middle', fill: MUTED }));
  }
  if (model.season) drawSeason(body, model.season, layout, lang);
  body.append(label(doc, t(lang, layout.barsWidth >= 84 ? 'calendar.yearTotal' : 'calendar.total'), { x: layout.barsX, y: 33, fill: MUTED }));

  const barLabelRoom = 34;
  const barRoom = Math.max(4, layout.barsWidth - barLabelRoom);
  let y = layout.gridY;
  for (const row of model.rows) {
    const rowGroup = svg(doc, 'g', { class: 'cal-row', 'data-year': row.year });
    rowGroup.append(label(doc, String(row.year), { x: layout.gridX - 6, y: y + layout.cellHeight / 2 + 4, 'text-anchor': 'end', fill: MUTED }));

    row.cells.forEach((cell, m) => {
      const x = layout.gridX + m * step;
      const box = { x, y, width: layout.cellWidth, height: layout.cellHeight, rx: 2 };
      const group = svg(doc, 'g', {
        class: 'cal-cell',
        'data-idx': cell.monthIdx,
        'data-status': cell.status,
        role: cell.status === 'nodata' ? 'img' : 'button',
        'aria-label': describeCell(cell, lang).join('. '),
        'aria-pressed': cell.status === 'nodata' ? null : String(cell.selected),
      });
      group.append(svg(doc, 'rect', { ...box, fill: cell.fill }));
      if (cell.hatched) {
        group.append(svg(doc, 'rect', { ...box, class: 'cal-hatch', fill: `url(#${prefix}-${cell.status === 'nodata' ? 'nodata' : 'hatch'})` }));
      }
      if (cell.status === 'nodata') {
        group.append(svg(doc, 'rect', { ...box, fill: 'none', stroke: LINE, 'stroke-width': 1, 'stroke-dasharray': '2 2' }));
      } else if (layout.showNumbers) {
        const text = label(doc, cell.label, {
          x: x + layout.cellWidth / 2,
          y: y + layout.cellHeight / 2 + 3.5,
          'text-anchor': 'middle',
          'font-size': 10.5,
          fill: cell.ink,
          class: 'cal-number',
        });
        if (cell.hatched) {
          // A halo keeps the number readable over the hatching.
          text.setAttribute('stroke', cell.ink === '#000000' ? '#ffffff' : '#000000');
          text.setAttribute('stroke-width', '2.5');
          text.setAttribute('stroke-opacity', '0.55');
          text.setAttribute('paint-order', 'stroke');
        }
        group.append(text);
      }
      if (cell.selected) {
        group.append(svg(doc, 'rect', { x: x - 1, y: y - 1, width: layout.cellWidth + 2, height: layout.cellHeight + 2, rx: 3, fill: 'none', stroke: INK, 'stroke-width': 2.5, class: 'cal-selected' }));
      }
      rowGroup.append(group);
    });

    // The year total: a bar and its number.
    const barLength = model.maxTotal > 0 ? (row.total / model.maxTotal) * barRoom : 0;
    const bar = { x: layout.barsX, y: y + 3, width: Math.max(barLength, row.total > 0 ? 1 : 0), height: layout.cellHeight - 6 };
    rowGroup.append(svg(doc, 'rect', { ...bar, fill: row.complete ? BAR : BAR_LIGHT, class: 'cal-bar' }));
    if (!row.complete && bar.width > 0) rowGroup.append(svg(doc, 'rect', { ...bar, fill: `url(#${prefix}-hatch)` }));
    rowGroup.append(label(doc, row.totalLabel, { x: layout.barsX + bar.width + 4, y: y + layout.cellHeight / 2 + 4, 'font-size': 10.5 }));
    body.append(rowGroup);
    y += layout.cellHeight + layout.gap;

    if (model.divider && row.year === model.divider.afterYear) {
      const text = t(lang, model.divider.labelKey);
      const fontSize = textWidth(text, 10) > options.width - 12 ? 8.5 : 10;
      const middle = y + layout.dividerHeight / 2 - layout.gap / 2;
      body.append(
        svg(doc, 'line', { x1: 0, x2: options.width, y1: middle, y2: middle, stroke: INK, 'stroke-width': 1 }),
        label(doc, text, {
          x: options.width / 2,
          y: middle + 3.5,
          'text-anchor': 'middle',
          'font-size': fontSize,
          'font-weight': 600,
          stroke: '#ffffff',
          'stroke-width': 6,
          'paint-order': 'stroke',
          class: 'cal-divider',
        }),
      );
      y += layout.dividerHeight;
    }
  }

  const legendHeight = drawLegend(body, model, options, y + 10, prefix);
  let height = titleHeight + y + 10 + legendHeight;
  if (options.frame) {
    root.append(label(doc, options.frame.footer, { x: 0, y: height + 12, fill: MUTED }));
    height += 22;
    const background = root.querySelector('.frame-background')!;
    background.setAttribute('height', String(height));
    background.setAttribute('fill', '#ffffff');
  }
  root.setAttribute('height', String(Math.ceil(height)));
  root.setAttribute('viewBox', `0 0 ${options.width} ${Math.ceil(height)}`);
  return root;
}

// ---- Drawing: on the page ------------------------------------------------------

export interface CalendarOptions {
  lang: Lang;
  /** The area's name, for the calendar's label and the table's caption. */
  areaName: string;
  /** Width in px. Default: the width of the element, or 720 where there is no layout. */
  width?: number;
  /** Called with the `month_idx` of a cell that was clicked or activated with Enter or Space. */
  onSelect?: (monthIdx: number) => void;
}

function cellOf(target: EventTarget | null): SVGGElement | null {
  return target instanceof Element ? (target.closest('g.cal-cell') as SVGGElement | null) : null;
}

/**
 * Draws the calendar into `element`, replacing what was there. Cells take
 * focus (one tab stop, arrow keys to move), show a tooltip on hover and on
 * focus, and report clicks through `onSelect`. The drawing follows the
 * element's width.
 */
export function renderCalendar(element: HTMLElement, model: CalendarModel, options: CalendarOptions): void {
  drawResponsive(element, (width) => drawCalendar(element, model, options, width), options.width);
}

function drawCalendar(element: HTMLElement, model: CalendarModel, options: CalendarOptions, width: number): void {
  const doc = element.ownerDocument;
  const lang = options.lang;
  const focusedIdx = cellOf(doc.activeElement)?.dataset.idx ?? null;
  const hadFocus = focusedIdx !== null && element.contains(doc.activeElement);

  const drawing = calendarSvg(doc, model, { lang, width, idPrefix: element.id || 'calendar' });
  drawing.setAttribute('role', 'group');
  const firstYear = model.rows[0]?.year ?? FIRST_YEAR;
  const lastYear = model.rows[model.rows.length - 1]?.year ?? firstYear;
  drawing.setAttribute('aria-label', t(lang, 'calendar.label', { area: options.areaName, from: firstYear, to: lastYear }));
  drawing.classList.add('calendar-svg');

  const tooltip = h(doc, 'div', { class: 'cal-tooltip', role: 'tooltip', hidden: true });
  const children: Node[] = [drawing, tooltip];
  if (model.empty) children.unshift(h(doc, 'p', { class: 'calendar-empty' }, t(lang, 'calendar.empty')));
  element.replaceChildren(...children);

  // One tab stop: the selected month, or else the latest month with data.
  const cells = Array.from(drawing.querySelectorAll<SVGGElement>('g.cal-cell[role="button"]'));
  const start = cells.find((cell) => cell.getAttribute('aria-pressed') === 'true') ?? cells[cells.length - 1];
  for (const cell of cells) cell.setAttribute('tabindex', cell === start ? '0' : '-1');

  const cellByIdx = (idx: number) => cells.find((cell) => cell.dataset.idx === String(idx)) ?? null;

  // A frame around each year's twelve months, shown by the stylesheet while that year is pointed at
  // here or in the yearly totals (class `linked` on the row). On screen only: the PNG has none.
  for (const row of drawing.querySelectorAll<SVGGElement>('g.cal-row')) {
    const boxes = Array.from(row.querySelectorAll<SVGRectElement>('g.cal-cell > rect:first-child'));
    if (boxes.length === 0) continue;
    const number = (box: SVGRectElement, name: string) => Number(box.getAttribute(name));
    const first = boxes[0];
    const last = boxes[boxes.length - 1];
    row.append(
      svg(doc, 'rect', {
        x: number(first, 'x') - 2,
        y: number(first, 'y') - 2,
        width: number(last, 'x') + number(last, 'width') - number(first, 'x') + 4,
        height: number(first, 'height') + 4,
        rx: 3,
        fill: 'none',
        stroke: HIGHLIGHT,
        'stroke-width': 1.5,
        class: 'cal-row-mark',
        'pointer-events': 'none',
      }),
    );
  }
  const cellData = new Map(model.rows.flatMap((row) => row.cells).map((cell) => [String(cell.monthIdx), cell]));

  const hideTooltip = () => {
    tooltip.hidden = true;
  };
  const showTooltip = (cell: SVGGElement) => {
    const data = cellData.get(cell.dataset.idx ?? '');
    if (!data) return;
    const [head, ...rest] = describeCell(data, lang);
    tooltip.replaceChildren(h(doc, 'strong', {}, head), ...rest.map((line) => h(doc, 'span', {}, line)));
    tooltip.hidden = false;
    // Above the cell, or below it when there is no room; kept inside the calendar's width.
    const box = element.getBoundingClientRect();
    const at = cell.getBoundingClientRect();
    const half = tooltip.offsetWidth / 2;
    const center = at.left - box.left + at.width / 2;
    const left = Math.min(Math.max(center, half), Math.max(half, box.width - half));
    const above = at.top - tooltip.offsetHeight - 8 >= 0;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${above ? at.top - box.top - tooltip.offsetHeight - 6 : at.bottom - box.top + 6}px`;
  };

  drawing.addEventListener('click', (event) => {
    const cell = cellOf(event.target);
    if (cell?.getAttribute('role') === 'button') options.onSelect?.(Number(cell.dataset.idx));
  });
  drawing.addEventListener('pointerover', (event) => {
    const cell = cellOf(event.target);
    if (cell) showTooltip(cell);
  });
  drawing.addEventListener('pointerout', (event) => {
    if (cellOf(event.target) !== cellOf((event as PointerEvent).relatedTarget)) hideTooltip();
  });
  drawing.addEventListener('focusin', (event) => {
    const cell = cellOf(event.target);
    if (cell) showTooltip(cell);
  });
  drawing.addEventListener('focusout', hideTooltip);
  drawing.addEventListener('keydown', (event) => {
    const cell = cellOf(event.target);
    if (!cell) return;
    const idx = Number(cell.dataset.idx);
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -12, ArrowDown: 12 };
    if (event.key in moves) {
      const next = cellByIdx(idx + moves[event.key]);
      if (next) {
        cell.setAttribute('tabindex', '-1');
        next.setAttribute('tabindex', '0');
        next.focus();
      }
      event.preventDefault();
    } else if (event.key === 'Enter' || event.key === ' ') {
      options.onSelect?.(idx);
      event.preventDefault();
    } else if (event.key === 'Escape') {
      hideTooltip();
    }
  });

  // Redrawing must not drop the keyboard user's place.
  if (hadFocus) {
    const again = cellByIdx(Number(focusedIdx));
    if (again) {
      for (const cell of cells) cell.setAttribute('tabindex', cell === again ? '0' : '-1');
      again.focus();
    }
  }
}

// ---- Drawing: table ------------------------------------------------------------

/** The same numbers as an HTML table, for screen readers and for copying. */
export function renderTable(element: HTMLElement, model: CalendarModel, options: Pick<CalendarOptions, 'lang' | 'areaName'>): void {
  const doc = element.ownerDocument;
  const lang = options.lang;
  const number = (value: number) => countText(value, lang);
  const months = Array.from({ length: 12 }, (_, m) => capitalize(t(lang, `months.short.${m}`), lang));

  const head = h(
    doc,
    'tr',
    {},
    h(doc, 'th', { scope: 'col' }, t(lang, 'calendar.year')),
    ...months.map((month) => h(doc, 'th', { scope: 'col' }, month)),
    h(doc, 'th', { scope: 'col' }, t(lang, 'calendar.yearTotal')),
  );

  const marks: Record<CellStatus, { mark: string; spoken: string } | null> = {
    complete: null,
    incomplete: { mark: '*', spoken: t(lang, 'calendar.srIncomplete') },
    partial: { mark: '†', spoken: t(lang, 'calendar.srPartial') },
    nodata: { mark: '–', spoken: t(lang, 'calendar.srNodata') },
  };
  const used = new Set<CellStatus>();

  const body = model.rows.map((row) =>
    h(
      doc,
      'tr',
      {},
      h(doc, 'th', { scope: 'row' }, String(row.year)),
      ...row.cells.map((cell) => {
        const note = marks[cell.status];
        if (note) used.add(cell.status);
        const ratio = cell.assessment?.ratio;
        const parts: Array<Node | string | null> = [
          cell.status === 'nodata' ? null : number(cell.value),
          model.mode === 'anomaly' && cell.status !== 'nodata' && ratio !== null && ratio !== undefined
            ? ` (${formatNumber(lang, ratio, 1, 1)}×)`
            : null,
          note ? h(doc, 'span', { 'aria-hidden': true }, cell.status === 'nodata' ? note.mark : ` ${note.mark}`) : null,
          note ? h(doc, 'span', { class: 'visually-hidden' }, ` (${note.spoken})`) : null,
        ];
        return h(doc, 'td', { 'data-status': cell.status }, ...parts);
      }),
      h(doc, 'td', {}, number(row.total)),
    ),
  );

  const notes: string[] = [];
  if (used.has('incomplete')) notes.push(t(lang, 'calendar.notes.incomplete'));
  if (used.has('partial')) notes.push(tCount(lang, 'calendar.notes.partial', model.partialDay ?? 0));
  if (used.has('nodata')) notes.push(t(lang, 'calendar.notes.nodata'));

  const caption = t(lang, model.view === 'raw' ? 'calendar.caption.raw' : 'calendar.caption.harmonized', {
    area: options.areaName,
  });
  const table = h(
    doc,
    'div',
    { class: 'table-scroll', tabindex: 0, role: 'region', 'aria-label': caption },
    h(doc, 'table', { class: 'cal-table' }, h(doc, 'caption', {}, caption), h(doc, 'thead', {}, head), h(doc, 'tbody', {}, ...body)),
  );
  element.replaceChildren(table);
  if (notes.length > 0) element.append(h(doc, 'p', { class: 'hint table-notes' }, notes.join(' · ')));
}
