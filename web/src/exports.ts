// Downloads (plan section 6.6): the hotspots CSV, the calendar CSV and the
// calendar as a PNG, plus the hotspots of one month as dots for the map.
//
// Hotspots come from the 1 degree point tiles. An area that touches more than
// 80 of them is refused before anything is fetched, and a tile that fails to
// load is named in the result, so the page can say so and offer a retry.

import type { CalendarModel } from './calendar';
import { DataError, isoDate, loadTile, confidenceText, satCode, satelliteName, dayNumber, type Meta, type TilePoints } from './data';
import { shapeMatcher, tilesForShape, type Shape } from './geo';
import { formatNumber, t, type Lang } from './i18n';
import { monthOfIdx, seriesCarriers, viirsSatellites, yearOfIdx } from './stats';
import type { Area } from './state';

/** The columns of the hotspots CSV, pinned by the plan. */
export const HOTSPOT_COLUMNS = [
  'latitude',
  'longitude',
  'local_date',
  'daynight',
  'satellite',
  'instrument',
  'confidence',
  'frp_mw',
  'in_harmonized_series',
  'modis_equivalent_weight',
] as const;

/** The columns of the calendar CSV, pinned by the plan. */
export const CALENDAR_COLUMNS = [
  'year',
  'month',
  'modis_equivalent_hotspots',
  'baseline_median',
  'ratio_to_median',
  'category',
  'data_complete',
] as const;

/** The most point tiles one request may touch. */
export const MAX_TILES = 80;
/** The most dots drawn on the map for one month. */
export const MAX_DOTS = 20000;
/** Where the app is published; written into the CSV headers. */
export const SITE_URL = 'https://ardbiu.github.io/FOCOS/';
/** The source code, named in the CSV header beside the site. */
export const REPO_URL = 'https://github.com/Ardbiu/FOCOS';
const CSV_TYPE = 'text/csv;charset=utf-8';
const TILES_AT_ONCE = 4;

/** What the downloads need to know besides the data itself. */
export interface ExportInfo {
  /** The area as the page names it. */
  areaName: string;
  /** The area as a part of a file name; see areaSlug(). */
  areaSlug: string;
  /** True for a drawn shape or a circle, whose calendar is summed on the grid and not from the detections. */
  drawn: boolean;
  meta: Meta;
  lang: Lang;
}

/** The area is too large: it touches more point tiles than the limit. Nothing was fetched. */
export interface TooLarge {
  status: 'tooLarge';
  tiles: number;
  limit: number;
}

/** A tile could not be loaded. Asking again retries it; tiles that did load are kept. */
export interface TileError {
  status: 'error';
  tileId: string | null;
  message: string;
}

export type HotspotsResult = { status: 'ok'; blob: Blob; fileName: string; rows: number } | TooLarge | TileError;

export type DotsResult =
  /** `count` positions to draw, out of `total` hotspots in the month. */
  | {
      status: 'ok';
      lat: Float64Array;
      lon: Float64Array;
      count: number;
      total: number;
      /** The MODIS-equivalent weights of all `total` detections, summed. */
      weight: number;
    }
  | TooLarge
  | TileError;

/** A file-name part for an area: `cordoba`, `argentina`, `drawn-area`, `circle_-31.4_-64.2_25km`. */
export function areaSlug(area: Area, name: string | null): string {
  if (area.kind === 'circle') return `circle_${area.lat}_${area.lon}_${area.km}km`;
  if (area.kind === 'polygon' || name === null) return 'drawn-area';
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---- Point tiles -----------------------------------------------------------------

/** The existing point tiles a shape touches, or how many when there are more than the limit. */
function tilesOf(shape: Shape, meta: Pick<Meta, 'tiles'>, limit = MAX_TILES): string[] | TooLarge {
  const existing = new Set(meta.tiles);
  const tiles = tilesForShape(shape).filter((id) => existing.has(id));
  return tiles.length > limit ? { status: 'tooLarge', tiles: tiles.length, limit } : tiles;
}

/** Loads tiles a few at a time, in order. Stops at the first that fails and names it. */
async function loadTiles(ids: string[]): Promise<TilePoints[] | TileError> {
  const loaded: TilePoints[] = new Array(ids.length);
  let next = 0;
  let failure: TileError | null = null;
  const worker = async () => {
    while (failure === null && next < ids.length) {
      const index = next++;
      try {
        loaded[index] = await loadTile(ids[index]);
      } catch (error) {
        const tileId = error instanceof DataError ? (error.tileId ?? ids[index]) : ids[index];
        failure ??= { status: 'error', tileId, message: error instanceof Error ? error.message : String(error) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(TILES_AT_ONCE, ids.length) }, worker));
  return failure ?? loaded;
}

// ---- CSV -------------------------------------------------------------------------

/** The `#` lines both CSVs share: area, range, data-through date, calibration, typical error, source, site. */
function metadata(title: string, range: string, info: ExportInfo): string[] {
  const { meta, lang } = info;
  const years = (pair: [number, number]) => `${pair[0]}-${pair[1]}`;
  return [
    title,
    t(lang, 'csv.area', { area: info.areaName }),
    range,
    t(lang, 'csv.dataThrough', { date: meta.data_end_date }),
    t(lang, 'csv.calibration', {
      candidate: meta.calibration.candidate,
      train: years(meta.calibration.train_years),
      test: years(meta.calibration.test_years),
    }),
    t(lang, 'csv.typicalError', { error: formatNumber(lang, meta.typical_error_pct) }),
    t(lang, 'csv.source', { viirs: viirsSatellites(seriesCarriers(meta)).join(', ') }),
    t(lang, 'csv.site', { url: SITE_URL }),
    t(lang, 'csv.code', { repo: REPO_URL }),
  ];
}

function comments(lines: string[]): string {
  return lines.map((line) => `# ${line}\n`).join('');
}

/**
 * The hotspots of a shape between two local dates (inclusive), one row per
 * detection: every cleaned Aqua and VIIRS row, with a flag and a weight that
 * say what it adds to the harmonized series.
 */
export async function hotspotsCsv(
  shape: Shape,
  from: string,
  to: string,
  info: ExportInfo,
  options: { maxTiles?: number } = {},
): Promise<HotspotsResult> {
  const ids = tilesOf(shape, info.meta, options.maxTiles);
  if (!Array.isArray(ids)) return ids;
  const tiles = await loadTiles(ids);
  if (!Array.isArray(tiles)) return tiles;

  const { lang } = info;
  const parts: string[] = [
    comments([
      ...metadata(t(lang, 'csv.hotspotsTitle'), t(lang, 'csv.dateRange', { from, to }), info),
      // Only for a province does the sum of the weights equal the calendar's count.
      t(lang, info.drawn ? 'csv.weightDrawn' : 'csv.weight'),
    ]),
    `${HOTSPOT_COLUMNS.join(',')}\n`,
  ];

  const inside = shapeMatcher(shape);
  const firstDay = dayNumber(from);
  const lastDay = dayNumber(to);
  const dates = new Map<number, string>();
  const names = new Map<number, string>();
  let rows = 0;
  for (const tile of tiles) {
    const lines: string[] = [];
    for (let i = 0; i < tile.count; i++) {
      const day = tile.day[i];
      if (day < firstDay || day > lastDay || !inside(tile.lon[i], tile.lat[i])) continue;
      let date = dates.get(day);
      if (date === undefined) dates.set(day, (date = isoDate(day)));
      let name = names.get(tile.sat[i]);
      if (name === undefined) {
        const { satellite, instrument } = satelliteName(satCode(tile.sat[i]));
        names.set(tile.sat[i], (name = `${satellite},${instrument}`));
      }
      lines.push(
        `${tile.lat[i].toFixed(5)},${tile.lon[i].toFixed(5)},${date},${tile.night[i] ? 'N' : 'D'},${name},` +
          `${confidenceText(tile.conf[i])},${tile.frp[i].toFixed(1)},${tile.s[i]},${tile.w[i].toFixed(6)}\n`,
      );
    }
    rows += lines.length;
    parts.push(lines.join(''));
  }
  return {
    status: 'ok',
    blob: new Blob(parts, { type: CSV_TYPE }),
    fileName: `focos_hotspots_${info.areaSlug}_${from}_${to}.csv`,
    rows,
  };
}

/** A number for a CSV cell: up to two decimals, no trailing zeros. */
function plain(value: number): string {
  return String(Number(value.toFixed(2)));
}

/**
 * The calendar as a CSV: one row per month with data in the years shown.
 * Always the harmonized series, whatever view the page is in.
 */
export function calendarCsv(model: CalendarModel, info: ExportInfo): { blob: Blob; fileName: string } {
  if (model.view !== 'harmonized') throw new Error('The calendar CSV is written from the harmonized series');
  const { lang } = info;
  const cells = model.rows.flatMap((row) => row.cells).filter((cell) => cell.status !== 'nodata');
  const month = (idx: number) => `${yearOfIdx(idx)}-${String(monthOfIdx(idx)).padStart(2, '0')}`;
  const firstYear = model.rows[0]?.year ?? 0;
  const lastYear = model.rows[model.rows.length - 1]?.year ?? firstYear;
  const range =
    cells.length > 0
      ? t(lang, 'csv.monthRange', { from: `${firstYear}-01`, to: month(cells[cells.length - 1].monthIdx) })
      : t(lang, 'csv.monthRange', { from: firstYear, to: lastYear });

  const lines = cells.map((cell) => {
    const assessed = cell.assessment;
    const compared = cell.status !== 'incomplete' && assessed?.baseline != null;
    const hasRatio = compared && !assessed!.rare && assessed!.ratio !== null && Number.isFinite(assessed!.ratio);
    return [
      cell.year,
      cell.month,
      plain(cell.value),
      compared ? plain(assessed!.baseline!.median) : '',
      hasRatio ? assessed!.ratio!.toFixed(2) : '',
      !compared ? '' : hasRatio ? (assessed!.category ?? '') : 'rare',
      cell.status === 'complete',
    ].join(',');
  });

  const text =
    comments([...metadata(t(lang, 'csv.calendarTitle'), range, info), t(lang, 'csv.category')]) +
    `${CALENDAR_COLUMNS.join(',')}\n` +
    lines.map((line) => `${line}\n`).join('');
  return {
    blob: new Blob([text], { type: CSV_TYPE }),
    fileName: `focos_calendar_${info.areaSlug}_${firstYear}_${lastYear}.csv`,
  };
}

// ---- Dots for the map ------------------------------------------------------------

/**
 * The positions of one month's hotspots inside a shape: the detections that
 * make up that calendar cell (the in-series rows). Above `limit` they are
 * thinned evenly, so the dots still cover the whole area.
 */
export async function monthDots(
  shape: Shape,
  monthIdx: number,
  meta: Pick<Meta, 'tiles'>,
  options: { limit?: number; maxTiles?: number } = {},
): Promise<DotsResult> {
  const ids = tilesOf(shape, meta, options.maxTiles);
  if (!Array.isArray(ids)) return ids;
  const tiles = await loadTiles(ids);
  if (!Array.isArray(tiles)) return tiles;

  const year = yearOfIdx(monthIdx);
  const month = monthOfIdx(monthIdx);
  const firstDay = Date.UTC(year, month - 1, 1) / 86_400_000;
  const lastDay = Date.UTC(year, month, 0) / 86_400_000;
  const inside = shapeMatcher(shape);
  const lats: number[] = [];
  const lons: number[] = [];
  let weight = 0;
  for (const tile of tiles) {
    for (let i = 0; i < tile.count; i++) {
      if (tile.s[i] !== 1 || tile.day[i] < firstDay || tile.day[i] > lastDay) continue;
      if (!inside(tile.lon[i], tile.lat[i])) continue;
      lats.push(tile.lat[i]);
      lons.push(tile.lon[i]);
      weight += tile.w[i];
    }
  }

  const total = lats.length;
  const count = Math.min(total, options.limit ?? MAX_DOTS);
  const lat = new Float64Array(count);
  const lon = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const pick = count === total ? i : Math.floor((i * total) / count);
    lat[i] = lats[pick];
    lon[i] = lons[pick];
  }
  return { status: 'ok', lat, lon, count, total, weight };
}

// ---- PNG and saving ----------------------------------------------------------------

/** An SVG element as a standalone document, ready to be drawn as an image. */
export function svgMarkup(drawing: SVGSVGElement): string {
  const copy = drawing.cloneNode(true) as SVGSVGElement;
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return new XMLSerializer().serializeToString(copy);
}

/**
 * Draws an SVG (with its width and height set, and all styles inline) onto a
 * canvas at twice its size and returns it as a PNG.
 */
export function calendarPng(drawing: SVGSVGElement): Promise<Blob> {
  const width = Number(drawing.getAttribute('width'));
  const height = Number(drawing.getAttribute('height'));
  const doc = drawing.ownerDocument;
  const scale = 2;
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = doc.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const context = canvas.getContext('2d');
      if (!context) {
        reject(new Error('This browser cannot draw on a canvas'));
        return;
      }
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The canvas gave no picture'))), 'image/png');
    };
    image.onerror = () => reject(new Error('The calendar could not be drawn as a picture'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup(drawing))}`;
  });
}

/** Hands a file to the browser to save. */
export function downloadBlob(doc: Document, blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = fileName;
  link.hidden = true;
  doc.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
