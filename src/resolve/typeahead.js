// Type-ahead resolution.
//
// A motion is typed `g` `/` `c` `h` `e` `c` `k` ... `<CR>`, so the query arrives one character
// at a time. Measured: typing is 1.5-2.5 s while the resolver is ~656 ms, and the answer
// stabilises long before the query ends - "log in to my account" is decided at "log". So the
// latency budget was always there, inside the user's own typing.
//
// This wraps a resolver and turns it into one that is usually already finished. It predicts
// nothing about the user: it only acts on characters they have actually typed.
//
// Policy, all of it measured (see .ledger/tmp/live-evidence.md):
//   - single-flight: at most one call in the air, so a fast typist cannot fan out
//   - coalescing: refire only once STEP more characters have arrived
//   - accept the newest completed answer whose query is a prefix of the final query
//   - stability: a prefix answer is trusted only when two consecutive answers agree, because
//     a 3-character prefix can differ from the whole query ("sub" abstains, "submit" resolves)
//
// A length floor on accepted prefixes was tried and is worse on every metric: it rejects good
// early answers more often than it catches bad ones.

const STEP = 3;
const MIN_QUERY = 3;

const label = (result) => (result.abstained ? `abstain:${result.reason || ''}`.slice(0, 40) : result.fp);

export function createTypeAhead({ resolver, step = STEP, minQuery = MIN_QUERY } = {}) {
  if (!resolver) throw new Error('createTypeAhead needs a resolver');

  // Completed answers for this query, oldest first. Reset when a motion ends.
  let done = [];
  let inflight = null;
  let firedAt = -Infinity;
  const stats = { primed: 0, hits: 0, misses: 0 };

  function reset() {
    done = [];
    inflight = null;
    firedAt = -Infinity;
  }

  /**
   * Called as the user types. Cheap and fire-and-forget: it never throws and never blocks the
   * keystroke. `command` carries the operator, which the resolver needs for its floor.
   */
  function prime(query, index, command) {
    const text = (query || '').trim();
    if (text.length < minQuery) return;
    if (inflight) return;                       // single-flight
    if (text.length - firedAt < step) return;   // coalesce

    firedAt = text.length;
    stats.primed += 1;
    const target = { kind: 'search', query: text };
    const promise = Promise.resolve(resolver(target, index, { ...command, target }))
      .then((result) => { done.push({ query: text, result }); return result; })
      .catch(() => null)
      .finally(() => { if (inflight && inflight.query === text) inflight = null; });
    inflight = { query: text, promise };
  }

  /** True when two consecutive completed answers agree, so an early read can be trusted. */
  function stable() {
    if (done.length < 2) return false;
    return label(done[done.length - 1].result) === label(done[done.length - 2].result);
  }

  /**
   * The resolver the runner calls. Uses a primed answer when one is trustworthy, otherwise
   * awaits the call already in the air, otherwise resolves from scratch.
   */
  async function resolve(target, index, command) {
    if (target.kind !== 'search') { reset(); return resolver(target, index, command); }
    const query = target.query.trim();

    const exact = [...done].reverse().find((d) => d.query === query);
    if (exact) { stats.hits += 1; const out = exact.result; reset(); return { ...out, typeahead: 'exact' }; }

    const prefix = [...done].reverse().find((d) => query.startsWith(d.query));
    if (prefix && stable()) {
      stats.hits += 1;
      const out = prefix.result;
      reset();
      return { ...out, typeahead: 'prefix', primedFrom: prefix.query };
    }

    // Nothing trustworthy yet. Wait on the call already running rather than starting a second.
    if (inflight) {
      await inflight.promise;
      const settled = [...done].reverse().find((d) => d.query === query || (query.startsWith(d.query) && stable()));
      if (settled) {
        stats.hits += 1;
        const out = settled.result;
        reset();
        return { ...out, typeahead: 'awaited', primedFrom: settled.query };
      }
    }

    stats.misses += 1;
    reset();
    const out = await resolver(target, index, command);
    return { ...out, typeahead: 'cold' };
  }

  return { prime, resolve, reset, stats, get pending() { return inflight !== null; } };
}
