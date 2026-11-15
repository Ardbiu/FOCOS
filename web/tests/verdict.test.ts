import { describe, expect, it } from 'vitest';
import { buildSample } from '../scripts/make-sample-data.mjs';
import {
  assessMonth,
  completenessFromMeta,
  fireSeason,
  monthIdx,
  monthlyMedians,
  peakMonth,
  seasonFromMedians,
  summarize,
  trend,
  yearlyTotals,
  type Completeness,
  type MonthAssessment,
  type Trend,
} from '../src/stats';
import { biasCaution, monthSentence, periodLabel, seasonSentence, testLine, trendSentence, verdict, framedTrend, yearSoFarSentence } from '../src/verdict';

/** A month as assessMonth() would return it, with only the interesting parts spelled out. */
function month(overrides: Partial<MonthAssessment>): MonthAssessment {
  return {
    monthIdx: monthIdx(2020, 8),
    status: 'complete',
    partialDay: null,
    value: 66,
    baseline: summarize([10, 20, 30, 40, 50]),
    rank: 1,
    ratio: 2.2,
    rare: false,
    category: 'record_high',
    ...overrides,
  };
}

const NOV_1_14 = month({
  monthIdx: monthIdx(2026, 11),
  status: 'partial',
  partialDay: 14,
  value: 21,
  baseline: summarize([4, 6, 8, 9, 10, 10, 11, 12, 22, 25]),
  rank: 3,
  ratio: 2.1,
  category: 'above',
});

describe('verdict', () => {
  it('writes the exact sentence for a fixed input, in English', () => {
    expect(verdict({ season: { start: 7, end: 10 }, month: NOV_1_14 }, 'en')).toBe(
      'Fire season here runs Jul–Oct. Nov 1–14, 2026 is 2.1× the usual level, the 3rd highest Nov 1–14 since 2003.',
    );
  });

  it('writes the exact sentence for the same input, in Spanish', () => {
    expect(verdict({ season: { start: 7, end: 10 }, month: NOV_1_14 }, 'es')).toBe(
      'La temporada de incendios aquí va de jul a oct. 1–14 nov 2026: 2,1 veces el nivel habitual, el 3.º valor más alto para los días 1 a 14 de noviembre desde 2003.',
    );
  });

  it('says fire is usually rare, with no ratio, no rank below 5 hotspots, and no NaN (baseline all zeros, value 3)', () => {
    const rare = month({
      monthIdx: monthIdx(2015, 6),
      value: 3,
      baseline: summarize(new Array(22).fill(0)),
      rank: 1,
      ratio: null,
      rare: true,
      category: 'record_high',
    });
    const english = verdict({ season: null, month: rare }, 'en');
    const spanish = verdict({ season: null, month: rare }, 'es');
    expect(english).toBe(
      'There is no clear fire season here. Jun 2015 has 3 MODIS-equivalent hotspots, too few to rank against other years. Usually almost no fire here this month.',
    );
    expect(spanish).toBe(
      'Aquí no hay una temporada de incendios clara. Jun 2015: 3 focos equivalentes a MODIS, demasiado pocos para compararlos con otros años. Normalmente casi no hay fuego aquí en este mes.',
    );
    for (const sentence of [english, spanish]) {
      expect(sentence).not.toMatch(/NaN|Infinity|undefined|null|×|veces/);
    }
  });

  it('works straight from assessMonth for an area with no fire at all', () => {
    const none: Completeness = {
      incomplete: new Set(),
      lastCompleteYear: 2025,
      lastMonthIdx: 286,
      partial: { monthIdx: 286, lastDay: 14 },
    };
    const zeros = new Array(287).fill(0);
    const assessed = assessMonth({ monthly: zeros, mtd: new Array(24).fill(0) }, 286, none);
    expect(verdict({ season: null, month: assessed }, 'en')).toBe(
      'There is no clear fire season here. Nov 1–14, 2026 has no hotspots. Usually almost no fire here this month.',
    );
    expect(verdict({ season: null, month: assessed }, 'es')).toBe(
      'Aquí no hay una temporada de incendios clara. 1–14 nov 2026: sin focos. Normalmente casi no hay fuego aquí en este mes.',
    );
  });
});

describe('seasonSentence', () => {
  it('names the first and last month of the season', () => {
    expect(seasonSentence({ start: 7, end: 9 }, 'en')).toBe('Fire season here runs Jul–Sep.');
    expect(seasonSentence({ start: 7, end: 9 }, 'es')).toBe('La temporada de incendios aquí va de jul a sep.');
  });

  it('handles a season that wraps over New Year', () => {
    expect(seasonSentence({ start: 12, end: 2 }, 'en')).toBe('Fire season here runs Dec–Feb.');
    expect(seasonSentence({ start: 12, end: 2 }, 'es')).toBe('La temporada de incendios aquí va de dic a feb.');
  });

  it('adds the peak month to a season of two to six months', () => {
    expect(seasonSentence({ start: 7, end: 10 }, 'en', 9)).toBe('Fire season here runs Jul–Oct and peaks in September.');
    expect(seasonSentence({ start: 7, end: 10 }, 'es', 9)).toBe(
      'La temporada de incendios aquí va de jul a oct y alcanza su máximo en septiembre.',
    );
    expect(seasonSentence({ start: 11, end: 4 }, 'en', 1)).toBe('Fire season here runs Nov–Apr and peaks in January.');
    // One month is its own peak.
    expect(seasonSentence({ start: 8, end: 8 }, 'en', 8)).toBe('Fire season here is concentrated in Aug.');
  });

  it('does not call a run of more than six months a season', () => {
    expect(seasonSentence({ start: 7, end: 1 }, 'en', 8)).toBe('Fire here is spread over most of the year and peaks in August.');
    expect(seasonSentence({ start: 7, end: 1 }, 'es', 8)).toBe(
      'Aquí el fuego se reparte en la mayor parte del año y alcanza su máximo en agosto.',
    );
    expect(seasonSentence({ start: 8, end: 4 }, 'en', 1)).toBe('Fire here is spread over most of the year and peaks in January.');
    expect(seasonSentence({ start: 1, end: 12 }, 'en', 3)).toBe('Fire here is spread over most of the year and peaks in March.');
    // Without a peak month the sentence still stands.
    expect(seasonSentence({ start: 7, end: 1 }, 'en')).toBe('Fire here is spread over most of the year.');
    expect(seasonSentence({ start: 7, end: 1 }, 'es')).toBe('Aquí el fuego se reparte en la mayor parte del año.');
  });

  it('puts the peak into the verdict', () => {
    expect(verdict({ season: { start: 7, end: 10 }, peak: 9, month: NOV_1_14 }, 'en')).toBe(
      'Fire season here runs Jul–Oct and peaks in September. Nov 1–14, 2026 is 2.1× the usual level, the 3rd highest Nov 1–14 since 2003.',
    );
    expect(verdict({ season: { start: 7, end: 1 }, peak: 8, month: NOV_1_14 }, 'en')).toBe(
      'Fire here is spread over most of the year and peaks in August. Nov 1–14, 2026 is 2.1× the usual level, the 3rd highest Nov 1–14 since 2003.',
    );
  });

  it('handles a one-month season and no season', () => {
    expect(seasonSentence({ start: 8, end: 8 }, 'en')).toBe('Fire season here is concentrated in Aug.');
    expect(seasonSentence({ start: 8, end: 8 }, 'es')).toBe('La temporada de incendios aquí se concentra en ago.');
    expect(seasonSentence(null, 'en')).toBe('There is no clear fire season here.');
    expect(seasonSentence(null, 'es')).toBe('Aquí no hay una temporada de incendios clara.');
  });
});

describe('periodLabel', () => {
  it('names a full month and a partial month', () => {
    expect(periodLabel(month({}), 'en')).toBe('Aug 2020');
    expect(periodLabel(month({}), 'es')).toBe('ago 2020');
    expect(periodLabel(NOV_1_14, 'en')).toBe('Nov 1–14, 2026');
    expect(periodLabel(NOV_1_14, 'es')).toBe('1–14 nov 2026');
  });
});

describe('a partial month with a single day of data', () => {
  const firstDay = month({ monthIdx: monthIdx(2026, 11), status: 'partial', partialDay: 1, value: 12, ratio: 1.5, rank: 4 });

  it('is called by its day, not "1–1"', () => {
    expect(periodLabel(firstDay, 'en')).toBe('Nov 1, 2026');
    expect(periodLabel(firstDay, 'es')).toBe('1 nov 2026');
    expect(monthSentence(firstDay, 'en')).toBe('Nov 1, 2026 is 1.5× the usual level, the 4th highest Nov 1 since 2003.');
  });
});

describe('trendSentence', () => {
  const rising = { slope: 12, startValue: 652, pctPerDecade: 18.4, p: 0.0123, direction: 'rising' as const, fromYear: 2003, toYear: 2025 };

  it('gives the direction, the pace and the p-value of a significant trend', () => {
    expect(trendSentence(rising, 'en')).toBe('Rising about 18% per decade since 2003 (p = 0.01).');
    expect(trendSentence(rising, 'es')).toBe('En aumento, cerca de un 18 % por década desde 2003 (p = 0,01).');
    const falling = { ...rising, pctPerDecade: -40.2, p: 0.0004, direction: 'falling' as const };
    expect(trendSentence(falling, 'en')).toBe('Falling about 40% per decade since 2003 (p < 0.001).');
    expect(trendSentence(falling, 'es')).toBe('En descenso, cerca de un 40 % por década desde 2003 (p < 0,001).');
    expect(trendSentence({ ...rising, p: 0.004 }, 'en')).toContain('(p = 0.004)');
    expect(trendSentence({ ...rising, p: 0.0499 }, 'en')).toContain('(p = 0.05)');
  });

  it('says when there is no significant trend, too little fire, or too few years', () => {
    expect(trendSentence({ ...rising, direction: 'none', p: 0.57 }, 'en')).toBe('No significant trend since 2003.');
    expect(trendSentence({ ...rising, direction: 'none', p: 0.57 }, 'es')).toBe('Sin tendencia significativa desde 2003.');
    expect(trendSentence({ reason: 'rare' }, 'en')).toBe('Too little fire here to assess a trend.');
    expect(trendSentence({ reason: 'rare' }, 'es')).toBe('Muy poco fuego aquí para evaluar una tendencia.');
    expect(trendSentence({ reason: 'short' }, 'en')).toBe('Too few complete years to assess a trend.');
    expect(trendSentence({ reason: 'short' }, 'es')).toBe('Muy pocos años completos para evaluar una tendencia.');
  });

  it('marks a raw trend as including the sensor switch', () => {
    expect(trendSentence(rising, 'en', { raw: true })).toBe(
      'Raw counts: rising about 18% per decade since 2003 (p = 0.01). This includes the sensor switch in 2012.',
    );
    expect(trendSentence({ ...rising, direction: 'none' }, 'en', { raw: true })).toBe(
      'Raw counts: no significant trend since 2003. This includes the sensor switch in 2012.',
    );
    expect(trendSentence(rising, 'es', { raw: true })).toBe(
      'Conteos sin armonizar: en aumento, cerca de un 18 % por década desde 2003 (p = 0,01). Esto incluye el cambio de sensor de 2012.',
    );
    expect(trendSentence({ reason: 'rare' }, 'en', { raw: true })).toBe('Too little fire here to assess a trend.');
  });

  it('gives the change per year where a percentage would mean little', () => {
    // The fitted line starts below 12 hotspots a year: trend() gives no percentage.
    const fromLittle = { ...rising, slope: 2, startValue: 5, pctPerDecade: null, p: 0.00008 };
    expect(trendSentence(fromLittle, 'en')).toBe('Rising by about 2 hotspots a year since 2003 (p < 0.001).');
    expect(trendSentence(fromLittle, 'es')).toBe('En aumento, cerca de 2 focos por año desde 2003 (p < 0,001).');
    expect(trendSentence({ ...fromLittle, slope: -1.04, direction: 'falling' }, 'en')).toBe(
      'Falling by about 1 hotspot a year since 2003 (p < 0.001).',
    );
    expect(trendSentence({ ...fromLittle, slope: -3.46, direction: 'falling' }, 'es')).toBe(
      'En descenso, cerca de 3,5 focos por año desde 2003 (p < 0,001).',
    );
    expect(trendSentence({ ...fromLittle, slope: 1234.5 }, 'en')).toBe('Rising by about 1,235 hotspots a year since 2003 (p < 0.001).');
    // The Raw view counts detections.
    expect(trendSentence({ ...fromLittle, slope: 26.4 }, 'en', { raw: true })).toBe(
      'Raw counts: rising by about 26 detections a year since 2003 (p < 0.001). This includes the sensor switch in 2012.',
    );
    expect(trendSentence({ ...fromLittle, slope: 26.4 }, 'es', { raw: true })).toBe(
      'Conteos sin armonizar: en aumento, cerca de 26 detecciones por año desde 2003 (p < 0,001). Esto incluye el cambio de sensor de 2012.',
    );
    expect(trendSentence({ ...fromLittle, direction: 'none', p: 0.4 }, 'en')).toBe('No significant trend since 2003.');
  });

  it('never prints NaN', () => {
    const broken = { ...rising, pctPerDecade: Number.NaN, p: Number.NaN };
    expect(trendSentence(broken, 'en')).not.toMatch(/NaN|Infinity/);
    expect(trendSentence({ ...rising, pctPerDecade: null, slope: Number.NaN }, 'en')).not.toMatch(/NaN|Infinity/);
  });
});

describe('testLine', () => {
  it('states the held-out test in one line, with rounded errors', () => {
    const meta = {
      calibration: { candidate: 'C2', train_years: [2012, 2019] as [number, number], test_years: [2020, 2021] as [number, number] },
      typical_error_pct: 16.98,
      naive_error_pct: 432.14,
    };
    expect(testLine(meta, 'en')).toBe(
      'Tested on 2020–2021, years the method never saw: a province’s monthly count typically came within 17% of MODIS (naive stitch: 432% off). Errors are larger for small areas and small counts.',
    );
    expect(testLine(meta, 'es')).toBe(
      'Probado en 2020–2021, años que el método nunca vio: el conteo mensual de una provincia quedó típicamente a menos de 17 % de MODIS (empalme directo: 432 % de diferencia). El error es mayor en áreas chicas y con pocos focos.',
    );
  });
});

describe('biasCaution', () => {
  const validation = {
    test_years: [2020, 2021] as [number, number],
    province_bias: [
      { prov: '58', name: 'Neuquén', aqua: 100, harmonized: 168, bias: 0.68 },
      { prov: '14', name: 'Córdoba', aqua: 2730.5, harmonized: 2144.5, bias: -0.2146 },
      { prov: '18', name: 'Corrientes', aqua: 100, harmonized: 110, bias: 0.1 },
      { prov: '06', name: 'Buenos Aires', aqua: 100, harmonized: 115, bias: 0.15 },
    ],
  };

  it('warns when a province ran more than 15% from MODIS in the test', () => {
    expect(biasCaution(validation, '58', 'en')).toBe(
      'In Neuquén the harmonized record ran 68% above MODIS in the 2020–2021 test.',
    );
    expect(biasCaution(validation, '14', 'en')).toBe(
      'In Córdoba the harmonized record ran 21% below MODIS in the 2020–2021 test.',
    );
    expect(biasCaution(validation, '58', 'es')).toBe(
      'En Neuquén el registro armonizado quedó un 68 % por encima de MODIS en la prueba de 2020–2021.',
    );
    expect(biasCaution(validation, '14', 'es')).toBe(
      'En Córdoba el registro armonizado quedó un 21 % por debajo de MODIS en la prueba de 2020–2021.',
    );
  });

  it('stays quiet inside 15%, for the nation, for unlisted provinces and without validation.json', () => {
    expect(biasCaution(validation, '18', 'en')).toBeNull();
    expect(biasCaution(validation, '06', 'en')).toBeNull(); // exactly 15% is not beyond it
    expect(biasCaution(validation, 'AR', 'en')).toBeNull();
    expect(biasCaution(validation, '94', 'en')).toBeNull();
    expect(biasCaution(null, '58', 'en')).toBeNull();
    expect(biasCaution({ test_years: [2020, 2021] }, '58', 'en')).toBeNull();
  });
});

describe('monthSentence', () => {
  it('gives the ratio and the rank of a full month', () => {
    expect(monthSentence(month({}), 'en')).toBe('Aug 2020 is 2.2× the usual level, the highest August since 2003.');
    expect(monthSentence(month({}), 'es')).toBe(
      'Ago 2020: 2,2 veces el nivel habitual, el valor más alto para agosto desde 2003.',
    );
  });

  it('writes ranks as ordinals', () => {
    const ranked = (rank: number) => monthSentence(month({ value: 35, ratio: 1.17, rank, category: 'near' }), 'en');
    expect(ranked(2)).toBe('Aug 2020 is 1.2× the usual level, the 2nd highest August since 2003.');
    expect(ranked(4)).toContain('the 4th highest');
    expect(ranked(11)).toContain('the 11th highest');
    expect(ranked(21)).toContain('the 21st highest');
    expect(ranked(22)).toContain('the 22nd highest');
    expect(monthSentence(month({ value: 35, ratio: 1.17, rank: 2 }), 'es')).toContain('el 2.º valor más alto');
  });

  it('calls a value below every baseline year the lowest', () => {
    const low = month({ value: 9, ratio: 0.3, rank: 6, category: 'below' });
    expect(monthSentence(low, 'en')).toBe('Aug 2020 is 0.3× the usual level, the lowest August since 2003.');
    expect(monthSentence(low, 'es')).toBe('Ago 2020: 0,3 veces el nivel habitual, el valor más bajo para agosto desde 2003.');
    // Tied with the lowest year is not "the lowest".
    const tied = month({ value: 10, ratio: 0.33, rank: 5, category: 'below' });
    expect(monthSentence(tied, 'en')).toBe('Aug 2020 is 0.3× the usual level, the 5th highest August since 2003.');
  });

  it('says so when a month that usually burns has no hotspots', () => {
    const zero = month({ value: 0, ratio: 0, rank: 6, category: 'below' });
    expect(monthSentence(zero, 'en')).toBe('Aug 2020 has no hotspots; the usual level is about 30.');
    expect(monthSentence(zero, 'es')).toBe('Ago 2020: sin focos; el nivel habitual es de unos 30.');
  });

  it('counts hotspots in the singular and the plural, with the digits of the language', () => {
    const rare = (value: number) =>
      month({ value, baseline: summarize([0, 0, 1, 2, 4]), rank: 1, ratio: null, rare: true });
    expect(monthSentence(rare(1), 'en')).toContain('has 1 MODIS-equivalent hotspot, too few to rank');
    expect(monthSentence(rare(1), 'es')).toContain(': 1 foco equivalente a MODIS, demasiado pocos');
    // From 5 hotspots up a rare month is ranked again.
    expect(monthSentence(rare(16), 'en')).toContain('has 16 MODIS-equivalent hotspots, the highest August since 2003.');
    expect(monthSentence(rare(4.6), 'en')).toContain('has 4.6 MODIS-equivalent hotspots,');
    expect(monthSentence(rare(4.6), 'es')).toContain(': 4,6 focos equivalentes a MODIS,');
    expect(monthSentence(rare(12345.4), 'en')).toContain('has 12,345 MODIS-equivalent hotspots,');
    expect(monthSentence(rare(12345.4), 'es')).toContain(': 12.345 focos equivalentes a MODIS,');
  });

  it('does not compare a month with incomplete data', () => {
    const incomplete = month({
      monthIdx: monthIdx(2010, 9),
      status: 'incomplete',
      value: 4,
      baseline: null,
      rank: null,
      ratio: null,
      category: null,
    });
    expect(monthSentence(incomplete, 'en')).toBe(
      'Sep 2010 has incomplete satellite data, so it is not compared with other years.',
    );
    expect(monthSentence(incomplete, 'es')).toBe(
      'Sep 2010: los datos satelitales están incompletos, así que no se compara con otros años.',
    );
  });

  it('says when there is no data yet, or nothing to compare with', () => {
    const blank = { baseline: null, rank: null, ratio: null, category: null };
    const later = month({ ...blank, monthIdx: monthIdx(2026, 3), status: 'nodata', value: 0 });
    expect(monthSentence(later, 'en')).toBe('There is no data for Mar 2026 yet.');
    expect(monthSentence(later, 'es')).toBe('Todavía no hay datos de mar 2026.');
    const alone = month({ ...blank, value: 12 });
    expect(monthSentence(alone, 'en')).toBe(
      'Aug 2020 has 12 MODIS-equivalent hotspots. There are not enough complete years to compare it.',
    );
    expect(monthSentence(alone, 'es')).toBe(
      'Ago 2020: 12 focos equivalentes a MODIS. No hay suficientes años completos para compararlo.',
    );
  });

  it('never prints NaN or Infinity, whatever the assessment', () => {
    const odd = [
      month({ ratio: Number.NaN }),
      month({ ratio: Number.POSITIVE_INFINITY }),
      month({ value: Number.NaN, ratio: null, rare: true }),
      month({ rank: null }),
    ];
    for (const assessment of odd) {
      for (const lang of ['en', 'es'] as const) {
        expect(monthSentence(assessment, lang)).not.toMatch(/NaN|Infinity|∞|undefined|null/);
      }
    }
  });
});

describe('on the sample data set (scripts/make-sample-data.mjs)', () => {
  const sample = buildSample();
  const json = (path: string) => JSON.parse(new TextDecoder().decode(sample.get(path)));
  const completeness = completenessFromMeta(json('meta.json'));
  const areas = json('summary/provinces.json').areas as Array<{
    id: string;
    monthly: number[];
    raw: number[];
    mtd: number[];
  }>;
  const [nation, corrientes, laPampa] = areas;

  it('writes a clean verdict for every month of every area, in both languages', () => {
    for (const area of areas) {
      const medians = monthlyMedians(area.monthly, completeness);
      const season = seasonFromMedians(medians);
      const peak = peakMonth(medians);
      for (let idx = 0; idx < 287; idx++) {
        const month = assessMonth(area, idx, completeness);
        for (const lang of ['en', 'es'] as const) {
          const sentence = verdict({ season, peak, month }, lang);
          if (/NaN|Infinity|∞|undefined|null|\{|\}/.test(sentence) || sentence.length < 40) {
            throw new Error(`bad verdict for ${area.id} month ${idx} (${lang}): ${sentence}`);
          }
        }
      }
    }
  });

  it('reads the seasons the sample was built with', () => {
    const sentence = (area: { monthly: number[] }) => {
      const medians = monthlyMedians(area.monthly, completeness);
      return seasonSentence(seasonFromMedians(medians), 'en', peakMonth(medians));
    };
    // Corrientes burns from July to February in the sample: too long a run to call a season.
    expect(fireSeason(corrientes.monthly, completeness)).toEqual({ start: 7, end: 2 });
    expect(sentence(corrientes)).toBe('Fire here is spread over most of the year and peaks in August.');
    expect(sentence(laPampa)).toBe('Fire season here runs Nov–Feb and peaks in January.');
  });

  it('compares the partial November 2026 on days 1 to 14', () => {
    const national = assessMonth(nation, 286, completeness);
    expect(national.status).toBe('partial');
    expect(national.value).toBe(nation.mtd[23]);
    // The generator is seeded, so these sentences are fixed.
    expect(monthSentence(national, 'en')).toBe('Nov 1–14, 2026 is 2.3× the usual level, the highest Nov 1–14 since 2003.');
    // In the sample Corrientes has almost no fire in early November.
    expect(monthSentence(assessMonth(corrientes, 286, completeness), 'en')).toBe(
      'Nov 1–14, 2026 has 5.7 MODIS-equivalent hotspots, the 3rd highest Nov 1–14 since 2003. Usually almost no fire here this month.',
    );
  });

  it('does not rank the two incomplete months', () => {
    for (const idx of [92, 192]) {
      const month = assessMonth(nation, idx, completeness);
      expect(month.status).toBe('incomplete');
      expect(month.category).toBeNull();
    }
    expect(monthSentence(assessMonth(nation, 92, completeness), 'en')).toBe(
      'Sep 2010 has incomplete satellite data, so it is not compared with other years.',
    );
  });

  it('finds the trend the sample was built with, and a different one in the raw series', () => {
    const harmonized = trend(yearlyTotals(laPampa.monthly, completeness));
    if ('reason' in harmonized) throw new Error('expected a trend');
    expect(harmonized.direction).toBe('rising');
    expect([harmonized.fromYear, harmonized.toYear]).toEqual([2003, 2025]);
    expect(harmonized.pctPerDecade!).toBeGreaterThan(10);
    expect(harmonized.pctPerDecade!).toBeLessThan(60);
    expect(trend(yearlyTotals(corrientes.monthly, completeness))).toMatchObject({ direction: 'none' });
    // The raw series carries the sensor switch, so its "trend" is far steeper.
    const raw = trend(yearlyTotals(laPampa.raw, completeness));
    if ('reason' in raw) throw new Error('expected a trend');
    expect(raw.direction).toBe('rising');
    expect(raw.pctPerDecade!).toBeGreaterThan(2 * harmonized.pctPerDecade!);
  });
});

describe('framedTrend', () => {
  const falling: Trend = { slope: -30, startValue: 1500, pctPerDecade: -20, p: 0.004, direction: 'falling', fromYear: 2003, toYear: 2025 };
  const rising: Trend = { slope: 400, startValue: 1000, pctPerDecade: 400, p: 0.0004, direction: 'rising', fromYear: 2003, toYear: 2025 };
  const none: Trend = { slope: -2, startValue: 1000, pctPerDecade: -2, p: 0.6, direction: 'none', fromYear: 2003, toYear: 2025 };

  it('sets the trend of the raw counts beside the harmonized one', () => {
    expect(framedTrend('trend.rawWouldSay', rising, 'en', { raw: true })).toBe(
      'Stitched without harmonizing, raw counts would show: rising about 400% per decade since 2003 (p < 0.001).',
    );
    expect(framedTrend('trend.rawWouldSay', none, 'en', { raw: true })).toBe('Stitched without harmonizing, raw counts would show: no significant trend since 2003.');
    expect(framedTrend('trend.rawWouldSay', rising, 'es', { raw: true })).toBe(
      'Empalmados sin armonizar, los conteos mostrarían: en aumento, cerca de un 400 % por década desde 2003 (p < 0,001).',
    );
  });

  it('counts raw detections, not hotspots, where the raw change is given per year', () => {
    const perYear: Trend = { ...rising, pctPerDecade: null, slope: 40 };
    expect(framedTrend('trend.rawWouldSay', perYear, 'en', { raw: true })).toBe(
      'Stitched without harmonizing, raw counts would show: rising by about 40 detections a year since 2003 (p < 0.001).',
    );
  });

  it('says what the trend is once a province’s known gap is removed, and whether that is the same trend', () => {
    expect(framedTrend('robust.holds', falling, 'en')).toBe(
      'With that gap removed from every VIIRS year, the trend holds: falling about 20% per decade since 2003 (p = 0.004).',
    );
    expect(framedTrend('robust.changes', none, 'en')).toBe(
      'With that gap removed from every VIIRS year, the trend would read: no significant trend since 2003.',
    );
    expect(framedTrend('robust.changes', none, 'es')).toBe(
      'Quitando esa diferencia de todos los años de VIIRS, la tendencia sería: sin tendencia significativa desde 2003.',
    );
    // "The trend holds: no significant trend" would be a riddle; that case has its own sentence.
    expect(framedTrend('robust.holds', none, 'en')).toBe('With that gap removed from every VIIRS year, there is still no significant trend.');
    expect(framedTrend('robust.holds', none, 'es')).toBe(
      'Quitando esa diferencia de todos los años de VIIRS, sigue sin haber una tendencia significativa.',
    );
    expect(framedTrend('robust.holds', falling, 'es')).toBe(
      'Quitando esa diferencia de todos los años de VIIRS, la tendencia se mantiene: en descenso, cerca de un 20 % por década desde 2003 (p = 0,004).',
    );
  });
});

describe('yearSoFarSentence', () => {
  const earlier = Array.from({ length: 23 }, (_, i) => 20000 + i * 500);
  const base = { year: 2026, throughMonth: 11, throughDay: 12 as number | null, value: 17380, usual: 31000, ratio: 0.56 as number | null, rank: 24, earlier };

  it('gives the year to date, how it compares with the same date in earlier years, and its rank', () => {
    expect(yearSoFarSentence(base, 'en')).toBe(
      '2026 up to Nov 12: 17,380 MODIS-equivalent hotspots, 0.6× the usual total by that date, the lowest since 2003.',
    );
    expect(yearSoFarSentence({ ...base, rank: 3, value: 32000, ratio: 1.03 }, 'en')).toBe(
      '2026 up to Nov 12: 32,000 MODIS-equivalent hotspots, 1.0× the usual total by that date, the 3rd highest since 2003.',
    );
    expect(yearSoFarSentence(base, 'es')).toBe(
      '2026 hasta el 12 de nov: 17.380 focos equivalentes a MODIS, 0,6 veces el total habitual a esa fecha, el valor más bajo desde 2003.',
    );
  });

  it('names the end of the month when the data ends there', () => {
    expect(yearSoFarSentence({ ...base, throughMonth: 10, throughDay: null }, 'en')).toMatch(/^2026 up to the end of Oct: /);
    expect(yearSoFarSentence({ ...base, throughMonth: 10, throughDay: null }, 'es')).toMatch(/^2026 hasta fin de oct: /);
  });

  it('gives no ratio where there is usually almost no fire by that date', () => {
    expect(yearSoFarSentence({ ...base, value: 3, usual: 2, ratio: null, rank: 5, earlier: [0, 1, 2, 2, 4] }, 'en')).toBe(
      '2026 up to Nov 12: 3 MODIS-equivalent hotspots, too few to rank against other years. Usually almost no fire here by that date.',
    );
  });
});

describe('ranks name the month they compare', () => {
  // A month is ranked against the same calendar month of other years, not against every month.
  it('names the calendar month of a complete month, in both languages', () => {
    const august = month({ rank: 1 });
    expect(monthSentence(august, 'en')).toBe('Aug 2020 is 2.2× the usual level, the highest August since 2003.');
    expect(monthSentence(august, 'es')).toBe('Ago 2020: 2,2 veces el nivel habitual, el valor más alto para agosto desde 2003.');
    expect(monthSentence(month({ rank: 4, value: 35 }), 'en')).toContain('the 4th highest August since 2003.');
    expect(monthSentence(month({ rank: 6, value: 5, ratio: 0.2, category: 'below' }), 'en')).toContain('the lowest August since 2003.');
  });

  it('names the days compared for the partial month', () => {
    expect(monthSentence(NOV_1_14, 'en')).toBe('Nov 1–14, 2026 is 2.1× the usual level, the 3rd highest Nov 1–14 since 2003.');
    expect(monthSentence(NOV_1_14, 'es')).toBe(
      '1–14 nov 2026: 2,1 veces el nivel habitual, el 3.º valor más alto para los días 1 a 14 de noviembre desde 2003.',
    );
  });
});
