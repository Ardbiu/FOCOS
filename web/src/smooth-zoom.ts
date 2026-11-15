// A wheel and trackpad zoom for the map that follows the scroll frame by frame.
//
// Leaflet's own wheel zoom collects the scroll for a moment, then plays a
// quarter-second animation to the next half level, and ignores whatever is
// scrolled while that plays. On a trackpad this reads as a series of jerks.
// Here every wheel event moves a goal, and each animation frame closes part of
// the gap between the map and that goal, with the place under the pointer held
// still. The map may come to rest between whole levels.

import L from 'leaflet';

/** Zoom levels per pixel of scroll: 300 px of scrolling is one level. */
const LEVELS_PER_PIXEL = 1 / 300;
/** A wheel that reports lines: three lines, one notch of a mouse wheel, count as 100 px. */
const PIXELS_PER_LINE = 100 / 3;
/** A trackpad pinch arrives as ctrl + wheel with small numbers. */
const PINCH_FACTOR = 6;
/** The most one wheel event may ask for, in levels. A wheel that reports pages asks for this. */
const MAX_STEP = 1;
/** The time, in ms, in which the map closes about two thirds of the gap to the goal. */
const EASE_MS = 70;
/** Closer than this to the goal, the map lands on it. */
const NEAR = 0.002;
/** The zoom has ended when the goal is reached and no wheel event came for this long, in ms. */
const IDLE_MS = 120;
/**
 * While the zoom runs, the shapes on the map are only scaled, as pictures.
 * After this many levels they are drawn afresh, so their outlines keep their
 * width and nothing is cut off at the old edge of the view.
 */
const REDRAW_AFTER = 0.35;

/** The change of zoom level that one wheel event asks for. Scrolling down zooms out. */
export function wheelZoomChange(event: Pick<WheelEvent, 'deltaY' | 'deltaMode' | 'ctrlKey'>): number {
  let change: number;
  if (event.deltaMode === 2) change = -Math.sign(event.deltaY) * MAX_STEP;
  else {
    const px = event.deltaMode === 1 ? event.deltaY * PIXELS_PER_LINE : event.deltaY;
    change = -px * LEVELS_PER_PIXEL * (event.ctrlKey ? PINCH_FACTOR : 1);
  }
  if (change === 0) return 0; // not -0
  return Math.max(-MAX_STEP, Math.min(MAX_STEP, change));
}

/**
 * Where a value on its way from `current` to `goal` is after `elapsedMs`. The
 * same whether the time passes in one frame or in several.
 */
export function easeToward(current: number, goal: number, elapsedMs: number): number {
  if (!(elapsedMs > 0)) return current;
  const next = goal + (current - goal) * Math.exp(-elapsedMs / EASE_MS);
  return Math.abs(goal - next) < NEAR ? goal : next;
}

/** The parts of a Leaflet map that its own pinch zoom uses to move it without an animation. */
interface MapInternals {
  /** Stops a pan or a flight under way, and nothing else. */
  _stop(): unknown;
  /** True while Leaflet's own animated zoom (a button, a double click, a key) plays. */
  _animatingZoom?: boolean;
  _moveStart(zoomChanged: boolean, noMoveStart: boolean): unknown;
  _move(center: L.LatLng, zoom: number): unknown;
  _moveEnd(zoomChanged: boolean): unknown;
}

/**
 * The handler. Give it to a map built with `scrollWheelZoom: false`, under
 * the same name, so that it takes the place of Leaflet's own:
 * `map.addHandler('scrollWheelZoom', SmoothWheelZoom)`.
 */
export class SmoothWheelZoom extends L.Handler {
  private readonly owner: L.Map;
  private running = false;
  private frame = 0;
  private goal = 0;
  /** The pointer, and the place on the ground under it. */
  private pointer = L.point(0, 0);
  private place = L.latLng(0, 0);
  private lastWheel = 0;
  private lastFrame = 0;
  /** Where this handler last put the map; if the map is elsewhere, something else moved it. */
  private center = L.latLng(0, 0);
  private zoom = 0;
  /** The zoom at which the shapes were last drawn afresh. */
  private drawnZoom = 0;
  /** Scrolling held while Leaflet's own zoom plays, in levels, and whether the map is being waited on. */
  private held = 0;
  private holding = false;

  constructor(map: L.Map) {
    super(map);
    this.owner = map;
  }

  addHooks(): void {
    this.owner.getContainer().addEventListener('wheel', this.onWheel, { passive: false });
  }

  removeHooks(): void {
    this.owner.getContainer().removeEventListener('wheel', this.onWheel);
    this.owner.off('zoomend', this.afterLeafletZoom);
    this.holding = false;
    this.held = 0;
    this.finish();
  }

  private readonly onWheel = (event: WheelEvent): void => {
    const map = this.owner;
    // The map takes the scroll, so the page must not.
    event.preventDefault();
    event.stopPropagation();
    const change = wheelZoomChange(event);
    if (change === 0) return;
    this.pointer = map.mouseEventToContainerPoint(event);
    this.lastWheel = performance.now();
    // When Leaflet's own zoom ends, Leaflet puts the map where that zoom ends, so a scroll
    // begun while it plays would be undone. It is kept until then.
    if ((map as unknown as MapInternals)._animatingZoom) {
      this.held += change;
      if (!this.holding) {
        this.holding = true;
        map.once('zoomend', this.afterLeafletZoom);
      }
      return;
    }
    this.zoomBy(change);
  };

  private readonly afterLeafletZoom = (): void => {
    const change = this.held;
    this.holding = false;
    this.held = 0;
    if (change !== 0 && this.enabled()) this.zoomBy(change);
  };

  /** Moves the goal by `change` levels, about the place under the pointer. */
  private zoomBy(change: number): void {
    const map = this.owner;
    if (!this.running) this.begin();
    this.goal = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), this.goal + change));
    this.place = map.containerPointToLatLng(this.pointer);
  }

  private begin(): void {
    const map = this.owner;
    // Not `map.stop()`: that also rounds the zoom to the nearest `zoomSnap` with a short animation,
    // and when the animation ends Leaflet puts the map back where it began, undoing the scroll
    // made meanwhile. The map jumped back and then forward again.
    (map as unknown as MapInternals)._stop();
    this.running = true;
    this.goal = this.zoom = this.drawnZoom = map.getZoom();
    this.center = map.getCenter();
    this.lastFrame = performance.now();
    (map as unknown as MapInternals)._moveStart(true, false);
    this.frame = requestAnimationFrame(this.step);
  }

  private readonly step = (): void => {
    if (!this.running) return;
    const map = this.owner;
    const internals = map as unknown as MapInternals;
    // A drag, a button or the page moved the map meanwhile: that wins.
    if (map.getZoom() !== this.zoom || !map.getCenter().equals(this.center)) {
      this.finish();
      return;
    }
    const now = performance.now();
    const zoom = easeToward(this.zoom, this.goal, now - this.lastFrame);
    this.lastFrame = now;
    if (zoom !== this.zoom) {
      // The centre that leaves `place` under the pointer at the new zoom.
      const fromCentre = this.pointer.subtract(map.getSize().divideBy(2));
      const center = map.unproject(map.project(this.place, zoom).subtract(fromCentre), zoom);
      internals._move(center, zoom);
      this.zoom = zoom;
      this.center = map.getCenter();
      if (Math.abs(zoom - this.drawnZoom) >= REDRAW_AFTER && zoom !== this.goal) {
        internals._moveEnd(true);
        internals._moveStart(true, false);
        this.drawnZoom = zoom;
      }
    }
    if (zoom === this.goal && now - this.lastWheel >= IDLE_MS) {
      this.finish();
      return;
    }
    this.frame = requestAnimationFrame(this.step);
  };

  private finish(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.frame);
    (this.owner as unknown as MapInternals)._moveEnd(true);
  }
}
