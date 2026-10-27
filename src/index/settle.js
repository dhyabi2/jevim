// Knowing when a page has stopped moving.
//
// The index was rebuilt lazily on a dirty flag set by any mutation. On a modern application that flag
// is set constantly - a spinner, a countdown, an analytics beacon - so "dirty" carries almost no
// information, and an index built mid-render is a stale index whose fingerprints will not match a
// moment later.
//
// Quiescence is the real signal: no DOM mutations AND no in-flight requests for a short window. This
// tracks both and resolves when the page is actually still, with a hard ceiling so a page that never
// settles - an open websocket, a polling widget - does not hang the caller forever.

const QUIET_MS = 350;
const CEILING_MS = 5000;

/**
 * Watch a window for quiescence.
 *
 * Returns `{ dirty, settled, stop }`. `dirty` is true when something changed since the last index.
 * `settled()` resolves once the page has been still for `quiet`, or at the ceiling, whichever comes
 * first - and says which, because "it never settled" is information the caller should have.
 */
export function createSettler(win, { quiet = QUIET_MS, ceiling = CEILING_MS } = {}) {
  const doc = win.document;
  let lastChange = Date.now();
  let dirty = true;
  let inflight = 0;
  let stopped = false;

  const touch = () => { lastChange = Date.now(); dirty = true; };

  const observer = new win.MutationObserver(touch);
  observer.observe(doc.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['aria-label', 'aria-hidden', 'href', 'role', 'disabled', 'hidden', 'class', 'style'],
  });
  win.addEventListener('scroll', touch, { passive: true });
  win.addEventListener('resize', touch, { passive: true });

  // Count requests so a fetch that will rewrite the page is not mistaken for stillness. Patching
  // fetch is intrusive, so the original is kept and restored on stop.
  const originalFetch = win.fetch;
  if (typeof originalFetch === 'function') {
    win.fetch = function patched(...args) {
      inflight++;
      touch();
      return originalFetch.apply(this, args).finally(() => { inflight = Math.max(0, inflight - 1); touch(); });
    };
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    win.removeEventListener('scroll', touch);
    win.removeEventListener('resize', touch);
    if (typeof originalFetch === 'function') win.fetch = originalFetch;
  }

  async function settled() {
    const startedAt = Date.now();
    for (;;) {
      if (stopped) return { settled: false, reason: 'stopped' };
      const still = Date.now() - lastChange;
      if (inflight === 0 && still >= quiet) return { settled: true, waitedMs: Date.now() - startedAt };
      if (Date.now() - startedAt >= ceiling) {
        // Deliberately not an error. A page that never settles is common, and the caller should be
        // told it is acting on a moving target rather than be left waiting.
        return { settled: false, reason: 'page never became still', waitedMs: Date.now() - startedAt, inflight };
      }
      await new Promise((r) => win.setTimeout(r, 40));
    }
  }

  return {
    settled, stop, touch,
    get dirty() { return dirty; },
    clean() { dirty = false; },
    get inflight() { return inflight; },
  };
}
