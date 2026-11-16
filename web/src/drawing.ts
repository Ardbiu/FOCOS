// Shared pieces of the SVG drawings (calendar and charts): colours, text,
// hatching, a flowing legend, and redrawing when the container's width changes.
//
// Every colour and font is set as an attribute, never through the stylesheet,
// so a drawing can be saved as a picture and look the same.

import { svg } from './dom';

export const INK = '#1c1b19';
export const MUTED = '#5d5a53';
export const LINE = '#b9b5ab';
export const BAR = '#55524b';
export const BAR_LIGHT = '#8d8a82';
export const BAND = '#dcd9d0';
/** The colour of the selected year's line and of the hotspot dots on the map. */
export const HIGHLIGHT = '#b2182b';
/** The colour of the fitted trend line over the yearly totals: the page's accent. */
export const TREND = '#1f4e79';
/** The series stitched without harmonizing, and the harmonized one (method page and intro). */
export const RAW_COLOR = '#c65102';
export const HARMONIZED_COLOR = '#1f6fb5';
export const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/** Rough width of a text in px; SVG cannot measure before it is on screen. */
export function textWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.56;
}

/** Breaks a text into lines that fit `maxWidth`, by the same rough measure. */
export function wrapText(text: string, fontSize: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const longer = line ? `${line} ${word}` : word;
    if (line && textWidth(longer, fontSize) > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = longer;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** A text element in the drawings' font; 11 px ink unless the attributes say otherwise. */
export function label(owner: Node, text: string, attributes: Record<string, string | number>): SVGTextElement {
  return svg(owner, 'text', { 'font-family': FONT, 'font-size': 11, fill: INK, ...attributes }, text);
}

/**
 * Hatch patterns. `{prefix}-hatch` lies over a coloured mark (an incomplete or
 * partial month or year); `{prefix}-nodata` fills a month without data.
 */
export function hatchPatterns(owner: Node, prefix: string): SVGDefsElement {
  const stripes = (id: string, light: string, dark: string) =>
    svg(
      owner,
      'pattern',
      { id, patternUnits: 'userSpaceOnUse', width: 6, height: 6, patternTransform: 'rotate(45)' },
      svg(owner, 'line', { x1: 1.5, y1: 0, x2: 1.5, y2: 6, stroke: light, 'stroke-width': 2 }),
      svg(owner, 'line', { x1: 4.5, y1: 0, x2: 4.5, y2: 6, stroke: dark, 'stroke-width': 1 }),
    );
  return svg(
    owner,
    'defs',
    {},
    stripes(`${prefix}-hatch`, 'rgba(255,255,255,0.8)', 'rgba(0,0,0,0.55)'),
    stripes(`${prefix}-nodata`, 'rgba(255,255,255,0)', 'rgba(0,0,0,0.28)'),
  );
}

/** One entry of a legend: a small drawing (12 px high, `width` px wide) and its text. */
export interface LegendEntry {
  text: string;
  width: number;
  draw(parent: SVGElement, x: number, y: number): void;
}

/**
 * Lays legend entries out from (0, y), left to right, starting a new line when
 * the width runs out. Returns the height used.
 */
export function flowLegend(parent: SVGElement, entries: LegendEntry[], y: number, width: number): number {
  const lineHeight = 18;
  let x = 0;
  let top = y;
  for (const entry of entries) {
    const needed = entry.width + 5 + textWidth(entry.text, 11) + 16;
    if (x > 0 && x + needed > width) {
      x = 0;
      top += lineHeight;
    }
    entry.draw(parent, x, top);
    parent.append(label(parent, entry.text, { x: x + entry.width + 5, y: top + 10 }));
    x += needed;
  }
  return top + lineHeight - y;
}

interface Responsive {
  draw: (width: number) => void;
  width: number;
  observer: ResizeObserver | null;
}

const responsive = new WeakMap<HTMLElement, Responsive>();

/**
 * Calls `draw` with the element's width, now and again whenever that width
 * changes. With `fixedWidth` it draws once at that width. Where there is no
 * layout (tests) the width is 720.
 */
export function drawResponsive(element: HTMLElement, draw: (width: number) => void, fixedWidth?: number): void {
  const width = fixedWidth ?? (element.clientWidth || 720);
  const entry: Responsive = { draw, width, observer: responsive.get(element)?.observer ?? null };
  responsive.set(element, entry);
  draw(width);
  if (!entry.observer && fixedWidth === undefined && typeof ResizeObserver !== 'undefined') {
    entry.observer = new ResizeObserver(() => {
      const current = responsive.get(element);
      const now = element.clientWidth;
      if (!current || now <= 0 || Math.abs(now - current.width) < 1) return;
      current.width = now;
      current.draw(now);
    });
    entry.observer.observe(element);
  }
}
