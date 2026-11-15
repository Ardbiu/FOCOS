// @vitest-environment jsdom
//
// The real Leaflet and Leaflet-Geoman, run in jsdom. jsdom has no layout and no
// canvas, so this checks the wiring (events in, areas out, nothing throws), not
// how the map looks.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rgb } from 'd3';
import L from 'leaflet';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildSample } from '../scripts/make-sample-data.mjs';
import type { ProvinceShapes } from '../src/data';
import { circle } from '../src/geo';
import {
  GREYED_LAND,
  TONE_FILL,
  TREND_FILL_OPACITY,
  clearDots,
  initMap,
  onAreaChange,
  refreshMapSize,
  setArea,
  setMapLanguage,
  setProvinceTrends,
  showDots,
} from '../src/map';
import { SmoothWheelZoom } from '../src/smooth-zoom';
import type { Area } from '../src/state';

const provinces = JSON.parse(new TextDecoder().decode(buildSample().get('provinces.geojson'))) as ProvinceShapes;
const LABELS = {
  polygon: 'Draw a polygon',
  rectangle: 'Draw a rectangle',
  rectangleHint: 'Press and drag on the map',
  touchHint: 'Tap the map to move it',
  overlay: 'Radar mosaic 2022 (CONAE SAOCOM)',
  overlayAttribution: 'SAOCOM mosaic: CONAE',
  overlayError: 'CONAE’s map service did not respond.',
};
const picked: Area[] = [];
let box: HTMLElement;

let created: L.Map;

/** The Leaflet map that initMap() built in the box. */
function leafletMap(): L.Map {
  return created;
}

beforeAll(() => {
  // jsdom has no 2D canvas; give Leaflet's canvas renderer something to draw on.
  const context = new Proxy({}, { get: () => () => undefined, set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);

  box = document.createElement('div');
  Object.defineProperty(box, 'clientWidth', { value: 600 });
  Object.defineProperty(box, 'clientHeight', { value: 400 });
  document.body.append(box);
  const factory = vi.spyOn(L, 'map');
  initMap(box, provinces, { lang: 'en', labels: LABELS });
  created = factory.mock.results[0].value as L.Map;
  onAreaChange((area) => picked.push(area));
});

describe('the map', () => {
  it('starts on the whole country with the provinces and only the two drawing tools', () => {
    const map = leafletMap();
    expect(map.getZoom()).toBe(4);
    expect(map.getCenter().lat).toBeCloseTo(-38.4, 5);
    expect(map.getCenter().lng).toBeCloseTo(-63.6, 5);
    expect(box.querySelectorAll('path.leaflet-interactive').length).toBeGreaterThanOrEqual(2);
    const tools = Array.from(box.querySelectorAll('.leaflet-pm-toolbar .leaflet-buttons-control-button')).map(
      (button) => button.querySelector('.control-icon')?.className ?? '',
    );
    expect(tools.some((name) => name.includes('polygon'))).toBe(true);
    expect(tools.some((name) => name.includes('rectangle'))).toBe(true);
    expect(tools).toHaveLength(2);
    // The rectangle comes first.
    expect(tools[0]).toContain('rectangle');
    // Leaflet-Geoman gives its buttons no name; the page does.
    const names = Array.from(box.querySelectorAll('.leaflet-pm-toolbar [aria-label]')).map((button) => button.getAttribute('aria-label'));
    expect(names.sort()).toEqual(['Draw a polygon', 'Draw a rectangle']);
    expect(box.querySelector('.leaflet-control-attribution')!.textContent).toContain('OpenStreetMap');
  });

  it('reports a clicked province', () => {
    picked.length = 0;
    const map = leafletMap();
    map.eachLayer((layer) => {
      const feature = (layer as L.Layer & { feature?: { properties?: { id?: string } } }).feature;
      if (feature?.properties?.id === '42') layer.fire('click');
    });
    expect(picked).toEqual([{ kind: 'province', id: '42' }]);
  });

  it('reports a drawn shape as a polygon with 5-decimal corners, and does not keep the drawing', () => {
    picked.length = 0;
    const map = leafletMap();
    const drawn = L.polygon([
      [-28.7000004, -58.3],
      [-28.7, -57.5],
      [-28.3, -57.5123456],
    ]).addTo(map);
    map.fire('pm:create', { shape: 'Polygon', layer: drawn });
    expect(picked).toEqual([
      { kind: 'polygon', ring: [[-58.3, -28.7], [-57.5, -28.7], [-57.51235, -28.3]] },
    ]);
    expect(map.hasLayer(drawn)).toBe(false);
  });

  it('shows a province, a circle and the nation without failing, and moves to them', () => {
    const map = leafletMap();
    const fit = vi.spyOn(map, 'fitBounds');
    setArea({ kind: 'province', id: '18' }, null, { fit: true });
    expect(fit).toHaveBeenCalledTimes(1);
    // The move is not animated: an animated zoom never finishes in a tab that is not in front,
    // which left a province opened from a link half off the map.
    expect(fit.mock.calls[0][1]).toMatchObject({ animate: false, maxZoom: 10 });
    const corrientes = map.getBounds().getCenter();
    expect(corrientes.lat).toBeGreaterThan(-29);
    expect(corrientes.lat).toBeLessThan(-28);
    setArea({ kind: 'circle', lat: -28.5, lon: -57.9, km: 25 }, circle(-28.5, -57.9, 25), { fit: true });
    expect(fit).toHaveBeenCalledTimes(2);
    setArea({ kind: 'circle', lat: -28.5, lon: -57.9, km: 25 }, circle(-28.5, -57.9, 25), { fit: false });
    expect(fit).toHaveBeenCalledTimes(2);
    // The nation: the whole country in view, at zoom 4 at most, however short the map is.
    setArea({ kind: 'province', id: 'AR' }, null, { fit: true });
    expect(fit).toHaveBeenCalledTimes(3);
    expect(fit.mock.calls[2][1]).toMatchObject({ animate: false, maxZoom: 4 });
    expect(map.getZoom()).toBeLessThanOrEqual(4);
    const view = map.getBounds();
    expect(view.getSouth()).toBeLessThan(-36.9); // the sample's two provinces lie between -36.9 and -28.1
    expect(view.getNorth()).toBeGreaterThan(-28.1);
  });

  it('draws and clears dots', () => {
    const map = leafletMap();
    const before = Object.keys((map as unknown as { _layers: object })._layers).length;
    showDots({ lat: Float64Array.of(-28.5, -28.6, -28.7), lon: Float64Array.of(-57.9, -57.8, -57.7), count: 2 });
    const during = Object.keys((map as unknown as { _layers: object })._layers).length;
    expect(during).toBeGreaterThanOrEqual(before + 2);
    clearDots();
    expect(Object.keys((map as unknown as { _layers: object })._layers).length).toBeLessThan(during);
    clearDots();
  });

  it('does not take the scroll wheel until it has been clicked or focused', () => {
    const map = leafletMap();
    // A wheel over the map scrolls the page...
    expect(map.scrollWheelZoom.enabled()).toBe(false);
    // ...until the reader clicks the map; leaving it hands the wheel back to the page.
    box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(map.scrollWheelZoom.enabled()).toBe(true);
    box.dispatchEvent(new MouseEvent('mouseleave'));
    expect(map.scrollWheelZoom.enabled()).toBe(false);
    // Keyboard focus counts as well.
    box.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(map.scrollWheelZoom.enabled()).toBe(true);
    box.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: document.body }));
    expect(map.scrollWheelZoom.enabled()).toBe(false);
    // With a mouse, dragging never blocks the page, so it stays on, and there is no hint.
    expect(map.dragging.enabled()).toBe(true);
    expect(box.querySelector<HTMLElement>('.map-hint')!.hidden).toBe(true);
  });

  it('zooms with the wheel continuously, and draws its shapes well past the edge of the view', () => {
    const map = leafletMap();
    // Leaflet's own wheel zoom moves in half-level jumps; the map uses its own instead.
    expect(map.scrollWheelZoom).toBeInstanceOf(SmoothWheelZoom);
    // Zooming out shows what lay outside the view: the outlines and the dots are drawn there already.
    let outlinesPadding = 0;
    map.eachLayer((layer) => {
      if ((layer as L.Path & { feature?: unknown }).feature) outlinesPadding = map.getRenderer(layer as L.Path).options.padding ?? 0;
    });
    expect(outlinesPadding).toBeGreaterThanOrEqual(0.5);
    let dotsPadding = 0;
    showDots({ lat: Float64Array.of(-28.5), lon: Float64Array.of(-57.9), count: 1 });
    map.eachLayer((layer) => {
      const renderer = (layer as L.CircleMarker).options?.renderer;
      if (renderer) dotsPadding = renderer.options.padding ?? 0;
    });
    clearDots();
    expect(dotsPadding).toBeGreaterThanOrEqual(0.5);
  });

  describe('the rectangle tool', () => {
    const button = () => box.querySelector('.leaflet-pm-toolbar .leaflet-pm-icon-rectangle')!.closest('a')!;
    const polygonButton = () => box.querySelector('.leaflet-pm-toolbar .leaflet-pm-icon-polygon')!.closest('a')!;
    const pressed = () => button().closest('.button-container')!.classList.contains('active');
    const hint = () => box.querySelector<HTMLElement>('.draw-hint')!;
    const pointer = (type: string, x: number, y: number) =>
      box.dispatchEvent(
        new PointerEvent(type, { clientX: x, clientY: y, button: 0, isPrimary: true, pointerId: 1, bubbles: true, cancelable: true }),
      );
    const clickProvince = (id: string) =>
      leafletMap().eachLayer((layer) => {
        const feature = (layer as L.Layer & { feature?: { properties?: { id?: string } } }).feature;
        if (feature?.properties?.id === id) layer.fire('click');
      });

    it('draws with one press, drag and release once its button is on, and reports the rectangle as a polygon', () => {
      picked.length = 0;
      const map = leafletMap();
      expect(hint().hidden).toBe(true);
      button().click();
      expect(pressed()).toBe(true);
      expect(box.classList.contains('drawing-rectangle')).toBe(true);
      // One line says what to do, since nothing happens on a plain click.
      expect(hint().hidden).toBe(false);
      expect(hint().textContent).toBe('Press and drag on the map');
      // Dragging draws now; it must not move the map as well.
      expect(map.dragging.enabled()).toBe(false);
      // A click on a province while the tool is on is not a choice of that province.
      clickProvince('42');
      expect(picked).toEqual([]);

      const from = map.containerPointToLatLng(L.point(100, 100));
      const to = map.containerPointToLatLng(L.point(300, 250));
      pointer('pointerdown', 100, 100);
      pointer('pointermove', 200, 200);
      pointer('pointerup', 300, 250);

      expect(picked).toHaveLength(1);
      const area = picked[0] as Extract<Area, { kind: 'polygon' }>;
      expect(area.kind).toBe('polygon');
      expect(area.ring).toHaveLength(4);
      expect(area.ring[0][0]).toBeCloseTo(from.lng, 4); // south-west
      expect(area.ring[0][1]).toBeCloseTo(to.lat, 4);
      expect(area.ring[2][0]).toBeCloseTo(to.lng, 4); // north-east
      expect(area.ring[2][1]).toBeCloseTo(from.lat, 4);
      // The tool has switched itself off, as in a slide editor: one shape per press of the button.
      expect(pressed()).toBe(false);
      expect(box.classList.contains('drawing-rectangle')).toBe(false);
      expect(hint().hidden).toBe(true);
      expect(map.dragging.enabled()).toBe(true);
      // Provinces can be clicked again.
      picked.length = 0;
      clickProvince('42');
      expect(picked).toEqual([{ kind: 'province', id: '42' }]);
    });

    it('is switched off by its Cancel action, by Escape, and by starting the polygon tool', () => {
      const map = leafletMap();
      button().click();
      expect(box.classList.contains('drawing-rectangle')).toBe(true);
      button().closest('.button-container')!.querySelector<HTMLElement>('.action-cancel')!.click();
      expect(box.classList.contains('drawing-rectangle')).toBe(false);
      expect(pressed()).toBe(false);

      button().click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(box.classList.contains('drawing-rectangle')).toBe(false);
      expect(pressed()).toBe(false);
      expect(map.dragging.enabled()).toBe(true);

      button().click();
      polygonButton().click();
      expect(box.classList.contains('drawing-rectangle')).toBe(false);
      expect(pressed()).toBe(false);
      expect(map.pm.globalDrawModeEnabled()).toBe(true);
      // And the other way round: the rectangle tool ends a polygon that was being drawn.
      button().click();
      expect(map.pm.globalDrawModeEnabled()).toBe(false);
      expect(box.classList.contains('drawing-rectangle')).toBe(true);
      button().click();
      expect(box.classList.contains('drawing-rectangle')).toBe(false);
    });
  });

  it('mutes the street map under the provinces with a grey filter, and only that layer', () => {
    const tiles: L.TileLayer[] = [];
    leafletMap().eachLayer((layer) => {
      if (layer instanceof L.TileLayer) tiles.push(layer);
    });
    const base = tiles.find((layer) => (layer as unknown as { _url: string })._url.includes('tile.openstreetmap.org'))!;
    expect(base.options.className).toBe('base-tiles');
    // The same tiles from the same service: a CSS filter greys them, nothing new is fetched.
    const css = readFileSync(join(process.cwd(), 'src', 'style.css'), 'utf8');
    const rule = /\.base-tiles\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/filter:\s*grayscale\(1\)/);
  });

  it('gives each trend colour 3 to 1 against the greyed land, as it is drawn (with its opacity)', () => {
    const luminance = (color: { r: number; g: number; b: number }) => {
      const linear = (channel: number) => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
    };
    const land = rgb(GREYED_LAND);
    for (const tone of ['falling', 'none', 'rising'] as const) {
      const fill = rgb(TONE_FILL[tone]);
      const drawn = {
        r: fill.r * TREND_FILL_OPACITY + land.r * (1 - TREND_FILL_OPACITY),
        g: fill.g * TREND_FILL_OPACITY + land.g * (1 - TREND_FILL_OPACITY),
        b: fill.b * TREND_FILL_OPACITY + land.b * (1 - TREND_FILL_OPACITY),
      };
      const [light, dark] = [luminance(land), luminance(drawn)].sort((a, b) => b - a);
      expect((light + 0.05) / (dark + 0.05), tone).toBeGreaterThanOrEqual(3);
    }
  });

  describe('provinces coloured by their trend', () => {
    const LEGEND = {
      title: 'Trend since 2003',
      falling: 'Falling',
      none: 'No significant trend',
      rising: 'Rising',
      unrated: 'Too little fire',
      unsure: 'Dashed outline: the trend fails its check',
    };
    /** The drawn outline of a province. */
    const outline = (id: string): SVGPathElement => {
      let found: SVGPathElement | null = null;
      leafletMap().eachLayer((layer) => {
        const path = layer as L.Path & { feature?: { properties?: { id?: string } } };
        if (path.feature?.properties?.id === id) found = path.getElement() as SVGPathElement;
      });
      return found!;
    };
    const legend = () => box.querySelector<HTMLElement>('.trend-legend');

    it('fills each province by its trend, dashes the outline of one whose trend fails its check, and explains both', () => {
      setArea({ kind: 'province', id: 'AR' }, null, { fit: false });
      expect(legend()).toBeNull();
      setProvinceTrends({ tones: { '18': { tone: 'falling', unsure: false }, '42': { tone: 'rising', unsure: true } }, legend: LEGEND });
      expect(outline('18').getAttribute('fill')).toBe(TONE_FILL.falling);
      expect(Number(outline('18').getAttribute('fill-opacity'))).toBeGreaterThanOrEqual(0.4);
      expect(outline('18').getAttribute('stroke-dasharray')).toBeNull();
      expect(outline('42').getAttribute('fill')).toBe(TONE_FILL.rising);
      expect(outline('42').getAttribute('stroke-dasharray')).not.toBeNull();
      // White dashes, drawn above the neighbours: dark dashes vanish on a dark fill.
      expect(outline('42').getAttribute('stroke')).toBe('#ffffff');
      expect(Number(outline('42').getAttribute('stroke-width'))).toBeGreaterThanOrEqual(2);
      expect(outline('42').parentElement!.lastElementChild).toBe(outline('42'));
      // Blue and orange, never red against green; and the legend says what each means.
      const text = legend()!.textContent!;
      for (const label of Object.values(LEGEND)) expect(text).toContain(label);
      expect(legend()!.querySelectorAll('.swatch')).toHaveLength(5);
      // In the corner over the Atlantic: the lower left would cover Patagonia.
      expect(legend()!.closest('.leaflet-bottom.leaflet-right')).not.toBeNull();
    });

    it('folds the legend to its title on a narrow map, so it does not cover the provinces, and opens it on a wide one', () => {
      const size = vi.spyOn(leafletMap(), 'getSize').mockReturnValue(L.point(340, 240));
      setProvinceTrends({ tones: { '18': { tone: 'falling', unsure: false }, '42': { tone: 'rising', unsure: true } }, legend: LEGEND });
      const folded = legend() as HTMLDetailsElement;
      expect(folded.tagName).toBe('DETAILS');
      expect(folded.open).toBe(false);
      expect(folded.querySelector('summary')!.textContent).toBe('Trend since 2003');
      // Folded, every word is still there for whoever opens it.
      expect(folded.querySelectorAll('.swatch')).toHaveLength(5);
      size.mockReturnValue(L.point(600, 400));
      setProvinceTrends({ tones: { '18': { tone: 'falling', unsure: false }, '42': { tone: 'rising', unsure: true } }, legend: LEGEND });
      expect((legend() as HTMLDetailsElement).open).toBe(true);
      size.mockRestore();
    });

    it('keeps the selected province in the selection colours', () => {
      setArea({ kind: 'province', id: '18' }, null, { fit: false });
      expect(outline('18').getAttribute('stroke')).toBe('#1f4e79');
      expect(outline('18').getAttribute('fill')).toBe('#1f4e79');
      expect(outline('42').getAttribute('fill')).toBe(TONE_FILL.rising);
    });

    it('updates the legend’s words without stacking a second legend', () => {
      setProvinceTrends({ tones: { '18': { tone: 'none', unsure: false } }, legend: { ...LEGEND, title: 'Tendencia desde 2003' } });
      expect(box.querySelectorAll('.trend-legend')).toHaveLength(1);
      expect(legend()!.textContent).toContain('Tendencia desde 2003');
      expect(outline('18').getAttribute('fill')).toBe('#1f4e79'); // still selected
      // A province the tones do not name is left as a plain outline.
      expect(Number(outline('42').getAttribute('fill-opacity'))).toBeLessThan(0.1);
    });

    it('goes back to plain outlines and takes the legend away when switched off', () => {
      setArea({ kind: 'province', id: 'AR' }, null, { fit: false });
      setProvinceTrends(null);
      expect(legend()).toBeNull();
      expect(outline('18').getAttribute('fill')).toBe('#1c1b19');
      expect(Number(outline('18').getAttribute('fill-opacity'))).toBeLessThan(0.1);
      expect(outline('42').getAttribute('stroke-dasharray')).toBeNull();
    });
  });

  it('follows the size of its box when asked', () => {
    const map = leafletMap();
    const resized = vi.spyOn(map, 'invalidateSize');
    refreshMapSize();
    expect(resized).toHaveBeenCalledTimes(1);
  });

  describe('the optional CONAE radar mosaic', () => {
    const toggle = () => box.querySelector<HTMLInputElement>('.overlay-toggle input[type="checkbox"]')!;
    const status = () => box.querySelector<HTMLElement>('.overlay-status')!;
    const wmsLayers = () => {
      const found: L.TileLayer.WMS[] = [];
      leafletMap().eachLayer((layer) => {
        if ((layer as L.TileLayer.WMS).wmsParams) found.push(layer as L.TileLayer.WMS);
      });
      return found;
    };
    const flip = (on: boolean) => {
      toggle().checked = on;
      toggle().dispatchEvent(new Event('change', { bubbles: true }));
    };

    it('is one labelled toggle on the map, off at first, and asks CONAE for nothing until it is turned on', () => {
      expect(box.querySelector('.overlay-toggle')!.textContent).toBe('Radar mosaic 2022 (CONAE SAOCOM)');
      expect(toggle().checked).toBe(false);
      expect(status().hidden).toBe(true);
      expect(wmsLayers()).toHaveLength(0);
      expect(box.innerHTML).not.toContain('conae.gov.ar');
      expect(box.querySelector('.leaflet-control-attribution')!.textContent).not.toContain('CONAE');
    });

    it('adds the mosaics as one WMS layer with their attribution when turned on, and removes them when turned off', () => {
      flip(true);
      const layers = wmsLayers();
      expect(layers).toHaveLength(1);
      expect((layers[0] as unknown as { _url: string })._url).toBe('https://geoportal.conae.gov.ar/geoserver/saocom_mosaicos/wms');
      expect(layers[0].wmsParams).toMatchObject({ format: 'image/png', transparent: true, service: 'WMS', request: 'GetMap' });
      expect(String(layers[0].wmsParams.layers).split(',')).toHaveLength(24);
      expect(layers[0].options.opacity).toBe(0.7);
      expect(box.querySelector('.leaflet-control-attribution')!.textContent).toContain('SAOCOM mosaic: CONAE');
      flip(false);
      expect(wmsLayers()).toHaveLength(0);
      expect(box.querySelector('.leaflet-control-attribution')!.textContent).not.toContain('CONAE');
    });

    it('says so in one line when the service does not answer, and stops saying it once a tile arrives', () => {
      flip(true);
      const layer = wmsLayers()[0];
      layer.fire('tileerror');
      layer.fire('tileerror');
      expect(status().hidden).toBe(false);
      expect(status().textContent).toBe('CONAE’s map service did not respond.');
      // The rest of the map is untouched.
      expect(box.querySelectorAll('path.leaflet-interactive').length).toBeGreaterThanOrEqual(2);
      layer.fire('tileload');
      expect(status().hidden).toBe(true);
      // Turning it off clears the line as well.
      layer.fire('tileerror');
      flip(false);
      expect(status().hidden).toBe(true);
    });
  });

  it('switches the language of the drawing tools', () => {
    setMapLanguage('es', {
      ...LABELS,
      polygon: 'Dibujar un polígono',
      rectangle: 'Dibujar un rectángulo',
      rectangleHint: 'Mantené presionado y arrastrá sobre el mapa',
      overlay: 'Mosaico de radar 2022 (CONAE SAOCOM)',
    });
    expect(box.querySelector('.draw-hint')!.textContent).toBe('Mantené presionado y arrastrá sobre el mapa');
    // The rectangle tool still works after the toolbar was rebuilt in the other language.
    const rectangle = box.querySelector('.leaflet-pm-toolbar .leaflet-pm-icon-rectangle')!.closest('a')!;
    expect(rectangle.getAttribute('aria-label')).toBe('Dibujar un rectángulo');
    rectangle.click();
    expect(box.classList.contains('drawing-rectangle')).toBe(true);
    rectangle.click();
    expect(box.classList.contains('drawing-rectangle')).toBe(false);
    expect(box.querySelector('.overlay-toggle')!.textContent).toBe('Mosaico de radar 2022 (CONAE SAOCOM)');
    expect(box.querySelector('.leaflet-pm-toolbar [aria-label="Dibujar un polígono"]')).not.toBeNull();
    setMapLanguage('en', LABELS);
    expect(box.querySelector('.leaflet-pm-toolbar [aria-label="Draw a rectangle"]')).not.toBeNull();
    expect(box.querySelector('.overlay-toggle')!.textContent).toBe('Radar mosaic 2022 (CONAE SAOCOM)');
  });
});
