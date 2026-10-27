// Bind-time repair: fix the one broken step, never the plan.
//
// An agent that meets a changed page re-plans the whole task. A recorded script simply breaks. The
// mechanism here is the one the brainstorm converged on at practicality 95 after the exclusion pass,
// and it is deliberately narrow: when the gate refuses a step because the element moved or was
// renamed, take the stored fingerprint's own parts, pull only the candidates from the CURRENT index
// that share the stored ROLE, and ask one Choice which of those is the same thing. Rebind that step
// and resume. One call, on the one step that failed.
//
// Two constraints carried straight from the brainstorm, because they are what keep it safe:
//
//   - A repair that changes the role is not a repair. A button does not become a link. This is the
//     mitigation for the gap the engine named against its own answer: a positional or ordinal step
//     can otherwise draw a structurally similar but semantically wrong candidate at high confidence.
//   - It must clear a confidence floor, and the floor is higher than a fresh resolution's. Guessing
//     at a replacement for something the user already bound is a larger claim than resolving a fresh
//     motion, so it needs more evidence, not less.

import { NONE } from './questions.js';

/** Repairs are held to a higher bar than fresh resolutions. */
export const REPAIR_FLOOR = 0.7;

export function createRepair({ decide, model = 'typesafe/jev-latest', floor = REPAIR_FLOOR, max = 25 } = {}) {
  if (!decide) throw new Error('createRepair needs a decide transport');

  /**
   * @param stale the index entry that failed the gate, carrying role, name, anc and fp
   * @param index the current index
   * @returns `{ fp, confidence, from }` or `{ abstained: true, reason }`
   */
  return async function repair(stale, index) {
    // Same role only. This is the whole safety constraint.
    const candidates = index
      .filter((e) => e.role === stale.role && e.fp !== stale.fp)
      .slice(0, max);

    if (!candidates.length) {
      return { abstained: true, reason: `nothing of role "${stale.role}" left on the page` };
    }

    const criteria = Object.fromEntries(candidates.map((e) => [e.id,
      `${e.role} "${e.name || '(unnamed)'}"${e.ctx ? ` in ${e.ctx}` : ''}`]));
    criteria[NONE] = 'None of these is the same element under a new name or position.';

    let answer;
    try {
      answer = await decide({
        model,
        state: candidates.map((e) => `${e.id}: ${e.role} "${e.name}"${e.ctx ? ` in ${e.ctx}` : ''}`),
        questions: {
          same: {
            type: 'choice',
            instructions: `A step used to act on the ${stale.role} "${stale.name}"${stale.ctx ? ` in ${stale.ctx}` : ''}. That element is gone. Which of these is the same element, renamed or moved?`,
            criteria,
          },
        },
      });
    } catch (error) {
      // A failed repair must degrade to the stale failure, never to an action.
      return { abstained: true, reason: `repair unavailable: ${error.message}` };
    }

    const picked = (answer.answers || {}).same;
    if (!picked) return { abstained: true, reason: 'no verdict on the repair' };
    if (picked.choice === NONE) {
      return { abstained: true, reason: `no element on the page is the old "${stale.name}"` };
    }
    if (typeof picked.confidence === 'number' && picked.confidence < floor) {
      return { abstained: true,
               reason: `repair confidence ${picked.confidence.toFixed(2)} below the repair floor of ${floor}` };
    }
    const chosen = candidates.find((e) => e.id === picked.choice);
    if (!chosen) return { abstained: true, reason: `repair named an id that is not a candidate` };
    if (chosen.role !== stale.role) {
      return { abstained: true, reason: 'a repair that changes the role is not a repair' };
    }
    return { fp: chosen.fp, confidence: picked.confidence, from: stale.fp,
             name: chosen.name, candidates: candidates.length };
  };
}
