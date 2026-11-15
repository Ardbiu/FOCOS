// Drawing a rectangle on the map the way a shape is placed in a slide: press
// where one corner goes, drag, and let go at the opposite corner.
//
// Leaflet-Geoman's own rectangle wants a click for the first corner and a
// second click for the other, with nothing held down in between.

import L from 'leaflet';
import type { LonLat } from './state';

/** A press that moves less than this, in px, across or down is a click, and draws nothing. */
const MIN_DRAG = 6;
/** How long, in ms, the click that follows a release is waited for. The browser sends it at once. */
const CLICK_WAIT_MS = 100;

export interface RectangleTool {
  /** Switches the tool on: the next press and drag on the map draws a rectangle. */
  arm(): void;
  /** Switches it off, dropping a rectangle that is being dragged. */
  disarm(): void;
  armed(): boolean;
}

export interface RectangleToolOptions {
  /** How the rectangle looks while it is dragged. */
  style: L.PathOptions;
  /** The finished rectangle: its corners as (lon, lat) with 5 decimals. The tool is off by then. */
  onDraw(ring: LonLat[]): void;
  /** Called whenever the tool goes on or off. */
  onChange?(armed: boolean): void;
}

function round5(value: number): number {
  return Number(value.toFixed(5));
}

export function rectangleTool(map: L.Map, options: RectangleToolOptions): RectangleTool {
  const container = map.getContainer();
  const doc = container.ownerDocument;
  let armed = false;
  /** The corner where the press began, while a drag is under way. */
  let start: { point: L.Point; latlng: L.LatLng; pointerId: number } | null = null;
  let outline: L.Rectangle | null = null;

  function dropDrag(): void {
    if (start) container.releasePointerCapture?.(start.pointerId);
    start = null;
    outline?.remove();
    outline = null;
  }

  function onDown(event: PointerEvent): void {
    if (start || !event.isPrimary || event.button !== 0) return;
    // The zoom buttons, the drawing buttons and the layer switch keep their presses.
    if ((event.target as Element | null)?.closest?.('.leaflet-control')) return;
    // The press is the tool's: no text selection, and no mouse events for the map to act on.
    event.preventDefault();
    const point = map.mouseEventToContainerPoint(event);
    start = { point, latlng: map.containerPointToLatLng(point), pointerId: event.pointerId };
    // The drag goes on when the pointer leaves the map.
    container.setPointerCapture?.(event.pointerId);
  }

  function onMove(event: PointerEvent): void {
    if (!start || event.pointerId !== start.pointerId) return;
    const bounds = L.latLngBounds(start.latlng, map.mouseEventToLatLng(event));
    if (outline) outline.setBounds(bounds);
    else outline = L.rectangle(bounds, { ...options.style, interactive: false, pmIgnore: true }).addTo(map);
  }

  function onUp(event: PointerEvent): void {
    if (!start || event.pointerId !== start.pointerId) return;
    const from = start;
    const end = map.mouseEventToContainerPoint(event);
    dropDrag();
    if (Math.abs(end.x - from.point.x) < MIN_DRAG || Math.abs(end.y - from.point.y) < MIN_DRAG) return;
    const bounds = L.latLngBounds(from.latlng, map.containerPointToLatLng(end));
    const [west, east] = [round5(bounds.getWest()), round5(bounds.getEast())];
    const [south, north] = [round5(bounds.getSouth()), round5(bounds.getNorth())];
    swallowNextClick();
    disarm();
    options.onDraw([
      [west, south],
      [west, north],
      [east, north],
      [east, south],
    ]);
  }

  function onCancel(event: PointerEvent): void {
    if (start && event.pointerId === start.pointerId) dropDrag();
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') disarm();
  }

  /**
   * The browser follows a release with a click. That click would reach the
   * map, which would take it for a click on the province under the pointer.
   */
  function swallowNextClick(): void {
    const swallow = (event: Event) => {
      // A click on one of the map's buttons is a click of its own, not the end of the drag.
      if ((event.target as Element | null)?.closest?.('.leaflet-control')) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      stop();
    };
    const timer = setTimeout(stop, CLICK_WAIT_MS);
    function stop(): void {
      clearTimeout(timer);
      container.removeEventListener('click', swallow, true);
    }
    container.addEventListener('click', swallow, true);
  }

  function arm(): void {
    if (armed) return;
    armed = true;
    container.classList.add('drawing-rectangle');
    container.addEventListener('pointerdown', onDown);
    container.addEventListener('pointermove', onMove);
    container.addEventListener('pointerup', onUp);
    container.addEventListener('pointercancel', onCancel);
    doc.addEventListener('keydown', onKey);
    options.onChange?.(true);
  }

  function disarm(): void {
    if (!armed) return;
    armed = false;
    dropDrag();
    container.classList.remove('drawing-rectangle');
    container.removeEventListener('pointerdown', onDown);
    container.removeEventListener('pointermove', onMove);
    container.removeEventListener('pointerup', onUp);
    container.removeEventListener('pointercancel', onCancel);
    doc.removeEventListener('keydown', onKey);
    options.onChange?.(false);
  }

  return { arm, disarm, armed: () => armed };
}
