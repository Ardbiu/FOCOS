import { describe, expect, it } from 'vitest';
import { buildSample } from '../scripts/make-sample-data.mjs';
import type { AreaSummary } from '../src/data';
import { assessMonth, completenessFromMeta, monthIdx } from '../src/stats';
import { decodeState } from '../src/state';
import { STORIES, storyCards } from '../src/stories';
import { monthSentence } from '../src/verdict';

const sample = buildSample();
const json = (path: string) => JSON.parse(new TextDecoder().decode(sample.get(path)));
const completeness = completenessFromMeta(json('meta.json'));
const areas = json('summary/provinces.json').areas as AreaSummary[];

describe('stories', () => {
  it('are the three the pitch uses, the two that agree best with MODIS first', () => {
    expect(STORIES.map((story) => [story.provinceId, story.year, story.month])).toEqual([
      ['30', 2020, 8], // Paraná Delta (Entre Ríos)
      ['42', 2017, 1], // La Pampa grasslands
      ['18', 2022, 2], // Corrientes wetlands: a record month, but understated against MODIS
    ]);
  });

  it('get their caption from the data, in the verdict\'s wording', () => {
    const cards = storyCards(areas, completeness, 'en');
    // The sample has no Entre Ríos, so its story is left out.
    expect(cards.map((card) => card.key)).toEqual(['pampa', 'corrientes']);
    expect(cards[1].title).toBe('Corrientes wetlands');
    expect(cards[1].caption).toBe(monthSentence(assessMonth(areas[1], monthIdx(2022, 2), completeness), 'en'));
    expect(cards[1].caption).toBe('Feb 2022 is 7.6× the usual level, the highest February since 2003.');
    expect(cards[0].title).toBe('La Pampa grasslands');
    expect(cards[0].caption).toBe('Jan 2017 is 3.3× the usual level, the highest January since 2003.');
  });

  it('link to the province with the month selected, keeping the language', () => {
    const [pampa, corrientes] = storyCards(areas, completeness, 'en');
    expect(corrientes.hash).toBe('area=prov:18&sel=2022-02');
    expect(pampa.hash).toBe('area=prov:42&sel=2017-01');
    expect(decodeState(corrientes.hash)).toMatchObject({ area: { kind: 'province', id: '18' }, sel: monthIdx(2022, 2) });
    const spanish = storyCards(areas, completeness, 'es');
    expect(spanish[1].hash).toBe('area=prov:18&lang=es&sel=2022-02');
    expect(spanish[1].title).toBe('Esteros de Corrientes');
    expect(spanish[1].caption).toBe('Feb 2022: 7,6 veces el nivel habitual, el valor más alto para febrero desde 2003.');
  });

  it('leave out a story whose month lies after the end of the data', () => {
    const early = { ...completeness, lastMonthIdx: monthIdx(2019, 12), lastCompleteYear: 2019, partial: null };
    expect(storyCards(areas, early, 'en').map((card) => card.key)).toEqual(['pampa']);
    expect(storyCards([], completeness, 'en')).toEqual([]);
  });
});
