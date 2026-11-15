// The map (plan sections 6.2 and 6.4): the provinces over an OpenStreetMap
// base, drawing tools for a polygon or a rectangle, the selected area, and the
// hotspots of a selected month as dots.
//
// This module is loaded on its own, after the first results are on screen. It
// holds one map; the page talks to it through the functions below.

import L from 'leaflet';
// Leaflet-Geoman attaches itself to the global `L` that Leaflet defines, so it must come second.
import '@geoman-io/leaflet-geoman-free';
import 'leaflet/dist/leaflet.css';
import '@geoman-io/leaflet-geoman-free/dist/leaflet-geoman.css';
import type { ProvinceShapes } from './data';
import type { Shape } from './geo';
import type { Lang } from './i18n';
import { SAOCOM_WMS_URL, saocomWmsOptions } from './overlay';
import { rectangleTool, type RectangleTool } from './rectangle-tool';
import { SmoothWheelZoom } from './smooth-zoom';
import type { Area, LonLat } from './state';

/** The view of the whole country. */
const HOME = { center: [-38.4, -63.6] as [number, number], zoom: 4 };
const INK = '#1c1b19';
const ACCENT = '#1f4e79';
const DOT = '#b2182b';
/**
 * How far past the edge of the view the outlines and the dots are drawn, as a
 * share of the view. While the map zooms they are only scaled, so zooming out
 * shows this margin before anything is drawn afresh.
 */
const DRAW_MARGIN = 0.5;

const PROVINCE_STYLE: L.PathOptions = { color: INK, weight: 1, opacity: 0.55, fillColor: INK, fillOpacity: 0.03 };
const SELECTED_STYLE: L.PathOptions = { color: ACCENT, weight: 2.5, opacity: 1, fillColor: ACCENT, fillOpacity: 0.12 };

/** What a province's trend says, for its colour on the map. */
export type ProvinceTone = 'rising' | 'falling' | 'none' | 'unrated';

/** Blue for falling and orange for rising, so that the two are told apart without red against green. */
export const TONE_FILL: Record<ProvinceTone, string> = { falling: '#2f6f9f', rising: '#b4501a', none: '#6f6c65', unrated: INK };
/**
 * How opaque a trend colour is drawn. With it, each colour keeps 3 to 1
 * against the greyed land of the base map (GREYED_LAND).
 */
export const TREND_FILL_OPACITY = 0.85;
/** OpenStreetMap's land colour (#f2efe9) after the `.base-tiles` filter in style.css. */
export const GREYED_LAND = '#e7e7e7';

/**
 * The provinces' trends, to colour the map by, and the words of the legend.
 * `unsure` marks a province whose trend fails its check against the province's
 * known gap to MODIS: its outline is dashed.
 */
export interface ProvinceTrends {
  tones: Record<string, { tone: ProvinceTone; unsure: boolean }>;
  legend: { title: string; falling: string; none: string; rising: string; unrated: string; unsure: string };
}

/** Below this map width, in px, the trend legend starts folded. */
const LEGEND_OPEN_WIDTH = 480;

let trends: ProvinceTrends | null = null;
let trendLegend: L.Control | null = null;
/** The province shown as selected, if one is. */
let selectedProvince: string | null = null;

/** How a province is drawn: selected, coloured by its trend, or as a plain outline. */
function provinceStyle(id: string | undefined): L.PathOptions {
  if (id !== undefined && id === selectedProvince) return { ...SELECTED_STYLE, dashArray: undefined };
  const entry = id === undefined ? undefined : trends?.tones[id];
  if (!entry || entry.tone === 'unrated') return { ...PROVINCE_STYLE, dashArray: entry?.unsure ? '5 4' : undefined };
  const fill = { fillColor: TONE_FILL[entry.tone], fillOpacity: TREND_FILL_OPACITY };
  // A trend that fails its check: white dashes, which show on every trend colour where dark ones vanish.
  if (entry.unsure) return { ...PROVINCE_STYLE, ...fill, color: '#ffffff', opacity: 1, weight: 2, dashArray: '5 4' };
  return { ...PROVINCE_STYLE, ...fill, opacity: 0.8, dashArray: undefined };
}

function restyleProvinces(): void {
  provinceLayer?.setStyle((feature) => provinceStyle((feature?.properties as { id?: string } | undefined)?.id));
  // Dashed outlines go on top, so that a neighbour's solid border does not cover half of each dash.
  provinceLayer?.eachLayer((layer) => {
    const id = (layer as L.Path & { feature?: { properties?: { id?: string } } }).feature?.properties?.id;
    if (id !== undefined && id !== selectedProvince && trends?.tones[id]?.unsure) (layer as L.Path).bringToFront();
  });
  // The selected province stays above everything.
  provinceLayer?.eachLayer((layer) => {
    const id = (layer as L.Path & { feature?: { properties?: { id?: string } } }).feature?.properties?.id;
    if (id !== undefined && id === selectedProvince) (layer as L.Path).bringToFront();
  });
}

/**
 * Colours the provinces by their trend and shows the legend, or, with `null`,
 * goes back to plain outlines. The selected province keeps its own colours.
 */
export function setProvinceTrends(next: ProvinceTrends | null): void {
  trends = next;
  restyleProvinces();
  trendLegend?.remove();
  trendLegend = null;
  if (!map || !next) return;
  const doc = map.getContainer().ownerDocument;
  // Over the Atlantic: in the lower left it would cover Patagonia.
  const legend = new L.Control({ position: 'bottomright' });
  legend.onAdd = () => {
    // On a narrow map (a phone) the open legend would cover half the country: it folds to its title.
    const box = L.DomUtil.create('details', 'leaflet-bar trend-legend') as HTMLDetailsElement;
    box.open = map!.getSize().x >= LEGEND_OPEN_WIDTH;
    const title = doc.createElement('summary');
    title.className = 'trend-legend-title';
    title.textContent = next.legend.title;
    box.append(title);
    const row = (text: string, style: Partial<CSSStyleDeclaration>) => {
      const line = doc.createElement('div');
      const swatch = doc.createElement('span');
      swatch.className = 'swatch';
      Object.assign(swatch.style, style);
      line.append(swatch, text);
      box.append(line);
    };
    for (const tone of ['falling', 'none', 'rising'] as const) row(next.legend[tone], { background: TONE_FILL[tone], opacity: String(TREND_FILL_OPACITY) });
    row(next.legend.unrated, { background: 'transparent' });
    row(next.legend.unsure, { background: TONE_FILL.none, opacity: String(TREND_FILL_OPACITY), border: '2px dashed #ffffff', outline: `1px solid ${INK}` });
    L.DomEvent.disableClickPropagation(box);
    return box;
  };
  trendLegend = legend.addTo(map);
}

/** Positions of hotspots to draw; only the first `count` entries are used. */
export interface Dots {
  lat: ArrayLike<number>;
  lon: ArrayLike<number>;
  count: number;
}

let map: L.Map | null = null;
let provinceLayer: L.GeoJSON | null = null;
let areaLayer: L.Layer | null = null;
let dotsLayer: L.LayerGroup | null = null;
let dotsRenderer: L.Renderer | null = null;
let hint: HTMLElement | null = null;
let labels: DrawLabels | null = null;
/** The optional CONAE radar mosaic and the pieces of its toggle. */
let overlay: L.TileLayer.WMS | null = null;
let overlayLabel: HTMLElement | null = null;
let overlayStatus: HTMLElement | null = null;
/** On a touch screen, dragging the map is off until the map is tapped. */
let touch = false;
/** True once the map has been clicked, tapped or focused, until the reader leaves it. */
let active = false;
/** The rectangle tool, its button's name in the toolbar, and the line that says how to use it. */
let rectangle: RectangleTool | null = null;
const RECTANGLE_BUTTON = 'dragRectangle';
let drawHint: HTMLElement | null = null;
const listeners: Array<(area: Area) => void> = [];

function emit(area: Area): void {
  for (const listener of listeners) listener(area);
}

function round5(value: number): number {
  return Number(value.toFixed(5));
}

/** Names for the two drawing tools, which Leaflet-Geoman leaves without one, and the hint shown on touch screens. */
export interface DrawLabels {
  polygon: string;
  rectangle: string;
  /** Shown on the map while the rectangle tool is on: it wants a press and a drag, not a click. */
  rectangleHint: string;
  touchHint: string;
  /** The optional CONAE layer: the toggle's label, its attribution, and the line shown when it does not load. */
  overlay: string;
  overlayAttribution: string;
  overlayError: string;
}

export interface MapOptions {
  lang: Lang;
  labels: DrawLabels;
  /** True on a touch screen. Default: what the browser reports for `(pointer: coarse)`. */
  coarsePointer?: boolean;
}

/** Gives the drawing buttons an accessible name and a hover title. */
function labelDrawButtons(labels: DrawLabels): void {
  const toolbar = map?.getContainer().querySelector('.leaflet-pm-toolbar');
  for (const icon of toolbar?.querySelectorAll('.control-icon') ?? []) {
    const name = icon.className.includes('rectangle') ? labels.rectangle : icon.className.includes('polygon') ? labels.polygon : null;
    const button = icon.closest('a, button');
    if (!name || !button) continue;
    button.setAttribute('aria-label', name);
    button.setAttribute('title', name);
    button.setAttribute('role', 'button');
  }
}

/**
 * Lets the map take the scroll wheel (and, on a touch screen, one-finger
 * drags) or hands them back to the page.
 *
 * A map that always took them would trap a reader who is only scrolling past:
 * the wheel would zoom the map, and on a phone, where the map is almost as
 * wide as the screen, a swipe would pan it and the page would not move.
 */
function setActive(on: boolean): void {
  active = on;
  applyInteraction();
}

/**
 * Who gets the wheel and the drag. The wheel zooms an active map. A drag moves
 * the map, except on a touch screen before the map is tapped, and except while
 * the rectangle tool is on, when a drag draws.
 */
function applyInteraction(): void {
  if (!map) return;
  const drawing = rectangle?.armed() ?? false;
  if (active) map.scrollWheelZoom.enable();
  else map.scrollWheelZoom.disable();
  if ((!touch || active) && !drawing) map.dragging.enable();
  else map.dragging.disable();
  if (hint) hint.hidden = active || !touch || drawing;
  if (drawHint) drawHint.hidden = !drawing;
}

/** A part of Leaflet-Geoman's toolbar that its types leave out: sets whether a button shows as pressed. */
interface ToolbarInternals {
  toggleButton(name: string, pressed: boolean, releaseOthers: boolean): boolean;
}

/**
 * Puts the rectangle tool's button in the drawing toolbar, first. The toolbar
 * is Leaflet-Geoman's; the tool is the page's own, because Geoman's rectangle
 * takes two clicks where a press and a drag are expected.
 */
function addRectangleButton(): void {
  if (!map) return;
  const toolbar = map.pm.Toolbar;
  const afterClick = (_event: unknown, context: { button: { toggled(): boolean } }) => {
    if (context.button.toggled()) rectangle?.arm();
    else rectangle?.disarm();
  };
  toolbar.createCustomControl({
    name: RECTANGLE_BUTTON,
    block: 'draw',
    className: 'leaflet-pm-icon-rectangle',
    toggle: true,
    actions: ['cancel'],
    afterClick: afterClick as unknown as () => void,
  });
  toolbar.changeControlOrder([RECTANGLE_BUTTON, 'drawPolygon'] as never);
}

/**
 * Turns the CONAE radar mosaic on or off. Nothing is asked of CONAE's server
 * before the first time it is turned on. If its tiles fail to load, one line
 * under the toggle says so and the rest of the map carries on.
 */
function setOverlay(on: boolean): void {
  if (!map || !labels) return;
  overlay?.remove();
  overlay = null;
  if (overlayStatus) overlayStatus.hidden = true;
  if (!on) return;
  const layer = L.tileLayer.wms(SAOCOM_WMS_URL, saocomWmsOptions(labels.overlayAttribution));
  let arrived = false;
  layer.on('tileload', () => {
    arrived = true;
    if (overlayStatus) overlayStatus.hidden = true;
  });
  layer.on('tileerror', () => {
    if (arrived || !overlayStatus || !labels) return;
    overlayStatus.textContent = labels.overlayError;
    overlayStatus.hidden = false;
  });
  overlay = layer.addTo(map);
}

/** The toggle for the CONAE layer, as a control in the map's corner. */
function addOverlayControl(doc: Document, text: DrawLabels): void {
  const control = new L.Control({ position: 'topright' });
  control.onAdd = () => {
    const box = L.DomUtil.create('div', 'leaflet-bar overlay-control');
    const toggle = doc.createElement('label');
    toggle.className = 'overlay-toggle';
    const checkbox = doc.createElement('input');
    checkbox.type = 'checkbox';
    overlayLabel = doc.createElement('span');
    overlayLabel.textContent = text.overlay;
    toggle.append(checkbox, overlayLabel);
    overlayStatus = doc.createElement('div');
    overlayStatus.className = 'overlay-status';
    overlayStatus.setAttribute('role', 'status');
    overlayStatus.hidden = true;
    box.append(toggle, overlayStatus);
    checkbox.addEventListener('change', () => setOverlay(checkbox.checked));
    // Clicks and scrolls on the control are not meant for the map underneath.
    L.DomEvent.disableClickPropagation(box);
    L.DomEvent.disableScrollPropagation(box);
    return box;
  };
  control.addTo(map!);
}

/** Builds the map in `element`. Call once. */
export function initMap(element: HTMLElement, provinces: ProvinceShapes, options: MapOptions): void {
  if (map) return;
  touch = options.coarsePointer ?? element.ownerDocument.defaultView?.matchMedia?.('(pointer: coarse)').matches ?? false;
  map = L.map(element, {
    center: HOME.center,
    zoom: HOME.zoom,
    minZoom: 2,
    maxZoom: 13,
    zoomSnap: 0.5,
    scrollWheelZoom: false,
    dragging: !touch,
    renderer: L.svg({ padding: DRAW_MARGIN }),
  });
  // The wheel and the trackpad zoom continuously; Leaflet's own handler moves in half-level jumps.
  map.addHandler('scrollWheelZoom', SmoothWheelZoom);

  // The map wakes on a click, a tap or keyboard focus, and sleeps when the reader leaves it.
  const doc = element.ownerDocument;
  hint = doc.createElement('div');
  hint.className = 'map-hint';
  hint.textContent = options.labels.touchHint;
  hint.hidden = !touch;
  element.append(hint);
  drawHint = doc.createElement('div');
  drawHint.className = 'map-hint draw-hint';
  drawHint.setAttribute('role', 'status');
  drawHint.textContent = options.labels.rectangleHint;
  drawHint.hidden = true;
  element.append(drawHint);
  element.addEventListener('click', () => setActive(true));
  element.addEventListener('focusin', () => setActive(true));
  element.addEventListener('mouseleave', () => setActive(false));
  element.addEventListener('focusout', (event) => {
    if (!element.contains(event.relatedTarget as Node | null)) setActive(false);
  });
  doc.addEventListener('pointerdown', (event) => {
    if (touch && !element.contains(event.target as Node | null)) setActive(false);
  });
  labels = options.labels;
  map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  // The street map is greyed by the stylesheet (`.base-tiles`), so the provinces and the dots stand out.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    className: 'base-tiles',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  provinceLayer = L.geoJSON(provinces, {
    style: PROVINCE_STYLE,
    pmIgnore: true,
    onEachFeature(feature, layer) {
      const { id, name } = feature.properties as { id: string; name: string };
      layer.bindTooltip(name, { sticky: true, direction: 'top' });
      // A click selects the province, unless the click is part of drawing a shape.
      layer.on('click', () => {
        if (!map?.pm.globalDrawModeEnabled() && !rectangle?.armed()) emit({ kind: 'province', id });
      });
    },
  }).addTo(map);

  // Hotspot dots go on their own canvas, above the areas, and never take clicks.
  map.createPane('dots');
  const pane = map.getPane('dots')!;
  pane.style.zIndex = '450';
  pane.style.pointerEvents = 'none';
  dotsRenderer = L.canvas({ pane: 'dots', padding: DRAW_MARGIN });

  map.pm.setLang(options.lang);
  map.pm.setGlobalOptions({ allowSelfIntersection: false, snappable: false });
  map.pm.addControls({
    position: 'topleft',
    drawPolygon: true,
    drawRectangle: false, // the page's own rectangle tool takes its place
    drawMarker: false,
    drawCircleMarker: false,
    drawPolyline: false,
    drawCircle: false,
    drawText: false,
    editMode: false,
    dragMode: false,
    cutPolygon: false,
    removalMode: false,
    rotateMode: false,
  });
  rectangle = rectangleTool(map, {
    style: SELECTED_STYLE,
    // The page draws the selected area itself, through setArea().
    onDraw: (ring) => emit({ kind: 'polygon', ring }),
    onChange: (armed) => {
      // One rectangle per press of the button, as in a slide editor.
      if (!armed) (map?.pm.Toolbar as unknown as ToolbarInternals | undefined)?.toggleButton(RECTANGLE_BUTTON, false, false);
      applyInteraction();
    },
  });
  addRectangleButton();
  labelDrawButtons(options.labels);
  addOverlayControl(doc, options.labels);
  map.on('pm:create', (event) => {
    const drawn = event.layer as L.Polygon;
    const corners = (drawn.getLatLngs()[0] ?? []) as L.LatLng[];
    const ring: LonLat[] = corners.map((corner) => [round5(corner.lng), round5(corner.lat)]);
    drawn.remove(); // the page draws the selected area itself, through setArea()
    if (ring.length >= 3) emit({ kind: 'polygon', ring });
  });
}

/** Calls `listener` when the user picks an area on the map: a drawn shape or a clicked province. */
export function onAreaChange(listener: (area: Area) => void): void {
  listeners.push(listener);
}

/**
 * Shows the selected area. `shape` is the outline of a drawn area or a circle;
 * a province is found among the province outlines. With `fit` the map moves to
 * the area.
 */
export function setArea(area: Area, shape: Shape | null, options: { fit: boolean }): void {
  if (!map || !provinceLayer) return;
  areaLayer?.remove();
  areaLayer = null;
  selectedProvince = area.kind === 'province' ? area.id : null;
  restyleProvinces();

  let bounds: L.LatLngBounds | null = null;
  if (area.kind === 'province') {
    provinceLayer.eachLayer((layer) => {
      const path = layer as L.Polygon & { feature?: { properties?: { id?: string } } };
      if (path.feature?.properties?.id === area.id) {
        path.bringToFront();
        bounds = path.getBounds();
      }
    });
  } else if (shape) {
    const outline = L.geoJSON(shape, { style: SELECTED_STYLE, interactive: false, pmIgnore: true });
    const group = L.featureGroup([outline]);
    if (area.kind === 'circle') {
      group.addLayer(
        L.circleMarker([area.lat, area.lon], {
          radius: 3,
          color: ACCENT,
          fillColor: ACCENT,
          fillOpacity: 1,
          interactive: false,
          pmIgnore: true,
        }),
      );
    }
    areaLayer = group.addTo(map);
    bounds = outline.getBounds();
  }

  if (!options.fit) return;
  // Moves are not animated: an animated zoom only finishes while the tab is in front, so an
  // area opened from a link in a background tab was left half off the map.
  if (bounds && (bounds as L.LatLngBounds).isValid()) {
    map.fitBounds(bounds, { padding: [24, 24], maxZoom: 10, animate: false });
    return;
  }
  // The nation: the whole country, at the home zoom when the map is tall enough and further out when it is not.
  const country = provinceLayer.getBounds();
  if (country.isValid()) map.fitBounds(country, { padding: [8, 8], maxZoom: HOME.zoom, animate: false });
  else map.setView(HOME.center, HOME.zoom, { animate: false });
}

/** Draws hotspots as dots on a canvas layer, replacing any dots already shown. */
export function showDots(dots: Dots): void {
  if (!map || !dotsRenderer) return;
  clearDots();
  const group = L.layerGroup();
  for (let i = 0; i < dots.count; i++) {
    L.circleMarker([dots.lat[i], dots.lon[i]], {
      renderer: dotsRenderer,
      radius: 2.5,
      stroke: false,
      fillColor: DOT,
      fillOpacity: 0.65,
      interactive: false,
      pmIgnore: true,
    }).addTo(group);
  }
  dotsLayer = group.addTo(map);
}

export function clearDots(): void {
  dotsLayer?.remove();
  dotsLayer = null;
}

/** The language of the drawing tools' own tooltips, the names of their buttons, and the touch hint. */
export function setMapLanguage(lang: Lang, text: DrawLabels): void {
  labels = text;
  map?.pm.setLang(lang);
  labelDrawButtons(text);
  if (hint) hint.textContent = text.touchHint;
  if (drawHint) drawHint.textContent = text.rectangleHint;
  if (overlayLabel) overlayLabel.textContent = text.overlay;
  if (overlayStatus && !overlayStatus.hidden) overlayStatus.textContent = text.overlayError;
}

/** Tells the map its box may have changed size, for example after the panel around it was opened. */
export function refreshMapSize(): void {
  map?.invalidateSize({ pan: false });
}
