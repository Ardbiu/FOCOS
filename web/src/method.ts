// The "How it works" page (plan section 6.9): the question, the naive answer,
// the method, the held-out test and what lies beyond it, and the limits.
//
// Every number on the page is read from validation.json or meta.json when the
// page loads. The text around the numbers lives in the language files.

import {
  DataError,
  clearDataCache,
  loadMeta,
  loadProvinces,
  loadValidation,
  type AreaSummary,
  type Meta,
  type ProvinceBias,
  type Validation,
  type ValidationMetrics,
} from './data';
import { applyStaticText, byId, h, loadErrorText, setStatus } from './dom';
import { formatNumber, t, tList, type Lang } from './i18n';
import {
  AQUA_COLOR,
  HARMONIZED_COLOR,
  RAW_COLOR,
  renderLines,
  renderProvinceBias,
  renderRatio,
  renderTestScatter,
  table,
  type BiasRow,
} from './method-charts';
import { extremeMonthBias, nationalTrendCheck, provinceFindings, tallyTrends, trendClass } from './findings';

export { extremeMonthBias };
import { completenessFromMeta, monthOfIdx, seriesCarriers, viirsSatellites, yearOfIdx, type Trend } from './stats';
import { decodeState } from './state';
import { capitalize, lowerFirst, pValue, trendShort } from './verdict';

export interface MethodPage {
  /** Resolves when the page has loaded its numbers and drawn itself. */
  idle(): Promise<void>;
  destroy(): void;
}

/** Beyond this share from Aqua's total, a province is marked (and the app shows a caution). */
const BIAS_LIMIT = 0.15;
const SCALES = ['national_month', 'province_month', 'tile_month'] as const;
/** NOAA-20's gap to Aqua in a province counts as apart from S-NPP's beyond this many points (as a fraction). */
const NOAA20_APART = 0.1;
/** Where "Extreme months are understated" sits in the list of limits. */
const EXTREME_LIMIT_POSITION = 5;

// ---- Numbers as text -------------------------------------------------------------

function percent(value: number, lang: Lang, decimals = 1): string {
  return t(lang, 'format.percent', { n: formatNumber(lang, value, decimals, decimals) });
}

/** A fraction as a signed percentage: 0.0496 is "+5.0%", -0.027 is "−2.7%". Empty when it is not a number. */
export function signedPercent(fraction: number, lang: Lang, decimals = 1): string {
  if (!Number.isFinite(fraction)) return '';
  const rounded = Number((Math.abs(fraction) * 100).toFixed(decimals));
  const sign = rounded === 0 ? '' : fraction > 0 ? '+' : '−';
  return `${sign}${percent(rounded, lang, decimals)}`;
}

/** The provinces from the most over Aqua to the most under, each marked when it is beyond 15%. */
export function provinceBiasRows(list: ProvinceBias[] | undefined): BiasRow[] {
  return (list ?? [])
    .filter((row) => Number.isFinite(row.bias))
    .map((row) => ({ ...row, beyond: Math.abs(row.bias) > BIAS_LIMIT }))
    .sort((a, b) => b.bias - a.bias);
}

/** A band of validation.json for reading: "5-19" is "5–19", "0.5-2x" is "0.5–2×", "<0.5x" is "< 0.5×". */
function bandLabel(band: string, lang: Lang): string {
  const decimal = formatNumber(lang, 0.5, 1, 1).charAt(1);
  return band.replace(/\./g, decimal).replace(/-/g, '–').replace(/x/g, '×').replace(/^</, '< ');
}

/** "Feb 2012" from "2012-02". */
function monthLabel(month: string, lang: Lang): string {
  const [year, number] = month.split('-').map(Number);
  return `${capitalize(t(lang, `months.short.${number - 1}`), lang)} ${year}`;
}

// ---- The page --------------------------------------------------------------------

export function startMethodPage(doc: Document): MethodPage {
  const win = doc.defaultView!;
  let lang: Lang = decodeState(win.location.hash).lang;
  /** `areas`: the nation, then the provinces; `null` when their file could not be read (the page does without). */
  let loaded: { meta: Meta; validation: Validation; areas: AreaSummary[] | null } | null = null;
  let queue: Promise<void> = Promise.resolve();
  let destroyed = false;

  const el = {
    status: byId(doc, 'method-status'),
    body: byId(doc, 'method-body'),
    langEn: byId<HTMLButtonElement>(doc, 'lang-en'),
    langEs: byId<HTMLButtonElement>(doc, 'lang-es'),
    back: byId<HTMLAnchorElement>(doc, 'back-link'),
  };
  const part = (id: string) => byId(doc, id);
  const setText = (id: string, text: string) => {
    part(id).textContent = text;
  };

  function enqueue(task: () => Promise<void>): void {
    queue = queue.then(() => (destroyed ? undefined : task())).catch((error: unknown) => console.error(error));
  }

  async function load(): Promise<void> {
    el.status.replaceChildren(t(lang, 'method.loading'));
    el.status.hidden = false;
    try {
      const [meta, validation] = await Promise.all([loadMeta(), loadValidation()]);
      if (!validation?.test?.harmonized || !Array.isArray(validation.yearly_national) || !Array.isArray(validation.test_pairs)) {
        clearDataCache(); // an incomplete file must not be kept for the retry
        throw new DataError('format', 'validation.json', 'validation.json does not hold the test results');
      }
      const areas = await loadProvinces().catch((error: unknown) => {
        console.warn(error);
        return null;
      });
      loaded = { meta, validation, areas };
    } catch (error) {
      console.error(error);
      const retry = h(doc, 'button', { type: 'button', class: 'button button-small' }, t(lang, 'app.retry'));
      retry.addEventListener('click', () => enqueue(load));
      el.status.replaceChildren(h(doc, 'span', {}, loadErrorText(error, lang)), ' ', retry);
      el.body.hidden = true;
      return;
    }
    el.status.replaceChildren();
    el.status.hidden = true;
    el.body.hidden = false;
    render();
  }

  /** Puts a table into its scrolling box and names the box after the table's caption. */
  function showTable(id: string, content: HTMLTableElement): void {
    const box = part(id);
    box.replaceChildren(content);
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', content.caption?.textContent ?? '');
  }

  function metricsCells(metrics: ValidationMetrics): string[] {
    return [signedPercent(metrics.bias, lang), percent(metrics.mape, lang), formatNumber(lang, metrics.logcorr, 3, 3)];
  }

  function render(): void {
    applyStaticText(doc, lang);
    doc.title = t(lang, 'method.pageTitle');
    doc.querySelector('meta[name="description"]')?.setAttribute('content', t(lang, 'app.description'));
    el.langEn.setAttribute('aria-pressed', String(lang === 'en'));
    el.langEs.setAttribute('aria-pressed', String(lang === 'es'));
    el.back.setAttribute('href', lang === 'en' ? './' : `./#lang=${lang}`);
    if (!loaded) return;
    const { meta, validation: v } = loaded;
    const carriers = seriesCarriers(meta);
    setText('footer-firms', t(lang, 'footer.firms', { viirs: viirsSatellites(carriers).join(', ') }));
    const number = (value: number, decimals = 0) => formatNumber(lang, value, decimals, decimals);
    const [trainFrom, trainTo] = v.train_years;

    // Province by province: the harmonized trend, what the raw counts would have concluded, and
    // whether a trend holds once a province's known gap to MODIS is taken out.
    const findings = provinceFindings(
      (loaded.areas ?? []).slice(1),
      completenessFromMeta(meta),
      yearOfIdx(carriers[1]?.fromIdx ?? 0),
      v.province_bias,
    ).sort((a, b) => a.name.localeCompare(b.name, lang));
    part('trends-part').hidden = findings.length === 0;
    if (findings.length > 0) {
      const harmonized = tallyTrends(findings.map((row) => row.harmonized));
      const raw = tallyTrends(findings.map((row) => row.raw));
      setText(
        'trends-text',
        t(lang, 'method.trends.text', {
          rawRising: number(raw.rising),
          total: number(findings.length),
          rising: number(harmonized.rising),
          falling: number(harmonized.falling),
          none: number(harmonized.none),
          unrated: number(harmonized.unrated),
        }),
      );
      showTable(
        'table-trends',
        table(
          doc,
          t(lang, 'method.trends.caption'),
          [['colProvince', 'colHarmonized', 'colRaw', 'colCheck'].map((key) => ({ text: t(lang, `method.trends.${key}`) }))],
          findings.map((row) => [
            row.name,
            trendShort(row.harmonized, lang),
            trendShort(row.raw, lang),
            row.adjusted === null
              ? '—'
              : row.holds
                ? t(lang, 'method.trends.holds')
                : t(lang, 'method.trends.changes', { trend: lowerFirst(trendShort(row.adjusted, lang), lang) }),
          ]),
        ),
      );
    }
    // The national trend against Aqua alone, which never changed sensor, and over the VIIRS years alone.
    const check = nationalTrendCheck(v.yearly_national, completenessFromMeta(meta).lastCompleteYear, yearOfIdx(carriers[1]?.fromIdx ?? 0));
    const described = (fitted: Trend) =>
      'reason' in fitted || fitted.direction === 'none'
        ? lowerFirst(trendShort(fitted, lang), lang)
        : `${lowerFirst(trendShort(fitted, lang), lang)} (${pValue(fitted.p, lang)})`;
    const stepped =
      check !== null &&
      trendClass(check.aqua) === 'falling' &&
      trendClass(check.harmonized) === 'falling' &&
      trendClass(check.aquaRecent) === 'none' &&
      trendClass(check.harmonizedRecent) === 'none';
    setStatus(
      part('trend-check'),
      check === null
        ? null
        : `${t(lang, 'method.trends.check', {
            from: check.fromYear,
            to: check.toYear,
            aqua: described(check.aqua),
            harmonized: described(check.harmonized),
          })} ${t(lang, stepped ? 'method.trends.recentStep' : 'method.trends.recent', {
            year: check.recentFrom,
            to: check.toYear,
            aqua: lowerFirst(trendShort(check.aquaRecent, lang), lang),
            harmonized: lowerFirst(trendShort(check.harmonizedRecent, lang), lang),
          })}`,
    );
    const [testFrom, testTo] = v.test_years;

    // 2. The naive answer: the first year both sensors have, and the yearly lines.
    const shared = v.yearly_national.find((year) => year.aqua !== null && year.viirs_raw !== null && year.aqua > 0);
    setText(
      'naive-text',
      shared
        ? t(lang, 'method.naive.text', { year: shared.year, viirs: number(shared.viirs_raw!), aqua: number(shared.aqua!) })
        : '',
    );
    const years = v.yearly_national;
    renderLines(part('chart-before-after'), {
      label: t(lang, 'method.naive.label', { from: years[0]?.year ?? '', to: years[years.length - 1]?.year ?? '' }),
      count: years.length,
      xTicks: years.map((year, index) => ({ index, text: String(year.year) })).filter((tick) => Number(tick.text) % 5 === 0),
      series: [
        { name: t(lang, 'method.naive.raw'), color: RAW_COLOR, dash: '6 4', values: years.map((year) => year.viirs_raw) },
        { name: t(lang, 'method.naive.aqua'), color: AQUA_COLOR, values: years.map((year) => year.aqua) },
        { name: t(lang, 'method.naive.harmonized'), color: HARMONIZED_COLOR, values: years.map((year) => year.viirs_harmonized) },
      ],
    });

    // 3. The method.
    setText('step-3', t(lang, 'method.steps.s3', { from: trainFrom, to: trainTo }));
    const score = (value: number) => percent(value, lang, value >= 100 ? 0 : 1);
    setText(
      'loyo-text',
      v.loyo
        ? t(lang, 'method.steps.loyo', {
            c0: score(v.loyo.C0),
            c1: score(v.loyo.C1),
            c2: score(v.loyo.C2),
            c3: score(v.loyo.C3),
            chosen: v.chosen,
          })
        : '',
    );

    // 4. The test.
    setText('test-design', t(lang, 'method.test.design', { trainFrom, trainTo, testFrom, testTo }));
    renderTestScatter(part('chart-scatter'), v.test_pairs, {
      label: t(lang, 'method.test.scatterLabel', { n: number(v.test_pairs.length) }),
      axisAqua: t(lang, 'method.test.axisAqua'),
      axisViirs: t(lang, 'method.test.axisViirs'),
      harmonized: t(lang, 'method.naive.harmonized'),
      naive: t(lang, 'method.naive.raw'),
      line: t(lang, 'method.test.line'),
    });
    const metricHeads = [t(lang, 'method.test.bias'), t(lang, 'method.test.error'), t(lang, 'method.test.correlation')];
    showTable('table-results', 
      table(
        doc,
        t(lang, 'method.test.tableCaption'),
        [
          [
            { text: t(lang, 'method.test.scale'), rows: 2 },
            { text: t(lang, 'method.test.n'), rows: 2 },
            { text: t(lang, 'method.test.harmonized'), span: 3 },
            { text: t(lang, 'method.test.naive'), span: 3 },
          ],
          [...metricHeads, ...metricHeads].map((text) => ({ text })),
        ],
        SCALES.map((scale) => [
          t(lang, `method.test.scales.${scale}`),
          number(v.test.harmonized[scale].n),
          ...metricsCells(v.test.harmonized[scale]),
          ...metricsCells(v.test.naive[scale]),
        ]),
      ),
    );
    const missed = Object.entries(v.targets_met ?? {})
      .filter(([, met]) => !met)
      .map(([name]) => t(lang, `method.test.targetNames.${name}`));
    setText(
      'test-targets',
      v.targets
        ? `${t(lang, 'method.test.targets', {
            biasMax: percent(v.targets.national_bias_abs_max * 100, lang, 0),
            mapeMax: percent(v.targets.province_month_mape_max, lang, 0),
            corrMin: number(v.targets.national_month_logcorr_min, 2),
          })} ${missed.length === 0 ? t(lang, 'method.test.met.all') : t(lang, 'method.test.met.some', { list: missed.join(', ') })}`
        : '',
    );
    setText(
      'test-peak',
      v.peak_month_agreement
        ? t(lang, 'method.test.peak', {
            share: percent(v.peak_month_agreement.harmonized * 100, lang, 0),
            n: number(v.peak_month_agreement.n),
          })
        : '',
    );

    // 5. Error by the size of the count, and bias by how unusual the month was.
    const counts = v.error_by_count ?? [];
    const levels = v.bias_by_level ?? [];
    const extreme = extremeMonthBias(levels);
    part('by-count').hidden = counts.length === 0 && levels.length === 0;
    part('by-count-part').hidden = counts.length === 0;
    part('by-level-part').hidden = levels.length === 0;
    showTable('table-by-count', 
      table(
        doc,
        t(lang, 'method.byCount.caption'),
        [[t(lang, 'method.byCount.band'), t(lang, 'method.test.n'), t(lang, 'method.test.error')].map((text) => ({ text }))],
        counts.map((band) => [bandLabel(band.band, lang), number(band.n), percent(band.mape, lang)]),
      ),
    );
    const extremeText = extreme === null ? null : percent(Math.abs(extreme) * 100, lang, 0);
    setText('by-level-text', extremeText ? t(lang, 'method.byCount.levelText', { pct: extremeText }) : '');
    showTable('table-by-level', 
      table(
        doc,
        t(lang, 'method.byCount.levelCaption'),
        [[t(lang, 'method.byCount.level'), t(lang, 'method.test.n'), t(lang, 'method.test.bias'), t(lang, 'method.test.error')].map((text) => ({ text }))],
        levels.map((level) => [bandLabel(level.band, lang), number(level.n), signedPercent(level.bias, lang), percent(level.mape, lang)]),
      ),
    );

    // 6. Province by province.
    const provinces = provinceBiasRows(v.province_bias);
    const limit = percent(BIAS_LIMIT * 100, lang, 0);
    part('by-province').hidden = provinces.length === 0;
    if (provinces.length > 0) {
      setText(
        'province-text',
        t(lang, 'method.byProvince.text', { limit, count: provinces.filter((row) => row.beyond).length, total: provinces.length }),
      );
      setText('province-caption', t(lang, 'method.byProvince.caption', { limit }));
      const top = provinces[0];
      const bottom = provinces[provinces.length - 1];
      renderProvinceBias(part('chart-province-bias'), provinces, {
        limit: BIAS_LIMIT,
        label: t(lang, 'method.byProvince.label', {
          top: top.name,
          topBias: signedPercent(top.bias, lang, 0),
          bottom: bottom.name,
          bottomBias: signedPercent(bottom.bias, lang, 0),
        }),
        short: (bias) => signedPercent(bias, lang, 0),
        spoken: (row) => t(lang, 'method.byProvince.bar', { name: row.name, bias: signedPercent(row.bias, lang) }),
      });
    }

    // 7. The two test years.
    const testYears = v.yearly_test ?? [];
    part('test-years').hidden = testYears.length === 0;
    showTable('table-test-years', 
      table(
        doc,
        t(lang, 'method.testYears.caption'),
        [[t(lang, 'method.testYears.year'), t(lang, 'method.testYears.aqua'), t(lang, 'method.testYears.harmonized'), t(lang, 'method.test.bias')].map((text) => ({ text }))],
        testYears.map((year) => [String(year.year), number(year.aqua), number(year.harmonized), signedPercent(year.bias, lang)]),
      ),
    );

    // 8. Beyond the test: the yearly ratio and the seam.
    const ratios = (v.yearly_ratio ?? []).filter((row) => Number.isFinite(row.ratio));
    const firstRatio = ratios[0];
    const lastRatio = ratios[ratios.length - 1];
    const highest = ratios.reduce((best, row) => (row.ratio > best.ratio ? row : best), firstRatio);
    const lowest = ratios.reduce((best, row) => (row.ratio < best.ratio ? row : best), firstRatio);
    setText(
      'ratio-text',
      firstRatio && lastRatio
        ? t(lang, 'method.beyond.ratioText', {
            first: number(firstRatio.ratio, 2),
            firstYear: firstRatio.year,
            last: number(lastRatio.ratio, 2),
            lastYear: lastRatio.year,
            max: number(highest.ratio, 2),
            maxYear: highest.year,
            min: number(lowest.ratio, 2),
            minYear: lowest.year,
          })
        : '',
    );
    // The ratio compares Aqua with S-NPP, so its last year is cut short in the year S-NPP ended.
    const snpp = carriers.find((carrier) => carrier.sat === 'N');
    const cutShort =
      lastRatio && snpp && snpp.toIdx !== null && yearOfIdx(snpp.toIdx) === lastRatio.year && monthOfIdx(snpp.toIdx) < 12;
    const ratioCaption = t(lang, 'method.beyond.ratioCaption');
    setText(
      'ratio-caption',
      cutShort ? t(lang, 'method.beyond.ratioCaptionEnds', { caption: ratioCaption, year: lastRatio.year, name: snpp.name }) : ratioCaption,
    );
    if (firstRatio && lastRatio) {
      renderRatio(part('chart-ratio'), ratios, {
        label: t(lang, 'method.beyond.ratioLabel', { from: firstRatio.year, to: lastRatio.year }),
        testYears: v.test_years,
        point: (year, ratio) => `${year}: ${number(ratio, 2)}`,
      });
    }
    const seam = v.seam?.months ?? [];
    if (seam.length > 0) {
      const range = { from: monthLabel(seam[0].month, lang), to: monthLabel(seam[seam.length - 1].month, lang) };
      setText(
        'seam-text',
        t(lang, 'method.beyond.seamText', {
          ...range,
          bias: signedPercent(v.seam.metrics.bias, lang),
          mape: percent(v.seam.metrics.mape, lang),
          n: number(v.seam.metrics.n),
        }),
      );
      renderLines(part('chart-seam'), {
        label: t(lang, 'method.beyond.seamLabel', range),
        count: seam.length,
        xTicks: seam.map((month, index) => ({ index, text: monthLabel(month.month, lang) })).filter((_, index) => index % 6 === 0),
        series: [
          { name: t(lang, 'method.naive.aqua'), color: AQUA_COLOR, values: seam.map((month) => month.aqua) },
          { name: t(lang, 'method.naive.harmonized'), color: HARMONIZED_COLOR, values: seam.map((month) => month.harmonized) },
        ],
      });
    }

    // 9. NOAA-20.
    const noaa20 = v.noaa20 ?? null;
    part('noaa20').hidden = noaa20 === null;
    if (noaa20) {
      // Present tense only once NOAA-20 carries a month of the record; the month comes from meta.json.
      const carrying = carriers.find((carrier) => carrier.sat === 'N20');
      const training = { trainFrom: noaa20.train_years[0], trainTo: noaa20.train_years[1] };
      setText(
        'noaa20-text',
        carrying
          ? t(lang, 'method.noaa20.text', {
              ...training,
              month: t(lang, 'period.monthLong', {
                month: t(lang, `months.long.${monthOfIdx(carrying.fromIdx) - 1}`),
                year: yearOfIdx(carrying.fromIdx),
              }),
            })
          : t(lang, 'method.noaa20.textFuture', training),
      );
      // The days NOAA-20 carried in place of S-NPP, from meta.json.
      const fill = meta.gap_fill ?? null;
      const filled = fill !== null && fill.days > 0;
      part('noaa20-fill').hidden = !filled;
      setText('noaa20-fill', filled ? t(lang, 'method.noaa20.fill', { days: number(fill.days), year: fill.first.slice(0, 4) }) : '');
      const scaleName = (scale: string) => {
        const name = t(lang, `method.test.scales.${scale}`);
        return name.charAt(0).toLocaleLowerCase(lang) + name.slice(1);
      };
      const [from, to] = noaa20.handover.years;
      showTable('table-noaa20', 
        table(
          doc,
          t(lang, 'method.noaa20.caption'),
          [[t(lang, 'method.noaa20.check'), t(lang, 'method.test.n'), ...metricHeads].map((text) => ({ text }))],
          [
            ...SCALES.map((scale) => [
              t(lang, 'method.noaa20.testRow', { scale: scaleName(scale) }),
              number(noaa20.test[scale].n),
              ...metricsCells(noaa20.test[scale]),
            ]),
            ...(['national_month', 'province_month'] as const).map((scale) => [
              t(lang, 'method.noaa20.handoverRow', { from, to, scale: scaleName(scale) }),
              number(noaa20.handover[scale].n),
              ...metricsCells(noaa20.handover[scale]),
            ]),
          ],
        ),
      );
    }

    // 10. Limits, with the measured size of the understatement where the file gives it.
    const limits = tList(lang, 'method.limits.items');
    limits.splice(
      EXTREME_LIMIT_POSITION,
      0,
      extremeText ? t(lang, 'method.limits.extremePct', { pct: extremeText }) : t(lang, 'method.limits.extreme'),
    );
    // NOAA-20's gaps to Aqua by province, against S-NPP's: where they differ, the months NOAA-20 carries can step.
    const noaa20Bias = new Map((v.noaa20?.province_bias ?? []).map((row) => [row.prov, row.bias]));
    const differing = (v.province_bias ?? [])
      .filter((row) => Number.isFinite(row.bias) && Number.isFinite(noaa20Bias.get(row.prov)))
      .map((row) => ({ name: row.name, snpp: row.bias, noaa: noaa20Bias.get(row.prov)! }));
    const apart = differing.filter((row) => Math.abs(row.noaa - row.snpp) > NOAA20_APART);
    const n20 = carriers.find((carrier) => carrier.sat === 'N20');
    if (apart.length > 0 && n20) {
      const most = apart.reduce((top, row) => (Math.abs(row.noaa - row.snpp) > Math.abs(top.noaa - top.snpp) ? row : top));
      limits.splice(
        limits.length - 1,
        0,
        t(lang, 'method.limits.noaa20Provinces', {
          count: number(apart.length),
          total: number(differing.length),
          name: most.name,
          snpp: signedPercent(most.snpp, lang, 0),
          noaa: signedPercent(most.noaa, lang, 0),
          month: t(lang, 'period.monthLong', {
            month: t(lang, `months.long.${monthOfIdx(n20.fromIdx) - 1}`),
            year: yearOfIdx(n20.fromIdx),
          }),
        }),
      );
    }
    part('limits-list').replaceChildren(...limits.map((item) => h(doc, 'li', {}, item)));

    // The partner-agency cross-check, when the pipeline delivers one.
    part('partner').hidden = v.partner_check === null || v.partner_check === undefined;

    // Data and credits.
    part('data-list').replaceChildren(...tList(lang, 'method.data.items').map((item) => h(doc, 'li', {}, item)));
    setStatus(part('excluded-text'), v.excluded_days > 0 ? t(lang, 'method.data.excluded', { days: number(v.excluded_days) }) : null);
    setText('data-through', t(lang, 'method.data.through', { date: meta.data_end_date, generated: String(v.generated_utc ?? '').slice(0, 10) }));
  }

  function setLanguage(next: Lang): void {
    if (next === lang) return;
    lang = next;
    win.history.replaceState(null, '', `${win.location.pathname}${win.location.search}${lang === 'en' ? '' : `#lang=${lang}`}`);
    render();
  }

  const listeners: Array<[EventTarget, string, EventListener]> = [
    [el.langEn, 'click', () => setLanguage('en')],
    [el.langEs, 'click', () => setLanguage('es')],
    [win, 'hashchange', () => setLanguage(decodeState(win.location.hash).lang)],
  ];
  for (const [target, type, listener] of listeners) target.addEventListener(type, listener);

  applyStaticText(doc, lang);
  enqueue(load);

  return {
    async idle() {
      let seen: Promise<void>;
      do {
        seen = queue;
        await seen;
      } while (seen !== queue);
    },
    destroy() {
      destroyed = true;
      for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
    },
  };
}
