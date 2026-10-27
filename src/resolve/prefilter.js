// Code prunes, the model decides. The jaggedness notes are explicit that accuracy falls as
// state fills with irrelevant detail, and today's measurement put numbers on it: real layout
// takes a Wikipedia page from 383 candidates to 32. This is the rest of that pruning.
//
// Nothing here is clever. It is substring and role matching, which is exactly the work that
// should never reach a model.

const MAX_CANDIDATES = 40;

// Roles a text object plausibly resolves to, so `if` (inner form) does not offer links.
const OBJECT_ROLES = {
  form: ['textbox', 'searchbox', 'button', 'checkbox', 'radio', 'select', 'password'],
  row: ['link', 'button', 'checkbox'],
  post: ['link', 'button'],
  article: ['link'],
  section: ['link', 'button'],
};

function normalise(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Without this, "the cheapest one" matches any element whose name contains "the", so a
// genuinely semantic motion is treated as a literal one and never reaches the ranked
// fallback the model actually needs. Stopwords carry no targeting information.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'my', 'me', 'i', 'to', 'of', 'in', 'on',
  'at', 'for', 'with', 'and', 'or', 'is', 'are', 'was', 'be', 'it', 'its', 'as', 'by', 'from',
  'one', 'ones', 'thing', 'please', 'go', 'first', 'last', 'next', 'previous',
]);

/** The words in a query that actually carry targeting information. */
export function contentWords(query) {
  const all = normalise(query).split(' ').filter(Boolean);
  const kept = all.filter((word) => word.length > 2 && !STOPWORDS.has(word));
  // A query made entirely of stopwords ("the one") has nothing literal to match on, and
  // returning `all` here would resurrect exactly the bug this filter exists to kill.
  return kept;
}

/** Literal-ish match first: the query's words against the element's name, then its context. */
function score(entry, words) {
  const name = normalise(entry.name);
  const ctx = normalise(entry.ctx);
  if (!words.length) return 0;
  let hits = 0;
  for (const word of words) {
    if (name.includes(word)) hits += 2;
    else if (ctx.includes(word)) hits += 1;
  }
  return hits;
}

/**
 * Narrow the index to the candidates worth paying a model to choose between.
 *
 * Returns `{ candidates, strategy }`. `strategy` says how the set was reached, because a
 * resolution over a substring-matched set of four means something different from one over
 * the forty most prominent elements on the page.
 */
export function prefilter(target, index, { max = MAX_CANDIDATES } = {}) {
  if (target.kind === 'search') {
    const words = contentWords(target.query);
    const scored = index.map((entry) => ({ entry, s: score(entry, words) })).filter((x) => x.s > 0);
    if (!scored.length) {
      // Nothing matched literally. The motion may still be semantic ("the cheapest one"), so
      // fall back to the index's own ranking, which already puts the viewport first.
      return { candidates: index.slice(0, max), strategy: 'ranked' };
    }

    scored.sort((a, b) => b.s - a.s);
    const literal = scored.slice(0, Math.ceil(max * 0.6)).map((x) => x.entry);

    // Union with the ranked head rather than trusting the literal match alone. Measured
    // failure this fixes: on Hacker News, "show me the newest stories" matched the word
    // "show" - a verb in the query but a proper name on that site - and the five Show HN
    // candidates crowded out the actual target, the link named "new". The model then
    // correctly answered that none of them matched, so a code-side heuristic turned a
    // reachable target into an abstention. State is nearly free, so there is no reason to
    // let one substring decide what the model is allowed to see.
    const seen = new Set(literal.map((e) => e.fp));
    const candidates = [...literal];
    for (const entry of index) {
      if (candidates.length >= max) break;
      if (seen.has(entry.fp)) continue;
      seen.add(entry.fp);
      candidates.push(entry);
    }
    return { candidates, strategy: 'substring+ranked' };
  }

  if (target.kind === 'textobject') {
    const roles = OBJECT_ROLES[target.id];
    const byRole = roles ? index.filter((entry) => roles.includes(entry.role)) : index;
    return { candidates: (byRole.length ? byRole : index).slice(0, max), strategy: 'role' };
  }

  return { candidates: index.slice(0, max), strategy: 'ranked' };
}
