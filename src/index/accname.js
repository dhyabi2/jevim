// A practical subset of the accessible-name computation, plus role mapping.
// The name is what the human would call the element, which is exactly what a motion
// like `g/checkout` has to match against.

import { launder, MAX_NAME } from './hostile.js';

const IMPLICIT_ROLE = {
  A: 'link', BUTTON: 'button', SUMMARY: 'disclosure', SELECT: 'select',
  TEXTAREA: 'textbox', OPTION: 'option', LABEL: 'label',
};

const INPUT_ROLE = {
  submit: 'button', button: 'button', reset: 'button', image: 'button',
  checkbox: 'checkbox', radio: 'radio', range: 'slider', file: 'file',
  search: 'searchbox', email: 'textbox', password: 'password', number: 'textbox',
  tel: 'textbox', url: 'textbox', text: 'textbox',
};

/** The element's role: explicit ARIA wins, then the tag's implicit role. */
export function roleOf(el) {
  const explicit = launder(el.getAttribute('role') || '', 32).split(' ')[0];
  if (explicit) return explicit;
  if (el.tagName === 'A') return el.hasAttribute('href') ? 'link' : 'generic';
  if (el.tagName === 'INPUT') return INPUT_ROLE[(el.type || 'text').toLowerCase()] || 'textbox';
  if (el.isContentEditable) return 'textbox';
  return IMPLICIT_ROLE[el.tagName] || 'generic';
}

function labelledBy(el, doc) {
  const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
  if (!ids.length) return '';
  return ids
    .map((id) => doc.getElementById(id))
    .filter(Boolean)
    .map((node) => node.textContent || '')
    .join(' ');
}

function associatedLabel(el, doc) {
  if (el.id) {
    const forLabel = doc.querySelector(`label[for="${CSS_escape(el.id)}"]`);
    if (forLabel) return forLabel.textContent || '';
  }
  const wrapper = el.closest ? el.closest('label') : null;
  return wrapper ? wrapper.textContent || '' : '';
}

// jsdom and older Chrome builds both have CSS.escape, but a content script should not
// assume it; ids with quotes are rare enough that rejecting them is the safe move.
function CSS_escape(value) {
  return value.replace(/["\\]/g, '\\$&');
}

/**
 * The element's accessible name, laundered. Empty string when it has none, which is a
 * real signal: an unnamed control is one a motion cannot address by meaning.
 */
export function accessibleName(el, doc) {
  const candidates = [
    el.getAttribute('aria-label'),
    labelledBy(el, doc),
    associatedLabel(el, doc),
    el.getAttribute('alt'),
    el.tagName === 'INPUT' && el.type === 'image' ? el.getAttribute('alt') : '',
    el.value && el.tagName === 'INPUT' && INPUT_ROLE[el.type] === 'button' ? el.value : '',
    el.textContent,
    el.getAttribute('placeholder'),
    el.getAttribute('title'),
    el.getAttribute('name'),
  ];
  for (const candidate of candidates) {
    const name = launder(candidate || '', MAX_NAME);
    if (name) return name;
  }
  return '';
}

/**
 * The nearest preceding heading or landmark label, so a name like "Edit" is
 * distinguishable from the six other "Edit" buttons further down the page.
 */
export function nearestContext(el, doc) {
  const SECTION = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.matches && sib.matches(SECTION)) return launder(sib.textContent, 60);
      const nested = sib.querySelector ? sib.querySelector(SECTION) : null;
      if (nested) return launder(nested.textContent, 60);
    }
    const label = node.getAttribute && node.getAttribute('aria-label');
    if (label) return launder(label, 60);
  }
  void doc;
  return '';
}
