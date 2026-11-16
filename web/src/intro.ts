// The intro: a page over the app, shown the first time someone opens the plain
// address. Going in (the button, or Escape) is remembered in the browser, so
// the next visit opens straight on the app. A link to a particular view (a
// story, a shared area) goes straight to it. The app loads underneath meanwhile,
// so going in is instant; its text and chart are filled by the app (app.ts).

import { scaleLinear } from 'd3';
import { svg } from './dom';
import { formatNumber, t, type Lang } from './i18n';
import { FONT, HARMONIZED_COLOR, INK, LINE, MUTED, RAW_COLOR, textWidth } from './drawing';

export const INTRO_SEEN_KEY = 'focos.introSeen';

/** The part of `localStorage` the intro uses. */
export interface IntroStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser's storage, or `null` where the browser refuses it. */
export function browserStorage(win: Window): IntroStorage | null {
  try {
    return win.localStorage;
  } catch {
    return null;
  }
}

function seen(storage: IntroStorage | null): boolean {
  try {
    return storage?.getItem(INTRO_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** True on a first visit to the plain address (the language may be set); false once seen or for a link to a view. */
export function introWanted(hash: string, storage: IntroStorage | null): boolean {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  for (const key of params.keys()) if (key !== 'lang') return false;
  return !seen(storage);
}

export interface Intro {
  readonly open: boolean;
  show(): void;
  close(): void;
  destroy(): void;
}

export function startIntro(doc: Document, storage: IntroStorage | null): Intro {
  const win = doc.defaultView!;
  const box = doc.getElementById('intro');
  const enter = doc.getElementById('intro-enter');
  const reopen = doc.getElementById('intro-reopen');
  let open = false;

  /** The page's own parts, which cannot be reached while the intro covers them. */
  const pageParts = () => [...doc.body.children].filter((child) => child !== box && child.tagName !== 'SCRIPT');

  function show(): void {
    if (!box) return;
    open = true;
    box.hidden = false;
    doc.documentElement.classList.add('intro-open');
    for (const part of pageParts()) part.setAttribute('inert', '');
    box.scrollTop = 0;
    enter?.focus({ preventScroll: true });
    // The app draws the chart at the width it is shown at.
    doc.dispatchEvent(new Event('intro-shown'));
  }

  function close(): void {
    if (!box || !open) return;
    open = false;
    box.hidden = true;
    doc.documentElement.classList.remove('intro-open');
    for (const part of pageParts()) part.removeAttribute('inert');
    try {
      storage?.setItem(INTRO_SEEN_KEY, '1');
    } catch {
      // The browser keeps nothing: the intro shows again next time, which does no harm.
    }
    doc.getElementById('results')?.focus({ preventScroll: true });
  }

  const onKey = (event: KeyboardEvent) => {
    if (open && event.key === 'Escape') close();
  };
  const onReopen = (event: Event) => {
    event.preventDefault();
    show();
  };

  enter?.addEventListener('click', close);
  reopen?.addEventListener('click', onReopen);
  doc.addEventListener('keydown', onKey);

  if (introWanted(win.location.hash, storage)) show();

  return {
    get open() {
      return open;
    },
    show,
    close,
    destroy() {
      enter?.removeEventListener('click', close);
      reopen?.removeEventListener('click', onReopen);
      doc.removeEventListener('keydown', onKey);
    },
  };
}

// ---- The chart ---------------------------------------------------------------------

export interface IntroYear {
  year: number;
  /** Hotspots stitched without harmonizing: MODIS, then VIIRS as it counts. */
  raw: number;
  /** MODIS-equivalent hotspots. */
  harmonized: number;
}

/** The drawing's width when the box has none yet (hidden, or not laid out). */
const DEFAULT_WIDTH = 640;
const HEIGHT = 220;
const TOP = 22;
const BOTTOM = 22;
const RIGHT = 4;

/**
 * Yearly hotspots, stitched and harmonized, as two bars per year on one scale:
 * the stitched count jumps when VIIRS takes over; the harmonized one does not.
 */
export function drawIntroChart(box: HTMLElement, years: IntroYear[], switchYear: number, lang: Lang): void {
  box.replaceChildren();
  if (years.length === 0) return;
  const doc = box.ownerDocument;
  // Drawn at the width it is shown at, so its text keeps its size on a phone.
  const WIDTH = Math.max(280, Math.min(900, box.clientWidth || DEFAULT_WIDTH));
  const first = years[0].year;
  const last = years[years.length - 1].year;
  const top = Math.max(...years.map((row) => Math.max(row.raw, row.harmonized)), 1);
  const y = scaleLinear().domain([0, top]).nice(4).range([HEIGHT - BOTTOM, TOP]);
  const label = { 'font-family': FONT, 'font-size': 12, fill: MUTED };
  // The axis in short numbers (400K, 400 mil), and room on the left for the longest.
  const short = new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 0 });
  const ticks = y.ticks(4);
  const LEFT = Math.ceil(Math.max(...ticks.map((tick) => textWidth(short.format(tick), 12)))) + 10;
  const band = (WIDTH - LEFT - RIGHT) / years.length;
  const barWidth = Math.max(2, band * 0.62);
  const x = (year: number) => LEFT + (year - first) * band + (band - barWidth) / 2;
  const count = (value: number) => formatNumber(lang, Math.round(value));

  const drawing = svg(doc, 'svg', {
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    role: 'img',
    'aria-label': t(lang, 'intro.chartLabel', { from: first, to: last }),
    class: 'intro-drawing',
  });

  for (const tick of ticks) {
    drawing.append(
      svg(doc, 'line', { x1: LEFT, x2: WIDTH - RIGHT, y1: y(tick), y2: y(tick), stroke: tick === 0 ? LINE : '#e7e4dc', 'stroke-width': 1 }),
      svg(doc, 'text', { ...label, x: LEFT - 6, y: y(tick) + 4, 'text-anchor': 'end' }, short.format(tick)),
    );
  }

  for (const row of years) {
    const group = svg(
      doc,
      'g',
      {},
      svg(doc, 'title', {}, t(lang, 'intro.bar', { year: row.year, raw: count(row.raw), harmonized: count(row.harmonized) })),
    );
    for (const [value, kind, fill] of [
      [row.raw, 'intro-bar-raw', RAW_COLOR],
      [row.harmonized, 'intro-bar-focos', HARMONIZED_COLOR],
    ] as const) {
      group.append(
        svg(doc, 'rect', { class: kind, x: x(row.year), y: y(value), width: barWidth, height: y(0) - y(value), fill }),
      );
    }
    drawing.append(group);
  }

  if (switchYear > first && switchYear <= last) {
    const at = LEFT + (switchYear - first) * band;
    drawing.append(
      svg(doc, 'line', { x1: at, x2: at, y1: TOP - 14, y2: HEIGHT - BOTTOM, stroke: MUTED, 'stroke-width': 1, 'stroke-dasharray': '3 3' }),
      svg(doc, 'text', { ...label, fill: INK, x: at + 5, y: TOP - 6 }, t(lang, 'yearly.switch', { year: switchYear })),
    );
  }

  // The first and last years sit flush with the ends of the axis, so neither is cut off.
  for (const year of new Set([first, switchYear, last])) {
    if (year < first || year > last) continue;
    const [at, anchor] =
      year === first ? [x(year), 'start'] : year === last ? [x(year) + barWidth, 'end'] : [x(year) + barWidth / 2, 'middle'];
    drawing.append(svg(doc, 'text', { ...label, x: at, y: HEIGHT - 6, 'text-anchor': anchor }, String(year)));
  }

  box.append(drawing);
}
