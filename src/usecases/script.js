// Running a motion script: the engine under both the testing and the workflow APIs.
//
// The two differ only in what a failure means. A test wants a verdict and treats a changed
// page as a red build. A workflow wants the work done and treats a changed page as a stop.
// Both replay the same artifact, and a fully pinned artifact replays with no model at all -
// which is what makes a CI run free and an audit trail meaningful.

import { format, isPinned } from '../artifact.js';

/**
 * Replay a script against a live session.
 *
 * `session` supplies `index`, `bindings` and `runner`. Steps are executed through the runner so
 * the atomic gate applies to every one: a step whose element moved fails as `stale` rather
 * than acting on the wrong thing.
 */
export async function run({ session, script, values = {}, pin = true }) {
  const results = [];
  const steps = script.steps;
  const startCalls = session.runner.net.calls;

  for (const [i, step] of steps.entries()) {
    const command = { count: 1, operator: verbToOperator(step.verb), target: step.target };

    // A pinned step is addressed by fingerprint, so it needs no resolution at all.
    if (step.fp) {
      // Prefer the live entry; fall back to the descriptor the script carries. Without one of the two
      // a redesigned element cannot be repaired, because the fingerprint alone describes nothing.
      const known = session.index.find((e) => e.fp === step.fp);
      session.bindings.remember(session.site, step.target, known || step.fp, {
        source: 'script',
        descriptor: known ? null : (step.role ? { role: step.role, name: step.name || '', ctx: '' } : null),
      });
    }

    let outcome;
    try {
      outcome = await session.runner.run(command, { confirmed: true });
    } catch (error) {
      outcome = { status: 'error', reason: error.message };
    }

    if (step.verb === 'type' && outcome.status === 'done') {
      const value = step.value?.startsWith('$') ? values[step.value.slice(1)] : step.value;
      outcome = { ...outcome, typed: value ?? null };
    }

    // Pin on first resolution, and RE-pin when a step was repaired: otherwise the artifact keeps the
    // dead fingerprint and pays for the same repair on every future run.
    if (pin && outcome.entry && (!step.fp || outcome.repaired)) {
      steps[i] = { ...step, fp: outcome.entry.fp, role: outcome.entry.role, name: outcome.entry.name,
                   confidence: outcome.confidence ?? undefined };
    }

    results.push({
      step: i + 1, verb: step.verb, target: step.target,
      status: outcome.status, reason: outcome.reason ?? null,
      element: outcome.entry ? { name: outcome.entry.name, role: outcome.entry.role, fingerprint: outcome.entry.fp } : null,
      tier: outcome.tier ?? null, typed: outcome.typed ?? undefined,
      repaired: outcome.repaired ?? undefined,
    });

    if (!['done', 'confirm'].includes(outcome.status)) break;
  }

  const failed = results.find((r) => r.status !== 'done');
  return {
    passed: !failed,
    steps: results,
    failedAt: failed ? failed.step : null,
    failure: failed ? { status: failed.status, reason: failed.reason } : null,
    networkCalls: session.runner.net.calls - startCalls,
    pinned: isPinned(script),
    script: format(script),
  };
}

function verbToOperator(verb) {
  if (verb === 'type') return 'change';
  if (verb === 'assert') return 'select';
  return verb;
}
