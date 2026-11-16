// @vitest-environment jsdom
//
// The intro: a page shown over the app the first time someone opens the plain
// address. After they go in, the browser remembers, and the site opens straight
// on the app. A link to a particular view never shows it.
import { afterEach, describe, expect, it } from 'vitest';
import { INTRO_SEEN_KEY, drawIntroChart, introWanted, startIntro, type Intro, type IntroStorage } from '../src/intro';
import { byId, click, mountPage } from './helpers/page';

function memoryStorage(seen = false): IntroStorage & { values: Map<string, string> } {
  const values = new Map<string, string>(seen ? [[INTRO_SEEN_KEY, '1']] : []);
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
  };
}

/** A browser that refuses site storage (a locked-down or private window). */
const refusingStorage: IntroStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('SecurityError');
  },
};

/** The page's own parts, which the intro covers. */
function pageParts(): Element[] {
  return [...document.body.children].filter((child) => child.id !== 'intro');
}

let intro: Intro | null = null;

afterEach(() => {
  intro?.destroy();
  intro = null;
  document.documentElement.className = '';
});

describe('introWanted', () => {
  it('wants the intro on a first visit to the plain address, in either language', () => {
    expect(introWanted('', memoryStorage())).toBe(true);
    expect(introWanted('#lang=es', memoryStorage())).toBe(true);
  });

  it('skips it once it has been seen', () => {
    expect(introWanted('', memoryStorage(true))).toBe(false);
  });

  it('skips it for a link to a particular view, such as a story', () => {
    expect(introWanted('#area=prov:30&sel=2020-08', memoryStorage())).toBe(false);
    expect(introWanted('#view=raw', memoryStorage())).toBe(false);
  });

  it('shows it when the browser keeps no storage at all', () => {
    expect(introWanted('', null)).toBe(true);
    expect(introWanted('', refusingStorage)).toBe(true);
  });
});

describe('startIntro', () => {
  it('covers the page on a first visit: the page underneath cannot be reached, and the way in has the focus', () => {
    mountPage();
    intro = startIntro(document, memoryStorage());
    expect(intro.open).toBe(true);
    expect(byId('intro').hidden).toBe(false);
    expect(document.documentElement.classList.contains('intro-open')).toBe(true);
    for (const part of pageParts()) expect(part.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).toBe(byId('intro-enter'));
  });

  it('opens the app when the button is pressed, and remembers it', () => {
    mountPage();
    const storage = memoryStorage();
    intro = startIntro(document, storage);
    click('intro-enter');
    expect(intro.open).toBe(false);
    expect(byId('intro').hidden).toBe(true);
    expect(document.documentElement.classList.contains('intro-open')).toBe(false);
    for (const part of pageParts()) expect(part.hasAttribute('inert')).toBe(false);
    expect(storage.values.get(INTRO_SEEN_KEY)).toBe('1');
  });

  it('opens the app on Escape as well', () => {
    mountPage();
    const storage = memoryStorage();
    intro = startIntro(document, storage);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(byId('intro').hidden).toBe(true);
    expect(storage.values.get(INTRO_SEEN_KEY)).toBe('1');
  });

  it('opens straight on the app the next time', () => {
    mountPage();
    intro = startIntro(document, memoryStorage(true));
    expect(intro.open).toBe(false);
    expect(byId('intro').hidden).toBe(true);
    for (const part of pageParts()) expect(part.hasAttribute('inert')).toBe(false);
  });

  it('stays out of the way of a link to a particular view, and does not count it as seen', () => {
    mountPage('area=prov:30&sel=2020-08');
    const storage = memoryStorage();
    intro = startIntro(document, storage);
    expect(byId('intro').hidden).toBe(true);
    expect(storage.values.has(INTRO_SEEN_KEY)).toBe(false);
  });

  it('can be shown again from the link in the footer', () => {
    mountPage();
    intro = startIntro(document, memoryStorage(true));
    click('intro-reopen');
    expect(intro.open).toBe(true);
    expect(byId('intro').hidden).toBe(false);
    expect(document.activeElement).toBe(byId('intro-enter'));
    click('intro-enter');
    expect(byId('intro').hidden).toBe(true);
  });

  it('still lets people in when the browser refuses storage', () => {
    mountPage();
    intro = startIntro(document, refusingStorage);
    expect(intro.open).toBe(true);
    expect(() => click('intro-enter')).not.toThrow();
    expect(byId('intro').hidden).toBe(true);
  });

  it('ignores Escape when it is not showing', () => {
    mountPage();
    const storage = memoryStorage(true);
    intro = startIntro(document, storage);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(intro.open).toBe(false);
  });
});

describe('drawIntroChart', () => {
  const years = [
    { year: 2010, raw: 37_346, harmonized: 35_928 },
    { year: 2011, raw: 45_740, harmonized: 43_987 },
    { year: 2012, raw: 167_274, harmonized: 35_420 },
    { year: 2013, raw: 210_338, harmonized: 38_700 },
  ];

  function draw(lang: 'en' | 'es' = 'en'): HTMLElement {
    const box = document.createElement('div');
    document.body.append(box);
    drawIntroChart(box, years, 2012, lang);
    return box;
  }

  const height = (rect: Element) => Number(rect.getAttribute('height'));

  it('draws one raw and one harmonized bar per year, on one scale', () => {
    const box = draw();
    const raw = [...box.querySelectorAll('rect.intro-bar-raw')];
    const focos = [...box.querySelectorAll('rect.intro-bar-focos')];
    expect(raw).toHaveLength(4);
    expect(focos).toHaveLength(4);
    // Before the switch the two nearly agree; from it on, the stitched count jumps and Focos does not.
    expect(height(raw[1]) / height(focos[1])).toBeLessThan(1.1);
    expect(height(raw[2]) / height(focos[2])).toBeGreaterThan(4);
    expect(height(focos[2])).toBeCloseTo((height(focos[1]) * 35_420) / 43_987, 1);
  });

  it('marks the switch to VIIRS and names the first and last years', () => {
    const box = draw();
    const labels = [...box.querySelectorAll('text')].map((label) => label.textContent);
    expect(labels).toContain('VIIRS from 2012');
    expect(labels).toContain('2010');
    expect(labels).toContain('2013');
  });

  it('describes itself for a screen reader, and each year on hover', () => {
    const box = draw();
    const drawing = box.querySelector('svg')!;
    expect(drawing.getAttribute('role')).toBe('img');
    expect(drawing.getAttribute('aria-label')).toContain('2010');
    expect(drawing.getAttribute('aria-label')).toContain('2013');
    const titles = [...box.querySelectorAll('title')].map((title) => title.textContent);
    expect(titles.some((title) => title?.includes('2012') && title.includes('167,274') && title.includes('35,420'))).toBe(true);
  });

  it('speaks Spanish too', () => {
    const box = draw('es');
    const labels = [...box.querySelectorAll('text')].map((label) => label.textContent);
    expect(labels).toContain('VIIRS desde 2012');
  });

  it('draws nothing, and does not fail, without years', () => {
    const box = document.createElement('div');
    drawIntroChart(box, [], 2012, 'en');
    expect(box.querySelector('svg')).toBeNull();
  });
});
