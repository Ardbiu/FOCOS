// @vitest-environment jsdom
//
// The map on a touch screen: a one-finger swipe over it must scroll the page,
// so dragging the map is off until the map has been tapped.
import L from 'leaflet';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildSample } from '../scripts/make-sample-data.mjs';
import type { ProvinceShapes } from '../src/data';
import { initMap, setMapLanguage } from '../src/map';

const LABELS = {
  polygon: 'Draw a polygon',
  rectangle: 'Draw a rectangle',
  rectangleHint: 'Press and drag on the map',
  touchHint: 'Tap the map to move it',
  overlay: 'Radar mosaic 2022 (CONAE SAOCOM)',
  overlayAttribution: 'SAOCOM mosaic: CONAE',
  overlayError: 'CONAE’s map service did not respond.',
};
const provinces = JSON.parse(new TextDecoder().decode(buildSample().get('provinces.geojson'))) as ProvinceShapes;
let box: HTMLElement;
let map: L.Map;

beforeAll(() => {
  const context = new Proxy({}, { get: () => () => undefined, set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
  box = document.createElement('div');
  document.body.append(box);
  const factory = vi.spyOn(L, 'map');
  initMap(box, provinces, {
    lang: 'en',
    labels: LABELS,
    coarsePointer: true,
  });
  map = factory.mock.results[0].value as L.Map;
});

describe('the map on a touch screen', () => {
  const hint = () => box.querySelector<HTMLElement>('.map-hint')!;

  it('lets a swipe scroll the page until the map is tapped, and says how to use it', () => {
    expect(map.dragging.enabled()).toBe(false);
    expect(map.scrollWheelZoom.enabled()).toBe(false);
    expect(hint().hidden).toBe(false);
    expect(hint().textContent).toBe('Tap the map to move it');
    // Pinching with two fingers still zooms.
    expect(map.touchZoom.enabled()).toBe(true);
  });

  it('can be dragged after a tap, until the reader touches the page outside it', () => {
    box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(map.dragging.enabled()).toBe(true);
    expect(hint().hidden).toBe(true);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(map.dragging.enabled()).toBe(false);
    expect(hint().hidden).toBe(false);
    // A touch inside the map does not switch it off.
    box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    box.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(map.dragging.enabled()).toBe(true);
  });

  it('gives the finger to the rectangle tool while it is on, and hands dragging back as it was', () => {
    const button = box.querySelector('.leaflet-pm-toolbar .leaflet-pm-icon-rectangle')!.closest('a')!;
    const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    // The map has been tapped: a finger drags it.
    box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(map.dragging.enabled()).toBe(true);
    button.click();
    expect(map.dragging.enabled()).toBe(false);
    escape();
    expect(map.dragging.enabled()).toBe(true);
    // The map has not been tapped: dragging was off, and is off afterwards.
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(map.dragging.enabled()).toBe(false);
    button.click();
    escape();
    expect(map.dragging.enabled()).toBe(false);
  });

  it('writes the hint in the language of the page', () => {
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    setMapLanguage('es', { ...LABELS, touchHint: 'Tocá el mapa para moverlo' });
    expect(hint().textContent).toBe('Tocá el mapa para moverlo');
  });
});
