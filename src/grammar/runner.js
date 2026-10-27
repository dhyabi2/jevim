// Turns a parsed command into an action. This is where the latency tiers live:
//
//   L0  a fingerprint already in the binding store        0 ms, no network
//   L1  a Jev call                                        70-500 ms
//   --  nothing to act on, or a verb that needs a confirm
//
// `run` is async because L1 is a network call in the keystroke path. That is deliberate:
// Jev is the core of the product, not a compilation step in front of it, so the common case
// on a page nobody has bound yet *is* the model call. L0 still answers without awaiting
// anything meaningful, which is what keeps a bound motion at zero cost.
//
// `net` counts every outbound call the runner makes. The macro law is asserted against it,
// so it is a real counter and not a comment.

import { DESTRUCTIVE } from './grammar.js';

// A resolution has to be confident before it becomes a permanent binding. Below this it still acts -
// the operator floor already allowed it - but it is resolved again next time rather than remembered.
export const PROMOTE_FLOOR = 0.75;

export function createRunner({ site, bindings, ops, getIndex, resolver = null, gate = null, repair = null,
                               promoteFloor = PROMOTE_FLOOR }) {
  const net = { calls: 0 };

  function byFingerprint(index, fp) {
    return index.find((entry) => entry.fp === fp) || null;
  }

  function edgeTarget(index, id) {
    if (!index.length) return null;
    if (id === 'first') return index[0];
    if (id === 'last') return index[index.length - 1];
    // Sections are approximated by context changes, which is all the DOM gives us for free.
    const contexts = [...new Set(index.map((entry) => entry.ctx).filter(Boolean))];
    if (!contexts.length) return null;
    const first = index.find((entry) => entry.ctx === contexts[id === 'nextSection' ? 0 : contexts.length - 1]);
    return first || null;
  }

  /**
   * Resolve a command's target to an index entry.
   * Returns `{ tier, entry }`, or `{ tier: 'none' }` when nothing matches.
   */
  async function resolve(command) {
    const index = getIndex();
    const { target } = command;

    if (target.kind === 'hint') return { tier: 'L0', entry: null, hint: true };
    if (target.kind === 'edge') {
      const entry = edgeTarget(index, target.id);
      return entry ? { tier: 'L0', entry } : { tier: 'none' };
    }

    const fp = bindings.lookup(site, target);
    if (fp) {
      const entry = byFingerprint(index, fp);
      if (entry) return { tier: 'L0', entry };

      // The fingerprint is absent from a fresh index, which is what a redesign looks like: the
      // element still exists but under a new name or in a new place, so it has a new fingerprint.
      // This is the case repair exists for, and it has to be handled here rather than at the gate -
      // the gate only ever sees elements the index still contains.
      const described = bindings.describe(site, target);
      bindings.forget(site, target);
      if (repair && described) {
        net.calls += 1;
        const fixed = await repair(described, index);
        if (!fixed.abstained && fixed.fp) {
          const entry2 = byFingerprint(index, fixed.fp);
          if (entry2) {
            bindings.remember(site, target, entry2, { confidence: fixed.confidence, source: 'repair' });
            return { tier: 'L0', entry: entry2, repaired: { from: described.fp, to: fixed.fp, confidence: fixed.confidence } };
          }
        }
        // Both staleness paths report the same way. A caller should not have to know whether the
        // binding vanished from the index or failed the gate - only that it went stale and could not
        // be repaired.
        return { tier: 'stale', reason: 'the bound element is no longer on the page',
                 repairFailed: fixed.reason, described };
      }
    }

    if (!resolver) return { tier: 'needs-resolver' };
    net.calls += 1;
    const resolved = await resolver(target, index, command);
    if (!resolved) return { tier: 'none' };
    if (resolved.abstained) return { tier: 'L1', abstained: true, reason: resolved.reason, resolution: resolved };
    if (!resolved.fp) return { tier: 'none', resolution: resolved };
    return { tier: 'L1', entry: byFingerprint(index, resolved.fp), confidence: resolved.confidence, resolution: resolved };
  }

  /**
   * Execute a command. Destructive verbs never run off an unconfirmed resolution, an entry
   * the collector flagged as carrying hidden text is never acted on automatically, and the
   * target's identity is re-checked in the same tick as the action.
   */
  async function run(command, { confirmed = false, attempted = false } = {}) {
    const resolution = await resolve(command);
    if (resolution.hint) return { status: 'hint', tier: 'L0' };
    if (resolution.tier === 'needs-resolver') return { status: 'needs-resolver', tier: 'none' };
    if (resolution.tier === 'stale') {
      return { status: 'stale', tier: 'L0', reason: resolution.reason,
               repairFailed: resolution.repairFailed };
    }
    // The model said none of these. Falling back to hints is strictly better than guessing,
    // because the user already typed the verb.
    if (resolution.abstained) {
      return { status: 'abstained', tier: 'L1', reason: resolution.reason, resolution: resolution.resolution };
    }
    if (resolution.tier === 'none' || !resolution.entry) {
      return { status: 'no-target', tier: 'none', repairFailed: resolution.repairFailed };
    }

    const { entry, tier } = resolution;
    if (entry.suspect) return { status: 'refused', reason: 'hidden text on target', tier, entry };
    if (DESTRUCTIVE.has(command.operator) && !confirmed) {
      return { status: 'confirm', tier, entry, operator: command.operator };
    }

    // The gate runs last, after any confirmation prompt, so that nothing can change
    // between the check and the click.
    if (gate) {
      // The CDP gate is async - the answer lives in the browser - so both forms are awaited.
      const verdict = await gate(entry);
      if (!verdict.ok) {
        bindings.forget(site, command.target);

        // The element moved or was renamed. Repair that one step rather than failing the run, but
        // only once: a repair that itself fails the gate is a wrong repair, not a retry.
        if (repair && !attempted) {
          net.calls += 1;
          const fixed = await repair(entry, getIndex());
          if (!fixed.abstained && fixed.fp) {
            const replacement = byFingerprint(getIndex(), fixed.fp);
            bindings.remember(site, command.target, replacement || fixed.fp,
              { confidence: fixed.confidence, source: 'repair' });
            const retried = await run(command, { confirmed, attempted: true });
            return { ...retried, repaired: { from: entry.fp, to: fixed.fp, confidence: fixed.confidence } };
          }
          return { status: 'stale', reason: verdict.reason, tier, entry,
                   repairFailed: fixed.reason };
        }
        return { status: 'stale', reason: verdict.reason, tier, entry };
      }
    }

    const op = ops[command.operator];
    if (!op) return { status: 'no-op', tier, entry };
    // The DOM ops take an element; the CDP ops take the entry, because there is no element on that
    // side. Passing both means one runner serves both backends, and awaiting covers the CDP case.
    const result = await op(entry.el, entry);

    // Promotion: a confident L1 resolution that actually worked becomes an L0 binding, so the same
    // motion costs nothing next time. Without this the annealing the whole design rests on never
    // happens - a smoke test on real Chrome showed the second run of an identical motion still paying
    // for a model call, because only scripts and repairs were writing bindings.
    let promoted = false;
    if (tier === 'L1' && typeof resolution.confidence === 'number'
        && resolution.confidence >= promoteFloor) {
      bindings.remember(site, command.target, entry, { confidence: resolution.confidence, source: 'jev' });
      promoted = true;
    }

    return { status: 'done', tier, entry, result, confidence: resolution.confidence ?? null,
             resolution: resolution.resolution ?? null,
             repaired: resolution.repaired ?? undefined,
             promoted: promoted || undefined };
  }

  return { run, resolve, net, index: getIndex };
}
