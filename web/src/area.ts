// Turns the selected area into the numbers the page shows (plan section 6.2).
//
// The nation and the provinces come straight from summary/provinces.json:
// instant and exact. A drawn shape or a circle is cut to the country, then
// stood for by the grid cells whose centers lie inside it (about 5 km).

import {
  loadProvinceShapes,
  loadProvinces,
  mtdForCells,
  seriesForCells,
  type Layer,
  type ProvinceShapes,
} from './data';
import { cellsInShape, circle, clipToCoverage, coverageOf, type CoverageStatus, type Shape } from './geo';
import { NATION, type Area } from './state';

export interface AreaData {
  /** The area as resolved: an unknown province becomes the nation. */
  area: Area;
  kind: 'nation' | 'province' | 'custom';
  /** The name of the nation or province; `null` for a drawn shape or a circle. */
  name: string | null;
  /** Whether a drawn shape or circle lies inside Argentina. Always `inside` for provinces. */
  coverage: CoverageStatus;
  /** True when a drawn shape is smaller than a cell, holds no cell center, and one cell stands for it. */
  tooSmall: boolean;
  /** True when a drawn shape is too narrow to hold a cell center, and the cells it passes through stand for it. */
  thin: boolean;
  /** Number of grid cells summed; `null` for the nation and provinces. */
  cellCount: number | null;
  /**
   * The part of a drawn shape or circle that lies in the country; `null` when
   * it lies outside. For the nation and provinces use areaShape().
   */
  shape: Shape | null;
  /** 287 harmonized monthly values; empty when the area is outside the country. */
  monthly: ArrayLike<number>;
  /** 287 raw monthly counts; `null` for a drawn area until the Raw view asks for them. */
  raw: ArrayLike<number> | null;
  /** Month-to-date values, one per year; empty when there is no partial month. */
  mtd: ArrayLike<number>;
}

let outlineOf: ProvinceShapes | null = null;
let outline: Shape | null = null;

/** The outline of the country, joined from the provinces once. */
export async function countryOutline(): Promise<Shape> {
  const provinces = await loadProvinceShapes();
  if (outlineOf !== provinces || outline === null) {
    outline = coverageOf(provinces.features.map((feature) => feature.geometry));
    outlineOf = provinces;
  }
  return outline;
}

/** The polygon of a drawn area or a circle, before it is cut to the country. */
export function drawnShape(area: Exclude<Area, { kind: 'province' }>): Shape {
  if (area.kind === 'circle') return circle(area.lat, area.lon, area.km);
  return { type: 'Polygon', coordinates: [[...area.ring, area.ring[0]]] };
}

/**
 * The series of an area. `layer` only matters for drawn areas: the raw grid is
 * fetched when it is `raw`, and not before.
 */
export async function resolveArea(area: Area, layer: Layer): Promise<AreaData> {
  if (area.kind === 'province') {
    const areas = await loadProvinces();
    const summary = areas.find((entry) => entry.id === area.id) ?? areas[0];
    const isNation = summary === areas[0];
    return {
      area: isNation ? NATION : area,
      kind: isNation ? 'nation' : 'province',
      name: summary.name,
      coverage: 'inside',
      tooSmall: false,
      thin: false,
      cellCount: null,
      shape: null,
      monthly: summary.monthly,
      raw: summary.raw,
      mtd: summary.mtd,
    };
  }

  const { shape, status } = clipToCoverage(drawnShape(area), await countryOutline());
  const custom = { area, kind: 'custom' as const, name: null, coverage: status, shape };
  if (shape === null) {
    return { ...custom, tooSmall: false, thin: false, cellCount: 0, monthly: [], raw: null, mtd: [] };
  }
  const { cells, tooSmall, thin } = cellsInShape(shape);
  const [monthly, mtd, raw] = await Promise.all([
    seriesForCells(cells, 'harmonized'),
    mtdForCells(cells),
    layer === 'raw' ? seriesForCells(cells, 'raw') : null,
  ]);
  return { ...custom, tooSmall, thin, cellCount: cells.length, monthly, raw, mtd };
}

/**
 * The outline used to pick an area's hotspots: the province, the country, or
 * the covered part of a drawn shape. `null` when the area is outside the country.
 */
export async function areaShape(data: AreaData): Promise<Shape | null> {
  if (data.kind === 'custom') return data.shape;
  if (data.kind === 'nation') return countryOutline();
  const id = data.area.kind === 'province' ? data.area.id : '';
  const provinces = await loadProvinceShapes();
  return provinces.features.find((feature) => feature.properties.id === id)?.geometry ?? null;
}
