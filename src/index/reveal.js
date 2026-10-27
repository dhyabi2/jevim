// Reaching elements that do not exist yet.
//
// A virtualised list - every large table, feed and result set built in the last decade - keeps only the
// visible rows in the DOM. Everything else is not hidden, it is absent. So an index built from one
// viewport is not a partial view of the page, it is a view of one frame of it, and a motion aimed at
// row 400 can never resolve because row 400 has never existed in the document.
//
// This scrolls in bounded steps and merges what appears, so the index covers the list rather than the
// window. Bounded because an infinite feed is infinite: the cap is a promise that this terminates.

const STEP_RATIO = 0.8;
const MAX_STEPS = 12;
const SETTLE_MS = 120;

/**
 * Scroll through the page, collecting at each stop, and return the merged index.
 *
 * Entries are merged by fingerprint, so a row seen in two overlapping viewports appears once. The
 * result reports how far it got and whether it ran out of steps, because "there is more list below"
 * changes what a refusal means: nothing found may mean not yet revealed.
 */
export async function revealAll(win, collectNow, { maxSteps = MAX_STEPS, settleMs = SETTLE_MS } = {}) {
  const doc = win.document;
  const startY = win.scrollY || 0;
  const byFingerprint = new Map();
  let steps = 0;
  let exhausted = false;

  const absorb = () => {
    for (const entry of collectNow()) {
      if (!byFingerprint.has(entry.fp)) byFingerprint.set(entry.fp, entry);
    }
  };

  absorb();

  const viewport = () => win.innerHeight || doc.documentElement.clientHeight || 800;
  const full = () => Math.max(
    doc.documentElement.scrollHeight || 0,
    doc.body ? doc.body.scrollHeight || 0 : 0,
  );

  let previousHeight = -1;
  while (steps < maxSteps) {
    const before = win.scrollY || 0;
    const height = full();

    // Nothing left to scroll and the document stopped growing: the list is fully revealed.
    if (before + viewport() >= height - 2 && height === previousHeight) { exhausted = true; break; }
    previousHeight = height;

    win.scrollTo(0, before + Math.round(viewport() * STEP_RATIO));
    await new Promise((r) => win.setTimeout(r, settleMs));
    steps++;

    // A virtualised list that did not move means scrolling is not what reveals more here.
    if ((win.scrollY || 0) === before && full() === height) { exhausted = true; break; }
    absorb();
  }

  win.scrollTo(0, startY);
  await new Promise((r) => win.setTimeout(r, settleMs));

  return {
    index: [...byFingerprint.values()],
    steps,
    exhausted,
    // The honest caveat for the caller: a refusal on a partially revealed list may only mean the
    // target has not been scrolled into existence yet.
    complete: exhausted,
  };
}
