// Visibility is decided by layout, so every measurement goes through an injected `env`.
// That keeps the collector testable off a real renderer and keeps the rules in one place.

/** Build the measurement environment from a real window. */
export function domEnv(win) {
  const doc = win.document;
  return {
    rect: (el) => el.getBoundingClientRect(),
    style: (el) => win.getComputedStyle(el),
    viewport: () => ({
      w: win.innerWidth || doc.documentElement.clientWidth,
      h: win.innerHeight || doc.documentElement.clientHeight,
    }),
  };
}

// Smaller than this in either axis and it is a tracking pixel or a clipped sr-only span,
// not something a person can aim at.
const MIN_SIZE = 3;

/** True when any ancestor (or the element) hides it from assistive tech. */
export function ariaHidden(el) {
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (node.getAttribute('aria-hidden') === 'true') return true;
    if (node.hasAttribute('inert')) return true;
    if (node.hasAttribute('hidden')) return true;
  }
  return false;
}

/**
 * True when a sighted user could see and hit this element right now.
 * Anything false here never enters the index, so it can never reach the model.
 */
export function isVisible(el, env) {
  if (ariaHidden(el)) return false;
  if (el.tagName === 'INPUT' && el.type === 'hidden') return false;
  if (el.disabled === true) return false;

  const style = env.style(el);
  if (!style) return false;
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  const opacity = parseFloat(style.opacity);
  if (!Number.isNaN(opacity) && opacity === 0) return false;

  const r = env.rect(el);
  if (!r) return false;
  if (r.width < MIN_SIZE || r.height < MIN_SIZE) return false;

  // Parked off-canvas (the classic `left: -9999px` hide).
  const { w, h } = env.viewport();
  if (r.right <= 0 || r.bottom <= 0) return false;
  if (r.left >= w * 4 || r.top >= h * 20) return false;

  return true;
}

/**
 * Where the element sits relative to the current viewport, plus a coarse grid cell so
 * spatial motions have something to sort on without shipping pixel coordinates.
 */
export function viewportBucket(el, env) {
  const r = env.rect(el);
  const { w, h } = env.viewport();
  if (r.bottom <= 0) return 'above';
  if (r.top >= h) return 'below';
  const col = r.left < w / 3 ? 'l' : r.left < (2 * w) / 3 ? 'c' : 'r';
  const row = r.top < h / 3 ? 't' : r.top < (2 * h) / 3 ? 'm' : 'b';
  return row + col;
}

/** Reading order: top to bottom, then left to right, in coarse 24px bands. */
export function readingOrder(el, env) {
  const r = env.rect(el);
  return [Math.round(r.top / 24), Math.round(r.left)];
}
