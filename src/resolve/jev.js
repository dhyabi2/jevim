// The L1 resolver. This is the tier that makes a motion mean something, and with Jev in the
// hot path it runs on every motion that has no binding yet — which on a page nobody has
// visited before is every motion.
//
// It never chooses the verb. The human already typed that. All this decides is which element
// the verb lands on, and whether it should land at all.

import { NONE, buildRequest, describe } from './questions.js';
import { prefilter } from './prefilter.js';

// How sure the model has to be before the verb fires, by operator. These are code's
// judgement, not the model's, and they scale with what going wrong costs.
export const FLOORS = {
  goto: 0.45,
  yank: 0.45,
  select: 0.45,
  change: 0.75,
  dismiss: 0.85,
};

/**
 * Build a resolver for `createRunner({ resolver })`.
 *
 * Returns `(target, index, command) => Promise<resolution>` where a resolution is either
 * `{ fp, confidence, ... }` or `{ abstained: true, reason, ... }`. The runner treats an
 * abstention as "do not act", which falls back to hint labels rather than guessing.
 */
export function createJevResolver({ transport, floors = FLOORS, model, max = 40 } = {}) {
  if (!transport) throw new Error('createJevResolver needs a transport');

  return async function resolve(target, index, command = { operator: 'goto', target }) {
    const { candidates, strategy } = prefilter(target, index, { max });
    const meta = { strategy, candidates: candidates.length, indexed: index.length };

    if (!candidates.length) {
      return { abstained: true, reason: 'nothing on the page to choose between', ...meta };
    }

    const request = buildRequest({ command, candidates, model });
    let answer;
    try {
      answer = await transport(request);
    } catch (error) {
      // A resolver that throws would take the keystroke down with it. Abstaining degrades to
      // hint labels, which is the behaviour the user already has without a model at all.
      return { abstained: true, reason: `resolver unavailable: ${error.message}`, ...meta };
    }

    const picked = read(answer, 'target');
    if (!picked) return { abstained: true, reason: 'no verdict for the target question', ...meta };

    const floor = floors[command.operator] ?? 0.5;
    const result = {
      ...meta,
      choice: picked.choice,
      confidence: picked.confidence ?? null,
      floor,
      pageFits: numberOf(read(answer, 'pageFits')),
      ms: answer.ms ?? null,
      usage: answer.usage ?? null,
    };

    if (picked.choice === NONE) {
      return { ...result, abstained: true, reason: `nothing matches "${describe(target)}"` };
    }
    if (result.confidence !== null && result.confidence < floor) {
      return { ...result, abstained: true,
               reason: `confidence ${result.confidence.toFixed(2)} below the ${command.operator} floor of ${floor}` };
    }

    const entry = candidates.find((c) => c.id === picked.choice);
    if (!entry) return { ...result, abstained: true, reason: `model named an id that is not a candidate: ${picked.choice}` };

    return { ...result, fp: entry.fp, id: entry.id, name: entry.name, role: entry.role };
  };
}

// Providers wrap the answers slightly differently, so read defensively rather than
// assuming one shape.
function read(answer, id) {
  const bag = answer.answers || answer.results || answer.questions || answer;
  const hit = bag && (bag[id] || (Array.isArray(bag) && bag.find((x) => x.id === id)));
  if (!hit) return null;
  return {
    choice: hit.choice ?? hit.value ?? hit.answer,
    confidence: hit.confidence ?? null,
    noul: hit.noul ?? null,
    probabilities: hit.probabilities ?? null,
  };
}

function numberOf(verdict) {
  if (!verdict) return null;
  return verdict.noul ?? (typeof verdict.choice === 'number' ? verdict.choice : null);
}
