import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatNumber, listOf, plural, t, tList, translate } from '../src/i18n';

const dictionaries = {
  en: {
    greeting: 'Hello, {name}. You have {count} new messages, {name}.',
    nested: { deep: { key: 'found' } },
    list: ['zero', 'one', 'two'],
    onlyEnglish: 'English only',
    item: { one: '{n} item', other: '{n} items' },
    place: { one: '{n}st', two: '{n}nd', few: '{n}rd', other: '{n}th' },
  },
  es: {
    greeting: 'Hola, {name}.',
    nested: { deep: { key: 'encontrado' } },
    list: ['cero', 'uno', 'dos'],
    item: { other: '{n} cosas' },
    place: { other: '{n}.º' },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('translate', () => {
  it('looks a key up by its dotted path, in lists too', () => {
    expect(translate(dictionaries, 'en', 'nested.deep.key')).toBe('found');
    expect(translate(dictionaries, 'es', 'nested.deep.key')).toBe('encontrado');
    expect(translate(dictionaries, 'es', 'list.2')).toBe('dos');
  });

  it('fills every {placeholder}', () => {
    expect(translate(dictionaries, 'en', 'greeting', { name: 'Ana', count: 3 })).toBe(
      'Hello, Ana. You have 3 new messages, Ana.',
    );
    expect(translate(dictionaries, 'es', 'greeting', { name: 'Ana' })).toBe('Hola, Ana.');
  });

  it('falls back to English for a key missing in Spanish, and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(translate(dictionaries, 'es', 'onlyEnglish')).toBe('English only');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('onlyEnglish');
  });

  it('returns the key itself when no language has it, and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(translate(dictionaries, 'en', 'no.such.key')).toBe('no.such.key');
    expect(translate(dictionaries, 'en', 'nested.deep')).toBe('nested.deep'); // a group, not a text
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe('plural', () => {
  it('picks the form for a count by the rules of the language', () => {
    expect(plural(dictionaries, 'en', 'item', 1)).toBe('1 item');
    expect(plural(dictionaries, 'en', 'item', 2)).toBe('2 items');
    expect(plural(dictionaries, 'en', 'item', 0)).toBe('0 items');
  });

  it('uses the "other" form when the language file has no form for the category', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(plural(dictionaries, 'es', 'item', 1)).toBe('1 cosas');
    expect(warn).not.toHaveBeenCalled();
  });

  it('picks ordinal forms', () => {
    const ordinal = (n: number) => plural(dictionaries, 'en', 'place', n, { type: 'ordinal' });
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 24].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
      '24th',
    ]);
    expect(plural(dictionaries, 'es', 'place', 3, { type: 'ordinal' })).toBe('3.º');
  });

  it('shows the count as given text when one is passed', () => {
    expect(plural(dictionaries, 'en', 'item', 1234, { shown: '1,234' })).toBe('1,234 items');
  });
});

describe('listOf', () => {
  it('gives the texts of a list in order, falling back to English', () => {
    expect(listOf(dictionaries, 'en', 'list')).toEqual(['zero', 'one', 'two']);
    expect(listOf(dictionaries, 'es', 'list')).toEqual(['cero', 'uno', 'dos']);
    expect(listOf(dictionaries, 'es', 'nested.deep.key')).toEqual([]); // a text, not a list
    expect(listOf(dictionaries, 'es', 'no.such.list')).toEqual([]);
    expect(listOf({ en: { only: ['a', 'b'] }, es: {} }, 'es', 'only')).toEqual(['a', 'b']);
  });

  it('reads the lists of the real language files', () => {
    expect(tList('en', 'months.short')).toHaveLength(12);
    expect(tList('es', 'months.long')[7]).toBe('agosto');
  });
});

describe('the real language files', () => {
  it('t() reads them', () => {
    expect(t('en', 'app.name')).toBe('Focos');
    expect(t('es', 'app.name')).toBe('Focos');
  });
});

describe('formatNumber', () => {
  it('writes numbers the way the language does', () => {
    expect(formatNumber('en', 2.14, 1, 1)).toBe('2.1');
    expect(formatNumber('es', 2.14, 1, 1)).toBe('2,1');
    expect(formatNumber('en', 2, 1, 1)).toBe('2.0');
    expect(formatNumber('en', 12345.6)).toBe('12,346');
    expect(formatNumber('es', 12345.6)).toBe('12.346');
    expect(formatNumber('en', 2.5, 1)).toBe('2.5');
    expect(formatNumber('en', 3, 1)).toBe('3');
  });
});
