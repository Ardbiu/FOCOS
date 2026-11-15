// @vitest-environment jsdom
//
// Drawing a rectangle on the map the way a shape is placed in a slide: press
// where one corner goes, drag, let go at the opposite corner. The real Leaflet
// runs here in jsdom.
import L from 'leaflet';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rectangleTool, type RectangleTool } from '../src/rectangle-tool';
import type { LonLat } from '../src/state';

let box: HTMLElement;
let map: L.Map;
let tool: RectangleTool;
let drawn: LonLat[][];
let changes: boolean[];

/** A pointer event on the map (or on `target`) at a place given in px from the map's corner. */
function pointer(type: string, x: number, y: number, init: PointerEventInit = {}, target: Element = box): PointerEvent {
  const event = new PointerEvent(type, {
    clientX: x,
    clientY: y,
    button: 0,
    isPrimary: true,
    pointerId: 1,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

/** The rectangles on the map (the tool's own outline while dragging). */
function outlines(): L.Rectangle[] {
  const found: L.Rectangle[] = [];
  map.eachLayer((layer) => {
    if (layer instanceof L.Rectangle) found.push(layer);
  });
  return found;
}

beforeEach(() => {
  box = document.createElement('div');
  Object.defineProperty(box, 'clientWidth', { value: 600 });
  Object.defineProperty(box, 'clientHeight', { value: 400 });
  document.body.append(box);
  map = L.map(box, { center: [-30, -60], zoom: 6, zoomSnap: 0.5 });
  drawn = [];
  changes = [];
  tool = rectangleTool(map, {
    style: { color: '#1f4e79', weight: 2 },
    onDraw: (ring) => drawn.push(ring),
    onChange: (armed) => changes.push(armed),
  });
});

afterEach(() => {
  tool.disarm();
  map.remove();
  box.remove();
  vi.useRealTimers();
});

describe('the rectangle tool', () => {
  it('does nothing until it is switched on', () => {
    expect(tool.armed()).toBe(false);
    const down = pointer('pointerdown', 100, 100);
    pointer('pointermove', 300, 250);
    pointer('pointerup', 300, 250);
    expect(drawn).toEqual([]);
    expect(outlines()).toHaveLength(0);
    expect(down.defaultPrevented).toBe(false);
    expect(box.classList.contains('drawing-rectangle')).toBe(false);
  });

  it('says when it goes on and off, and marks the map so the pointer becomes a cross', () => {
    tool.arm();
    tool.arm(); // a second time changes nothing
    expect(tool.armed()).toBe(true);
    expect(box.classList.contains('drawing-rectangle')).toBe(true);
    tool.disarm();
    tool.disarm();
    expect(tool.armed()).toBe(false);
    expect(box.classList.contains('drawing-rectangle')).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it('draws with one press, drag and release, and then switches itself off', () => {
    tool.arm();
    const from = map.containerPointToLatLng(L.point(100, 100));
    const to = map.containerPointToLatLng(L.point(300, 250));

    const down = pointer('pointerdown', 100, 100);
    // The press belongs to the tool: the map must not start a drag of its own, and no text gets selected.
    expect(down.defaultPrevented).toBe(true);
    pointer('pointermove', 200, 180);
    pointer('pointerup', 300, 250);

    expect(drawn).toHaveLength(1);
    const round = (value: number) => Number(value.toFixed(5));
    const [west, east] = [round(from.lng), round(to.lng)];
    const [north, south] = [round(from.lat), round(to.lat)];
    // South-west, north-west, north-east, south-east: the order Leaflet gives a rectangle's corners in.
    expect(drawn[0]).toEqual([
      [west, south],
      [west, north],
      [east, north],
      [east, south],
    ]);
    expect(tool.armed()).toBe(false);
    expect(changes).toEqual([true, false]);
    expect(box.classList.contains('drawing-rectangle')).toBe(false);
  });

  it('gives the same rectangle whichever corner the drag starts from', () => {
    tool.arm();
    pointer('pointerdown', 100, 100);
    pointer('pointerup', 300, 250);
    tool.arm();
    pointer('pointerdown', 300, 250);
    pointer('pointerup', 100, 100);
    tool.arm();
    pointer('pointerdown', 300, 100);
    pointer('pointerup', 100, 250);
    expect(drawn).toHaveLength(3);
    expect(drawn[1]).toEqual(drawn[0]);
    expect(drawn[2]).toEqual(drawn[0]);
  });

  it('shows the rectangle while it is dragged, following the pointer, and takes it away afterwards', () => {
    tool.arm();
    pointer('pointerdown', 100, 100);
    expect(outlines()).toHaveLength(0); // nothing to show before the pointer moves
    pointer('pointermove', 200, 180);
    expect(outlines()).toHaveLength(1);
    const first = outlines()[0].getBounds();
    expect(map.latLngToContainerPoint(first.getNorthWest()).x).toBeCloseTo(100, 0);
    expect(map.latLngToContainerPoint(first.getSouthEast()).x).toBeCloseTo(200, 0);
    expect(map.latLngToContainerPoint(first.getSouthEast()).y).toBeCloseTo(180, 0);
    pointer('pointermove', 320, 260);
    expect(outlines()).toHaveLength(1);
    expect(map.latLngToContainerPoint(outlines()[0].getBounds().getSouthEast()).x).toBeCloseTo(320, 0);
    // The outline is only a picture: it takes no clicks.
    expect(outlines()[0].options.interactive).toBe(false);
    pointer('pointerup', 320, 260);
    expect(outlines()).toHaveLength(0);
  });

  it('takes a click without a drag for a click: nothing is drawn and the tool stays on', () => {
    tool.arm();
    pointer('pointerdown', 100, 100);
    pointer('pointerup', 102, 101);
    expect(drawn).toEqual([]);
    expect(tool.armed()).toBe(true);
    // A sliver is not a rectangle either.
    pointer('pointerdown', 100, 100);
    pointer('pointermove', 300, 102);
    pointer('pointerup', 300, 102);
    expect(drawn).toEqual([]);
    expect(outlines()).toHaveLength(0);
    expect(tool.armed()).toBe(true);
    // The next real drag still works.
    pointer('pointerdown', 100, 100);
    pointer('pointerup', 300, 250);
    expect(drawn).toHaveLength(1);
  });

  it('swallows the click that ends the drag, and only that one', () => {
    vi.useFakeTimers();
    const clicks = vi.fn();
    map.on('click', clicks);
    tool.arm();
    pointer('pointerdown', 100, 100);
    pointer('pointerup', 300, 250);
    // The browser follows a release with a click; it must not reach the map, or the province under it would be picked.
    box.dispatchEvent(new MouseEvent('click', { clientX: 300, clientY: 250, bubbles: true, cancelable: true }));
    expect(clicks).not.toHaveBeenCalled();
    box.dispatchEvent(new MouseEvent('click', { clientX: 300, clientY: 250, bubbles: true, cancelable: true }));
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('lets a click on one of the map’s buttons through, even right after a drag', () => {
    const control = document.createElement('div');
    control.className = 'leaflet-control';
    const button = document.createElement('a');
    control.append(button);
    box.append(control);
    const presses = vi.fn();
    button.addEventListener('click', presses);
    tool.arm();
    pointer('pointerdown', 100, 100);
    pointer('pointerup', 300, 250);
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(presses).toHaveBeenCalledTimes(1);
  });

  it('does not wait for ever for that click: a release outside the map sends none', () => {
    vi.useFakeTimers();
    const clicks = vi.fn();
    map.on('click', clicks);
    tool.arm();
    pointer('pointerdown', 100, 100);
    pointer('pointerup', 300, 250);
    vi.advanceTimersByTime(1000);
    box.dispatchEvent(new MouseEvent('click', { clientX: 50, clientY: 50, bubbles: true, cancelable: true }));
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('is switched off by Escape, also in the middle of a drag', () => {
    tool.arm();
    pointer('pointerdown', 100, 100);
    pointer('pointermove', 200, 180);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(tool.armed()).toBe(false);
    expect(outlines()).toHaveLength(0);
    pointer('pointerup', 300, 250);
    expect(drawn).toEqual([]);
    // Other keys leave it alone.
    tool.arm();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(tool.armed()).toBe(true);
  });

  it('starts over when the browser takes the press away', () => {
    tool.arm();
    pointer('pointerdown', 100, 100);
    pointer('pointermove', 200, 180);
    pointer('pointercancel', 200, 180);
    expect(outlines()).toHaveLength(0);
    expect(drawn).toEqual([]);
    expect(tool.armed()).toBe(true);
    pointer('pointerup', 300, 250); // a release with no press before it
    expect(drawn).toEqual([]);
  });

  it('leaves presses on the map’s buttons, other mouse buttons and second fingers alone', () => {
    tool.arm();
    const control = document.createElement('div');
    control.className = 'leaflet-control';
    box.append(control);
    const onControl = pointer('pointerdown', 20, 20, {}, control);
    expect(onControl.defaultPrevented).toBe(false);
    pointer('pointerup', 300, 250);
    const right = pointer('pointerdown', 100, 100, { button: 2 });
    expect(right.defaultPrevented).toBe(false);
    pointer('pointerup', 300, 250);
    const second = pointer('pointerdown', 100, 100, { isPrimary: false, pointerId: 2 });
    expect(second.defaultPrevented).toBe(false);
    pointer('pointerup', 300, 250, { isPrimary: false, pointerId: 2 });
    expect(drawn).toEqual([]);
    expect(tool.armed()).toBe(true);
  });
});
