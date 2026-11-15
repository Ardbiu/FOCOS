// Small DOM helpers shared by the page modules.

import { DataError } from './data';
import { t, type Lang } from './i18n';

const SVG_NS = 'http://www.w3.org/2000/svg';

type Attributes = Record<string, string | number | boolean | null | undefined>;
type Child = Node | string | null | undefined | false;

function fill<T extends Element>(element: T, attributes: Attributes, children: Child[]): T {
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    element.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child);
  }
  return element;
}

/** Creates an HTML element in the document of `owner`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  owner: Node,
  tag: K,
  attributes: Attributes = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const doc = owner.ownerDocument ?? (owner as Document);
  return fill(doc.createElement(tag), attributes, children);
}

/** Creates an SVG element in the document of `owner`. */
export function svg<K extends keyof SVGElementTagNameMap>(
  owner: Node,
  tag: K,
  attributes: Attributes = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const doc = owner.ownerDocument ?? (owner as Document);
  return fill(doc.createElementNS(SVG_NS, tag), attributes, children);
}

/** The element with this id; throws when the page does not have it. */
export function byId<T extends HTMLElement = HTMLElement>(doc: Document, id: string): T {
  const element = doc.getElementById(id);
  if (!element) throw new Error(`The page has no element with id "${id}"`);
  return element as T;
}

/**
 * Fills the page's fixed text from the language file. An element says what it
 * wants with `data-i18n="key"` (its text) or `data-i18n-attr="attribute:key"`
 * (one or more attributes, separated by `;`).
 */
export function applyStaticText(doc: Document, lang: Lang): void {
  doc.documentElement.lang = lang;
  for (const element of doc.querySelectorAll<HTMLElement>('[data-i18n]')) {
    element.textContent = t(lang, element.dataset.i18n ?? '');
  }
  for (const element of doc.querySelectorAll<HTMLElement>('[data-i18n-attr]')) {
    for (const pair of (element.dataset.i18nAttr ?? '').split(';')) {
      const [attribute, key] = pair.split(':');
      if (attribute && key) element.setAttribute(attribute.trim(), t(lang, key.trim()));
    }
  }
}

/**
 * What to say when a file could not be loaded: the language's own sentence
 * with the name of the file, never the error's English detail.
 */
export function loadErrorText(error: unknown, lang: Lang): string {
  return error instanceof DataError ? t(lang, 'app.loadError', { file: error.file }) : t(lang, 'app.loadErrorPlain');
}

/** Shows `message` in a status element, or hides the element when there is none. */
export function setStatus(element: HTMLElement, message: string | null): void {
  element.textContent = message ?? '';
  element.hidden = !message;
}
