// Revealing a virtualised list in a real browser.
//
// src/index/reveal.js does this against a jsdom window by calling win.scrollTo and re-collecting. None
// of that exists here: there is no window object on this side of CDP, and the index comes from Chrome's
// accessibility tree rather than a DOM walk. The contract is deliberately identical - merge by
// fingerprint, bound the steps, restore the scroll position, report whether it finished - because a
// caller should not have to know which backend it is talking to.
//
// The bound is the honest part. An infinite feed is infinite, so `complete: false` is the difference
// between "the target is not on this page" and "the target has not been scrolled into existence yet",
// and a refusal means something different in each case.

const STEP_RATIO = 0.8;
const MAX_STEPS = 12;
const SETTLE_MS = 150;

const METRICS = `(() => {
  const d = document.documentElement, b = document.body;
  return {
    y: window.scrollY || 0,
    viewport: window.innerHeight || d.clientHeight || 800,
    height: Math.max(d.scrollHeight || 0, b ? b.scrollHeight || 0 : 0),
  };
})()`;

/**
 * Scroll through the page in bounded steps, re-indexing at each stop, and return the merged index.
 *
 * `reindex` is supplied by the session: it must rebuild the index from the page as it is now, because
 * the whole point is that rows which did not exist a moment ago now do.
 */
export async function revealAllCdp(page, reindex, { maxSteps = MAX_STEPS, settleMs = SETTLE_MS } = {}) {
  const metrics = () => page.evaluate(METRICS);
  const start = await metrics();
  const byFingerprint = new Map();
  let steps = 0;
  let exhausted = false;

  const absorb = async () => {
    for (const entry of await reindex()) {
      if (!byFingerprint.has(entry.fp)) byFingerprint.set(entry.fp, entry);
    }
  };

  await absorb();

  let previousHeight = -1;
  while (steps < maxSteps) {
    const before = await metrics();

    // Nothing left to scroll and the document stopped growing: the list is fully revealed.
    if (before.y + before.viewport >= before.height - 2 && before.height === previousHeight) {
      exhausted = true; break;
    }
    previousHeight = before.height;

    const to = before.y + Math.round(before.viewport * STEP_RATIO);
    await page.evaluate(`window.scrollTo(0, ${to})`);
    await new Promise((r) => setTimeout(r, settleMs));
    steps += 1;

    // Did not move and did not grow: scrolling is not what reveals more on this page.
    const after = await metrics();
    if (after.y === before.y && after.height === before.height) { exhausted = true; break; }
    await absorb();
  }

  await page.evaluate(`window.scrollTo(0, ${start.y})`);
  await new Promise((r) => setTimeout(r, settleMs));

  return { index: [...byFingerprint.values()], steps, exhausted, complete: exhausted };
}
