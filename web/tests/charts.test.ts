// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  renderSeasonalProfile,
  renderYearlyBars,
  seasonalProfileModel,
  yearlyBarsModel,
} from '../src/charts';
import { monthIdx, monthOfIdx, trend, yearOfIdx, yearlyTotals, type Completeness, type YearValue } from '../src/stats';

const completeness: Completeness = {
  incomplete: new Set([monthIdx(2010, 9)]),
  lastCompleteYear: 2025,
  lastMonthIdx: 286,
  partial: { monthIdx: 286, lastDay: 14 },
};

/** August burns (100, or 300 in 2020); every other month holds 20. */
const monthly: number[] = Array.from({ length: 287 }, (_, idx) => (monthOfIdx(idx) === 8 ? (yearOfIdx(idx) === 2020 ? 300 : 100) : 20));

const years = (values: number[], notComplete: number[] = []): YearValue[] =>
  values.map((value, i) => ({ year: 2003 + i, value, complete: !notComplete.includes(2003 + i) }));

let box: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = '<div id="chart"></div>';
  box = document.getElementById('chart')!;
});

describe('yearlyBarsModel', () => {
  it('labels the top three years and hatches the years that are not complete', () => {
    const model = yearlyBarsModel(years([50, 70369, 300, 70344, 20, 35420, 900], [2009]), { view: 'harmonized', switchYear: 2012 });
    expect(model.bars.map((bar) => bar.label)).toEqual([null, '70k', null, '70k', null, '35k', null]);
    expect(model.bars.map((bar) => bar.hatched)).toEqual([false, false, false, false, false, false, true]);
    expect(model.max).toBe(70369);
    expect(model.bars[1].share).toBe(1);
    expect(model.bars[5].share).toBeCloseTo(35420 / 70369, 12);
    expect(model.topYear).toBe(2004);
    expect(model.empty).toBe(false);
  });

  it('breaks ties by the earlier year and never labels a year without fire', () => {
    expect(yearlyBarsModel(years([5, 5, 5, 5]), { view: 'harmonized', switchYear: 2012 }).bars.map((bar) => bar.label)).toEqual(['5', '5', '5', null]);
    expect(yearlyBarsModel(years([0, 7, 0, 0]), { view: 'harmonized', switchYear: 2012 }).bars.map((bar) => bar.label)).toEqual([null, '7', null, null]);
  });

  it('says when there is no fire at all', () => {
    const model = yearlyBarsModel(years([0, 0, 0]), { view: 'harmonized', switchYear: 2012 });
    expect(model.empty).toBe(true);
    expect(model.bars.every((bar) => bar.label === null && bar.share === 0)).toBe(true);
    expect(yearlyBarsModel([], { view: 'raw', switchYear: 2012 }).empty).toBe(true);
  });

  it('marks the sensor switch only when the years on both sides are there', () => {
    expect(yearlyBarsModel(yearlyTotals(monthly, completeness), { view: 'raw', switchYear: 2012 }).switchYear).toBe(2012);
    expect(yearlyBarsModel(years([1, 2, 3]), { view: 'raw', switchYear: 2012 }).switchYear).toBeNull();
  });

  it('follows the totals it is given: 2026 is partial and 2010 has an incomplete month', () => {
    const model = yearlyBarsModel(yearlyTotals(monthly, completeness), { view: 'harmonized', switchYear: 2012 });
    expect(model.bars).toHaveLength(24);
    expect(model.bars.filter((bar) => bar.hatched).map((bar) => bar.year)).toEqual([2010, 2026]);
    expect(model.bars.find((bar) => bar.year === 2020)!.label).toBe('520');
  });
});

describe('the trend line of the yearly totals', () => {
  /** Twelve complete years that fall by 10 a year from 200, and a thirteenth, partial year. */
  const falling = years([200, 190, 180, 170, 160, 150, 140, 130, 120, 110, 100, 90, 40], [2015]);
  const options = { view: 'harmonized' as const, switchYear: 2012 };

  it('runs from the first to the last complete year, along the fitted trend', () => {
    const fitted = trend(falling);
    expect('reason' in fitted ? null : fitted.direction).toBe('falling');
    const model = yearlyBarsModel(falling, { ...options, trend: fitted });
    expect(model.trendLine).toEqual({ fromYear: 2003, fromValue: 200, toYear: 2014, toValue: 90 });
  });

  it('is left out when no trend is given, when the trend is not clear, and when it could not be assessed', () => {
    expect(yearlyBarsModel(falling, options).trendLine).toBeNull();
    const flat = years([100, 120, 90, 110, 100, 95, 115, 105, 98, 112, 101, 99]);
    const none = trend(flat);
    expect('reason' in none ? null : none.direction).toBe('none');
    expect(yearlyBarsModel(flat, { ...options, trend: none }).trendLine).toBeNull();
    expect(yearlyBarsModel(years([200, 190, 180]), { ...options, trend: trend(years([200, 190, 180])) }).trendLine).toBeNull();
  });

  it('is never drawn over raw counts, whose rise is the change of sensor', () => {
    expect(yearlyBarsModel(falling, { view: 'raw', switchYear: 2012, trend: trend(falling) }).trendLine).toBeNull();
  });

  it('is cut off where it reaches zero, instead of running below the chart or bending', () => {
    const steep = years([400, 330, 280, 200, 150, 90, 40, 12, 12, 12, 12, 12]);
    const fitted = trend(steep);
    if ('reason' in fitted) throw new Error('the fixture has no trend');
    expect(fitted.direction).toBe('falling');
    // The fitted line is below zero by the last year.
    expect(fitted.startValue + fitted.slope * 11).toBeLessThan(0);
    const line = yearlyBarsModel(steep, { ...options, trend: fitted }).trendLine!;
    expect(line.fromYear).toBe(2003);
    expect(line.fromValue).toBe(fitted.startValue);
    expect(line.toValue).toBe(0);
    expect(line.toYear).toBeGreaterThan(2003);
    expect(line.toYear).toBeLessThan(2014);
    expect((line.toValue - line.fromValue) / (line.toYear - line.fromYear)).toBeCloseTo(fitted.slope, 9);
  });

  it('makes room when the fitted line starts above the tallest bar', () => {
    const lowStart = years([100, 300, 290, 280, 270, 260, 250, 240, 230, 220, 210, 200]);
    const fitted = trend(lowStart);
    if ('reason' in fitted) throw new Error('the fixture has no trend');
    expect(fitted.startValue).toBeGreaterThan(300);
    const model = yearlyBarsModel(lowStart, { ...options, trend: fitted });
    renderYearlyBars(box, model, { lang: 'en', areaName: 'Corrientes', width: 650 });
    const tallest = box.querySelector('g.year-bar[data-year="2004"] rect')!;
    const line = box.querySelector('line.trend-line')!;
    // The line starts at the top of the plot, and the tallest bar ends below it, in proportion.
    const base = Number(tallest.getAttribute('y')) + Number(tallest.getAttribute('height'));
    const plot = base - Number(line.getAttribute('y1'));
    expect(Number(tallest.getAttribute('height'))).toBeCloseTo((300 / fitted.startValue) * plot, 6);
    expect(Number(line.getAttribute('y1'))).toBeGreaterThanOrEqual(20);
  });

  it('is drawn from the middle of its first bar to the middle of its last, at the fitted heights', () => {
    const model = yearlyBarsModel(falling, { ...options, trend: trend(falling) });
    renderYearlyBars(box, model, { lang: 'en', areaName: 'Corrientes', width: 650 });
    const line = box.querySelector('line.trend-line')!;
    expect(line).not.toBeNull();
    const band = 650 / 13;
    expect(Number(line.getAttribute('x1'))).toBeCloseTo(band / 2, 6);
    expect(Number(line.getAttribute('x2'))).toBeCloseTo(11 * band + band / 2, 6);
    // The tallest bar (200) reaches the top of the plot; the line starts there and ends at 90/200 of the height.
    const top = Number(box.querySelector('g.year-bar rect')!.getAttribute('y'));
    const base = top + Number(box.querySelector('g.year-bar rect')!.getAttribute('height'));
    expect(Number(line.getAttribute('y1'))).toBeCloseTo(top, 6);
    expect(Number(line.getAttribute('y2'))).toBeCloseTo(base - (90 / 200) * (base - top), 6);
    // It says what it is to a screen reader, and sits above the bars.
    expect(box.querySelector('g.trend title')!.textContent).toBe('Trend fitted to the complete years');
    const marks = Array.from(box.querySelectorAll('svg > g'));
    expect(marks.indexOf(box.querySelector('g.trend')!)).toBeGreaterThan(marks.indexOf(box.querySelectorAll('g.year-bar')[12]));
  });

  it('is not drawn where the model has none', () => {
    renderYearlyBars(box, yearlyBarsModel(falling, options), { lang: 'en', areaName: 'Corrientes', width: 650 });
    expect(box.querySelector('.trend-line')).toBeNull();
    expect(box.querySelector('g.trend')).toBeNull();
  });
});

describe('renderYearlyBars', () => {
  const options = { lang: 'en' as const, areaName: 'Córdoba', width: 640 };

  it('draws one bar per year, with the top three labelled and partial years hatched', () => {
    renderYearlyBars(box, yearlyBarsModel(yearlyTotals(monthly, completeness), { view: 'harmonized', switchYear: 2012 }), options);
    const bars = Array.from(box.querySelectorAll('g.year-bar'));
    expect(bars).toHaveLength(24);
    expect(box.querySelectorAll('.year-bar-label')).toHaveLength(3);
    expect(Array.from(box.querySelectorAll('.year-bar-hatch')).map((hatch) => hatch.parentElement!.getAttribute('data-year'))).toEqual(['2010', '2026']);
    expect(bars[17].getAttribute('aria-label')).toBe('2020: 520 MODIS-equivalent hotspots');
    expect(bars[23].getAttribute('aria-label')).toBe('2026: 300 MODIS-equivalent hotspots (year not complete)');
    expect(bars[17].querySelector('title')!.textContent).toBe('2020: 520 MODIS-equivalent hotspots');
    expect(box.querySelector('svg')!.getAttribute('aria-label')).toBe('Yearly totals for Córdoba, 2003 to 2026. The highest year is 2020.');
    expect(box.querySelector('.year-switch')!.textContent).toBe('VIIRS from 2012');
    expect(box.innerHTML).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('names raw counts as raw detections', () => {
    const raw = monthly.map((value, idx) => (idx >= 109 ? value * 4 : value));
    renderYearlyBars(box, yearlyBarsModel(yearlyTotals(raw, completeness), { view: 'raw', switchYear: 2012 }), options);
    expect(box.querySelector('g.year-bar[data-year="2020"]')!.getAttribute('aria-label')).toBe('2020: 2,080 raw detections');
  });

  it('explains an empty chart instead of drawing it', () => {
    renderYearlyBars(box, yearlyBarsModel(years([0, 0, 0]), { view: 'harmonized', switchYear: 2012 }), options);
    expect(box.querySelector('svg')).toBeNull();
    expect(box.textContent).toBe('No hotspots were recorded in this area.');
  });

  it('names the two eras under the bars: MODIS up to the switch, VIIRS after it, harmonized or raw', () => {
    renderYearlyBars(box, yearlyBarsModel(yearlyTotals(monthly, completeness), { view: 'harmonized', switchYear: 2012 }), options);
    const eras = () => Array.from(box.querySelectorAll<SVGTextElement>('text.year-era'));
    expect(eras().map((era) => era.textContent)).toEqual(['MODIS', 'VIIRS, harmonized']);
    // Below the year numbers, each centred under its own years: 2003–2011 and 2012–2026 of 24 bars.
    const yearNumber = Array.from(box.querySelectorAll<SVGTextElement>('text')).find((text) => text.textContent === '2005')!;
    for (const era of eras()) expect(Number(era.getAttribute('y'))).toBeGreaterThan(Number(yearNumber.getAttribute('y')));
    const band = 640 / 24;
    expect(Number(eras()[0].getAttribute('x'))).toBeCloseTo(4.5 * band, 0);
    expect(Number(eras()[1].getAttribute('x'))).toBeCloseTo(9 * band + 7.5 * band, 0);
    expect(box.querySelectorAll('line.year-era-line')).toHaveLength(2);
    const raw = monthly.map((value, idx) => (idx >= 109 ? value * 4 : value));
    renderYearlyBars(box, yearlyBarsModel(yearlyTotals(raw, completeness), { view: 'raw', switchYear: 2012 }), options);
    expect(eras().map((era) => era.textContent)).toEqual(['MODIS', 'VIIRS, raw']);
    renderYearlyBars(box, yearlyBarsModel(yearlyTotals(monthly, completeness), { view: 'harmonized', switchYear: 2012 }), { ...options, lang: 'es' });
    expect(eras().map((era) => era.textContent)).toEqual(['MODIS', 'VIIRS, armonizado']);
  });

  it('leaves the eras out when the chart does not show both sides of the switch', () => {
    renderYearlyBars(box, yearlyBarsModel(years([10, 20, 30]), { view: 'harmonized', switchYear: 2012 }), options);
    expect(box.querySelector('text.year-era')).toBeNull();
  });

  it('fits a phone', () => {
    renderYearlyBars(box, yearlyBarsModel(yearlyTotals(monthly, completeness), { view: 'harmonized', switchYear: 2012 }), { ...options, width: 309 });
    expect(box.querySelector('svg')!.getAttribute('width')).toBe('309');
    for (const rect of box.querySelectorAll('g.year-bar rect')) {
      expect(Number(rect.getAttribute('x')) + Number(rect.getAttribute('width'))).toBeLessThanOrEqual(309);
    }
  });
});

describe('an area with no fire, after an area with fire', () => {
  // A stand-in for the browser's ResizeObserver: the test decides when the box "changes size".
  let resize: Array<() => void> = [];
  let width = 640;
  beforeEach(() => {
    resize = [];
    width = 640;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: () => void) {}
        observe(): void {
          resize.push(this.callback);
        }
        disconnect(): void {}
      },
    );
    Object.defineProperty(box, 'clientWidth', { get: () => width, configurable: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const narrow = () => {
    width = 400;
    for (const callback of resize) callback();
  };
  const options = { lang: 'en' as const, areaName: 'Córdoba' };
  const noFire = new Array(287).fill(0);

  it('keeps the yearly chart explained, not redrawn with the old bars, when the box changes size', () => {
    renderYearlyBars(box, yearlyBarsModel(yearlyTotals(monthly, completeness), { view: 'harmonized', switchYear: 2012 }), options);
    expect(box.querySelectorAll('g.year-bar')).toHaveLength(24);
    renderYearlyBars(box, yearlyBarsModel(yearlyTotals(noFire, completeness), { view: 'harmonized', switchYear: 2012 }), options);
    expect(box.textContent).toBe('No hotspots were recorded in this area.');
    narrow();
    expect(box.querySelector('svg')).toBeNull();
    expect(box.textContent).toBe('No hotspots were recorded in this area.');
    // And a chart drawn after the empty one follows the new width.
    renderYearlyBars(box, yearlyBarsModel(yearlyTotals(monthly, completeness), { view: 'harmonized', switchYear: 2012 }), options);
    expect(box.querySelector('svg')!.getAttribute('width')).toBe('400');
  });

  it('does the same for the seasonal profile', () => {
    renderSeasonalProfile(box, seasonalProfileModel(monthly, completeness, 2020), options);
    expect(box.querySelector('path.profile-median')).not.toBeNull();
    renderSeasonalProfile(box, seasonalProfileModel(noFire, completeness, 2020), options);
    narrow();
    expect(box.querySelector('svg')).toBeNull();
    expect(box.textContent).toBe('No hotspots were recorded in this area.');
  });
});

describe('seasonalProfileModel', () => {
  it('gives the median and quartiles of each month over the complete years', () => {
    const model = seasonalProfileModel(monthly, completeness, 2020);
    expect(model.months).toHaveLength(12);
    expect(model.months[7]).toEqual({ month: 8, median: 100, q1: 100, q3: 100 });
    expect(model.months[0]).toEqual({ month: 1, median: 20, q1: 20, q3: 20 });
    expect([model.fromYear, model.toYear]).toEqual([2003, 2025]);
  });

  it('carries the selected year, month by month, and the top of the scale', () => {
    const model = seasonalProfileModel(monthly, completeness, 2020);
    expect(model.year).toBe(2020);
    expect(model.points).toHaveLength(12);
    expect(model.points[7]).toEqual({ month: 8, value: 300, status: 'complete' });
    expect(model.max).toBe(300);
    expect(model.empty).toBe(false);
  });

  it('stops the current year at the last month with data and flags the partial month', () => {
    const model = seasonalProfileModel(monthly, completeness, 2026);
    expect(model.points.map((point) => point.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(model.points[10]).toEqual({ month: 11, value: 20, status: 'partial' });
    expect(seasonalProfileModel(monthly, completeness, 2010).points[8].status).toBe('incomplete');
  });

  it('gives the partial month its own usual level, for the same days of the month in other years', () => {
    // Days 1–14 of November: 8 in every year, 12 this year. The full-month median (20) is not the comparison.
    const mtd = Array.from({ length: 24 }, (_, i) => (i === 23 ? 12 : 8));
    const model = seasonalProfileModel(monthly, completeness, 2026, mtd);
    expect(model.partialUsual).toEqual({ month: 11, day: 14, value: 8 });
    // Only for the current year, and only with month-to-date values.
    expect(seasonalProfileModel(monthly, completeness, 2020, mtd).partialUsual).toBeNull();
    expect(seasonalProfileModel(monthly, completeness, 2026).partialUsual).toBeNull();
    expect(seasonalProfileModel(monthly, completeness, 2026, []).partialUsual).toBeNull();
  });

  it('draws that usual level as a short mark beside the partial month, with its own legend entry', () => {
    const mtd = Array.from({ length: 24 }, (_, i) => (i === 23 ? 12 : 8));
    renderSeasonalProfile(box, seasonalProfileModel(monthly, completeness, 2026, mtd), { lang: 'en', areaName: 'Córdoba', width: 640 });
    const mark = box.querySelector<SVGLineElement>('line.profile-partial-usual')!;
    expect(mark).not.toBeNull();
    expect(mark.querySelector('title')!.textContent).toBe('Usual level for Nov 1–14: 8');
    expect(Array.from(box.querySelectorAll('text')).map((text) => text.textContent)).toContain('Usual level for Nov 1–14');
    renderSeasonalProfile(box, seasonalProfileModel(monthly, completeness, 2026, mtd), { lang: 'es', areaName: 'Córdoba', width: 640 });
    expect(Array.from(box.querySelectorAll('text')).map((text) => text.textContent)).toContain('Nivel habitual del 1 al 14 de nov');
  });

  it('keeps the year inside the years with data, and says when there is no fire', () => {
    expect(seasonalProfileModel(monthly, completeness, 2031).year).toBe(2026);
    expect(seasonalProfileModel(monthly, completeness, 1990).year).toBe(2003);
    const empty = seasonalProfileModel(new Array(287).fill(0), completeness, 2020);
    expect(empty.empty).toBe(true);
    expect(empty.max).toBeGreaterThan(0);
  });

  it('leaves incomplete months out of the baseline', () => {
    const spiked = monthly.slice();
    spiked[monthIdx(2010, 9)] = 1_000_000;
    expect(seasonalProfileModel(spiked, completeness, 2020).months[8]).toEqual({ month: 9, median: 20, q1: 20, q3: 20 });
  });
});

describe('renderSeasonalProfile', () => {
  const options = { lang: 'en' as const, areaName: 'Córdoba', width: 640 };

  it('draws the band, the median and the line of the selected year', () => {
    renderSeasonalProfile(box, seasonalProfileModel(monthly, completeness, 2020), options);
    expect(box.querySelector('path.profile-band')).not.toBeNull();
    expect(box.querySelector('path.profile-median')).not.toBeNull();
    expect(box.querySelectorAll('circle.profile-point')).toHaveLength(12);
    expect(box.querySelector('circle.profile-point title')!.textContent).toBe('Jan 2020: 20 MODIS-equivalent hotspots');
    const texts = Array.from(box.querySelectorAll('text')).map((text) => text.textContent);
    expect(texts).toEqual(expect.arrayContaining(['Median of 2003–2025', 'Middle half of years', '2020']));
    expect(texts).not.toContain('Partial or incomplete month');
    expect(box.querySelector('svg')!.getAttribute('aria-label')).toBe(
      'Seasonal profile for Córdoba: the median and the middle half of years for each month, with 2020.',
    );
    expect(box.innerHTML).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('draws partial and incomplete months as open points and says what they are', () => {
    renderSeasonalProfile(box, seasonalProfileModel(monthly, completeness, 2026), options);
    const open = Array.from(box.querySelectorAll('circle.profile-point[data-status="partial"]'));
    expect(open).toHaveLength(1);
    expect(open[0].getAttribute('fill')).toBe('#ffffff');
    expect(Array.from(box.querySelectorAll('text')).map((text) => text.textContent)).toContain('Partial or incomplete month');
  });

  it('explains an empty chart instead of drawing it', () => {
    renderSeasonalProfile(box, seasonalProfileModel(new Array(287).fill(0), completeness, 2020), options);
    expect(box.querySelector('svg')).toBeNull();
    expect(box.textContent).toBe('No hotspots were recorded in this area.');
  });

  it('is drawn in Spanish too', () => {
    renderSeasonalProfile(box, seasonalProfileModel(monthly, completeness, 2020), { ...options, lang: 'es' });
    expect(Array.from(box.querySelectorAll('text')).map((text) => text.textContent)).toContain('Mediana de 2003–2025');
  });
});
