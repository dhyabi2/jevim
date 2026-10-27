// Building the Jev request. One Choice over the candidate ids, plus one extra option that
// means "none of these".
//
// The sentinel is the whole abstention mechanism. Choice probabilities always sum to 1, so a
// Choice over real elements alone names a best element even on a page where nothing matches
// — and since the human has already typed the operator, a wrong target means the right verb
// fires on the wrong thing. Putting the escape hatch inside the same distribution keeps it to
// one question, one threshold and one round-trip, and it is TypeSafe's own documented shape:
// their date-extraction guidance puts an explicit "not stated" option in the Choice so a
// missing part is reported rather than guessed.
//
// A paired Noul was the obvious alternative and is deliberately not used: the jaggedness
// notes warn that a Choice and a Noul answer different questions and that a threshold tuned
// on one must not be carried to the other.

export const NONE = '__none__';

/** How an option is described to the model. Every option gets one, including the sentinel. */
export function rubric(entry) {
  const name = entry.name || '(unnamed)';
  return entry.ctx ? `${entry.role} "${name}" in ${entry.ctx}` : `${entry.role} "${name}"`;
}

function instruction(target) {
  if (target.kind === 'search') return `Which element is the user asking for when they say: "${target.query}"?`;
  if (target.kind === 'textobject') {
    const scope = target.inner ? 'inside' : 'containing';
    return `Which element is the one ${scope} the ${target.id} the user is acting on?`;
  }
  return 'Which element is the target?';
}

/**
 * Build the request body. Every sub-decision of a compound command goes in one request:
 * Jev ingests the state once and answers every question in parallel, and output tokens are
 * free, so the extra questions are close to free. One call per sub-decision would multiply
 * latency and lose the keystroke-speed claim outright.
 */
export function buildRequest({ command, candidates, model = 'typesafe/jev-latest' }) {
  const criteria = Object.fromEntries(candidates.map((entry) => [entry.id, rubric(entry)]));
  criteria[NONE] = 'No element on this page is what the user asked for.';

  const questions = {
    target: {
      type: 'choice',
      instructions: instruction(command.target),
      criteria,
    },
  };

  // A second, cheap question, recorded for logging and deliberately NEVER mixed into the
  // target threshold. Measured on a live call: a page whose Checkout link Jev chose with
  // probability 1.00 and confidence 1.00 scored only 0.20-0.24 on this Noul. Gating on it
  // would have abstained from a certain answer. That is the jaggedness warning about mixing
  // question types, observed rather than quoted.
  questions.pageFits = {
    type: 'noul',
    instructions: `Does this page contain anything matching: "${describe(command.target)}"?`,
    criteria: { true: 'something on the page matches', false: 'nothing on the page matches' },
  };

  return {
    model,
    state: candidates.map((entry) => `${entry.id}: ${rubric(entry)}`),
    questions,
  };
}

export function describe(target) {
  if (target.kind === 'search') return target.query;
  if (target.kind === 'textobject') return `${target.inner ? 'inner' : 'around'} ${target.id}`;
  return target.kind;
}
