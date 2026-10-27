// Fetching and rehydrating a page without a browser.
//
// The honest cost is stated up front: jsdom has no layout engine, so `env.rect` is
// synthesised from document order rather than measured. Every visibility rule that depends
// on geometry (offscreen parking, 1px traps, viewport buckets) therefore degrades to a
// heuristic here. Everything that depends on the DOM itself - aria-hidden, display:none,
// hidden, disabled, accessible names, laundering, fingerprints, the grammar, the gate -
// behaves exactly as it does in Chrome. Responses say which mode produced them.

import { JSDOM } from 'jsdom';

const UA = 'Jevim/0.1 (headless element indexer; +https://github.com/)';
const ROW_HEIGHT = 20;

export async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow' });
  const html = await res.text();
  const dom = new JSDOM(html, { url: res.url });
  return { ...wrap(dom, res.url), status: res.status, html };
}

export function wrap(dom, url) {
  const win = dom.window;
  const doc = win.document;

  // One synthetic rect per element, assigned lazily in document order and memoised, so a
  // second call on the same node returns the same box and fingerprints stay stable.
  const boxes = new WeakMap();
  let cursor = 0;

  const env = {
    style: (el) => win.getComputedStyle(el),
    viewport: () => ({ w: 1280, h: 900 }),
    rect: (el) => {
      if (boxes.has(el)) return boxes.get(el);
      const top = (cursor += ROW_HEIGHT);
      const width = Math.max(24, Math.min(400, (el.textContent || '').trim().length * 7 || 80));
      const box = { left: 8, top, width, height: 18, right: 8 + width, bottom: top + 18 };
      boxes.set(el, box);
      return box;
    },
  };

  return { dom, win, doc, env, url, layout: 'synthetic' };
}

/**
 * Emulate submitting a GET form, which is what a site search almost always is.
 * Returns the URL the browser would have navigated to, or null when the form is a POST.
 */
export function formTarget(el, doc, baseUrl) {
  const form = el.form || (el.closest && el.closest('form'));
  if (!form) return null;
  if ((form.getAttribute('method') || 'get').toLowerCase() !== 'get') return null;

  const action = new URL(form.getAttribute('action') || '', baseUrl);
  for (const field of form.querySelectorAll('input[name], select[name], textarea[name]')) {
    if (field.disabled) continue;
    const type = (field.type || 'text').toLowerCase();
    if ((type === 'checkbox' || type === 'radio') && !field.checked) continue;
    if (type === 'submit' && field !== el) continue;
    action.searchParams.set(field.getAttribute('name'), field.value ?? '');
  }
  void doc;
  return action.toString();
}
