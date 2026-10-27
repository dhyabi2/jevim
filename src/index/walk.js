// Walking a page across every boundary a page script is allowed to cross.
//
// `document.querySelectorAll` stops at every shadow root and every frame. Measured on a page with one
// shadow root holding a button and an input: the collector found 1 of 3 interactive elements. On
// component-based applications and any page with an embedded payment or sign-in frame, that means
// indexing a fraction of the page and then resolving confidently against it.
//
// What a content script can reach: open shadow roots, and same-origin frames. Closed shadow roots and
// cross-origin frames are invisible from inside the page by design - those need CDP, which the
// headless path uses.
//
// Frames carry their own coordinate space, so an offset travels with the walk. Without it an element
// inside a frame reports a rect relative to the frame and lands in the wrong viewport bucket.

/**
 * Yield `{ el, offset, boundary }` for every element matching `selector`, descending through open
 * shadow roots and same-origin frames.
 *
 * `boundary` is the chain of boundaries crossed to reach the element. It goes into the fingerprint so
 * that two elements with the same role and name on either side of a shadow root stay distinct.
 */
export function* walk(root, selector, { offset = { x: 0, y: 0 }, boundary = [], depth = 0 } = {}) {
  if (depth > 12) return;   // pathological nesting; stop rather than hang

  const scope = root.querySelectorAll ? root : null;
  if (!scope) return;

  for (const el of scope.querySelectorAll('*')) {
    if (el.matches && el.matches(selector)) yield { el, offset, boundary };

    // An open shadow root. Closed ones return null here and are simply unreachable from the page.
    if (el.shadowRoot) {
      yield* walk(el.shadowRoot, selector, {
        offset,
        boundary: [...boundary, `shadow:${el.tagName.toLowerCase()}`],
        depth: depth + 1,
      });
    }

    if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
      yield* frame(el, selector, offset, boundary, depth);
    }
  }
}

function* frame(el, selector, offset, boundary, depth) {
  let doc = null;
  try {
    // Cross-origin access throws, which is the browser doing its job. Skip it.
    doc = el.contentDocument;
  } catch { return; }
  if (!doc || !doc.querySelectorAll) return;

  let box = { left: 0, top: 0 };
  try { box = el.getBoundingClientRect(); } catch { /* detached */ }

  const src = (el.getAttribute('src') || '').slice(0, 40) || 'inline';
  yield* walk(doc, selector, {
    offset: { x: offset.x + (box.left || 0), y: offset.y + (box.top || 0) },
    boundary: [...boundary, `frame:${src}`],
    depth: depth + 1,
  });
}

/** Wrap a measurement env so rects inside a frame are reported in page coordinates. */
export function shift(env, offset) {
  if (!offset || (!offset.x && !offset.y)) return env;
  return {
    ...env,
    rect: (el) => {
      const r = env.rect(el);
      return {
        left: r.left + offset.x, top: r.top + offset.y,
        right: r.right + offset.x, bottom: r.bottom + offset.y,
        width: r.width, height: r.height,
      };
    },
  };
}
