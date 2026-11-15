#!/usr/bin/env node
// Generates a small SAMPLE data set that follows the data contract in
// PROJECT_PLAN.md section 5. The tests use it in memory (buildSample), so they
// do not depend on the real pipeline output in web/public/data.
//
// The numbers are invented. Hotspots are drawn from a seeded random generator,
// then the grids, the province summaries and the month-to-date layer are all
// summed from those same points, so the files agree with each other the way the
// real pipeline outputs must.
//
//   node scripts/make-sample-data.mjs --out <folder>   write the sample files
//
// web/public/data holds the real data and is never the default target. The
// script refuses to write over a folder whose meta.json is not sample data.
// The output is deterministic: running it twice gives byte-identical files.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'fflate';

// ---- Contract constants (section 5) ----------------------------------------
const FIRST_YEAR = 2003;
const MONTH_COUNT = 287;
const YEAR_COUNT = 24;
const GRID = { lat0: -56.0, lon0: -74.0, cell: 0.05, nlat: 700, nlon: 420 };
const SWITCH_IDX = 109; // Feb 2012: S-NPP carries the series from here on
const TILE_HEADER = 'lat,lon,date,dn,sat,conf,frp,s,w';

// ---- Sample choices ----------------------------------------------------------
/** A fixed timestamp marks the files as sample data (and keeps them reproducible). */
export const SAMPLE_GENERATED_UTC = '2026-11-12T00:00:00Z';
const SEED = 20261114;
const DATA_END = { year: 2026, month: 11, day: 14 };
const SNPP_FIRST = { idx: 108, day: 20 }; // S-NPP rows start on 2012-01-20, out of series until Feb
const NOAA20_FIRST_IDX = 286; // NOAA-20 carries the series from 2026-11 (section 4.11); S-NPP ends 2026-10-31

/** Outage days per month_idx. Coverage = 1 - outage days / days in month (section 4.6). */
const OUTAGES = [
  { month_idx: 92, sensor: 'A', days: [10, 11, 12, 13, 14, 15, 16, 17, 18] }, // Sep 2010, coverage 0.70
  { month_idx: 192, sensor: 'N', days: [5, 6, 7, 8, 9, 10, 11, 12] }, // Jan 2019, coverage 0.74
];

/** MODIS-equivalent weight of one S-NPP fire cell-pass, per season and day/night (a C1-style table). */
const K = {
  D: { DJF: 0.42, MAM: 0.38, JJA: 0.4, SON: 0.41 },
  N: { DJF: 0.4, MAM: 0.36, JJA: 0.37, SON: 0.39 },
};
const K_MEAN = 0.4;
const SEASON_OF_MONTH = ['DJF', 'DJF', 'MAM', 'MAM', 'MAM', 'JJA', 'JJA', 'JJA', 'SON', 'SON', 'SON', 'DJF'];

/** Pixels per fire cell-pass. S-NPP averages 1.6, so raw / harmonized is about 1.6 / 0.4 = 4. */
const AQUA_PIXELS = [0.8, 0.15, 0.05];
const SNPP_PIXELS = [0.6, 0.25, 0.1, 0.05];

/**
 * Two provinces with real Georef ids and names but invented, simplified outlines
 * placed inside the real provinces. Rings are [lon, lat], counter-clockwise.
 * `season` is the expected MODIS-equivalent count per month, as a share of `base`.
 */
const PROVINCES = [
  {
    id: '18',
    name: 'Corrientes',
    multi: false,
    ring: [
      [-58.55, -28.75],
      [-57.95, -28.9],
      [-57.25, -28.7],
      [-57.3, -28.2],
      [-57.9, -28.1],
      [-58.5, -28.25],
      [-58.55, -28.75],
    ],
    base: 22,
    season: [0.55, 0.5, 0.3, 0.12, 0.1, 0.2, 0.6, 1.0, 0.85, 0.45, 0.3, 0.4],
    growthPerYear: 0,
    clusters: [
      { lat: -28.55, lon: -58.25, spread: 0.1, share: 0.4 },
      { lat: -28.45, lon: -57.6, spread: 0.12, share: 0.4 },
      { lat: -28.7, lon: -57.85, spread: 0.08, share: 0.2 },
    ],
    // month_idx -> multiplier. Jan-Feb 2022 echoes the real wetland fires.
    events: { 80: 2.0, 211: 2.2, 228: 5.0, 229: 6.0, 286: 2.2 },
  },
  {
    id: '42',
    name: 'La Pampa',
    multi: true, // written as a MultiPolygon, the way Georef publishes provinces
    ring: [
      [-65.85, -36.8],
      [-65.3, -36.9],
      [-65.1, -36.45],
      [-65.35, -36.1],
      [-65.8, -36.2],
      [-65.85, -36.8],
    ],
    base: 18,
    season: [1.0, 0.7, 0.3, 0.06, 0.03, 0.02, 0.02, 0.04, 0.08, 0.18, 0.4, 0.8],
    growthPerYear: 0.05,
    clusters: [
      { lat: -36.5, lon: -65.5, spread: 0.12, share: 0.5 },
      { lat: -36.35, lon: -65.4, spread: 0.08, share: 0.25 },
      { lat: -36.7, lon: -65.45, spread: 0.08, share: 0.25 },
    ],
    // Dec 2016 to Jan 2017 echoes the real grassland fires.
    events: { 24: 2.2, 167: 3.0, 168: 4.0, 180: 2.0, 286: 2.2 },
  },
];

// ---- Small helpers -----------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function insideRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < xi + ((lat - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
  }
  return inside;
}

const round = (value, decimals) => Math.round(value * 10 ** decimals) / 10 ** decimals;
const pad2 = (n) => String(n).padStart(2, '0');
const cellId = (lat, lon) =>
  Math.floor((lat - GRID.lat0) / GRID.cell) * GRID.nlon + Math.floor((lon - GRID.lon0) / GRID.cell);
const tileId = (lat, lon) => `t_${Math.floor(lat)}_${Math.floor(lon)}`;

// ---- Point generation --------------------------------------------------------
function generatePoints() {
  const rand = mulberry32(SEED);
  const gauss = () => {
    const u = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  const poisson = (mean) => {
    if (mean <= 0) return 0;
    if (mean > 40) return Math.max(0, Math.round(mean + Math.sqrt(mean) * gauss()));
    const limit = Math.exp(-mean);
    let count = 0;
    for (let product = rand(); product > limit; product *= rand()) count++;
    return count;
  };
  const pick = (shares) => {
    let u = rand();
    for (let i = 0; i < shares.length; i++) {
      u -= shares[i];
      if (u < 0) return i;
    }
    return shares.length - 1;
  };

  /** A point inside the province, rounded to 5 decimals, drawn around one of its clusters. */
  const placeFire = (province) => {
    for (;;) {
      const cluster = province.clusters[pick(province.clusters.map((c) => c.share))];
      const lat = round(cluster.lat + cluster.spread * gauss(), 5);
      const lon = round(cluster.lon + cluster.spread * gauss(), 5);
      if (insideRing(lon, lat, province.ring)) return { lat, lon };
    }
  };
  /** Another pixel in the same 0.01 degree cell (so it belongs to the same fire cell-pass). */
  const placeNeighbour = (province, first) => {
    const lat0 = Math.floor(first.lat * 100) / 100;
    const lon0 = Math.floor(first.lon * 100) / 100;
    for (let attempt = 0; attempt < 50; attempt++) {
      const lat = round(lat0 + 0.0005 + 0.009 * rand(), 5);
      const lon = round(lon0 + 0.0005 + 0.009 * rand(), 5);
      if (insideRing(lon, lat, province.ring)) return { lat, lon };
    }
    return first;
  };

  const outage = new Map(OUTAGES.map((o) => [`${o.month_idx}:${o.sensor}`, new Set(o.days)]));
  const lastIdx = (DATA_END.year - FIRST_YEAR) * 12 + (DATA_END.month - 1);
  const points = [];

  for (const province of PROVINCES) {
    const yearFactor = Array.from({ length: YEAR_COUNT }, (_, y) => Math.exp(0.22 * gauss()) * (1 + province.growthPerYear * y));

    for (let idx = 0; idx <= lastIdx; idx++) {
      const year = FIRST_YEAR + Math.floor(idx / 12);
      const month = (idx % 12) + 1;
      const monthDays = daysInMonth(year, month);
      const lastDay = idx === lastIdx ? DATA_END.day : monthDays;
      const expected =
        province.base * province.season[month - 1] * yearFactor[year - FIRST_YEAR] * (province.events[idx] ?? 1);

      const sensors = [{ sat: 'A', firstDay: 1, perUnit: 1, pixels: AQUA_PIXELS }];
      if (idx >= SNPP_FIRST.idx) {
        sensors.push({
          sat: idx >= NOAA20_FIRST_IDX ? 'N20' : 'N',
          firstDay: idx === SNPP_FIRST.idx ? SNPP_FIRST.day : 1,
          perUnit: 1 / K_MEAN, // this many S-NPP cell-passes make one MODIS-equivalent hotspot
          pixels: SNPP_PIXELS,
        });
      }

      for (const sensor of sensors) {
        const dayCount = lastDay - sensor.firstDay + 1;
        const cellPasses = poisson((expected * sensor.perUnit * dayCount) / monthDays);
        const outageDays = outage.get(`${idx}:${sensor.sat}`);
        const inSeries = sensor.sat === 'A' ? idx < SWITCH_IDX : idx >= SWITCH_IDX;

        for (let n = 0; n < cellPasses; n++) {
          const day = sensor.firstDay + Math.floor(rand() * dayCount);
          const dn = rand() < 0.75 ? 'D' : 'N';
          const nPix = pick(sensor.pixels) + 1;
          const first = placeFire(province);
          const conf = sensor.sat === 'A' ? String(30 + Math.floor(rand() * 71)) : rand() < 0.88 ? 'n' : 'h';
          const frpMedian = sensor.sat === 'A' ? 18 : 4;
          if (outageDays?.has(day)) continue; // the sensor saw nothing that day

          const k = sensor.sat === 'A' ? 1 : K[dn][SEASON_OF_MONTH[month - 1]];
          const weight = inSeries ? (k / nPix).toFixed(6) : '0.000000';
          for (let p = 0; p < nPix; p++) {
            const where = p === 0 ? first : placeNeighbour(province, first);
            points.push({
              lat: where.lat,
              lon: where.lon,
              date: `${year}-${pad2(month)}-${pad2(day)}`,
              idx,
              year,
              month,
              day,
              dn,
              sat: sensor.sat,
              conf,
              frp: Math.max(0.3, frpMedian * Math.exp(0.8 * gauss())).toFixed(1),
              s: inSeries ? 1 : 0,
              w: weight,
              province: province.id,
            });
          }
        }
      }
    }
  }

  points.sort(
    (a, b) =>
      (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
      (a.sat < b.sat ? -1 : a.sat > b.sat ? 1 : 0) ||
      a.lat - b.lat ||
      a.lon - b.lon,
  );
  return points;
}

// ---- Encoders ----------------------------------------------------------------
const gzip = (bytes) => gzipSync(bytes, { level: 9, mtime: 0 });
const text = (string) => new TextEncoder().encode(string);

/** Section 5 layout: uint32 N, N x uint32 cell_id, N x float32 value, N x uint16 index. Little-endian. */
function encodeGrid(sums) {
  const entries = [...sums.entries()].sort((a, b) => a[0] - b[0]); // by cell, then index
  const n = entries.length;
  const view = new DataView(new ArrayBuffer(4 + 10 * n));
  view.setUint32(0, n, true);
  entries.forEach(([key, value], i) => {
    view.setUint32(4 + 4 * i, Math.floor(key / 512), true);
    view.setFloat32(4 + 4 * n + 4 * i, value, true);
    view.setUint16(4 + 8 * n + 2 * i, key % 512, true);
  });
  return gzip(new Uint8Array(view.buffer));
}

/**
 * Builds every sample file in memory.
 * @returns {Map<string, Uint8Array>} path relative to web/public/data -> file bytes
 */
export function buildSample() {
  const points = generatePoints();
  const add = (map, key, value) => map.set(key, (map.get(key) ?? 0) + value);

  const monthly = new Map(); // cell * 512 + month_idx -> sum of w
  const raw = new Map(); // cell * 512 + month_idx -> sum of s
  const mtd = new Map(); // cell * 512 + (year - 2003) -> sum of w over days 1..D of the current month
  const zeros = (length) => new Array(length).fill(0);
  const summaries = new Map(
    ['AR', ...PROVINCES.map((p) => p.id)].map((id) => [id, { monthly: zeros(MONTH_COUNT), raw: zeros(MONTH_COUNT), mtd: zeros(YEAR_COUNT) }]),
  );
  const tiles = new Map(); // tile id -> csv lines

  for (const p of points) {
    const tile = tileId(p.lat, p.lon);
    if (!tiles.has(tile)) tiles.set(tile, [TILE_HEADER]);
    tiles
      .get(tile)
      .push(`${p.lat.toFixed(5)},${p.lon.toFixed(5)},${p.date},${p.dn},${p.sat},${p.conf},${p.frp},${p.s},${p.w}`);

    if (p.s !== 1) continue;
    const weight = Number(p.w);
    const cell = cellId(p.lat, p.lon);
    const isMonthToDate = p.month === DATA_END.month && p.day <= DATA_END.day;
    add(monthly, cell * 512 + p.idx, weight);
    add(raw, cell * 512 + p.idx, 1);
    if (isMonthToDate) add(mtd, cell * 512 + (p.year - FIRST_YEAR), weight);
    for (const id of ['AR', p.province]) {
      const summary = summaries.get(id);
      summary.monthly[p.idx] += weight;
      summary.raw[p.idx] += 1;
      if (isMonthToDate) summary.mtd[p.year - FIRST_YEAR] += weight;
    }
  }

  const tileIds = [...tiles.keys()].sort();
  const meta = {
    version: 1,
    generated_utc: SAMPLE_GENERATED_UTC,
    country: 'Argentina',
    data_end_date: `${DATA_END.year}-${pad2(DATA_END.month)}-${pad2(DATA_END.day)}`,
    switch_month: '2012-02',
    grid: GRID,
    month_count: MONTH_COUNT,
    calibration: { candidate: 'C2', train_years: [2012, 2019], test_years: [2020, 2021] },
    typical_error_pct: 18.4,
    naive_error_pct: 310.0,
    series: [
      { sat: 'A', name: 'Aqua MODIS', from: '2003-01', to: '2012-01', typical_error_pct: null },
      { sat: 'N', name: 'S-NPP VIIRS', from: '2012-02', to: '2026-10', typical_error_pct: 18.4 },
      { sat: 'N20', name: 'NOAA-20 VIIRS', from: '2026-11', to: null, typical_error_pct: 19.2 },
    ],
    incomplete_months: OUTAGES.map((o) => {
      const days = daysInMonth(FIRST_YEAR + Math.floor(o.month_idx / 12), (o.month_idx % 12) + 1);
      return { month_idx: o.month_idx, coverage: round(1 - o.days.length / days, 2), sensor: o.sensor };
    }),
    tiles: tileIds,
    mtd: { month: DATA_END.month, last_day: DATA_END.day },
  };

  const areas = [{ id: 'AR', name: 'Argentina' }, ...PROVINCES].map(({ id, name }) => {
    const summary = summaries.get(id);
    return {
      id,
      name,
      monthly: summary.monthly.map((v) => round(v, 4)),
      raw: summary.raw,
      mtd: summary.mtd.map((v) => round(v, 4)),
    };
  });

  const geojson = {
    type: 'FeatureCollection',
    features: PROVINCES.map((p) => ({
      type: 'Feature',
      properties: { id: p.id, name: p.name },
      geometry: p.multi
        ? { type: 'MultiPolygon', coordinates: [[p.ring]] }
        : { type: 'Polygon', coordinates: [p.ring] },
    })),
  };

  const files = new Map();
  files.set('meta.json', text(`${JSON.stringify(meta, null, 2)}\n`));
  files.set('grid/monthly.bin.gz', encodeGrid(monthly));
  files.set('grid/raw.bin.gz', encodeGrid(raw));
  files.set('grid/mtd.bin.gz', encodeGrid(mtd));
  for (const tile of tileIds) files.set(`points/${tile}.csv.gz`, gzip(text(`${tiles.get(tile).join('\n')}\n`)));
  files.set(
    'summary/provinces.json',
    text(`{"areas": [\n${areas.map((area) => `  ${JSON.stringify(area)}`).join(',\n')}\n]}\n`),
  );
  files.set('provinces.geojson', text(`${JSON.stringify(geojson)}\n`));
  // Placeholder: the shape of validation.json is pinned in task D7.
  files.set('validation.json', text('{}\n'));
  return files;
}

// ---- Command line ------------------------------------------------------------
function main() {
  const outArg = process.argv.indexOf('--out');
  if (outArg < 0 || !process.argv[outArg + 1]) {
    console.error('Usage: node scripts/make-sample-data.mjs --out <folder>');
    process.exit(1);
  }
  const outDir = resolve(process.argv[outArg + 1]);
  const metaPath = join(outDir, 'meta.json');
  if (existsSync(metaPath)) {
    const existing = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (existing.generated_utc !== SAMPLE_GENERATED_UTC) {
      console.error(
        `${metaPath} is not sample data (generated_utc ${existing.generated_utc}).\n` +
          'Refusing to write over pipeline output.',
      );
      process.exit(1);
    }
  }
  let total = 0;
  for (const [path, bytes] of buildSample()) {
    const target = join(outDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    total += bytes.length;
    console.log(`${String(bytes.length).padStart(8)}  ${path}`);
  }
  console.log(`${String(total).padStart(8)}  total, written to ${outDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
