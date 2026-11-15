// The page: loads the data, keeps the state in step with the address and the
// controls, and redraws the results when either changes.
//
// Loading an area's series runs through one queue, so results are always drawn
// in the order they were asked for. The detections for the map and for the
// hotspots CSV are megabytes of tiles: they load in the background, off the
// queue, so the page keeps answering while they arrive. Tests wait on idle().

import { areaShape, drawnShape, resolveArea, type AreaData } from './area';
import { renderSeasonalProfile, renderYearlyBars, seasonalProfileModel, yearlyBarsModel } from './charts';
import {
  buildCalendarModel,
  calendarSvg,
  describeCell,
  renderCalendar,
  renderTable,
  type CalendarInput,
  type CalendarModel,
} from './calendar';
import {
  loadMeta,
  loadProvinceShapes,
  loadProvinces,
  loadValidation,
  type AreaSummary,
  type Layer,
  type Meta,
  type Validation,
} from './data';
import { applyStaticText, byId, h, loadErrorText, setStatus } from './dom';
import {
  areaSlug,
  calendarCsv,
  calendarPng,
  downloadBlob,
  hotspotsCsv,
  monthDots,
  type ExportInfo,
  type TileError,
  type TooLarge,
} from './exports';
import { formatNumber, t, tCount, type Lang } from './i18n';
import {
  assessMonth,
  completenessFromMeta,
  errorBands,
  monthlyMedians,
  peakMonth,
  seasonFromMedians,
  seriesCarriers,
  trend,
  viirsSatellites,
  yearOfIdx,
  yearlyTotals,
  type Carrier,
  type Completeness,
  type ErrorBand,
} from './stats';
import {
  NATION_ID,
  RADIUS_KM,
  YEAR_MAX,
  YEAR_MIN,
  clampRadius,
  csvDates,
  decodeState,
  encodeState,
  sameArea,
  type AppState,
  type Area,
  type Mode,
} from './state';
import { storyCards } from './stories';
import {
  BIAS_CHECK_LIMIT,
  extremeBandBias,
  provinceFindings,
  trendFrom,
  trendClass,
  trendWithoutBias,
  yearSoFar,
} from './findings';
import { aboutCount, biasCaution, framedTrend, hotspotsText, periodLabel, testLine, trendSentence, verdict, yearSoFarSentence } from './verdict';

/** Ways to stand in for the browser, and to tighten the limits. Used by the tests. */
export interface StartOptions {
  /** Hands a file to the reader. Default: a browser download. */
  save?: (blob: Blob, fileName: string) => void;
  /** Turns the calendar drawing into a PNG. Default: through a canvas. */
  toPng?: (drawing: SVGSVGElement) => Promise<Blob>;
  /** Puts a text on the clipboard. Default: the browser's clipboard. */
  copy?: (text: string) => Promise<void>;
  /** The most point tiles one request may touch, and the most dots on the map. Default: 80 and 20,000. */
  limits?: { tiles?: number; dots?: number };
  /** How long the first drawing waits for validation.json before going on without it. Default: 3,000 ms. */
  validationWaitMs?: number;
}

export interface App {
  /** A copy of the current state. */
  state(): AppState;
  /** Resolves when the selected area has been loaded and drawn. Background downloads may still be running. */
  drawn(): Promise<void>;
  /** Resolves when everything that was asked for has been loaded and drawn, background downloads included. */
  idle(): Promise<void>;
  /** Removes the page's listeners. */
  destroy(): void;
}

/** What the page knows once the first files are loaded. */
interface Loaded {
  meta: Meta;
  completeness: Completeness;
  /** The satellites that carry the series, in order. */
  carriers: Carrier[];
  /** The nation first, then the provinces. */
  areas: AreaSummary[];
  /** The last year with any data: the upper end of the year slider. */
  lastYear: number;
  /** validation.json, once it has arrived. The page works without it. */
  validation: Validation | null;
  /** Test-year error by the size of the count, from validation.json; empty until then. */
  errorBands: ErrorBand[];
}

type MapModule = typeof import('./map');

/** The longest the first drawing waits for validation.json. */
const VALIDATION_WAIT_MS = 3000;

/** Keeps a p-value such as "(p = 0.002)" on one line where the sentence wraps. */
function unbroken(sentence: string): string {
  return sentence.replace(/\(p [=<] [^)]*\)/g, (value) => value.replace(/ /g, '\u00a0'));
}

/** The area's name for headings and file names: a province name, or a description of the drawn area. */
export function areaLabel(data: Pick<AreaData, 'area' | 'name'>, lang: Lang): string {
  if (data.name !== null) return data.name;
  if (data.area.kind === 'circle') {
    const { lat, lon, km } = data.area;
    return t(lang, 'area.name.circle', { km, lat, lon });
  }
  return t(lang, 'area.name.polygon');
}

export function startApp(doc: Document, options: StartOptions = {}): App {
  const win = doc.defaultView!;
  const save = options.save ?? ((blob: Blob, fileName: string) => downloadBlob(doc, blob, fileName));
  const toPng = options.toPng ?? calendarPng;
  const copy = options.copy ?? ((text: string) => win.navigator.clipboard.writeText(text));
  let state = decodeState(win.location.hash);
  let loaded: Loaded | null = null;
  let data: AreaData | null = null;
  let model: CalendarModel | null = null;
  let map: MapModule | null = null;
  let tableView = false;
  /** The area and month whose dots are on the map (or were asked for), so they are not fetched twice. */
  let dotsShown = '';
  let queue: Promise<void> = Promise.resolve();
  /** Downloads that run beside the queue: the dots of a month and the hotspots CSV. */
  let background: Promise<void> = Promise.resolve();
  let destroyed = false;

  const el = {
    province: byId<HTMLSelectElement>(doc, 'province'),
    mapBox: byId(doc, 'map'),
    mapStatus: byId(doc, 'map-status'),
    dotsStatus: byId(doc, 'dots-status'),
    downloadCalendar: byId<HTMLButtonElement>(doc, 'download-calendar'),
    downloadPng: byId<HTMLButtonElement>(doc, 'download-png'),
    downloadHotspots: byId<HTMLButtonElement>(doc, 'download-hotspots'),
    downloadStatus: byId(doc, 'download-status'),
    hotspotsHint: byId(doc, 'hotspots-hint'),
    mapDetails: byId<HTMLDetailsElement>(doc, 'map-details'),
    circleForm: byId<HTMLFormElement>(doc, 'circle-form'),
    circleLat: byId<HTMLInputElement>(doc, 'circle-lat'),
    circleLon: byId<HTMLInputElement>(doc, 'circle-lon'),
    circleKm: byId<HTMLInputElement>(doc, 'circle-km'),
    circleMessage: byId(doc, 'circle-message'),
    title: byId(doc, 'area-title'),
    notice: byId(doc, 'area-notice'),
    loadStatus: byId(doc, 'load-status'),
    body: byId(doc, 'results-body'),
    verdictCard: byId(doc, 'verdict-card'),
    verdictLabel: byId(doc, 'verdict-label'),
    verdictText: byId(doc, 'verdict-text'),
    verdictMore: byId(doc, 'verdict-more'),
    rawTrend: byId(doc, 'raw-trend'),
    cautionCheck: byId(doc, 'caution-check'),
    extremeNote: byId(doc, 'extreme-note'),
    yearSoFar: byId(doc, 'year-so-far'),
    viewHint: byId(doc, 'view-hint'),
    trendLineHint: byId(doc, 'trend-line-hint'),
    caution: byId(doc, 'caution'),
    testLineText: byId(doc, 'test-line-text'),
    yearly: byId(doc, 'yearly'),
    trendText: byId(doc, 'trend-text'),
    seasonalCard: byId(doc, 'seasonal-card'),
    seasonal: byId(doc, 'seasonal'),
    rawBanner: byId(doc, 'raw-banner'),
    tableToggle: byId<HTMLButtonElement>(doc, 'table-toggle'),
    calendar: byId(doc, 'calendar'),
    calendarTable: byId(doc, 'calendar-table'),
    cellDetail: byId(doc, 'cell-detail'),
    yearFrom: byId<HTMLInputElement>(doc, 'year-from'),
    yearTo: byId<HTMLInputElement>(doc, 'year-to'),
    yearFill: byId(doc, 'year-range-fill'),
    yearLabel: byId(doc, 'year-range-label'),
    dateFrom: byId<HTMLInputElement>(doc, 'date-from'),
    dateTo: byId<HTMLInputElement>(doc, 'date-to'),
    dataThrough: byId(doc, 'data-through'),
    langEn: byId<HTMLButtonElement>(doc, 'lang-en'),
    langEs: byId<HTMLButtonElement>(doc, 'lang-es'),
    copyLink: byId<HTMLButtonElement>(doc, 'copy-link'),
    linkStatus: byId(doc, 'link-status'),
    footerFirms: byId(doc, 'footer-firms'),
    stories: byId(doc, 'stories'),
    storyList: byId(doc, 'story-list'),
  };
  const radios = (name: string) => Array.from(doc.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${name}"]`));

  // ---- The queue ----------------------------------------------------------------

  function enqueue(task: () => Promise<void>): void {
    queue = queue.then(() => (destroyed ? undefined : task())).catch((error: unknown) => {
      console.error(error);
    });
  }

  /** Runs a download beside the queue, so it never holds up a change of area, month or language. */
  function inBackground(task: () => Promise<void>): void {
    const running = destroyed ? Promise.resolve() : task().catch((error: unknown) => console.error(error));
    background = Promise.all([background, running]).then(() => undefined);
  }

  async function drawn(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = queue;
      await seen;
    } while (seen !== queue);
  }

  async function idle(): Promise<void> {
    for (;;) {
      const [waitedQueue, waitedBackground] = [queue, background];
      await waitedQueue;
      await waitedBackground;
      if (waitedQueue === queue && waitedBackground === background) return;
    }
  }

  // ---- Loading and errors -------------------------------------------------------

  function showLoading(key: string): void {
    el.loadStatus.replaceChildren(t(state.lang, key));
    el.loadStatus.hidden = false;
  }

  function clearLoadStatus(): void {
    el.loadStatus.replaceChildren();
    el.loadStatus.hidden = true;
  }

  /** Says which file failed and offers to run `retry` again. Never leaves a blank page or an endless "loading". */
  function showLoadError(error: unknown, retry: () => Promise<void>): void {
    console.error(error);
    setMessage(el.loadStatus, loadErrorText(error, state.lang), () => {
      showLoading('app.loading');
      enqueue(retry);
    });
    el.body.hidden = true;
  }

  async function boot(): Promise<void> {
    showLoading('app.loading');
    // validation.json decides whether a province's trend survives its check, so the first headline
    // waits for it, but not for long: a slow or missing file must not hold the page.
    const validationLoad = loadValidation().then(
      (validation): Validation | null => validation,
      (error: unknown) => {
        console.warn(error);
        return null;
      },
    );
    try {
      const [meta, areas] = await Promise.all([loadMeta(), loadProvinces()]);
      const completeness = completenessFromMeta(meta);
      loaded = {
        meta,
        completeness,
        carriers: seriesCarriers(meta),
        areas,
        lastYear: yearOfIdx(completeness.lastMonthIdx),
        validation: null,
        errorBands: [],
      };
    } catch (error) {
      showLoadError(error, boot);
      return;
    }
    if (state.sel !== null && state.sel > loaded.completeness.lastMonthIdx) state = { ...state, sel: null };
    const waited = options.validationWaitMs ?? VALIDATION_WAIT_MS;
    const early = await Promise.race([
      validationLoad,
      new Promise<undefined>((resolve) => win.setTimeout(() => resolve(undefined), waited)),
    ]);
    if (early) applyValidation(early);
    fillFixedParts();
    await refreshArea({ fit: true });
    // Arriving late, it is applied when it comes, beside the queue.
    if (early === undefined) {
      inBackground(async () => {
        const late = await validationLoad;
        if (late && loaded) {
          applyValidation(late);
          render();
        }
      });
    }
    if (el.mapDetails.open) enqueue(loadMap);
  }

  /** validation.json: the error bands, the provinces' gaps to MODIS and the checks on their trends. */
  function applyValidation(validation: Validation): void {
    if (!loaded) return;
    loaded.validation = validation;
    loaded.errorBands = errorBands(validation);
  }

  /** Loads the series of the selected area, then redraws. */
  async function refreshArea(options: { fit: boolean }): Promise<void> {
    if (!loaded) return;
    if (state.area.kind !== 'province') showLoading('app.loadingGrid');
    try {
      data = await resolveArea(state.area, state.view);
    } catch (error) {
      showLoadError(error, () => refreshArea(options));
      return;
    }
    state.area = data.area; // an unknown province has become the nation
    clearLoadStatus();
    setStatus(el.downloadStatus, null);
    render();
    writeHash();
    showAreaOnMap(options.fit);
    startDots();
  }

  /** Loads the map the first time its panel is open; after that, only tells it that its box is back. */
  async function loadMap(): Promise<void> {
    if (map) {
      map.refreshMapSize();
      return;
    }
    if (!loaded) return;
    try {
      const [module, provinces] = await Promise.all([import('./map'), loadProvinceShapes()]);
      module.initMap(el.mapBox, provinces, { lang: state.lang, labels: drawLabels() });
      module.onAreaChange((area) => setArea(area, { fit: false }));
      map = module;
      setStatus(el.mapStatus, null);
      showAreaOnMap(true);
      dotsShown = '';
      startDots();
    } catch (error) {
      console.error(error);
      setStatus(el.mapStatus, t(state.lang, 'area.mapError'));
    }
  }

  /** The texts the map shows itself: the drawing tools, the touch hint and the optional CONAE layer. */
  function drawLabels(): import('./map').DrawLabels {
    const lang = state.lang;
    return {
      polygon: t(lang, 'area.draw.polygon'),
      rectangle: t(lang, 'area.draw.rectangle'),
      rectangleHint: t(lang, 'area.draw.rectangleHint'),
      touchHint: t(lang, 'area.touchHint'),
      overlay: t(lang, 'area.overlay.label'),
      overlayAttribution: t(lang, 'area.overlay.attribution'),
      overlayError: t(lang, 'area.overlay.error'),
    };
  }

  function showAreaOnMap(fit: boolean): void {
    if (!map) return;
    map.setArea(state.area, state.area.kind === 'province' ? null : drawnShape(state.area), { fit });
    showTrendsOnMap();
  }

  /**
   * While the whole country is selected, the map colours each province by its harmonized trend,
   * and marks the ones whose trend fails its check. For a single area the provinces go back to
   * plain outlines, so that the area and its dots stand out; raw counts have no trend worth a colour.
   */
  function showTrendsOnMap(): void {
    if (!map || !loaded) return;
    const nation = state.area.kind === 'province' && state.area.id === NATION_ID && state.view === 'harmonized';
    if (!nation) {
      map.setProvinceTrends(null);
      return;
    }
    const lang = state.lang;
    const switchYear = yearOfIdx(loaded.carriers[1]?.fromIdx ?? 0);
    const tones: import('./map').ProvinceTrends['tones'] = {};
    for (const row of provinceFindings(loaded.areas.slice(1), loaded.completeness, switchYear, loaded.validation?.province_bias)) {
      const kind = trendClass(row.harmonized);
      tones[row.id] = { tone: kind === 'rare' || kind === 'short' ? 'unrated' : kind, unsure: row.holds === false };
    }
    map.setProvinceTrends({
      tones,
      legend: {
        title: t(lang, 'area.trendLegend.title', { from: YEAR_MIN }),
        falling: t(lang, 'area.trendLegend.falling'),
        none: t(lang, 'area.trendLegend.none'),
        rising: t(lang, 'area.trendLegend.rising'),
        unrated: t(lang, 'area.trendLegend.unrated'),
        unsure: t(lang, 'area.trendLegend.unsure'),
      },
    });
  }

  // ---- State --------------------------------------------------------------------

  function writeHash(): void {
    const hash = encodeState(state);
    const url = `${win.location.pathname}${win.location.search}${hash ? `#${hash}` : ''}`;
    win.history.replaceState(null, '', url);
  }

  /** Changes the area and loads its series. */
  function setArea(area: Area, options: { fit: boolean }): void {
    if (sameArea(area, state.area) && data) return;
    state = { ...state, area, sel: null };
    enqueue(() => refreshArea(options));
  }

  /** Changes anything that needs no new data, then redraws. */
  function update(patch: Partial<AppState>): void {
    state = { ...state, ...patch };
    render();
    writeHash();
    if ('sel' in patch) startDots();
  }

  /** Harmonized or Raw. A drawn area has to fetch the raw grid the first time. */
  function setView(view: Layer): void {
    if (view === state.view) return;
    state = { ...state, view };
    if (view === 'raw' && data?.kind === 'custom' && data.raw === null && data.coverage !== 'outside') {
      enqueue(() => refreshArea({ fit: false }));
    } else {
      render();
      writeHash();
    }
  }

  function onHashChange(): void {
    applyState(decodeState(win.location.hash));
  }

  /** Takes on a whole new state: from the address, or from a story link. */
  function applyState(wanted: AppState): void {
    let next = wanted;
    if (encodeState(next) === encodeState(state)) return;
    if (loaded && next.sel !== null && next.sel > loaded.completeness.lastMonthIdx) next = { ...next, sel: null };
    const needsData = !sameArea(next.area, state.area) || next.view !== state.view;
    const langChanged = next.lang !== state.lang;
    state = next;
    if (langChanged && loaded) fillFixedParts();
    if (needsData) enqueue(() => refreshArea({ fit: true }));
    else {
      render();
      writeHash();
      startDots();
    }
  }

  function setLanguage(lang: Lang): void {
    if (lang === state.lang) return;
    state = { ...state, lang };
    fillFixedParts();
    render();
    writeHash();
    dotsShown = '';
    startDots(); // the line under the map is in the old language
  }

  async function copyLink(): Promise<void> {
    const url = win.location.href;
    try {
      await copy(url);
      setStatus(el.linkStatus, t(state.lang, 'link.copied'));
    } catch {
      // No clipboard (an old browser, or a page not served over https): show the link to copy by hand.
      setStatus(el.linkStatus, t(state.lang, 'link.manual', { url }));
    }
  }

  // ---- Drawing ------------------------------------------------------------------

  /** The parts that depend only on the language and the loaded files. */
  function fillFixedParts(): void {
    if (!loaded) return;
    const lang = state.lang;
    applyStaticText(doc, lang);
    doc.title = t(lang, 'app.title');
    doc.querySelector('meta[name="description"]')?.setAttribute('content', t(lang, 'app.description'));
    el.dataThrough.textContent = t(lang, 'footer.dataThrough', { date: loaded.meta.data_end_date });
    // Only the satellites that carry the record in this data are credited.
    el.footerFirms.textContent = t(lang, 'footer.firms', { viirs: viirsSatellites(loaded.carriers).join(', ') });

    const provinces = loaded.areas.slice(1).sort((a, b) => a.name.localeCompare(b.name, lang));
    el.province.replaceChildren(
      h(doc, 'option', { value: NATION_ID }, t(lang, 'area.nation')),
      ...provinces.map((province) => h(doc, 'option', { value: province.id }, province.name)),
    );

    for (const slider of [el.yearFrom, el.yearTo]) {
      slider.min = String(YEAR_MIN);
      slider.max = String(loaded.lastYear);
    }
    el.dateFrom.min = `${YEAR_MIN}-01-01`;
    el.dateFrom.max = loaded.meta.data_end_date;
    el.dateTo.min = `${YEAR_MIN}-01-01`;
    el.dateTo.max = loaded.meta.data_end_date;

    el.langEn.setAttribute('aria-pressed', String(lang === 'en'));
    el.langEs.setAttribute('aria-pressed', String(lang === 'es'));
    // Every link to the method page carries the language, so a Spanish reader lands on the Spanish page.
    for (const link of doc.querySelectorAll('a[data-method-link]')) {
      link.setAttribute('href', lang === 'en' ? 'method.html' : `method.html#lang=${lang}`);
    }
    setStatus(el.linkStatus, null);
    map?.setMapLanguage(lang, drawLabels());

    // Story links, with captions computed from the data.
    const cards = storyCards(loaded.areas, loaded.completeness, lang);
    el.stories.hidden = cards.length === 0;
    el.storyList.replaceChildren(
      ...cards.map((card) => {
        const link = h(
          doc,
          'a',
          { class: 'story', href: `#${card.hash}` },
          h(doc, 'span', { class: 'story-title' }, card.title),
          h(doc, 'span', { class: 'story-caption' }, card.caption),
        );
        link.addEventListener('click', (event) => {
          event.preventDefault();
          applyState(decodeState(card.hash));
        });
        return link;
      }),
    );
  }

  /** The year range the calendar shows: the state's range, kept inside the years with data. */
  function shownYears(): { from: number; to: number } {
    const last = loaded?.lastYear ?? YEAR_MAX;
    const from = Math.min(Math.max(state.yearFrom, YEAR_MIN), last);
    const to = Math.min(Math.max(state.yearTo, from), last);
    return { from, to };
  }

  function render(): void {
    if (!loaded || !data) return;
    const lang = state.lang;
    const name = areaLabel(data, lang);
    el.title.textContent = name;

    const notes: string[] = [];
    if (data.kind === 'custom') {
      if (data.coverage === 'outside') notes.push(t(lang, 'area.status.outside'));
      else {
        if (data.coverage === 'clipped') notes.push(t(lang, 'area.status.clipped'));
        notes.push(t(lang, data.tooSmall ? 'area.status.tooSmall' : data.thin ? 'area.status.thin' : 'area.status.custom'));
      }
    }
    setStatus(el.notice, notes.length > 0 ? notes.join(' ') : null);

    syncControls();
    const outside = data.coverage === 'outside';
    el.body.hidden = outside;
    if (outside) {
      model = null;
      return;
    }

    // In Raw view a drawn area's raw counts may still be on their way: keep the last drawing until then.
    if (state.view === 'raw' && data.raw === null) return;

    model = buildCalendarModel(calendarInput(state.view, state.mode)!);

    el.tableToggle.setAttribute('aria-pressed', String(tableView));
    el.calendar.hidden = tableView;
    el.calendarTable.hidden = !tableView;
    if (tableView) renderTable(el.calendarTable, model, { lang, areaName: name });
    else renderCalendar(el.calendar, model, { lang, areaName: name, onSelect: toggleSelected });

    const selected = model.rows.flatMap((row) => row.cells).find((cell) => cell.selected);
    // The whole country holds too many detections for the map and the CSV: say so before the reader clicks.
    const nation = data.kind === 'nation';
    el.cellDetail.textContent = selected
      ? describeCell(selected, lang).join(' · ')
      : t(lang, nation ? 'calendar.detailHintNation' : 'calendar.detailHint');
    el.hotspotsHint.hidden = !nation;

    for (const radio of radios('view')) radio.checked = radio.value === state.view;
    for (const radio of radios('mode')) {
      radio.checked = radio.value === model.mode;
      radio.disabled = radio.value === 'anomaly' && !model.anomalyEnabled;
    }

    renderCards(name);
    showTrendsOnMap();
  }

  /** The headline, the caution, the test line, the switch, the yearly totals with the trend, and the seasonal profile. */
  function renderCards(name: string): void {
    if (!loaded || !data) return;
    const lang = state.lang;
    const c = loaded.completeness;
    const isRaw = state.view === 'raw';
    const series = { monthly: data.monthly, mtd: data.mtd };
    const switchYear = yearOfIdx(loaded.carriers[1]?.fromIdx ?? 0);

    // The headline says two things: the long-term trend of the harmonized series, and how a month
    // compares with its usual level (the selected month, or else the latest month with data). The
    // trend comes first where it is clear, unless the reader has picked a month; then the month
    // does. Never of raw counts.
    const month = state.sel ?? c.lastMonthIdx;
    const medians = monthlyMedians(data.monthly, c);
    const assessed = assessMonth(series, month, c);
    const monthText = verdict({ season: seasonFromMedians(medians), peak: peakMonth(medians), month: assessed }, lang);
    const harmonizedTotals = yearlyTotals(data.monthly, c);
    const fitted = trend(harmonizedTotals);
    // A clear trend whose years since the sensor switch, taken alone, show none: most of the change came before.
    const recent = trendFrom(harmonizedTotals, switchYear);
    const recentFlat = trendClass(fitted) !== 'none' && !('reason' in fitted) && trendClass(recent) === 'none';
    const trendText = `${trendSentence(fitted, lang, { switchYear })}${recentFlat ? ` ${t(lang, 'trend.recentNone', { year: switchYear })}` : ''}`;
    // Where a province ran far from MODIS in the test, a trend could be that gap and not fire: the
    // trend is tested again with the gap taken out of the VIIRS years. A check, never a correction.
    const provinceId = !isRaw && data.kind === 'province' && data.area.kind === 'province' ? data.area.id : null;
    const bias = loaded.validation?.province_bias?.find((province) => province.prov === provinceId)?.bias;
    const adjusted =
      bias !== undefined && Math.abs(bias) > BIAS_CHECK_LIMIT && !('reason' in fitted)
        ? trendWithoutBias(yearlyTotals(data.monthly, c), switchYear, bias)
        : null;
    const holds = adjusted === null ? null : trendClass(adjusted) === trendClass(fitted);
    // A trend that does not survive that check is not a headline.
    const trendLeads = state.sel === null && !('reason' in fitted) && fitted.direction !== 'none' && holds !== false;
    el.verdictCard.hidden = isRaw;
    el.verdictLabel.textContent = t(
      lang,
      trendLeads ? 'verdict.label.trend' : state.sel === null ? 'verdict.label.latest' : 'verdict.label.selected',
    );
    el.verdictText.textContent = unbroken(trendLeads ? trendText : monthText);
    el.verdictMore.textContent = unbroken(trendLeads ? monthText : trendText);

    // What stitching the two sensors without harmonizing would have concluded for this area. A
    // drawn area's raw counts are loaded only for Raw view; until they are there the line is left out.
    const rawFitted = !isRaw && data.raw ? trend(yearlyTotals(data.raw, c)) : null;
    setStatus(
      el.rawTrend,
      rawFitted && !('reason' in rawFitted) ? unbroken(framedTrend('trend.rawWouldSay', rawFitted, lang, { raw: true })) : null,
    );

    const caution = provinceId === null ? null : biasCaution(loaded.validation, provinceId, lang);
    setStatus(el.caution, caution);
    const check = caution !== null && adjusted ? framedTrend(holds ? 'robust.holds' : 'robust.changes', adjusted, lang) : null;
    setStatus(el.cautionCheck, check === null ? null : unbroken(check));
    // A month far above its usual level: the test says how such months read, and the page passes it on.
    // The figure is the average of months in the same band (5 to 10 times, or 10 times and more); single months vary widely.
    const extreme = !isRaw && assessed.ratio !== null ? extremeBandBias(loaded.validation?.bias_by_level, assessed.ratio) : null;
    setStatus(
      el.extremeNote,
      extreme !== null && Math.round(Math.abs(extreme.bias) * 100) > 0
        ? t(lang, extreme.bias < 0 ? 'caution.extremeLow' : 'caution.extremeHigh', {
            band: t(lang, extreme.band === '10x+' ? 'caution.band10' : 'caution.band5'),
            pct: formatNumber(lang, Math.abs(extreme.bias) * 100),
          })
        : null,
    );
    el.testLineText.textContent = `${testLine(loaded.meta, lang)} `;

    // The switch, and what Raw is: one line beside it, or the banner once Raw is on.
    el.viewHint.textContent = t(lang, 'view.hint', { year: switchYear });
    el.viewHint.hidden = isRaw;
    el.rawBanner.textContent = t(lang, 'rawBanner', { before: switchYear - 1, year: switchYear });
    el.rawBanner.hidden = !isRaw;

    // Yearly totals follow the switch. The trend line is drawn over the harmonized series only. The
    // sentence under the chart is for Raw view, where the headline, which holds it otherwise, is off.
    const totals = yearlyTotals(isRaw ? (data.raw ?? []) : data.monthly, c);
    const bars = yearlyBarsModel(totals, { view: state.view, switchYear, trend: isRaw ? null : fitted });
    renderYearlyBars(el.yearly, bars, { lang, areaName: name });
    el.trendLineHint.hidden = bars.trendLine === null;
    el.trendText.textContent = trendSentence(isRaw ? trend(totals) : fitted, lang, { raw: isRaw, switchYear });
    el.trendText.hidden = !isRaw;

    el.seasonalCard.hidden = isRaw;
    // The year so far against the same date in earlier years: a comparison across both sensors.
    const soFar = isRaw ? null : yearSoFar(series, c);
    setStatus(el.yearSoFar, soFar ? yearSoFarSentence(soFar, lang) : null);
    if (!isRaw) {
      renderSeasonalProfile(el.seasonal, seasonalProfileModel(data.monthly, c, yearOfIdx(month), data.mtd), { lang, areaName: name });
    }
  }

  // ---- Dots and downloads ------------------------------------------------------

  /** A message in a status box, with a "Try again" button that calls `retry` when it is given. */
  function setMessage(box: HTMLElement, message: string | null, retry?: () => void): void {
    box.replaceChildren();
    box.hidden = message === null;
    if (message === null) return;
    box.append(h(doc, 'span', {}, message));
    if (retry) {
      const button = h(doc, 'button', { type: 'button', class: 'button button-small' }, t(state.lang, 'app.retry'));
      button.addEventListener('click', retry);
      box.append(' ', button);
    }
  }

  function tooLargeText(key: string, result: TooLarge): string {
    return t(state.lang, key, { tiles: result.tiles, limit: result.limit });
  }

  /** Names the tile that failed; the error's own English detail goes to the console only. */
  function tileErrorText(result: TileError | null): string {
    return result?.tileId ? t(state.lang, 'dots.error', { tile: result.tileId }) : t(state.lang, 'dots.errorPlain');
  }

  /** Starts loading the selected month's detections for the map, without holding the queue. */
  function startDots(): void {
    inBackground(refreshDots);
  }

  /** Shows the hotspots of the selected month on the map, or says why it cannot. */
  /**
   * Shows the detections of the selected month on the map, or says why it cannot.
   * It runs beside the queue; if the area or the month changes while the tiles
   * are loading, the late result is dropped.
   */
  async function refreshDots(): Promise<void> {
    const area = data;
    if (!loaded || !area || !map) return;
    const lang = state.lang;
    const sel = state.sel;
    const key = sel === null || area.coverage === 'outside' ? '' : `${encodeState({ ...state, sel: null })}|${sel}`;
    if (key === dotsShown) return;
    dotsShown = key;
    map.clearDots();
    if (key === '' || sel === null) {
      setMessage(el.dotsStatus, null);
      return;
    }
    const period = periodLabel({ monthIdx: sel, partialDay: null }, lang);
    setMessage(el.dotsStatus, t(lang, 'dots.loading', { period }));
    const retry = () => {
      dotsShown = '';
      startDots();
    };
    try {
      const shape = await areaShape(area);
      if (dotsShown !== key) return;
      if (!shape) {
        setMessage(el.dotsStatus, null);
        return;
      }
      const result = await monthDots(shape, sel, loaded.meta, { limit: options.limits?.dots, maxTiles: options.limits?.tiles });
      if (dotsShown !== key) return; // the area or the month moved on while the tiles were loading
      if (result.status === 'tooLarge') {
        setMessage(el.dotsStatus, tooLargeText('dots.tooLarge', result));
      } else if (result.status === 'error') {
        console.error(result.message);
        setMessage(el.dotsStatus, tileErrorText(result), retry);
      } else if (result.total === 0) {
        setMessage(el.dotsStatus, t(lang, 'dots.none', { period }));
      } else {
        map.showDots(result);
        const shown = formatNumber(lang, result.count);
        const message =
          result.count < result.total
            ? t(lang, 'dots.capped', { shown, total: formatNumber(lang, result.total), period })
            : tCount(lang, 'dots.shown', result.count, { shown, params: { period } });
        // VIIRS reports many small detections, each a fraction of a MODIS-equivalent hotspot: say what they weigh.
        const weighed = t(lang, 'dots.weighed', { count: hotspotsText(aboutCount(result.weight), lang) });
        const drawnNote = area.kind === 'custom' ? ` ${t(lang, 'dots.weighedDrawn')}` : '';
        setMessage(el.dotsStatus, `${message} ${weighed}${drawnNote}`);
      }
    } catch (error) {
      console.error(error);
      if (dotsShown === key) setMessage(el.dotsStatus, tileErrorText(null), retry);
    }
  }

  function exportInfo(): ExportInfo | null {
    if (!loaded || !data) return null;
    return {
      areaName: areaLabel(data, state.lang),
      areaSlug: areaSlug(data.area, data.name),
      drawn: data.kind === 'custom',
      meta: loaded.meta,
      lang: state.lang,
    };
  }

  /** What the calendar is built from, for the view and mode asked for. */
  function calendarInput(view: Layer, mode: Mode): CalendarInput | null {
    if (!loaded || !data) return null;
    const years = shownYears();
    return {
      monthly: data.monthly,
      raw: data.raw,
      mtd: data.mtd,
      completeness: loaded.completeness,
      carriers: loaded.carriers,
      errorBands: loaded.errorBands,
      view,
      mode,
      yearFrom: years.from,
      yearTo: years.to,
      sel: state.sel,
    };
  }

  async function saveCalendarCsv(): Promise<void> {
    const info = exportInfo();
    const input = calendarInput('harmonized', 'count');
    if (!info || !input) return;
    const { blob, fileName } = calendarCsv(buildCalendarModel({ ...input, sel: null }), info);
    save(blob, fileName);
    setMessage(el.downloadStatus, t(state.lang, 'downloads.savedFile', { file: fileName }));
  }

  async function savePng(): Promise<void> {
    const info = exportInfo();
    if (!info || !model) return;
    const lang = state.lang;
    const years = shownYears();
    const what = t(lang, model.view === 'raw' ? 'downloads.pngRaw' : model.mode === 'anomaly' ? 'downloads.pngAnomaly' : 'downloads.pngCount');
    const drawing = calendarSvg(doc, model, {
      lang,
      width: 1200,
      idPrefix: 'export',
      frame: {
        title: t(lang, 'downloads.pngTitle', { area: info.areaName, from: years.from, to: years.to, what }),
        footer: t(lang, 'downloads.pngFooter'),
      },
    });
    const fileName = `focos_calendar_${info.areaSlug}_${years.from}_${years.to}.png`;
    try {
      save(await toPng(drawing), fileName);
      setMessage(el.downloadStatus, t(lang, 'downloads.savedFile', { file: fileName }));
    } catch (error) {
      console.error(error);
      setMessage(el.downloadStatus, t(lang, 'downloads.pngError'));
    }
  }

  /** Builds the hotspots CSV in the background and hands it over, or says why it cannot. */
  async function saveHotspots(): Promise<void> {
    const info = exportInfo();
    const area = data;
    if (!info || !loaded || !area) return;
    const lang = state.lang;
    const years = shownYears();
    const dates = csvDates({ ...state, yearFrom: years.from, yearTo: years.to }, loaded.meta.data_end_date);
    const retry = () => inBackground(saveHotspots);
    setMessage(el.downloadStatus, t(lang, 'downloads.preparing'));
    try {
      const shape = await areaShape(area);
      if (!shape) {
        setMessage(el.downloadStatus, t(lang, 'downloads.outside'));
        return;
      }
      const result = await hotspotsCsv(shape, dates.from, dates.to, info, { maxTiles: options.limits?.tiles });
      if (result.status === 'tooLarge') {
        setMessage(el.downloadStatus, tooLargeText('downloads.tooLarge', result));
      } else if (result.status === 'error') {
        console.error(result.message);
        setMessage(el.downloadStatus, tileErrorText(result), retry);
      } else {
        save(result.blob, result.fileName);
        const shown = formatNumber(lang, result.rows);
        setMessage(el.downloadStatus, tCount(lang, 'downloads.saved', result.rows, { shown, params: { file: result.fileName } }));
      }
    } catch (error) {
      console.error(error);
      setMessage(el.downloadStatus, tileErrorText(null), retry);
    }
  }

  /** Puts the state back into the controls, so the address, the map and the forms agree. */
  function syncControls(): void {
    if (!loaded) return;
    const lang = state.lang;

    // A drawn area has no entry in the province list: show a disabled one while it is selected.
    el.province.querySelector('option[data-custom]')?.remove();
    if (state.area.kind === 'province') {
      el.province.value = state.area.id;
    } else {
      el.province.prepend(h(doc, 'option', { value: '', disabled: true, 'data-custom': true }, t(lang, 'area.custom')));
      el.province.value = '';
    }
    if (state.area.kind === 'circle') {
      el.circleLat.value = String(state.area.lat);
      el.circleLon.value = String(state.area.lon);
      el.circleKm.value = String(state.area.km);
    }

    const years = shownYears();
    el.yearFrom.value = String(years.from);
    el.yearTo.value = String(years.to);
    el.yearLabel.textContent = t(lang, 'years.range', years);
    const span = Math.max(1, loaded.lastYear - YEAR_MIN);
    el.yearFill.style.left = `${((years.from - YEAR_MIN) / span) * 100}%`;
    el.yearFill.style.right = `${((loaded.lastYear - years.to) / span) * 100}%`;

    const dates = csvDates({ ...state, yearFrom: years.from, yearTo: years.to }, loaded.meta.data_end_date);
    el.dateFrom.value = dates.from;
    el.dateTo.value = dates.to;
  }

  // ---- Controls -----------------------------------------------------------------

  function onProvinceChange(): void {
    if (el.province.value) setArea({ kind: 'province', id: el.province.value }, { fit: true });
  }

  function onCircleSubmit(event: Event): void {
    event.preventDefault();
    const lang = state.lang;
    const lat = el.circleLat.value.trim() === '' ? Number.NaN : Number(el.circleLat.value);
    const lon = el.circleLon.value.trim() === '' ? Number.NaN : Number(el.circleLon.value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      setStatus(el.circleMessage, t(lang, 'area.circle.invalid'));
      return;
    }
    const asked = el.circleKm.value.trim() === '' ? RADIUS_KM.initial : Number(el.circleKm.value);
    const km = clampRadius(asked);
    el.circleKm.value = String(km);
    setStatus(el.circleMessage, km === asked ? null : t(lang, 'area.circle.clamped', { km }));
    setArea({ kind: 'circle', lat, lon, km }, { fit: true });
  }

  /** The year sliders. Moving one past the other pushes the other along. */
  function onYearInput(moved: 'from' | 'to'): void {
    if (!loaded) return;
    let from = Number(el.yearFrom.value);
    let to = Number(el.yearTo.value);
    if (from > to) {
      if (moved === 'from') to = from;
      else from = to;
    }
    // At the ends of the slider the state keeps the open-ended defaults, so the address stays short.
    update({ yearFrom: from, yearTo: to >= loaded.lastYear ? YEAR_MAX : to });
  }

  /** The CSV date pickers. An emptied picker goes back to following the year range. */
  function onDateChange(): void {
    if (!loaded) return;
    const years = shownYears();
    const follow = csvDates(
      { ...state, yearFrom: years.from, yearTo: years.to, dateFrom: null, dateTo: null },
      loaded.meta.data_end_date,
    );
    let dateFrom = el.dateFrom.value && el.dateFrom.value !== follow.from ? el.dateFrom.value : null;
    let dateTo = el.dateTo.value && el.dateTo.value !== follow.to ? el.dateTo.value : null;
    if ((dateFrom ?? follow.from) > (dateTo ?? follow.to)) [dateFrom, dateTo] = [dateTo ?? follow.to, dateFrom ?? follow.from];
    update({ dateFrom, dateTo });
  }

  /** A click on a calendar cell selects its month; a second click lets it go. */
  function toggleSelected(monthIdx: number): void {
    update({ sel: state.sel === monthIdx ? null : monthIdx });
  }

  function onRadioChange(event: Event): void {
    const radio = event.target as HTMLInputElement;
    if (!radio.checked) return;
    if (radio.name === 'view') setView(radio.value as Layer);
    if (radio.name === 'mode') update({ mode: radio.value as Mode });
  }

  function onTableToggle(): void {
    tableView = !tableView;
    render();
  }

  // ---- The yearly totals and the calendar point at each other -------------------

  /** Marks one year in both charts (its bar, its calendar row), or none. The marks are classes the stylesheet draws. */
  function markYear(year: string | null): void {
    for (const marked of doc.querySelectorAll('#yearly .linked, #calendar .linked')) marked.classList.remove('linked');
    if (year === null) return;
    for (const target of doc.querySelectorAll(`#yearly g.year-bar[data-year="${year}"], #calendar g.cal-row[data-year="${year}"]`)) {
      target.classList.add('linked');
    }
  }

  /** The year of the bar or calendar row an event happened in, or `null`. */
  function yearAt(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    return target.closest<SVGGElement>('g.year-bar, g.cal-row')?.dataset.year ?? null;
  }

  function onChartPointerOver(event: Event): void {
    markYear(yearAt(event.target));
  }

  function onChartPointerOut(event: Event): void {
    // Moving between the parts of one year keeps the mark; leaving it clears it.
    const next = yearAt((event as MouseEvent).relatedTarget);
    if (next !== yearAt(event.target)) markYear(next);
  }

  const listeners: Array<[EventTarget, string, EventListener]> = [
    [el.yearly, 'pointerover', onChartPointerOver],
    [el.yearly, 'pointerout', onChartPointerOut],
    [el.calendar, 'pointerover', onChartPointerOver],
    [el.calendar, 'pointerout', onChartPointerOut],
    [el.calendar, 'focusin', onChartPointerOver],
    [el.calendar, 'focusout', () => markYear(null)],
    [el.province, 'change', onProvinceChange],
    [el.circleForm, 'submit', onCircleSubmit],
    [el.yearFrom, 'input', () => onYearInput('from')],
    [el.yearTo, 'input', () => onYearInput('to')],
    [el.dateFrom, 'change', onDateChange],
    [el.dateTo, 'change', onDateChange],
    [el.tableToggle, 'click', onTableToggle],
    [el.downloadCalendar, 'click', () => enqueue(saveCalendarCsv)],
    [el.downloadPng, 'click', () => enqueue(savePng)],
    [el.downloadHotspots, 'click', () => inBackground(saveHotspots)],
    [el.langEn, 'click', () => setLanguage('en')],
    [el.langEs, 'click', () => setLanguage('es')],
    [el.copyLink, 'click', () => enqueue(copyLink)],
    [el.mapDetails, 'toggle', () => el.mapDetails.open && enqueue(loadMap)],
    ...[...radios('view'), ...radios('mode')].map((radio): [EventTarget, string, EventListener] => [radio, 'change', onRadioChange]),
    [win, 'hashchange', onHashChange],
  ];
  for (const [target, type, listener] of listeners) target.addEventListener(type, listener);

  // On a wide screen the map sits beside the results. On a phone it stays folded, so the
  // verdict and the calendar come right after the province list.
  el.mapDetails.open = win.matchMedia ? win.matchMedia('(min-width: 60rem)').matches : true;

  applyStaticText(doc, state.lang);
  enqueue(boot);

  return {
    state: () => ({ ...state }),
    drawn,
    idle,
    destroy() {
      destroyed = true;
      for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
    },
  };
}
