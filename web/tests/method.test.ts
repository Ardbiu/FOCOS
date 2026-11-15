// @vitest-environment jsdom
//
// The "How it works" page, started on the sample meta.json and a copy of the
// pipeline's validation.json (tests/fixtures). Every number on the page must
// come from those two files.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDataCache } from '../src/data';
import { provinceFindings, tallyTrends } from '../src/findings';
import { extremeMonthBias, provinceBiasRows, signedPercent, startMethodPage, type MethodPage } from '../src/method';
import { completenessFromMeta } from '../src/stats';
import fixture from './fixtures/validation.json';
import { byId, click, isHidden, mountMethodPage, text } from './helpers/page';
import { serveSample, type SampleServer } from './helpers/sample-server';

let server: SampleServer;
let page: MethodPage | null = null;

async function start(hash = '', validation: unknown = fixture): Promise<MethodPage> {
  server.files.set('validation.json', JSON.stringify(validation));
  mountMethodPage(hash);
  page = startMethodPage(document);
  await page.idle();
  return page;
}

beforeEach(() => {
  server = serveSample();
});
afterEach(() => {
  page?.destroy();
  page = null;
  vi.unstubAllGlobals();
});

const cells = (tableId: string) =>
  Array.from(byId(tableId).querySelectorAll('tbody tr')).map((row) =>
    Array.from(row.querySelectorAll('th, td')).map((cell) => cell.textContent),
  );

describe('helpers', () => {
  it('writes a fraction as a signed percentage', () => {
    expect(signedPercent(0.0496, 'en')).toBe('+5.0%');
    expect(signedPercent(-0.027, 'en')).toBe('−2.7%');
    expect(signedPercent(0, 'en')).toBe('0.0%');
    expect(signedPercent(0.676, 'en', 0)).toBe('+68%');
    expect(signedPercent(-0.2146, 'es')).toBe('−21,5 %');
    expect(signedPercent(Number.NaN, 'en')).toBe('');
  });

  it('sorts provinces from the most over to the most under, and marks those beyond 15%', () => {
    const rows = provinceBiasRows(fixture.province_bias);
    expect(rows).toHaveLength(21);
    expect(rows[0]).toMatchObject({ name: 'Neuquén', beyond: true });
    expect(rows[rows.length - 1]).toMatchObject({ name: 'San Luis', beyond: true });
    expect(rows.find((row) => row.name === 'Corrientes')!.beyond).toBe(false);
    expect(rows.filter((row) => row.beyond).map((row) => row.name)).toEqual([
      'Neuquén', 'Mendoza', 'San Juan', 'Santa Fe', 'Jujuy', 'Buenos Aires', 'Catamarca', 'Córdoba', 'San Luis',
    ]);
    for (let i = 1; i < rows.length; i++) expect(rows[i].bias).toBeLessThanOrEqual(rows[i - 1].bias);
  });

  it('averages the bias of months at 5 times the usual level or more, weighted by their number', () => {
    expect(extremeMonthBias(fixture.bias_by_level)).toBeCloseTo(-0.0931, 4);
    expect(extremeMonthBias([{ band: '0.5-2x', n: 10, bias: 0.02, mape: 17 }])).toBeNull();
    expect(extremeMonthBias(undefined)).toBeNull();
  });
});

describe('the method page', () => {
  it('fills every fixed text and shows the page once the numbers are in', async () => {
    await start();
    expect(document.documentElement.lang).toBe('en');
    expect(isHidden('method-status')).toBe(true);
    expect(isHidden('method-body')).toBe(false);
    for (const element of document.querySelectorAll('[data-i18n]')) {
      expect(element.textContent, element.getAttribute('data-i18n')!).not.toBe('');
      expect(element.textContent).not.toBe(element.getAttribute('data-i18n'));
    }
    expect(byId('method').innerHTML).not.toMatch(/NaN|undefined|Infinity|\{\w+\}/);
    const headings = Array.from(document.querySelectorAll('#method-body section:not([hidden]) > h3')).map((h) => h.textContent);
    expect(headings).toEqual([
      '1. The question',
      '2. The naive answer, and why it fails',
      '3. The method, in three steps',
      '4. The test',
      '5. Small counts and extreme months',
      '6. Province by province',
      '7. The two test years',
      '8. Beyond the test',
      '9. A third satellite: NOAA-20',
      '10. Limits',
      'Data and credits',
    ]);
  });

  it('shows the jump of the naive stitch with the numbers of the first shared year', async () => {
    await start();
    // VIIRS pixels are not compared with Aqua's cell-passes as if they were the same unit.
    expect(text('naive-text')).toContain(
      'in 2012, the first year both sensors flew, VIIRS reported 164,200 detections where Aqua’s record counts 35,929 fire cell-passes.',
    );
    expect(text('naive-text')).not.toContain('times as many');
    const chart = byId('chart-before-after');
    expect(chart.querySelectorAll('path.series-line')).toHaveLength(3);
    expect(Array.from(chart.querySelectorAll('text')).map((node) => node.textContent)).toEqual(
      expect.arrayContaining(['Aqua MODIS (the reference)', 'VIIRS, raw', 'VIIRS, harmonized', '2005', '2025']),
    );
    expect(chart.querySelector('svg')!.getAttribute('aria-label')).toBe(
      'Yearly national totals from 2003 to 2025: Aqua MODIS, raw VIIRS and harmonized VIIRS.',
    );
  });

  it('checks the national trend against Aqua alone, and over the VIIRS years alone', async () => {
    await start();
    expect(isHidden('trend-check')).toBe(false);
    expect(text('trend-check')).toMatch(
      /^A check that does not lean on the method\. From 2003 to 2025, Aqua MODIS alone, the same sensor all along: [a-z][^.]*\(p [=<] [\d.]+\)\. The harmonized record: [a-z][^.]*\(p [=<] [\d.]+\)\. Aqua’s orbit has drifted to a later overpass, nearer the afternoon peak of fire, so its last years may read high and this check, if anything, understates the fall\. It supports the national trend but does not prove it\. From 2012 to 2025 alone, Aqua: [a-z ,%\d]+; harmonized record: [a-z ,%\d]+\./,
    );
  });

  it('shows, province by province, what the raw counts would have concluded', async () => {
    await start();
    const summary = server.json('summary/provinces.json');
    const rows = provinceFindings(summary.areas.slice(1), completenessFromMeta(server.json('meta.json')), 2012, fixture.province_bias);
    const harmonized = tallyTrends(rows.map((row) => row.harmonized));
    const raw = tallyTrends(rows.map((row) => row.raw));
    expect(rows).toHaveLength(2);
    expect(text('trends-text')).toBe(
      `Province by province, the same thing happens. Raw counts rise in ${raw.rising} of 2 provinces, because VIIRS reports several detections where MODIS reported one. ` +
        `The harmonized record rises in ${harmonized.rising}, falls in ${harmonized.falling}, shows no significant trend in ${harmonized.none} and has too little fire to assess in ${harmonized.unrated}.`,
    );
    // The sample's two provinces: Corrientes has no harmonized trend and a raw rise; La Pampa rises.
    expect(harmonized).toMatchObject({ rising: 1, none: 1 });
    expect(raw.rising).toBeGreaterThanOrEqual(1);
    expect(byId('table-trends').querySelector('caption')!.textContent).toBe('Trend of the yearly totals by province: harmonized record and raw counts');
    expect(Array.from(byId('table-trends').querySelectorAll('thead th')).map((th) => th.textContent)).toEqual([
      'Province',
      'Harmonized record',
      'Raw counts',
      'With the test gap removed',
    ]);
    const table = cells('table-trends');
    expect(table.map((row) => row[0])).toEqual(['Corrientes', 'La Pampa']);
    expect(table[0].slice(1)).toEqual(['No significant trend', 'Rising, 297% per decade', '—']);
    expect(table[1][1]).toBe('Rising, 32% per decade');
    // Both are within 15% of MODIS in this file, so neither is re-tested.
    expect(table[1][3]).toBe('—');
    expect(byId('naive').innerHTML).not.toMatch(/NaN|undefined|Infinity|\{\w+\}/);
  });

  it('says in that table whether a trend holds once a province’s known gap is removed', async () => {
    await start('', {
      ...fixture,
      province_bias: [
        { prov: '42', name: 'La Pampa', aqua: 100, harmonized: 168, bias: 0.68 },
        { prov: '18', name: 'Corrientes', aqua: 100, harmonized: 120, bias: 0.2 },
      ],
    });
    const table = cells('table-trends');
    // Corrientes: no trend either way. La Pampa: the rise does not survive.
    expect(table[0][3]).toBe('Holds');
    expect(table[1][3]).toMatch(/^Changes to: (no significant trend|falling, \d+% per decade)$/);
  });

  it('leaves the province table out when the province file cannot be read, and keeps the rest', async () => {
    server.files.set('summary/provinces.json', { status: 404 });
    clearDataCache();
    await start();
    expect(isHidden('trends-part')).toBe(true);
    expect(isHidden('naive')).toBe(false);
    expect(text('naive-text')).toContain('Any trend read across that jump is false.');
  });

  it('explains the method with the training years and the candidates\' scores', async () => {
    await start();
    expect(text('step-3')).toContain('fire cell-passes in 2012–2019 becomes a weight');
    expect(text('loyo-text')).toContain('Their typical errors were 20.8%, 17.2% and 17.7%; the naive stitch scored 406%.');
    expect(text('loyo-text')).toContain('(C2)');
  });

  it('states the test design and draws every province-month of the test', async () => {
    await start();
    expect(text('test-design')).toBe(
      'The ratios were tuned on 2012–2019 only. The years 2020 and 2021 were kept aside until the method was frozen. On those years the harmonized VIIRS record is compared with what Aqua counted. The results were recomputed once, after a second review (by a separate AI session that had not written the code) changed which days count as outages; the frozen ratios did not change.',
    );
    const scatter = byId('chart-scatter');
    expect(scatter.querySelectorAll('circle.pair-harmonized')).toHaveLength(40);
    expect(scatter.querySelectorAll('circle.pair-naive')).toHaveLength(40);
    expect(scatter.querySelector('line.pair-line')).not.toBeNull();
    expect(scatter.querySelector('svg')!.getAttribute('aria-label')).toContain('40 province-months.');
  });

  it('gives one results table, harmonized next to the naive stitch, at three scales', async () => {
    await start();
    const table = byId('table-results');
    expect(table.querySelector('caption')!.textContent).toBe(
      'Test-year results at three scales, harmonized next to the naive stitch',
    );
    // The box scrolls sideways on a phone, so it can be focused and is named after the table.
    expect(table.getAttribute('tabindex')).toBe('0');
    expect(table.getAttribute('role')).toBe('region');
    expect(table.getAttribute('aria-label')).toBe('Test-year results at three scales, harmonized next to the naive stitch');
    expect(cells('table-results')).toEqual([
      ['Nation, by month', '24', '−0.1%', '8.3%', '0.993', '+428.5%', '458.4%', '0.983'],
      ['Province, by month', '331', '−0.9%', '17.0%', '0.972', '+423.1%', '432.1%', '0.961'],
      ['1° tile, by month', '921', '−4.6%', '22.6%', '0.913', '+411.4%', '375.0%', '0.908'],
    ]);
    expect(Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent)).toEqual([
      'Scale', 'Cases', 'Harmonized', 'Naive stitch', 'Bias', 'Typical error', 'Correlation', 'Bias', 'Typical error', 'Correlation',
    ]);
    expect(text('test-targets')).toBe(
      'Targets set before the test: national bias within ±10%, province-month error at most 25%, national correlation at least 0.95. All three were met.',
    );
    expect(text('test-peak')).toBe('The busiest month of the year matched Aqua’s in 86% of 44 province-years.');
  });

  it('says which targets were missed when some were', async () => {
    await start('', { ...fixture, targets_met: { national_bias: true, province_month_mape: false, national_month_logcorr: false } });
    expect(text('test-targets')).toContain('Not all were met: province-month error, national correlation.');
  });

  it('shows how the error depends on the count and on how unusual the month was', async () => {
    await start();
    expect(cells('table-by-count')).toEqual([
      ['1–4', '63', '124.0%'],
      ['5–19', '107', '43.3%'],
      ['20+', '331', '17.0%'],
    ]);
    expect(cells('table-by-level')).toEqual([
      ['< 0.5×', '18', '+24.6%', '26.1%'],
      ['0.5–2×', '199', '+2.5%', '17.2%'],
      ['2–5×', '71', '−0.6%', '18.6%'],
      ['5–10×', '30', '−8.7%', '12.0%'],
      ['10×+', '13', '−10.7%', '14.1%'],
    ]);
    expect(text('by-level-text')).toBe(
      'It also depends on how unusual the month was. Extreme months are understated: about 9% low at 5 times the usual level or more.',
    );
  });

  it('shows the bias of every province, sorted, with those beyond 15% marked', async () => {
    await start();
    expect(text('province-text')).toBe(
      'Over the two test years, the harmonized total ran more than 15% from Aqua’s in 9 of 21 provinces. The app says so when one of them is selected.',
    );
    const bars = Array.from(byId('chart-province-bias').querySelectorAll<SVGGElement>('g.bias-bar'));
    expect(bars).toHaveLength(21);
    expect(bars[0].getAttribute('aria-label')).toBe('Neuquén: +67.6%');
    expect(bars[20].getAttribute('aria-label')).toBe('San Luis: −27.4%');
    expect(bars.filter((bar) => bar.dataset.beyond === 'true')).toHaveLength(9);
    expect(text('province-caption')).toBe('Harmonized total against Aqua’s, test years. Dark bars are beyond ±15%.');
  });

  it('gives the two test years', async () => {
    await start();
    expect(cells('table-test-years')).toEqual([
      ['2020', '62,217', '60,535', '−2.7%'],
      ['2021', '31,597', '33,163', '+5.0%'],
    ]);
  });

  it('says when the last year of the ratio stops with S-NPP', async () => {
    // The sample's meta.json has S-NPP carrying the record to October 2026.
    await start('', { ...fixture, yearly_ratio: [...fixture.yearly_ratio, { year: 2026, ratio: 0.917 }] });
    expect(text('ratio-text')).toBe(
      'The yearly ratio of Aqua to harmonized VIIRS was 1.01 in 2012 and 0.92 in 2026. It was highest in 2024 (1.16) and lowest in 2026 (0.92). A later Aqua overpass would raise it, and S-NPP’s outages in 2024 may add to that. The record reads high in months with little fire, which lowers the ratio in a quiet year. This page does not prove the cause.',
    );
    expect(text('ratio-caption')).toBe(
      'Aqua ÷ harmonized VIIRS, national, by year. The shaded years are the test years. 2026 stops when S-NPP VIIRS stopped delivering data.',
    );
    click('lang-es');
    expect(text('ratio-caption')).toBe(
      'Aqua ÷ VIIRS armonizado, nacional, por año. Los años sombreados son los de prueba. 2026 termina cuando S-NPP VIIRS dejó de entregar datos.',
    );
  });

  it('says nothing about filled days when the file lists none', async () => {
    await start();
    expect(isHidden('noaa20-fill')).toBe(true);
  });

  it('says on how many days NOAA-20 stood in for S-NPP', async () => {
    const meta = server.json('meta.json');
    server.files.set(
      'meta.json',
      JSON.stringify({ ...meta, gap_fill: { sat: 'N20', name: 'NOAA-20 VIIRS', days: 62, first: '2019-01-21', last: '2026-08-03' } }),
    );
    await start();
    expect(isHidden('noaa20-fill')).toBe(false);
    expect(text('noaa20-fill')).toBe(
      'NOAA-20 also stands in for S-NPP on 62 days since 2019: the days on which S-NPP delivered no data, or none by day. Those days carry NOAA-20’s harmonized counts. This was added after the held-out test and changes none of its results, which compare S-NPP alone with Aqua.',
    );
    click('lang-es');
    expect(text('noaa20-fill')).toBe(
      'NOAA-20 también reemplaza a S-NPP en 62 días desde 2019: los días en que S-NPP no entregó datos, o ninguno de día. Esos días llevan los conteos armonizados de NOAA-20. Esto se agregó después de la prueba y no cambia ninguno de sus resultados, que comparan solo S-NPP con Aqua.',
    );
  });

  it('shows the yearly ratio and the seam', async () => {
    await start();
    expect(text('ratio-text')).toBe(
      'The yearly ratio of Aqua to harmonized VIIRS was 1.01 in 2012 and 1.09 in 2025. It was highest in 2024 (1.16) and lowest in 2021 (0.95). A later Aqua overpass would raise it, and S-NPP’s outages in 2024 may add to that. The record reads high in months with little fire, which lowers the ratio in a quiet year. This page does not prove the cause.',
    );
    expect(text('ratio-caption')).toBe('Aqua ÷ harmonized VIIRS, national, by year. The shaded years are the test years.');
    expect(byId('chart-ratio').querySelectorAll('circle.ratio-point')).toHaveLength(14);
    expect(byId('chart-ratio').querySelectorAll('rect.test-years')).toHaveLength(1);
    expect(text('seam-text')).toBe(
      'At the seam, from Feb 2012 to Dec 2013, both sensors flew and the series switches from one to the other. Month by month the harmonized VIIRS total ran −0.2% from Aqua’s, with a typical error of 4.4% over 23 months.',
    );
    expect(byId('chart-seam').querySelectorAll('path.series-line')).toHaveLength(2);
  });

  it('has a short NOAA-20 panel: its test and its handover', async () => {
    await start();
    // The sample's meta.json has NOAA-20 carrying the record from November 2026: present tense, month from the file.
    expect(text('noaa20-text')).toBe(
      'S-NPP stopped delivering data on 2 November 2026. NOAA-20 carries the same VIIRS instrument in the same orbit and carries the record from November 2026. Its ratios were fitted on 2018–2019, the stable years it shared with Aqua, and tested on the same held-out years.',
    );
    expect(cells('table-noaa20')).toEqual([
      ['Test against Aqua, nation, by month', '24', '−1.9%', '7.1%', '0.995'],
      ['Test against Aqua, province, by month', '331', '−2.6%', '17.5%', '0.972'],
      ['Test against Aqua, 1° tile, by month', '924', '−5.4%', '23.8%', '0.904'],
      ['Handover 2022–2025 against S-NPP, nation, by month', '48', '−2.2%', '3.9%', '0.997'],
      ['Handover 2022–2025 against S-NPP, province, by month', '667', '−2.3%', '10.3%', '0.987'],
    ]);
  });

  it('lists the limits and the data', async () => {
    await start();
    const limits = Array.from(byId('limits-list').querySelectorAll('li')).map((li) => li.textContent);
    expect(limits).toHaveLength(10);
    // NOAA-20's gaps to Aqua by province, against S-NPP's, from validation.json.
    expect(limits).toContain(
      'In 6 of 21 provinces NOAA-20’s gap to Aqua in the test years differs from S-NPP’s by more than 10 points (the most in Entre Ríos: S-NPP +3%, NOAA-20 −13%). There the months NOAA-20 carries, from November 2026 and on the days it fills, can sit above or below the S-NPP months.',
    );
    expect(limits).toContain('Hotspot counts are not burned area.');
    expect(limits).toContain('Fixed heat sources labelled as fire inflate the VIIRS era in a few provinces.');
    // No claim that the data on screen is near-real-time: it is only so once the record runs into the current year.
    expect(limits).toContain('Where the record runs into the current year, its latest months use near-real-time data, which is revised later.');
    expect(limits.find((item) => item!.startsWith('Extreme months'))).toBe(
      'Extreme months are understated: about 9% low at 5 times the usual level or more.',
    );
    const data = Array.from(byId('data-list').querySelectorAll('li')).map((li) => li.textContent);
    expect(data).toHaveLength(6);
    expect(data).toContain('Optional map layer: SAOCOM L-band radar mosaics, 2022, CONAE (Argentina’s space agency).');
    expect(data).toContain('Designing and building was assisted with Claude, an AI assistant (Anthropic)');
    expect(text('footer-si')).toBe('Designing and building was assisted with Claude, an AI assistant (Anthropic)');
    expect(text('excluded-text')).toBe(
      '167 days are left out of every comparison: the days on which one of the sensors delivered no data, and a window from 16 August to 2 September 2020 that was set aside before the test as a suspected Aqua outage. Today’s archive has Aqua data on most of those days, so leaving them out is only a precaution.',
    );
    expect(text('data-through')).toBe('Data through 2026-11-14. Test results computed 2026-11-13.');
    expect(isHidden('partner')).toBe(true);
  });

  it('speaks of NOAA-20 in the future while it carries no month of the record', async () => {
    // Today's real meta.json: two carriers, S-NPP still the current one.
    const meta = server.json('meta.json');
    server.files.set('meta.json', JSON.stringify({ ...meta, series: [meta.series[0], { ...meta.series[1], to: null }] }));
    await start();
    expect(text('noaa20-text')).toBe(
      'S-NPP stopped delivering data on 2 November 2026. NOAA-20 carries the same VIIRS instrument in the same orbit and will carry the record from November 2026. Its ratios are already fitted, on 2018–2019, the stable years it shared with Aqua, and tested on the same held-out years.',
    );
    page!.destroy();
    // An older meta.json without the list of carriers reads the same way.
    const { series: _series, ...older } = meta;
    server.files.set('meta.json', JSON.stringify(older));
    clearDataCache();
    await start();
    expect(text('noaa20-text')).toContain('will carry the record from November 2026');
  });

  it('is written in Spanish on request, and the toggle switches both ways', async () => {
    await start('lang=es');
    expect(document.documentElement.lang).toBe('es');
    expect(document.querySelector('.method-title')!.textContent).toBe('Cómo funciona');
    expect(text('naive-text')).toContain('VIIRS informó 164.200 detecciones donde el registro de Aqua cuenta 35.929 pasos de celda con fuego.');
    expect(cells('table-results')[1]).toEqual(['Provincia, por mes', '331', '−0,9 %', '17,0 %', '0,972', '+423,1 %', '432,1 %', '0,961']);
    expect(byId<HTMLAnchorElement>('back-link').getAttribute('href')).toBe('./#lang=es');
    click('lang-en');
    await page!.idle();
    expect(document.documentElement.lang).toBe('en');
    expect(location.hash).toBe('');
    expect(document.querySelector('.method-title')!.textContent).toBe('How it works');
    expect(byId<HTMLAnchorElement>('back-link').getAttribute('href')).toBe('./');
    click('lang-es');
    await page!.idle();
    expect(location.hash).toBe('#lang=es');
    expect(byId('lang-es').getAttribute('aria-pressed')).toBe('true');
  });

  it('leaves out the parts a validation file does not have, without failing', async () => {
    const { noaa20: _noaa20, bias_by_level: _levels, province_bias: _provinces, error_by_count: _counts, yearly_test: _years, ...older } = fixture;
    await start('', { ...older, noaa20: null });
    expect(isHidden('noaa20')).toBe(true);
    expect(isHidden('by-province')).toBe(true);
    expect(isHidden('test-years')).toBe(true);
    expect(isHidden('by-count')).toBe(true);
    expect(isHidden('test')).toBe(false);
    expect(byId('method').innerHTML).not.toMatch(/NaN|undefined|Infinity|\{\w+\}/);
    const limits = Array.from(byId('limits-list').querySelectorAll('li')).map((li) => li.textContent);
    expect(limits).toContain('Extreme months are understated.');
  });

  it('shows the error-by-count table without the extreme-months table, and the other way round', async () => {
    const { bias_by_level: _levels, ...withoutLevels } = fixture;
    await start('', withoutLevels);
    expect(isHidden('by-count')).toBe(false);
    expect(isHidden('by-count-part')).toBe(false);
    expect(isHidden('by-level-part')).toBe(true);
  });

  it('says so when the results cannot be loaded, and recovers on retry', async () => {
    server.files.set('validation.json', { status: 503 });
    mountMethodPage();
    page = startMethodPage(document);
    await page.idle();
    expect(isHidden('method-body')).toBe(true);
    expect(text('method-status')).toBe('The data could not be loaded (validation.json). Try again');
    server.files.set('validation.json', JSON.stringify(fixture));
    click(byId('method-status').querySelector('button')!);
    await page.idle();
    expect(isHidden('method-status')).toBe(true);
    expect(isHidden('method-body')).toBe(false);
    expect(cells('table-results')).toHaveLength(3);
  });

  it('does not show an empty validation file as results', async () => {
    await start('', {});
    expect(isHidden('method-body')).toBe(true);
    expect(text('method-status')).toContain('could not be loaded');
  });
});

describe('the cleaning step', () => {
  it('says that only the fixed heat sources the archive labels are dropped, and that some remain', async () => {
    const { default: en } = await import('../src/i18n/en.json');
    const { default: es } = await import('../src/i18n/es.json');
    expect(en.method.steps.s1).toContain('labels as vegetation fire');
    expect(en.method.steps.s1).toContain('not every one');
    expect(en.method.steps.s1).not.toMatch(/drop low-confidence detections and fixed heat sources/);
    expect(es.method.steps.s1).toContain('no todas');
  });
});

describe('the note under the province trend table', () => {
  it('explains why some raw percentages run so high', async () => {
    const { default: en } = await import('../src/i18n/en.json');
    const { default: es } = await import('../src/i18n/es.json');
    expect(en.method.trends.note).toContain('Raw percentages run very high where the record started from very little fire.');
    expect(es.method.trends.note).toContain('partió de muy poco fuego');
  });
});
