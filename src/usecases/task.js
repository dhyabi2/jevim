// Multi-step, compiled to an artifact.
//
// browser-use plans every run: a model decides each step, every time, so the same task takes a
// different path on Tuesday than it took on Monday. That is the right design for open-ended browsing
// and the wrong one for anything audited or run in CI.
//
// Here a plan is generated ONCE, executed under the gate, and written out as a fingerprint-pinned
// script. Every run after the first is pure replay: no model, no network, identical trace. The
// artifact is the deliverable - reviewable text a person can read and diff.
//
// The division of labour is the one the whole project rests on. Generation proposes the sequence,
// because only a generative model can. Jev grounds each step's target, because it selects rather than
// invents. Code executes, gates and replays, because it is free and deterministic.

import { format, isPinned } from '../artifact.js';
import { run as runScript } from './script.js';

/**
 * Compile a described task into a pinned script by executing it once.
 *
 * `plan` is the generated step list. Each step is executed through the runner, so the gate, the
 * confidence floors, the refusals and repair all apply exactly as they do to a hand-written script -
 * a generated step gets no more trust than a typed one.
 *
 * Returns the artifact and an honest account of what happened, including the steps that did not run.
 */
export async function compile({ session, task, plan, values = {}, screen = null }) {
  const script = { meta: { name: task, url: session.page ? session.page.url : undefined }, steps: plan };

  // A generated step carrying a destructive verb is never executed unreviewed. The screen is Jev
  // checking the generator's work: the model that writes is not the model that approves.
  let screened = null;
  if (screen) {
    screened = await screen(plan);
    const unbacked = screened
      .map((verdict, i) => ({ verdict, step: plan[i] }))
      .filter(({ verdict, step }) => step && ['dismiss', 'change'].includes(step.verb)
        && verdict !== null && verdict < 0.5);
    if (unbacked.length) {
      return {
        compiled: false,
        reason: `${unbacked.length} destructive step(s) were not backed by the screen and need review`,
        needsReview: unbacked.map(({ step }) => step.verb),
        script: format(script),
        screen: screened,
      };
    }
  }

  const outcome = await runScript({ session, script, values, pin: true });

  return {
    compiled: outcome.passed,
    ranSteps: outcome.steps.length,
    plannedSteps: plan.length,
    failedAt: outcome.failedAt,
    failure: outcome.failure,
    // A partially compiled artifact is still written out: the pinned prefix is worth keeping, and
    // hiding it would make the failure harder to diagnose than it needs to be.
    script: outcome.script,
    pinned: isPinned(script),
    networkCalls: outcome.networkCalls,
    repairs: outcome.steps.filter((s) => s.repaired).length,
    screen: screened,
  };
}

/**
 * Replay a compiled artifact. This is the path that runs every time after the first, and the one the
 * determinism claim is about: a fully pinned script makes no model call at all.
 */
export async function replay({ session, script, values = {} }) {
  const before = session.runner.net.calls;
  const outcome = await runScript({ session, script, values, pin: false });
  return {
    passed: outcome.passed,
    steps: outcome.steps,
    failedAt: outcome.failedAt,
    failure: outcome.failure,
    networkCalls: session.runner.net.calls - before,
    deterministic: session.runner.net.calls - before === 0,
  };
}
