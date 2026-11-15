// Loads the body of index.html into the jsdom document, the way the browser
// would have it when the app starts, and offers small helpers to drive it.
import html from '../../index.html?raw';
import methodHtml from '../../method.html?raw';

function mount(source: string, hash: string): void {
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(source)![1].replace(/<script[\s\S]*?<\/script>/g, '');
  document.body.innerHTML = body;
  history.replaceState(null, '', `${location.pathname}${hash ? `#${hash}` : ''}`);
}

/** The main page. */
export function mountPage(hash = ''): void {
  mount(html, hash);
}

/** The "How it works" page. */
export function mountMethodPage(hash = ''): void {
  mount(methodHtml, hash);
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`no element #${id}`);
  return element as T;
}

/** Sets a form control's value and fires the events a user's edit would. */
export function setValue(id: string, value: string): void {
  const control = byId<HTMLInputElement | HTMLSelectElement>(id);
  control.value = value;
  control.dispatchEvent(new Event('input', { bubbles: true }));
  control.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Picks a radio button by name and value. */
export function choose(name: string, value: string): void {
  const radio = document.querySelector<HTMLInputElement>(`input[type="radio"][name="${name}"][value="${value}"]`);
  if (!radio) throw new Error(`no radio ${name}=${value}`);
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
}

export function click(target: string | Element): void {
  const element = typeof target === 'string' ? byId(target) : target;
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

export function text(id: string): string {
  return (byId(id).textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function isHidden(id: string): boolean {
  return byId(id).hidden === true;
}
