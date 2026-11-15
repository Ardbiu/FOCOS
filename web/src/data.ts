// Loaders for every file of the data contract (plan section 5), plus the sums
// over grid cells that turn a drawn area into a series.
//
// All files are fetched relative to the site base, from `data/...`. Each file is
// fetched once and kept; a failed load is not kept, so calling again retries.

import { gunzipSync } from 'fflate';
import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { CELL_COUNT, GRID } from './geo';

/** Number of months in every series: Jan 2003 (index 0) to Nov 2026 (index 286). */
export const MONTH_COUNT = 287;

/** `harmonized` is the sum of weights `w`; `raw` is the count of in-series pixels (section 4.10). */
export type Layer = 'harmonized' | 'raw';

// ---- Shapes of the files -------------------------------------------------------

export interface IncompleteMonth {
  month_idx: number;
  coverage: number;
  /** The sensor that carries the series that month: `A` (Aqua) or `N` (S-NPP). */
  sensor: 'A' | 'N';
}

/** One satellite that carries the harmonized series for a run of months. */
export interface SeriesCarrier {
  /** `A` (Aqua), `N` (S-NPP) or `N20` (NOAA-20). */
  sat: string;
  /** For example `S-NPP VIIRS`. */
  name: string;
  /** First month carried, `YYYY-MM`. */
  from: string;
  /** Last month carried, `YYYY-MM`; `null` for the current carrier. */
  to: string | null;
  /** Typical error of its harmonized values on the test years; `null` for Aqua, the reference. */
  typical_error_pct: number | null;
}

export interface Meta {
  version: number;
  generated_utc: string;
  country: string;
  /** Last local date with data, `YYYY-MM-DD`. Its month is partial unless this is the month's last day. */
  data_end_date: string;
  switch_month: string;
  grid: { lat0: number; lon0: number; cell: number; nlat: number; nlon: number };
  month_count: number;
  calibration: { candidate: string; train_years: [number, number]; test_years: [number, number] };
  typical_error_pct: number;
  naive_error_pct: number;
  /** The carriers in order. Optional: older files have only `switch_month`. See seriesCarriers() in stats.ts. */
  series?: SeriesCarrier[];
  incomplete_months: IncompleteMonth[];
  tiles: string[];
  /** `null` when the data ends on the last day of a month. */
  mtd: { month: number; last_day: number } | null;
  /** The days NOAA-20 carried in place of S-NPP, which delivered no data. Optional: older files lack it. */
  gap_fill?: { sat: string; name: string; days: number; first: string; last: string } | null;
}

/** One entry of summary/provinces.json: the nation (`AR`, first) or a province. */
export interface AreaSummary {
  id: string;
  name: string;
  /** 287 harmonized monthly sums. */
  monthly: number[];
  /** 287 raw monthly counts. */
  raw: number[];
  /** Sums over days 1 to D of the current month, one per year from 2003; empty when there is no partial month. */
  mtd: number[];
}

export type ProvinceShapes = FeatureCollection<Polygon | MultiPolygon, { id: string; name: string }>;

/** One row of validation metrics. `bias` is a fraction (-0.005 is -0.5%); `mape` is in percent. */
export interface ValidationMetrics {
  n: number;
  bias: number;
  mape: number;
  logcorr: number;
}

/** Metrics at the three scales of section 4.7. */
export interface ValidationScales {
  national_month: ValidationMetrics;
  province_month: ValidationMetrics;
  tile_month: ValidationMetrics;
}

/** validation.json: everything the method page draws (pinned by pipeline task D7). */
export interface Validation {
  generated_utc: string;
  /** The frozen calibration candidate, e.g. `C2`. */
  chosen: string;
  m: number;
  train_years: [number, number];
  test_years: [number, number];
  /** Leave-one-year-out score of each candidate on the training years, in percent. */
  loyo: Record<'C0' | 'C1' | 'C2' | 'C3', number>;
  targets: { national_bias_abs_max: number; province_month_mape_max: number; national_month_logcorr_min: number };
  test: { harmonized: ValidationScales; naive: ValidationScales };
  targets_met: { national_bias: boolean; province_month_mape: boolean; national_month_logcorr: boolean };
  peak_month_agreement: { harmonized: number; naive: number; n: number };
  rank_corr: { national_years: number; provinces_test_years: number };
  /** `null` where a sensor has no data that year. */
  yearly_national: Array<{
    year: number;
    aqua: number | null;
    viirs_raw: number | null;
    viirs_harmonized: number | null;
    series: number | null;
    raw_series: number | null;
  }>;
  test_pairs: Array<{
    prov: string;
    name: string;
    year: number;
    month: number;
    aqua: number;
    harmonized: number;
    naive: number;
  }>;
  yearly_ratio: Array<{ year: number; ratio: number }>;
  seam: { months: Array<{ month: string; aqua: number; harmonized: number }>; metrics: ValidationMetrics };
  typical_error_pct: number;
  naive_error_pct: number;
  excluded_days: number;
  /** The partner-agency cross-check of task P1, when there is one. */
  partner_check: unknown | null;
  /** How far each province's harmonized total ran from Aqua's on the test years. */
  province_bias?: ProvinceBias[];
  /** Test-year error by the size of the count; bands `1-4`, `5-19`, `20+`. */
  error_by_count?: Array<{ band: string; n: number; mape: number }>;
  /** Test-year bias by how unusual the month was for Aqua; bands `<0.5x`, `0.5-2x`, `2-5x`, `5-10x`, `10x+`. */
  bias_by_level?: Array<{ band: string; n: number; bias: number; mape: number }>;
  /** National totals of each test year. */
  yearly_test?: Array<{ year: number; aqua: number; harmonized: number; bias: number }>;
  /** ISO dates left out of the comparison. */
  excluded_dates?: string[];
  /** The NOAA-20 carrier's own test (section 4.11). */
  noaa20?: {
    train_years: [number, number];
    test: ValidationScales;
    handover: { years: [number, number]; national_month: ValidationMetrics; province_month: ValidationMetrics };
    typical_error_pct: number;
    province_bias?: ProvinceBias[];
  } | null;
}

/** `bias` is a fraction: 0.68 means the harmonized record ran 68% above Aqua. */
export interface ProvinceBias {
  prov: string;
  name: string;
  aqua: number;
  harmonized: number;
  bias: number;
}

/** A sparse grid file: entry i says cell `cells[i]` holds `values[i]` at month or year `index[i]`. */
export interface SparseGrid {
  count: number;
  cells: Uint32Array;
  values: Float32Array;
  index: Uint16Array;
}

/** Satellite codes of the point tiles, by the number stored in TilePoints.sat. Unknown codes are added as they are met. */
const SAT_CODES = ['A', 'N', 'N20'];
export const SAT_AQUA = 0;
export const SAT_SNPP = 1;
export const SAT_NOAA20 = 2;

/** The satellite code (`A`, `N`, `N20`, ...) behind a number in TilePoints.sat. */
export function satCode(sat: number): string {
  return SAT_CODES[sat] ?? '';
}

function satNumber(code: string): number {
  const known = SAT_CODES.indexOf(code);
  return known >= 0 ? known : SAT_CODES.push(code) - 1;
}

const SATELLITE_NAMES: Record<string, string> = { A: 'Aqua', N: 'S-NPP', N20: 'NOAA-20' };

/**
 * How a satellite code is shown: `Aqua MODIS`, `S-NPP VIIRS`, `NOAA-20 VIIRS`.
 * Every satellite other than Aqua is VIIRS, including codes this app does not know.
 */
export function satelliteName(code: string): { satellite: string; instrument: string; label: string } {
  const satellite = SATELLITE_NAMES[code] ?? code;
  const instrument = code === 'A' ? 'MODIS' : 'VIIRS';
  return { satellite, instrument, label: `${satellite} ${instrument}` };
}
/** S-NPP confidence classes, stored after the 0 to 100 range Aqua uses. */
export const CONF_NOMINAL = 101;
export const CONF_HIGH = 102;

/** The hotspots of one 1 degree tile, one typed column per CSV column. */
export interface TilePoints {
  id: string;
  count: number;
  lat: Float64Array;
  lon: Float64Array;
  /** Local date as a day number; see dayNumber() and isoDate(). */
  day: Int32Array;
  /** 1 for a night detection (`N`), 0 for a day detection (`D`). */
  night: Uint8Array;
  /** SAT_AQUA, SAT_SNPP, SAT_NOAA20 or a later number; satCode() gives the code. */
  sat: Uint8Array;
  /** 0 to 100 for Aqua; CONF_NOMINAL or CONF_HIGH for S-NPP. See confidenceText(). */
  conf: Uint8Array;
  /** Fire radiative power, MW. */
  frp: Float32Array;
  /** 1 when the row is part of the harmonized series. */
  s: Uint8Array;
  /** MODIS-equivalent weight; 0 for rows outside the series. */
  w: Float32Array;
}

/** A data file could not be fetched (`fetch`) or does not follow the contract (`format`). */
export class DataError extends Error {
  readonly kind: 'fetch' | 'format';
  /** Path of the file under `data/`. */
  readonly file: string;
  /** Set when the file is a point tile. */
  readonly tileId?: string;

  constructor(kind: 'fetch' | 'format', file: string, message: string, tileId?: string) {
    super(message);
    this.name = 'DataError';
    this.kind = kind;
    this.file = file;
    this.tileId = tileId;
  }
}

// ---- Dates ---------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/** Days from 1970-01-01 to a `YYYY-MM-DD` date. `NaN` when the text is not a date. */
export function dayNumber(iso: string): number {
  return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / MS_PER_DAY;
}

export function isoDate(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** The confidence as the contract writes it: `0` to `100`, `n` or `h`. */
export function confidenceText(conf: number): string {
  if (conf === CONF_NOMINAL) return 'n';
  if (conf === CONF_HIGH) return 'h';
  return String(conf);
}

// ---- Decoders ------------------------------------------------------------------

/**
 * Decodes a grid file: `uint32 N`, then `N x uint32 cell_id`, `N x float32 value`,
 * `N x uint16 index`, little-endian.
 */
export function decodeGrid(bytes: Uint8Array, file = 'grid'): SparseGrid {
  if (bytes.byteLength < 4) throw new DataError('format', file, `${file} is not a grid file: it is too short`);
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (bytes.byteLength !== 4 + 10 * count) {
    throw new DataError(
      'format',
      file,
      `${file} is not a grid file: ${count} entries need ${4 + 10 * count} bytes, found ${bytes.byteLength}`,
    );
  }
  // Copy each block so the typed arrays are aligned whatever the offset of `bytes`.
  const block = (start: number, length: number) =>
    bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + start + length) as ArrayBuffer;
  return {
    count,
    cells: new Uint32Array(block(4, 4 * count)),
    values: new Float32Array(block(4 + 4 * count, 4 * count)),
    index: new Uint16Array(block(4 + 8 * count, 2 * count)),
  };
}

const TILE_HEADER = 'lat,lon,date,dn,sat,conf,frp,s,w';

/** Parses the text of a point tile (`points/{id}.csv.gz`, already decompressed). */
export function parseTile(id: string, csv: string): TilePoints {
  const file = tilePath(id);
  const lines = csv.split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines[0]?.trim() !== TILE_HEADER) {
    throw new DataError('format', file, `Point tile ${id} does not start with the columns ${TILE_HEADER}`, id);
  }
  const count = lines.length - 1;
  const tile: TilePoints = {
    id,
    count,
    lat: new Float64Array(count),
    lon: new Float64Array(count),
    day: new Int32Array(count),
    night: new Uint8Array(count),
    sat: new Uint8Array(count),
    conf: new Uint8Array(count),
    frp: new Float32Array(count),
    s: new Uint8Array(count),
    w: new Float32Array(count),
  };
  for (let i = 0; i < count; i++) {
    const field = lines[i + 1].split(',');
    const lat = Number(field[0]);
    const lon = Number(field[1]);
    const day = dayNumber(field[2] ?? '');
    const conf = field[5] === 'n' ? CONF_NOMINAL : field[5] === 'h' ? CONF_HIGH : Number(field[5]);
    const frp = Number(field[6]);
    const weight = Number(field[8]);
    const valid =
      field.length === 9 &&
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      Number.isFinite(day) &&
      (field[3] === 'D' || field[3] === 'N') &&
      field[4] !== '' &&
      conf >= 0 &&
      conf <= CONF_HIGH &&
      Number.isFinite(frp) &&
      (field[7] === '0' || field[7] === '1') &&
      Number.isFinite(weight);
    if (!valid) throw new DataError('format', file, `Point tile ${id} has a malformed row ${i + 1}`, id);
    tile.lat[i] = lat;
    tile.lon[i] = lon;
    tile.day[i] = day;
    tile.night[i] = field[3] === 'N' ? 1 : 0;
    tile.sat[i] = satNumber(field[4]);
    tile.conf[i] = conf;
    tile.frp[i] = frp;
    tile.s[i] = field[7] === '1' ? 1 : 0;
    tile.w[i] = weight;
  }
  return tile;
}

// ---- Fetching ------------------------------------------------------------------

function tilePath(id: string): string {
  return `points/${id}.csv.gz`;
}

/** What to call a file in an error message. */
function describe(file: string, tileId?: string): string {
  return tileId ? `point tile ${tileId} (${file})` : file;
}

/** How long a request may take before it is given up, so a stalled download cannot hang the page. */
const DEFAULT_FETCH_TIMEOUT_MS = 60_000;
let fetchTimeoutMs = DEFAULT_FETCH_TIMEOUT_MS;

/** Changes the time limit of every request; `null` restores the default of 60 seconds. */
export function setFetchTimeout(ms: number | null): void {
  fetchTimeoutMs = ms ?? DEFAULT_FETCH_TIMEOUT_MS;
}

function timeLimit(): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(fetchTimeoutMs);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), fetchTimeoutMs);
  return controller.signal;
}

async function fetchBytes(file: string, tileId?: string): Promise<Uint8Array> {
  const url = `${import.meta.env.BASE_URL}data/${file}`;
  let response: Response;
  let bytes: Uint8Array;
  try {
    response = await fetch(url, { signal: timeLimit() });
    if (!response.ok) {
      throw new DataError('fetch', file, `Could not load ${describe(file, tileId)}: HTTP ${response.status}`, tileId);
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (cause) {
    if (cause instanceof DataError) throw cause;
    // A network failure, or the time limit: either while waiting for the answer or while reading it.
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new DataError('fetch', file, `Could not load ${describe(file, tileId)}: ${reason}`, tileId);
  }
  // GitHub Pages serves .gz files as they are. Some servers decompress them on
  // the way out, so only gunzip what still carries the gzip signature.
  const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  if (!isGzip) return bytes;
  try {
    return gunzipSync(bytes);
  } catch {
    throw new DataError('format', file, `Could not decompress ${describe(file, tileId)}`, tileId);
  }
}

async function fetchJson(file: string): Promise<unknown> {
  const text = new TextDecoder().decode(await fetchBytes(file));
  try {
    return JSON.parse(text);
  } catch {
    throw new DataError('format', file, `${file} is not valid JSON`);
  }
}

const cache = new Map<string, Promise<unknown>>();

/** Runs `load` once per key. A rejected load is forgotten so the next call tries again. */
function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  let pending = cache.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = load().catch((error: unknown) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
  }
  return pending;
}

/** Forgets every loaded file. */
export function clearDataCache(): void {
  cache.clear();
}

// ---- Loaders -------------------------------------------------------------------

export function loadMeta(): Promise<Meta> {
  return once('meta.json', async () => {
    const meta = (await fetchJson('meta.json')) as Meta;
    const grid = meta?.grid;
    const sameGrid =
      grid &&
      grid.lat0 === GRID.lat0 &&
      grid.lon0 === GRID.lon0 &&
      grid.cell === GRID.cell &&
      grid.nlat === GRID.nlat &&
      grid.nlon === GRID.nlon;
    if (!sameGrid) throw new DataError('format', 'meta.json', 'meta.json has a grid other than the one this app is built for');
    if (meta.month_count !== MONTH_COUNT) {
      throw new DataError('format', 'meta.json', `meta.json has month_count ${meta.month_count}, expected ${MONTH_COUNT}`);
    }
    return meta;
  });
}

/** The nation (first, id `AR`) and the provinces, from summary/provinces.json. */
export function loadProvinces(): Promise<AreaSummary[]> {
  const file = 'summary/provinces.json';
  return once(file, async () => {
    const areas = ((await fetchJson(file)) as { areas?: AreaSummary[] })?.areas;
    if (!Array.isArray(areas) || areas[0]?.id !== 'AR') {
      throw new DataError('format', file, `${file} does not list the nation (id AR) first`);
    }
    return areas;
  });
}

/** The province outlines, from provinces.geojson. */
export function loadProvinceShapes(): Promise<ProvinceShapes> {
  const file = 'provinces.geojson';
  return once(file, async () => {
    const shapes = (await fetchJson(file)) as ProvinceShapes;
    if (shapes?.type !== 'FeatureCollection' || !Array.isArray(shapes.features)) {
      throw new DataError('format', file, `${file} is not a GeoJSON FeatureCollection`);
    }
    return shapes;
  });
}

/** validation.json, for the method page. */
export function loadValidation(): Promise<Validation> {
  return once('validation.json', async () => (await fetchJson('validation.json')) as Validation);
}

function loadGridFile(file: string): Promise<SparseGrid> {
  return once(file, async () => decodeGrid(await fetchBytes(file), file));
}

/** Harmonized monthly sums per cell. The index of each entry is a `month_idx`. */
export function loadGrid(): Promise<SparseGrid> {
  return loadGridFile('grid/monthly.bin.gz');
}

/** Raw in-series pixel counts per cell and month. Loaded only when the Raw view is first opened. */
export function loadRawGrid(): Promise<SparseGrid> {
  return loadGridFile('grid/raw.bin.gz');
}

/** Month-to-date sums per cell. The index of each entry is `year - 2003`. */
export function loadMtd(): Promise<SparseGrid> {
  return loadGridFile('grid/mtd.bin.gz');
}

/** The hotspots of one point tile. Rejects with a DataError naming the tile. */
export function loadTile(id: string): Promise<TilePoints> {
  const file = tilePath(id);
  return once(file, async () => parseTile(id, new TextDecoder().decode(await fetchBytes(file, id))));
}

// ---- Sums over cells -----------------------------------------------------------

function sumByIndex(grid: SparseGrid, cells: Uint32Array, length: number): Float32Array {
  const sums = new Float64Array(length);
  if (cells.length > 0) {
    const picked = new Uint8Array(CELL_COUNT);
    for (const id of cells) picked[id] = 1; // an id off the grid is ignored by the typed array
    for (let i = 0; i < grid.count; i++) {
      if (picked[grid.cells[i]] === 1 && grid.index[i] < length) sums[grid.index[i]] += grid.values[i];
    }
  }
  return Float32Array.from(sums);
}

/**
 * The monthly series (287 numbers) of a set of grid cells, from cellsInShape().
 * `raw` reads only the raw grid and fetches it on first use.
 */
export async function seriesForCells(cells: Uint32Array, layer: Layer): Promise<Float32Array> {
  const [meta, grid] = await Promise.all([loadMeta(), layer === 'raw' ? loadRawGrid() : loadGrid()]);
  return sumByIndex(grid, cells, meta.month_count);
}

/**
 * The month-to-date sums of a set of grid cells: days 1 to D of the current
 * month, one number per year from 2003. Empty when there is no partial month.
 */
export async function mtdForCells(cells: Uint32Array): Promise<Float32Array> {
  const [meta, grid] = await Promise.all([loadMeta(), loadMtd()]);
  if (meta.mtd === null) return new Float32Array(0);
  return sumByIndex(grid, cells, Math.ceil(meta.month_count / 12));
}
