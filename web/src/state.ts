// The state of the page and its form in the address (plan section 6.7), so a
// link restores the area, the dates, the mode, the view, the language and the
// selected month.
//
//   #area=prov:14&years=2015-2025&from=2020-01-01&to=2020-12-31
//    &mode=anomaly&view=raw&lang=es&sel=2020-08
//
// Parts at their default value are left out, so the national view has an empty
// hash. Anything malformed falls back to its default.

import { MONTH_COUNT, type Layer } from './data';
import type { Lang } from './i18n';
import { FIRST_YEAR, monthIdx, monthOfIdx, yearOfIdx } from './stats';

/** A position as GeoJSON writes it: [lon, lat]. */
export type LonLat = [number, number];

export type Area =
  /** A province by its Georef id, or the whole country (`AR`). */
  | { kind: 'province'; id: string }
  /** A drawn polygon or rectangle: its corners in order, not closed. */
  | { kind: 'polygon'; ring: LonLat[] }
  /** A point and a radius. */
  | { kind: 'circle'; lat: number; lon: number; km: number };

export type Mode = 'count' | 'anomaly';

export interface AppState {
  area: Area;
  /** The rows the calendar shows. */
  yearFrom: number;
  yearTo: number;
  /** The range of the hotspots CSV, `YYYY-MM-DD`; `null` follows the year range. */
  dateFrom: string | null;
  dateTo: string | null;
  mode: Mode;
  view: Layer;
  lang: Lang;
  /** `month_idx` of the selected calendar cell. */
  sel: number | null;
}

/** The id that stands for the whole country, in the address and in summary/provinces.json. */
export const NATION_ID = 'AR';
export const NATION: Area = { kind: 'province', id: NATION_ID };
export const YEAR_MIN = FIRST_YEAR;
export const YEAR_MAX = yearOfIdx(MONTH_COUNT - 1);
export const RADIUS_KM = { min: 5, max: 300, initial: 25 } as const;
const MAX_POLYGON_POINTS = 500;

export function defaultState(): AppState {
  return {
    area: NATION,
    yearFrom: YEAR_MIN,
    yearTo: YEAR_MAX,
    dateFrom: null,
    dateTo: null,
    mode: 'count',
    view: 'harmonized',
    lang: 'en',
    sel: null,
  };
}

export function clampRadius(km: number): number {
  if (!Number.isFinite(km)) return RADIUS_KM.initial;
  return Math.min(RADIUS_KM.max, Math.max(RADIUS_KM.min, km));
}

export function sameArea(a: Area, b: Area): boolean {
  return encodeArea(a) === encodeArea(b);
}

/**
 * The date range of the hotspots CSV: the dates the user picked, or else the
 * range of the year slider, never past the last date with data.
 */
export function csvDates(state: AppState, dataEndDate: string): { from: string; to: string } {
  const picked = state.dateTo ?? `${state.yearTo}-12-31`;
  const to = picked > dataEndDate ? dataEndDate : picked;
  const from = state.dateFrom ?? `${state.yearFrom}-01-01`;
  return { from: from > to ? to : from, to };
}

// ---- Encoding ------------------------------------------------------------------

/** Up to 5 decimals (about 1 m), without trailing zeros. */
function coordinate(value: number): string {
  return String(Number(value.toFixed(5)) + 0);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function encodeArea(area: Area): string {
  if (area.kind === 'province') return `prov:${area.id}`;
  if (area.kind === 'circle') {
    const km = Number(clampRadius(area.km).toFixed(1));
    return `circle:${coordinate(area.lat)},${coordinate(area.lon)},${km}`;
  }
  const points = area.ring.map(([lon, lat]) => `${coordinate(lat)},${coordinate(lon)}`);
  if (points.length > 1 && points[points.length - 1] === points[0]) points.pop(); // a closed ring
  return `poly:${points.join(';')}`;
}

/** The state as a hash, without the leading `#`. */
export function encodeState(state: AppState): string {
  const base = defaultState();
  const parts: string[] = [];
  if (!sameArea(state.area, base.area)) parts.push(`area=${encodeArea(state.area)}`);
  if (state.yearFrom !== base.yearFrom || state.yearTo !== base.yearTo) {
    parts.push(`years=${state.yearFrom}-${state.yearTo}`);
  }
  if (state.dateFrom) parts.push(`from=${state.dateFrom}`);
  if (state.dateTo) parts.push(`to=${state.dateTo}`);
  if (state.mode !== base.mode) parts.push(`mode=${state.mode}`);
  if (state.view !== base.view) parts.push(`view=${state.view}`);
  if (state.lang !== base.lang) parts.push(`lang=${state.lang}`);
  if (state.sel !== null) parts.push(`sel=${yearOfIdx(state.sel)}-${pad2(monthOfIdx(state.sel))}`);
  return parts.join('&');
}

// ---- Decoding ------------------------------------------------------------------

function decodeArea(text: string): Area | null {
  const colon = text.indexOf(':');
  if (colon < 0) return null;
  const kind = text.slice(0, colon);
  const rest = text.slice(colon + 1);

  if (kind === 'prov') return /^(AR|\d{2})$/.test(rest) ? { kind: 'province', id: rest } : null;

  const numbers = (list: string) => list.split(',').map((part) => (part.trim() === '' ? Number.NaN : Number(part)));
  const onEarth = (lat: number, lon: number) =>
    Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

  if (kind === 'circle') {
    const [lat, lon, km] = numbers(rest);
    if (!onEarth(lat, lon)) return null;
    return { kind: 'circle', lat, lon, km: clampRadius(km ?? Number.NaN) };
  }

  if (kind === 'poly') {
    const ring: LonLat[] = [];
    for (const pair of rest.split(';')) {
      const [lat, lon, extra] = numbers(pair);
      if (!onEarth(lat, lon) || extra !== undefined) return null;
      ring.push([lon, lat]);
    }
    const last = ring[ring.length - 1];
    if (ring.length > 1 && last[0] === ring[0][0] && last[1] === ring[0][1]) ring.pop();
    return ring.length >= 3 && ring.length <= MAX_POLYGON_POINTS ? { kind: 'polygon', ring } : null;
  }
  return null;
}

/** A real calendar date from 2003 on, as `YYYY-MM-DD`; otherwise `null`. */
function decodeDate(text: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return real && year >= FIRST_YEAR ? text : null;
}

function decodeSel(text: string): number | null {
  const match = /^(\d{4})-(\d{2})$/.exec(text);
  if (!match) return null;
  const month = Number(match[2]);
  const idx = monthIdx(Number(match[1]), month);
  return month >= 1 && month <= 12 && idx >= 0 && idx < MONTH_COUNT ? idx : null;
}

/** Reads a hash (with or without `#`). Whatever cannot be read keeps its default. */
export function decodeState(hash: string): AppState {
  const state = defaultState();
  const params = new Map<string, string>();
  for (const part of hash.replace(/^#/, '').split('&')) {
    const equals = part.indexOf('=');
    if (equals <= 0) continue;
    try {
      params.set(part.slice(0, equals), decodeURIComponent(part.slice(equals + 1)));
    } catch {
      // A broken percent-escape: skip this part.
    }
  }

  state.area = decodeArea(params.get('area') ?? '') ?? NATION;

  const years = /^(\d{4})-(\d{4})$/.exec(params.get('years') ?? '');
  if (years) {
    const clamp = (year: number) => Math.min(YEAR_MAX, Math.max(YEAR_MIN, year));
    const [a, b] = [clamp(Number(years[1])), clamp(Number(years[2]))];
    state.yearFrom = Math.min(a, b);
    state.yearTo = Math.max(a, b);
  }

  state.dateFrom = decodeDate(params.get('from') ?? '');
  state.dateTo = decodeDate(params.get('to') ?? '');
  if (state.dateFrom && state.dateTo && state.dateFrom > state.dateTo) {
    [state.dateFrom, state.dateTo] = [state.dateTo, state.dateFrom];
  }

  if (params.get('mode') === 'anomaly') state.mode = 'anomaly';
  if (params.get('view') === 'raw') state.view = 'raw';
  if (params.get('lang') === 'es') state.lang = 'es';
  state.sel = decodeSel(params.get('sel') ?? '');
  return state;
}
