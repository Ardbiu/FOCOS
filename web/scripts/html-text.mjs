// Fills `%i18n:some.key%` placeholders in the HTML pages from a language file,
// at build time. It is used for the parts of the page head that must be in the
// HTML itself (the description and the share text), so that even those strings
// live in src/i18n and not in the markup.

/** Looks `key` up by its dotted path; `undefined` when it is not a text. */
function lookup(dictionary, key) {
  let entry = dictionary;
  for (const part of key.split('.')) {
    if (entry === null || typeof entry !== 'object') return undefined;
    entry = entry[part];
  }
  return typeof entry === 'string' ? entry : undefined;
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Replaces every `%i18n:key%` in `html` with the text of `key`, escaped for HTML.
 * @param {string} html
 * @param {object} dictionary a language file, e.g. src/i18n/en.json
 * @returns {string}
 */
export function fillHtmlText(html, dictionary) {
  return html.replace(/%i18n:([\w.]+)%/g, (_, key) => {
    const text = lookup(dictionary, key);
    if (text === undefined) throw new Error(`The language file has no text for "${key}"`);
    return escapeHtml(text);
  });
}

/**
 * The same as a Vite plugin.
 * @param {object} dictionary
 */
export function htmlText(dictionary) {
  return {
    name: 'focos-html-text',
    transformIndexHtml: (html) => fillHtmlText(html, dictionary),
  };
}
