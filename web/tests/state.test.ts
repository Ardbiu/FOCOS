import { describe, expect, it } from 'vitest';
import {
  NATION,
  RADIUS_KM,
  YEAR_MAX,
  YEAR_MIN,
  clampRadius,
  csvDates,
  decodeState,
  defaultState,
  encodeState,
  sameArea,
  type AppState,
  type Area,
} from '../src/state';

function withArea(area: Area): AppState {
  return { ...defaultState(), area };
}

describe('defaults', () => {
  it('opens on all of Argentina, in English, harmonized, counting', () => {
    expect(defaultState()).toEqual({
      area: { kind: 'province', id: 'AR' },
      yearFrom: 2003,
      yearTo: 2026,
      dateFrom: null,
      dateTo: null,
      mode: 'count',
      view: 'harmonized',
      lang: 'en',
      sel: null,
    });
    expect(NATION).toEqual({ kind: 'province', id: 'AR' });
    expect([YEAR_MIN, YEAR_MAX]).toEqual([2003, 2026]);
    expect(RADIUS_KM).toEqual({ min: 5, max: 300, initial: 25 });
  });

  it('keeps the default view out of the address', () => {
    expect(encodeState(defaultState())).toBe('');
    expect(decodeState('')).toEqual(defaultState());
    expect(decodeState('#')).toEqual(defaultState());
  });
});

describe('areas survive an encode and decode round trip', () => {
  it('a province', () => {
    const state = withArea({ kind: 'province', id: '14' });
    expect(encodeState(state)).toBe('area=prov:14');
    expect(decodeState(encodeState(state))).toEqual(state);
    expect(decodeState('#area=prov:14')).toEqual(state);
  });

  it('a drawn polygon', () => {
    const state = withArea({
      kind: 'polygon',
      ring: [
        [-64.25, -31.5],
        [-63.75012, -31.5],
        [-63.9, -31.12345],
        [-64.3, -31.2],
      ],
    });
    expect(encodeState(state)).toBe('area=poly:-31.5,-64.25;-31.5,-63.75012;-31.12345,-63.9;-31.2,-64.3');
    expect(decodeState(encodeState(state))).toEqual(state);
  });

  it('a drawn polygon is kept to 5 decimals and without a repeated closing point', () => {
    const drawn = withArea({
      kind: 'polygon',
      ring: [
        [-64.2500004, -31.4999996],
        [-63.75, -31.5],
        [-63.9, -31.1],
        [-64.2500004, -31.4999996],
      ],
    });
    const back = decodeState(encodeState(drawn));
    expect(back.area).toEqual({
      kind: 'polygon',
      ring: [
        [-64.25, -31.5],
        [-63.75, -31.5],
        [-63.9, -31.1],
      ],
    });
    expect(encodeState(back)).toBe(encodeState(drawn));
  });

  it('a point and radius', () => {
    const state = withArea({ kind: 'circle', lat: -31.4, lon: -64.2, km: 25 });
    expect(encodeState(state)).toBe('area=circle:-31.4,-64.2,25');
    expect(decodeState(encodeState(state))).toEqual(state);
  });
});

describe('a malformed hash falls back to the national view', () => {
  const bad = [
    'area=prov:999',
    'area=prov:',
    'area=prov:1a',
    'area=poly:-31.5,-64.25;-31.5,-63.75', // two points are not an area
    'area=poly:-31.5,-64.25;x,y;-31.1,-63.9',
    'area=poly:-95,-64.25;-31.5,-63.75;-31.1,-63.9', // latitude out of range
    'area=circle:abc',
    'area=circle:-31.4',
    'area=circle:-31.4,-640.2,25',
    'area=star:1,2,3',
    'area=',
    'garbage',
    '%E0%A4%A',
    '&&&=&',
  ];
  for (const hash of bad) {
    it(`"${hash}"`, () => {
      expect(decodeState(hash).area).toEqual(NATION);
      expect(decodeState(`#${hash}`)).toEqual(defaultState());
    });
  }

  it('keeps the rest of the state when only the area is broken', () => {
    expect(decodeState('area=circle:abc&view=raw&sel=2020-08')).toEqual({
      ...defaultState(),
      view: 'raw',
      sel: 211,
    });
  });
});

describe('radius', () => {
  it('is clamped to 5 to 300 km', () => {
    expect(clampRadius(2)).toBe(5);
    expect(clampRadius(1000)).toBe(300);
    expect(clampRadius(42.5)).toBe(42.5);
    expect(clampRadius(Number.NaN)).toBe(25);
    expect(decodeState('area=circle:-31.4,-64.2,1').area).toEqual({ kind: 'circle', lat: -31.4, lon: -64.2, km: 5 });
    expect(decodeState('area=circle:-31.4,-64.2,5000').area).toEqual({ kind: 'circle', lat: -31.4, lon: -64.2, km: 300 });
    expect(decodeState('area=circle:-31.4,-64.2').area).toEqual({ kind: 'circle', lat: -31.4, lon: -64.2, km: 25 });
    expect(encodeState(withArea({ kind: 'circle', lat: -31.4, lon: -64.2, km: 900 }))).toBe('area=circle:-31.4,-64.2,300');
  });
});

describe('view, mode and language', () => {
  it('view=raw survives a round trip', () => {
    const state: AppState = { ...defaultState(), view: 'raw' };
    expect(encodeState(state)).toBe('view=raw');
    expect(decodeState(encodeState(state))).toEqual(state);
  });

  it('an unknown view falls back to harmonized', () => {
    expect(decodeState('view=sideways').view).toBe('harmonized');
    expect(decodeState('view=').view).toBe('harmonized');
    expect(decodeState('view=RAW').view).toBe('harmonized');
  });

  it('mode and language round trip, and unknown values fall back', () => {
    const state: AppState = { ...defaultState(), mode: 'anomaly', lang: 'es' };
    expect(encodeState(state)).toBe('mode=anomaly&lang=es');
    expect(decodeState(encodeState(state))).toEqual(state);
    expect(decodeState('mode=loud&lang=fr')).toEqual(defaultState());
  });
});

describe('selected month', () => {
  it('round trips as YYYY-MM', () => {
    const state: AppState = { ...defaultState(), sel: 211 };
    expect(encodeState(state)).toBe('sel=2020-08');
    expect(decodeState('sel=2020-08').sel).toBe(211);
    expect(decodeState('sel=2003-01').sel).toBe(0);
    expect(decodeState('sel=2026-11').sel).toBe(286);
  });

  it('ignores a month outside the series or a malformed one', () => {
    for (const sel of ['2026-12', '2002-12', '2020-13', '2020-00', '2020', 'aug', '']) {
      expect(decodeState(`sel=${sel}`).sel).toBeNull();
    }
  });
});

describe('year range and CSV dates', () => {
  it('the year range round trips', () => {
    const state: AppState = { ...defaultState(), yearFrom: 2010, yearTo: 2020 };
    expect(encodeState(state)).toBe('years=2010-2020');
    expect(decodeState(encodeState(state))).toEqual(state);
  });

  it('the year range is ordered and kept inside 2003 to 2026', () => {
    expect(decodeState('years=2020-2010')).toMatchObject({ yearFrom: 2010, yearTo: 2020 });
    expect(decodeState('years=1990-2050')).toMatchObject({ yearFrom: 2003, yearTo: 2026 });
    expect(decodeState('years=2015-2015')).toMatchObject({ yearFrom: 2015, yearTo: 2015 });
    expect(decodeState('years=abc')).toMatchObject({ yearFrom: 2003, yearTo: 2026 });
    expect(decodeState('years=2015')).toMatchObject({ yearFrom: 2003, yearTo: 2026 });
  });

  it('the CSV dates round trip', () => {
    const state: AppState = { ...defaultState(), dateFrom: '2020-08-01', dateTo: '2020-10-31' };
    expect(encodeState(state)).toBe('from=2020-08-01&to=2020-10-31');
    expect(decodeState(encodeState(state))).toEqual(state);
  });

  it('a date that does not exist is dropped, and reversed dates are put in order', () => {
    expect(decodeState('from=2020-02-30&to=2020-10-31')).toMatchObject({ dateFrom: null, dateTo: '2020-10-31' });
    expect(decodeState('from=yesterday')).toMatchObject({ dateFrom: null, dateTo: null });
    expect(decodeState('from=1999-01-01')).toMatchObject({ dateFrom: null });
    expect(decodeState('from=2021-01-01&to=2020-01-01')).toMatchObject({ dateFrom: '2020-01-01', dateTo: '2021-01-01' });
  });

  it('the CSV dates default to the range of the year slider, up to the end of the data', () => {
    const state: AppState = { ...defaultState(), yearFrom: 2010, yearTo: 2020 };
    expect(csvDates(state, '2026-11-14')).toEqual({ from: '2010-01-01', to: '2020-12-31' });
    expect(csvDates(defaultState(), '2026-11-14')).toEqual({ from: '2003-01-01', to: '2026-11-14' });
    expect(csvDates(defaultState(), '2025-12-31')).toEqual({ from: '2003-01-01', to: '2025-12-31' });
    // Dates the user picked win, but never run past the end of the data.
    expect(csvDates({ ...state, dateFrom: '2015-03-01' }, '2026-11-14')).toEqual({ from: '2015-03-01', to: '2020-12-31' });
    expect(csvDates({ ...state, dateTo: '2027-01-01' }, '2026-11-14')).toEqual({ from: '2010-01-01', to: '2026-11-14' });
  });
});

describe('whole state', () => {
  const state: AppState = {
    area: { kind: 'province', id: '14' },
    yearFrom: 2015,
    yearTo: 2025,
    dateFrom: '2020-01-01',
    dateTo: '2020-12-31',
    mode: 'anomaly',
    view: 'raw',
    lang: 'es',
    sel: 211,
  };

  it('is written in a fixed order', () => {
    expect(encodeState(state)).toBe(
      'area=prov:14&years=2015-2025&from=2020-01-01&to=2020-12-31&mode=anomaly&view=raw&lang=es&sel=2020-08',
    );
  });

  it('round trips, whatever the order of the parts, ignoring parts it does not know', () => {
    expect(decodeState(encodeState(state))).toEqual(state);
    expect(decodeState('#sel=2020-08&lang=es&utm=x&view=raw&mode=anomaly&to=2020-12-31&from=2020-01-01&years=2015-2025&area=prov:14')).toEqual(state);
  });

  it('reads an address the browser has percent-encoded', () => {
    expect(decodeState('#area=circle%3A-31.4%2C-64.2%2C25').area).toEqual({ kind: 'circle', lat: -31.4, lon: -64.2, km: 25 });
  });
});

describe('sameArea', () => {
  it('compares areas by value', () => {
    expect(sameArea({ kind: 'province', id: '14' }, { kind: 'province', id: '14' })).toBe(true);
    expect(sameArea({ kind: 'province', id: '14' }, { kind: 'province', id: '18' })).toBe(false);
    expect(sameArea({ kind: 'circle', lat: 1, lon: 2, km: 25 }, { kind: 'circle', lat: 1, lon: 2, km: 25 })).toBe(true);
    expect(sameArea({ kind: 'circle', lat: 1, lon: 2, km: 25 }, { kind: 'circle', lat: 1, lon: 2, km: 30 })).toBe(false);
    expect(sameArea({ kind: 'polygon', ring: [[1, 2], [3, 4], [5, 6]] }, { kind: 'polygon', ring: [[1, 2], [3, 4], [5, 6]] })).toBe(true);
    expect(sameArea({ kind: 'polygon', ring: [[1, 2], [3, 4], [5, 6]] }, NATION)).toBe(false);
  });
});
