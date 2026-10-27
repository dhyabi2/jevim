// Crawler navigation decisions.
//
// Not a crawler: a crawler's navigation brain. The expensive, per-site, constantly-breaking
// part of crawling is "where is next page", "is this a consent wall", "is this a product page".
// Those are closed-set decisions with a right answer and a knowable "no", which is exactly the
// shape Jev answers and exactly what a CSS selector cannot tell you it got wrong.
//
// Every question here goes in ONE call: Jev ingests the state once and answers in parallel, and
// output tokens are free.

export const PAGE_KINDS = {
  listing: 'a list or index of many items',
  detail: 'a single item, article or product in full',
  search: 'a search results page',
  consent: 'a cookie or consent wall blocking the content',
  login: 'a sign-in or registration wall',
  error: 'an error, missing or blocked page',
  other: 'none of the above',
};

/**
 * Take the head and the tail of the index, considering only named elements.
 *
 * Two lessons are baked in here. Unnamed elements are dropped because every question the
 * survey asks is semantic and an element with no accessible name cannot answer one - and
 * because the index's own ranking pushes unnamed entries to the end, so a naive tail is
 * nothing but junk. Measured: Hacker News has 227 entries, its "More" link ranks 193rd, and
 * both the plain head and the head-plus-raw-tail missed it, so the survey reported no next
 * page on a page that plainly has one.
 */
export function sample(index, max) {
  const named = index.filter((entry) => entry.name);
  if (named.length <= max) return named;
  const tail = Math.max(8, Math.floor(max / 3));
  return [...named.slice(0, max - tail), ...named.slice(-tail)];
}

/** One call answering everything a crawler needs to decide before it moves. */
export async function survey({ decide, index, model = 'typesafe/jev-latest', max = 60 }) {
  // Head and tail, not just the head. Pagination lives in the footer: taking the first 60
  // entries of a Hacker News index hid the "More" link entirely and the survey reported no
  // next page on a page that plainly has one. Consent banners sit at the top, next-page links
  // at the bottom, so a survey has to see both ends.
  const candidates = sample(index, max);
  const criteria = Object.fromEntries(candidates.map((e) => [e.id,
    `${e.role} "${e.name || '(unnamed)'}"${e.ctx ? ` in ${e.ctx}` : ''}`]));
  criteria.__none__ = 'No element on this page is what was asked for.';

  const questions = {
    kind: { type: 'choice', instructions: 'What kind of page is this?', criteria: PAGE_KINDS },
    nextPage: { type: 'choice', instructions: 'Which element goes to the next page of results?', criteria },
    consentAccept: { type: 'choice', instructions: 'Which element dismisses or accepts a cookie or consent notice?', criteria },
    loginLink: { type: 'choice', instructions: 'Which element leads to signing in?', criteria },
    paywalled: { type: 'noul', instructions: 'Is the main content hidden behind a paywall or registration wall?' },
  };

  const answer = await decide({ model, state: candidates.map((e) => `${e.id}: ${criteria[e.id]}`), questions });
  const bag = answer.answers || {};
  const pick = (id) => {
    const hit = bag[id];
    if (!hit || hit.choice === '__none__') return null;
    const entry = candidates.find((c) => c.id === hit.choice);
    return entry ? { fingerprint: entry.fp, name: entry.name, role: entry.role, confidence: hit.confidence } : null;
  };

  return {
    kind: bag.kind ? { value: bag.kind.choice, confidence: bag.kind.confidence } : null,
    nextPage: pick('nextPage'),
    consentAccept: pick('consentAccept'),
    loginLink: pick('loginLink'),
    paywalled: bag.paywalled?.noul ?? null,
    candidates: candidates.length,
    usage: answer.usage ?? null,
  };
}
