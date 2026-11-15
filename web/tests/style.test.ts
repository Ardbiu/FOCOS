// Checks on the look that can be made without a screen: text contrast (WCAG AA
// asks for 4.5 to 1), the head of the two pages, and the favicon.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rgb } from 'd3';
import { describe, expect, it } from 'vitest';
import { RARE_COLOR, ZERO_COLOR, colorForAnomaly, colorForCount, inkOn } from '../src/calendar';
import { BAR, HIGHLIGHT, INK, MUTED } from '../src/drawing';
import en from '../src/i18n/en.json';
import { AQUA_COLOR, HARMONIZED_COLOR, RAW_COLOR } from '../src/method-charts';
import { fillHtmlText } from '../scripts/html-text.mjs';

const webDir = process.cwd();
const css = readFileSync(join(webDir, 'src', 'style.css'), 'utf8');

function luminance(color: string): number {
  const { r, g, b } = rgb(color);
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** The value of a custom property in :root. */
function token(name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!match) throw new Error(`style.css has no --${name}`);
  return match[1];
}

describe('text contrast (WCAG AA)', () => {
  it('holds for the page colours', () => {
    const pairs: Array<[string, string, string]> = [
      ['ink on paper', token('ink'), token('paper')],
      ['ink on surface', token('ink'), token('surface')],
      ['muted on paper', token('muted'), token('paper')],
      ['muted on surface', token('muted'), token('surface')],
      ['link on paper', token('accent'), token('paper')],
      ['link on surface', token('accent'), token('surface')],
      ['pressed button', token('surface'), token('ink')],
      ['ink on a notice', token('ink'), token('notice-bg')],
    ];
    for (const [name, foreground, background] of pairs) {
      expect(contrast(foreground, background), name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('holds for the text in the drawings', () => {
    expect(contrast(INK, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(MUTED, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(MUTED, token('paper'))).toBeGreaterThanOrEqual(4.5);
  });

  it('holds for the number printed in a calendar cell, whatever its colour', () => {
    const fills = [ZERO_COLOR, RARE_COLOR];
    for (let step = 0; step <= 100; step++) {
      fills.push(colorForCount((step / 100) ** 2 * 1000 + 0.001, 1000));
      fills.push(colorForAnomaly(10 * 2 ** (step / 25 - 2), 10));
    }
    for (const fill of fills) {
      expect(contrast(inkOn(fill), fill), fill).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps chart marks clear of their background (3 to 1 for graphics)', () => {
    for (const color of [BAR, HIGHLIGHT, AQUA_COLOR, RAW_COLOR, HARMONIZED_COLOR]) {
      expect(contrast(color, '#ffffff'), color).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('focus', () => {
  it('is always visible: nothing removes the outline without drawing another mark', () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline: 2px solid/);
    // Each rule that drops the outline belongs to an element whose focus is drawn another way
    // (the slider thumbs, the calendar cells), or that is only focused by script (the skip targets),
    // or that the keyboard cannot reach at all (the province outlines on the map: a mouse press
    // focuses them, because their tooltips listen for focus, and the browser then boxes the whole
    // province in a ring for the length of the click; with the keyboard a province is picked from the list).
    const dropped = Array.from(css.matchAll(/([^{}]+)\{[^}]*outline: none/g)).map((match) =>
      match[1].replace(/\/\*[\s\S]*?\*\//g, '').trim(),
    );
    expect(dropped.sort()).toEqual([
      '.calendar-svg g.cal-cell:focus',
      ".dual-range input[type='range']:focus-visible",
      '.map path.leaflet-interactive:focus',
      '.method:focus',
      '.results:focus',
    ]);
    expect(css).toContain('.calendar-svg g.cal-cell:focus-visible > rect:first-child');
    expect(css).toContain(".dual-range input[type='range']:focus-visible::-webkit-slider-thumb");
  });
});

describe('type', () => {
  /** The declarations of the first rule for `selector`. */
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    if (at < 0) throw new Error(`style.css has no rule for ${selector}`);
    return css.slice(at, css.indexOf('}', at));
  };

  it('gives the area title more weight than the card headings', () => {
    expect(rule('.results-head h2')).toMatch(/font-size:\s*2rem/);
  });

  it('sets numbers in the charts, the calendar and its tooltip in figures of one width, so columns line up', () => {
    for (const selector of ['.chart-svg', '.calendar-svg', '.cal-tooltip', '.cell-detail']) {
      expect(css, selector).toMatch(new RegExp(`${selector.replace('.', '\\.')}[^{]*\\{[^}]*font-variant-numeric:\\s*tabular-nums`));
    }
  });
});

describe('the head of each page', () => {
  for (const page of ['index.html', 'method.html']) {
    it(`${page}: description, share text and icon come from the English language file at build time`, () => {
      const source = readFileSync(join(webDir, page), 'utf8');
      expect(source).toContain('%i18n:app.description%');
      const built = fillHtmlText(source, en);
      expect(built).not.toContain('%i18n:');
      expect(built).toContain(`<meta name="description" content="${en.app.description}" />`);
      expect(built).toMatch(/<meta property="og:title" content="[^"%]+" \/>/);
      expect(built).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
      expect(built).toContain('<meta name="viewport" content="width=device-width, initial-scale=1" />');
    });
  }

  for (const page of ['index.html', 'method.html']) {
    it(`${page}: a share picture at its full address, and a line for a browser without JavaScript`, () => {
      const built = fillHtmlText(readFileSync(join(webDir, page), 'utf8'), en);
      // Link previews need the picture's full address; the site lives at ardbiu.github.io/FOCOS/.
      expect(built).toContain('<meta property="og:image" content="https://ardbiu.github.io/FOCOS/og-image.png" />');
      expect(built).toContain('<meta property="og:image:width" content="1200" />');
      expect(built).toContain('<meta property="og:image:height" content="630" />');
      expect(built).toMatch(/<meta property="og:image:alt" content="[^"%]{20,}" \/>/);
      expect(built).toContain('<meta name="twitter:card" content="summary_large_image" />');
      expect(built).toMatch(/<noscript><p class="noscript">[^<%]{30,} <a href="https:\/\/github\.com\/Ardbiu\/FOCOS">/);
      expect(built).toContain(en.app.noscript);
    });
  }

  it('ships the share picture: a PNG of 1200 by 630', () => {
    const file = readFileSync(join(webDir, 'public', 'og-image.png'));
    expect(file.subarray(1, 4).toString('ascii')).toBe('PNG');
    // The width and height are the first two numbers of the IHDR chunk.
    expect([file.readUInt32BE(16), file.readUInt32BE(20)]).toEqual([1200, 630]);
    expect(file.length).toBeLessThan(600_000);
  });

  it('fails loudly on a placeholder the language file does not have', () => {
    expect(() => fillHtmlText('<meta content="%i18n:no.such.key%">', en)).toThrow(/no\.such\.key/);
    expect(fillHtmlText('<p title="%i18n:app.name%">', en)).toBe('<p title="Focos">');
    expect(fillHtmlText('<p title="%i18n:nav.method%">', { nav: { method: 'A "quoted" & <odd> text' } })).toBe(
      '<p title="A &quot;quoted&quot; &amp; &lt;odd&gt; text">',
    );
  });

  it('has a favicon', () => {
    const icon = join(webDir, 'public', 'favicon.svg');
    expect(existsSync(icon)).toBe(true);
    expect(readFileSync(icon, 'utf8')).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });
});
