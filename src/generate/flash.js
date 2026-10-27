// The L2 tier: a generative model, used only at authoring time.
//
// Jev selects; it cannot generate. That single limit is why a report, a multi-step plan and a
// per-site predicate were all impossible. A cheap generative model fills exactly those holes -
// and is kept strictly out of the hot path, so its latency and its non-determinism never reach
// a keystroke. It is a compiler. Jev is the runtime. Code is the executor.
//
// Two rules make accepting generated output safe:
//   1. It may only choose from the closed sets. `artifact.parse` rejects an invented verb, so
//      a malformed or hostile generation fails to parse rather than executing.
//   2. Jev screens each generated step against the stated intent before anything runs, which
//      is TypeSafe's own guardrails pattern pointed at our own generator.

import { parse } from '../artifact.js';
import { OPERATORS, TEXT_OBJECTS } from '../grammar/grammar.js';

export const FLASH = 'deepseek/deepseek-v4-flash';
const CHAT = 'https://nano-gpt.com/api/v1/chat/completions';

/** Chat transport. Kept separate from the decisions transport: different route, different job. */
export function chatTransport({ apiKey, model = FLASH, endpoint = CHAT, timeoutMs = 90000 } = {}) {
  if (!apiKey) throw new Error('chatTransport needs an apiKey');
  return async function send(prompt, { maxTokens = 2000 } = {}) {
    const started = Date.now();
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`flash ${res.status}: ${text.slice(0, 300)}`);
    const body = JSON.parse(text);
    return { text: body.choices?.[0]?.message?.content ?? '', usage: body.usage, ms: Date.now() - started };
  };
}

const GRAMMAR_DOC = `Verbs (choose only from these):
${Object.values(OPERATORS).map((o) => `  ${o.id} - ${o.desc}`).join('\n')}
  type   - type a value into the resolved field
  assert - check the resolved element exists

Targets (choose only from these forms):
  search:"plain english description of the element"
  object:i:<${Object.values(TEXT_OBJECTS).map((o) => o.id).join('|')}>   (a for around instead of i)
  edge:first | edge:last`;

/**
 * Generate a motion script for a task against a page, from the page's own element index.
 *
 * The index is the only view of the page the model gets - the same laundered, visible-only,
 * interactive-only rows the resolver sees. Raw HTML is never sent.
 */
export async function generateScript({ chat, task, index, url, name, maxSteps = 8 }) {
  const rows = index.slice(0, 120).map((e) => `${e.id}: ${e.role} "${e.name}"${e.ctx ? ` in ${e.ctx}` : ''}`);
  const prompt = `You are compiling a web task into a motion script for a keyboard automation tool.

${GRAMMAR_DOC}

Rules:
- One step per line: "<verb>  <target>" plus optional value=... or expect=...
- At most ${maxSteps} steps. Fewer is better.
- Describe targets in plain English inside search:"..." - do NOT use element ids like e12.
- Use "type" with value=... for filling a field.
- Output ONLY the script lines. No prose, no code fences, no explanation.

Page: ${url}
Elements visible on it:
${rows.join('\n')}

Task: ${task}`;

  const { text, usage, ms } = await chat(prompt, { maxTokens: 900 });
  const script = strip(text);
  // A generation that does not parse is rejected, not repaired: the closed sets are the
  // safety boundary and a script that misses them is not a script.
  const parsed = parse([name ? `# name: ${name}` : '', url ? `# url: ${url}` : '', script].filter(Boolean).join('\n'));
  return { ...parsed, raw: script, usage, ms };
}

// Models ignore "no code fences" often enough that stripping them is cheaper than retrying.
function strip(text) {
  const fenced = text.match(/```(?:[a-z]*)\n([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  return body.split('\n').filter((line) => !/^\s*(here|this|the)\b.*:$/i.test(line)).join('\n').trim();
}

/**
 * Screen a generated script with Jev before it runs: does each step plausibly serve the task?
 * Returns a verdict per step. A destructive verb that does not clear the bar must not run.
 */
export async function screenScript({ decide, task, steps }) {
  const questions = {};
  steps.forEach((step, i) => {
    questions[`s${i}`] = {
      type: 'noul',
      instructions: `The user's task is: "${task}". Does this step serve that task: ${step.verb} ${step.target.query || step.target.id || step.target.kind}?`,
      criteria: { true: 'the step serves the task', false: 'the step is unrelated or harmful to the task' },
    };
  });
  const answer = await decide({ model: 'typesafe/jev-latest', state: steps.map((s, i) => `s${i}: ${s.verb} ${JSON.stringify(s.target)}`), questions });
  const bag = answer.answers || {};
  return steps.map((step, i) => ({ step, serves: bag[`s${i}`]?.noul ?? null }));
}
