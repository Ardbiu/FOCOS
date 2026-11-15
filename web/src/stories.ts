// The three story links under the header (plan section 6.8). Each opens a
// province with one month selected. Its caption is computed from the data when
// the page loads, in the wording of the verdict, so it can never drift from
// what the calendar shows.

import type { AreaSummary } from './data';
import { t, type Lang } from './i18n';
import { assessMonth, monthIdx, type Completeness } from './stats';
import { defaultState, encodeState } from './state';
import { monthSentence } from './verdict';

export interface Story {
  /** The key of the story's title in the language files (`stories.{key}`). */
  key: string;
  /** Georef id of the province. */
  provinceId: string;
  year: number;
  /** 1 to 12. */
  month: number;
}

/**
 * In the order shown. The first two agree closely with MODIS's own counts for
 * the month; Corrientes in February 2022 is a record but reads low against
 * MODIS, so it does not lead.
 */
export const STORIES: Story[] = [
  { key: 'delta', provinceId: '30', year: 2020, month: 8 },
  { key: 'pampa', provinceId: '42', year: 2017, month: 1 },
  { key: 'corrientes', provinceId: '18', year: 2022, month: 2 },
];

export interface StoryCard {
  key: string;
  title: string;
  /** The month's sentence, as the verdict card would say it. */
  caption: string;
  /** The address of the story, without `#`. */
  hash: string;
}

/** The stories the data can tell: those whose province and month are in it. */
export function storyCards(areas: AreaSummary[], c: Completeness, lang: Lang): StoryCard[] {
  const cards: StoryCard[] = [];
  for (const story of STORIES) {
    const area = areas.find((entry) => entry.id === story.provinceId);
    const idx = monthIdx(story.year, story.month);
    if (!area || idx > c.lastMonthIdx) continue;
    cards.push({
      key: story.key,
      title: t(lang, `stories.${story.key}`),
      caption: monthSentence(assessMonth(area, idx, c), lang),
      hash: encodeState({ ...defaultState(), area: { kind: 'province', id: story.provinceId }, sel: idx, lang }),
    });
  }
  return cards;
}
