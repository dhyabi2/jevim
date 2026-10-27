// A fingerprint has to survive a redeploy, a re-render and a class-name change, because a
// stored L0 binding is worthless the moment its selector rots. CSS paths rot on every one
// of those. Role plus accessible name plus the chain of landmark ancestors does not.

import { launder } from './hostile.js';

const LANDMARK = new Set([
  'HEADER', 'NAV', 'MAIN', 'ASIDE', 'FOOTER', 'FORM', 'SECTION', 'ARTICLE', 'DIALOG', 'TABLE',
]);

/** The chain of landmark ancestors, outermost first, capped so deep DOMs stay cheap. */
export function ancestry(el) {
  const chain = [];
  for (let node = el.parentElement; node && node.nodeType === 1; node = node.parentElement) {
    const role = node.getAttribute('role');
    if (LANDMARK.has(node.tagName)) chain.push(node.tagName.toLowerCase());
    else if (role) chain.push(launder(role, 24).split(' ')[0]);
    if (chain.length >= 4) break;
  }
  return chain.reverse();
}

// FNV-1a. Short, stable across runs, and no crypto dependency in a content script.
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

/**
 * Build a fingerprint for one element. `ordinal` disambiguates the sixth identical
 * "Edit" button; it is supplied by the collector, which is the only thing that can see
 * all the siblings at once.
 */
export function fingerprint({ role, name, el, ordinal = 0, boundary = [], chain = null }) {
  // The boundary chain is part of identity: the same role and name on either side of a shadow root
  // are two different elements.
  //
  // `chain` may be supplied directly. The accessibility-tree collector has no DOM element to walk -
  // it has Chrome's own tree - and its ancestry is computed from that, which is more semantic than
  // walking tags. Passing it in keeps one fingerprint function for both collectors, so an identity
  // minted by one is recognised by the other.
  const resolved = chain !== null ? chain : [...boundary, ...ancestry(el)].join('>');
  const parts = [role, name.toLowerCase(), resolved, String(ordinal)];
  return hash(parts.join('|'));
}

/**
 * Assign ordinals across a collected set so that two elements sharing role, name and
 * ancestry still get distinct fingerprints, in stable document order.
 */
export function withOrdinals(entries) {
  const seen = new Map();
  return entries.map((entry) => {
    const key = [entry.role, entry.name.toLowerCase(),
      [...(entry.boundary || []), ...ancestry(entry.el)].join('>')].join('|');
    const ordinal = seen.get(key) || 0;
    seen.set(key, ordinal + 1);
    return { ...entry, ordinal };
  });
}
