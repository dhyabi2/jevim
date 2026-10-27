// DOM to element index. Code prunes, the model decides later: the jaggedness notes are
// explicit that accuracy falls as state fills with irrelevant detail, so nothing that a
// keystroke could not plausibly target is allowed through.

import { accessibleName, nearestContext, roleOf } from './accname.js';
import { ancestry, fingerprint, withOrdinals } from './fingerprint.js';
import { hadInvisibles, launder } from './hostile.js';
import { isVisible, readingOrder, viewportBucket } from './visibility.js';
import { shift, walk } from './walk.js';

const INTERACTIVE = [
  'a[href]', 'button', 'input', 'select', 'textarea', 'summary', '[contenteditable=""]',
  '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
  '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="tab"]',
  '[role="menuitem"]', '[role="option"]', '[role="switch"]', '[role="textbox"]',
  '[role="searchbox"]', '[role="combobox"]', '[role="slider"]',
].join(',');

/**
 * Collect every element on the page a motion could address.
 *
 * Returns entries of the shape
 * `{ id, fp, role, name, anc, ctx, vp, suspect, el }` — `el` is the live node and is
 * stripped before anything is serialised for a model. `anc` is kept so the gate can
 * re-check identity at action time without a second collection pass.
 */
export function collect(doc, env, { limit = 400 } = {}) {
  const raw = [];
  // Crosses open shadow roots and same-origin frames. querySelectorAll stops at both, which meant
  // indexing a fraction of any component-based page.
  for (const { el, offset, boundary } of walk(doc, INTERACTIVE)) {
    // Inside a frame, rects are relative to that frame, so measurement is shifted into page space.
    const local = shift(env, offset);
    if (!isVisible(el, local)) continue;
    const rawName = el.getAttribute('aria-label') || el.textContent || '';
    // Names and context resolve within the element's OWN document: an aria-labelledby inside a
    // shadow root or a frame points at an id in that root, not in the top-level document.
    const owner = el.ownerDocument || doc;
    raw.push({
      el,
      boundary,
      offset,
      role: roleOf(el),
      name: accessibleName(el, owner),
      ctx: launder(nearestContext(el, owner), 60),
      vp: viewportBucket(el, local),
      // The page tried to say something only a model would read. Kept as a flag rather
      // than dropped, so the resolver can refuse to act on it later.
      suspect: hadInvisibles(rawName),
      order: readingOrder(el, local),
    });
  }

  raw.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);

  const ranked = rank(raw).slice(0, limit);
  return withOrdinals(ranked).map((entry, i) => ({
    id: `e${i}`,
    fp: fingerprint(entry),
    role: entry.role,
    name: entry.name,
    anc: fullAncestry(entry),
    boundary: entry.boundary,
    offset: entry.offset,
    ctx: entry.ctx,
    vp: entry.vp,
    suspect: entry.suspect,
    el: entry.el,
  }));
}

/**
 * Ancestry including the boundaries crossed to reach the element.
 *
 * Without the boundary chain, a button named "Submit" inside a shadow root and another in the light
 * DOM produce the same ancestry and collide on fingerprint.
 */
export function fullAncestry(entry) {
  return [...(entry.boundary || []), ...ancestry(entry.el)].join('>');
}

// In-viewport first: the thing the user is looking at is the thing they mean. Then what
// they have scrolled past, then what is still below. Named elements beat unnamed ones,
// because an unnamed control cannot be addressed by meaning anyway.
function rank(entries) {
  const band = (entry) => (entry.vp === 'above' ? 1 : entry.vp === 'below' ? 2 : 0);
  return entries
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => {
      const byBand = band(a.entry) - band(b.entry);
      if (byBand) return byBand;
      const byName = (a.entry.name ? 0 : 1) - (b.entry.name ? 0 : 1);
      if (byName) return byName;
      return a.i - b.i;
    })
    .map(({ entry }) => entry);
}
