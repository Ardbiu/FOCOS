// @vitest-environment jsdom
//
// The map's wheel and trackpad zoom. Leaflet's own zooms in steps of half a
// level, each a short animation that ignores the scrolling done meanwhile; this
// one follows the scroll frame by frame. The real Leaflet runs here in jsdom,
// with the clock and the animation frames driven by the test.
import L from 'leaflet';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmoothWheelZoom, easeToward, wheelZoomChange } from '../src/smooth-zoom';

const pixels = (deltaY: number, ctrlKey = false) => ({ deltaY, deltaMode: 0, ctrlKey });

describe('wheelZoomChange', () => {
  it('turns scroll distance into zoom levels: 300 px is one level, down zooms out, up zooms in', () => {
    expect(wheelZoomChange(pixels(300))).toBeCloseTo(-1, 10);
    expect(wheelZoomChange(pixels(-150))).toBeCloseTo(0.5, 10);
    expect(wheelZoomChange(pixels(0))).toBe(0);
  });

  it('keeps a small scroll small instead of rounding it to a step', () => {
    expect(wheelZoomChange(pixels(3))).toBeCloseTo(-0.01, 10);
  });

  it('reads a trackpad pinch, which arrives as ctrl + wheel with small numbers, six times as strongly', () => {
    expect(wheelZoomChange(pixels(-10, true))).toBeCloseTo(0.2, 10);
  });

  it('reads a wheel that reports lines: three lines, one notch, is the same as 100 px', () => {
    expect(wheelZoomChange({ deltaY: 3, deltaMode: 1, ctrlKey: false })).toBeCloseTo(wheelZoomChange(pixels(100)), 10);
  });

  it('never takes more than one level from a single event', () => {
    expect(wheelZoomChange(pixels(5000))).toBe(-1);
    expect(wheelZoomChange(pixels(-5000))).toBe(1);
    expect(wheelZoomChange({ deltaY: 1, deltaMode: 2, ctrlKey: false })).toBe(-1);
  });
});

describe('easeToward', () => {
  it('goes part of the way each frame, never past the goal, and lands on it exactly', () => {
    let zoom = 4;
    const seen: number[] = [];
    for (let frame = 0; frame < 120 && zoom !== 5; frame++) {
      zoom = easeToward(zoom, 5, 16);
      seen.push(zoom);
    }
    expect(zoom).toBe(5);
    expect(seen.length).toBeGreaterThan(5);
    expect(seen[0]).toBeGreaterThan(4);
    expect(seen[0]).toBeLessThan(4.5);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    expect(Math.max(...seen)).toBe(5);
  });

  it('works downward as well', () => {
    const next = easeToward(5, 4, 16);
    expect(next).toBeLessThan(5);
    expect(next).toBeGreaterThan(4.5);
  });

  it('covers the same ground in one long frame as in two short ones', () => {
    expect(easeToward(easeToward(4, 5, 16), 5, 16)).toBeCloseTo(easeToward(4, 5, 32), 10);
  });

  it('stays put when no time has passed', () => {
    expect(easeToward(4, 5, 0)).toBe(4);
  });
});

describe('SmoothWheelZoom', () => {
  let box: HTMLElement;
  let map: L.Map;

  const wheel = (deltaY: number, at: { x: number; y: number } = { x: 300, y: 200 }) => {
    const event = new WheelEvent('wheel', { deltaY, deltaMode: 0, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true });
    box.dispatchEvent(event);
    return event;
  };
  /** Lets the animation run for `ms`. */
  const run = (ms: number) => vi.advanceTimersByTime(ms);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'setTimeout', 'clearTimeout'] });
    box = document.createElement('div');
    Object.defineProperty(box, 'clientWidth', { value: 600 });
    Object.defineProperty(box, 'clientHeight', { value: 400 });
    document.body.append(box);
    map = L.map(box, { center: [-38.4, -63.6], zoom: 4, minZoom: 2, maxZoom: 13, zoomSnap: 0.5, scrollWheelZoom: false });
    map.addHandler('scrollWheelZoom', SmoothWheelZoom);
  });

  afterEach(() => {
    map.remove();
    box.remove();
    vi.useRealTimers();
  });

  it('replaces the map’s own wheel zoom and, like it, does nothing until it is switched on', () => {
    expect(map.scrollWheelZoom).toBeInstanceOf(SmoothWheelZoom);
    expect(map.scrollWheelZoom.enabled()).toBe(false);
    const event = wheel(-300);
    run(1000);
    expect(map.getZoom()).toBe(4);
    // The page scrolls instead.
    expect(event.defaultPrevented).toBe(false);
  });

  it('zooms in many small steps to the level that was scrolled, and rests there, between whole levels if need be', () => {
    map.scrollWheelZoom.enable();
    const zooms: number[] = [];
    const ends = vi.fn();
    map.on('zoom', () => zooms.push(map.getZoom()));
    map.on('moveend', ends);

    const event = wheel(-100);
    // The page must not scroll while the map zooms.
    expect(event.defaultPrevented).toBe(true);
    // Nothing jumps at the moment of the scroll.
    expect(map.getZoom()).toBe(4);
    run(1000);

    expect(map.getZoom()).toBeCloseTo(4 + 1 / 3, 6);
    expect(zooms.length).toBeGreaterThan(5);
    let last = 4;
    for (const zoom of zooms) {
      expect(zoom).toBeGreaterThan(last);
      expect(zoom - last).toBeLessThan(0.15);
      last = zoom;
    }
    // It has finished: the map has said so, and no frames are left running.
    expect(ends).toHaveBeenCalled();
    const before = zooms.length;
    run(1000);
    expect(zooms.length).toBe(before);
  });

  it('keeps the place under the pointer where it is', () => {
    map.scrollWheelZoom.enable();
    const pointer = { x: 450, y: 100 };
    const place = map.containerPointToLatLng(L.point(pointer.x, pointer.y));
    wheel(-450, pointer);
    run(1500);
    expect(map.getZoom()).toBeCloseTo(5, 6);
    const now = map.latLngToContainerPoint(place);
    expect(Math.abs(now.x - pointer.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(now.y - pointer.y)).toBeLessThanOrEqual(1);
  });

  it('adds up scrolling that arrives while it is still moving', () => {
    map.scrollWheelZoom.enable();
    wheel(150);
    run(30);
    wheel(150);
    run(30);
    wheel(150);
    run(1500);
    expect(map.getZoom()).toBeCloseTo(2.5, 6);
  });

  it('starts a second scroll from where the first came to rest, between levels, without jumping back first', () => {
    map.scrollWheelZoom.enable();
    wheel(-90); // three tenths of a level
    run(1000);
    expect(map.getZoom()).toBeCloseTo(4.3, 6);
    const zooms: number[] = [];
    map.on('zoom', () => zooms.push(map.getZoom()));
    wheel(-150); // half a level more
    run(1000);
    expect(map.getZoom()).toBeCloseTo(4.8, 6);
    // Only zooming in: the map never falls back to a rounder level on the way.
    expect(Math.min(...zooms)).toBeGreaterThanOrEqual(4.3 - 1e-9);
  });

  it('holds a scroll made while Leaflet’s own zoom (a button, a double click) plays, and zooms when it ends', () => {
    map.scrollWheelZoom.enable();
    // jsdom does not run Leaflet's zoom animation, so the test plays one by hand. When the real
    // one ends, Leaflet puts the map at that zoom's end, undoing anything moved meanwhile.
    const internals = map as unknown as { _animatingZoom: boolean };
    internals._animatingZoom = true;
    wheel(-150);
    run(200);
    expect(map.getZoom()).toBe(4);
    internals._animatingZoom = false;
    map.fire('zoomend');
    run(1000);
    expect(map.getZoom()).toBeCloseTo(4.5, 6);
  });

  it('stops at the map’s zoom limits', () => {
    map.scrollWheelZoom.enable();
    for (let i = 0; i < 10; i++) wheel(900);
    run(3000);
    expect(map.getZoom()).toBe(2);
    for (let i = 0; i < 30; i++) wheel(-900);
    run(5000);
    expect(map.getZoom()).toBe(13);
  });

  it('has the shapes on the map redrawn on the way during a long zoom, not only at the end', () => {
    map.scrollWheelZoom.enable();
    const redraws = vi.fn();
    map.on('zoomend', redraws);
    for (let i = 0; i < 3; i++) wheel(-300);
    run(3000);
    expect(map.getZoom()).toBeCloseTo(7, 6);
    // Three levels: several redraws on the way, so outlines never grow to eight times their width.
    expect(redraws.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('stops at once when it is switched off part of the way', () => {
    map.scrollWheelZoom.enable();
    const ends = vi.fn();
    map.on('moveend', ends);
    wheel(-600);
    run(50);
    const reached = map.getZoom();
    expect(reached).toBeGreaterThan(4);
    expect(reached).toBeLessThan(6);
    ends.mockClear(); // the redraws on the way say "moveend" too
    map.scrollWheelZoom.disable();
    expect(ends).toHaveBeenCalledTimes(1);
    run(1000);
    expect(map.getZoom()).toBe(reached);
    expect(ends).toHaveBeenCalledTimes(1);
  });

  it('gives way when something else moves the map', () => {
    map.scrollWheelZoom.enable();
    wheel(-600);
    run(50);
    map.setView([-30, -60], 6, { animate: false });
    run(1000);
    expect(map.getZoom()).toBe(6);
    expect(map.getCenter().lat).toBeCloseTo(-30, 3);
  });
});
