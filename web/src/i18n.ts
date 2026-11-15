// Language lookup. Every user-facing string lives in src/i18n/en.json and
// es.json; code asks for it by key. English is the fallback for a missing key.
//
// This is the part the verdict sentences need (task W3). The language toggle
// and its wiring into the page arrive with task W8.

import en from './i18n/en.json';
import es from './i18n/es.json';

export type Lang = 'en' | 'es';
export const LANGS: readonly Lang[] = ['en', 'es'];

/** A language file: texts, lists of texts, and groups of those. */
export type Entry = string | Entry[] | { [key: string]: Entry };
export type Dictionaries = Record<Lang, Entry>;
export type Params = Record<string, string | number>;

const DICTIONARIES: Dictionaries = { en, es };

function lookup(dictionary: Entry, key: string): string | undefined {
  let entry: Entry | undefined = dictionary;
  for (const part of key.split('.')) {
    if (entry === undefined || typeof entry === 'string') return undefined;
    entry = (entry as Record<string, Entry>)[part];
  }
  return typeof entry === 'string' ? entry : undefined;
}

function fill(template: string, params: Params): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in params ? String(params[name]) : placeholder,
  );
}

/**
 * The text for `key` (a dotted path, e.g. `verdict.season.none`) in `lang`,
 * with each `{name}` replaced from `params`. A key missing in `lang` falls back
 * to English with a warning; a key missing everywhere comes back as the key.
 */
export function translate(dictionaries: Dictionaries, lang: Lang, key: string, params: Params = {}): string {
  let template = lookup(dictionaries[lang], key);
  if (template === undefined) {
    console.warn(`i18n: no "${key}" in ${lang}`);
    template = lang === 'en' ? undefined : lookup(dictionaries.en, key);
  }
  return template === undefined ? key : fill(template, params);
}

export interface PluralOptions {
  /** `ordinal` picks forms like 1st, 2nd, 3rd. Default `cardinal`: 1 item, 2 items. */
  type?: 'cardinal' | 'ordinal';
  /** The count as it should be shown, e.g. `1,234`. Default: the plain number. */
  shown?: string;
  params?: Params;
}

/**
 * The form of `key` that fits `count` in `lang`. The language file holds one
 * text per plural category (`one`, `two`, `few`, `many`, `other`) under `key`;
 * `other` is used for a category the file leaves out. `{n}` is the count.
 */
export function plural(
  dictionaries: Dictionaries,
  lang: Lang,
  key: string,
  count: number,
  options: PluralOptions = {},
): string {
  const category = new Intl.PluralRules(lang, { type: options.type ?? 'cardinal' }).select(count);
  const hasForm = lookup(dictionaries[lang], `${key}.${category}`) !== undefined;
  return translate(dictionaries, lang, `${key}.${hasForm ? category : 'other'}`, {
    ...options.params,
    n: options.shown ?? String(count),
  });
}

/**
 * The texts of a list in the language file (an array under `key`), in order.
 * Falls back to the English list; empty when there is none.
 */
export function listOf(dictionaries: Dictionaries, lang: Lang, key: string): string[] {
  const find = (dictionary: Entry): Entry | undefined => {
    let entry: Entry | undefined = dictionary;
    for (const part of key.split('.')) {
      if (entry === undefined || typeof entry === 'string') return undefined;
      entry = (entry as Record<string, Entry>)[part];
    }
    return entry;
  };
  const found = find(dictionaries[lang]) ?? find(dictionaries.en);
  return Array.isArray(found) ? found.filter((item): item is string => typeof item === 'string') : [];
}

/** listOf() on the app's own language files. */
export function tList(lang: Lang, key: string): string[] {
  return listOf(DICTIONARIES, lang, key);
}

/** translate() on the app's own language files. */
export function t(lang: Lang, key: string, params?: Params): string {
  return translate(DICTIONARIES, lang, key, params);
}

/** plural() on the app's own language files. */
export function tCount(lang: Lang, key: string, count: number, options?: PluralOptions): string {
  return plural(DICTIONARIES, lang, key, count, options);
}

/** A number written the way the language writes it, rounded to at most `maxDecimals`. */
export function formatNumber(lang: Lang, value: number, maxDecimals = 0, minDecimals = 0): string {
  return new Intl.NumberFormat(lang, {
    maximumFractionDigits: maxDecimals,
    minimumFractionDigits: minDecimals,
  }).format(value);
}
