// Judge one run, blind to which agent produced it.
//
//   NANO_API_KEY=... node bench/h2h/judge.mjs RUN_DIR [RUN_DIR ...]
//
// Two verdicts per run, from the same judge model for both agents:
//
//   lenient  browser-use's own rubric, verbatim from github.com/browser-use/online-mind2web - the one
//            behind their 97%. Like theirs, it reads the task and the final answer only.
//   strict   in the manner of Online-Mind2Web's WebJudge: the judge first lists the task's key points,
//            then checks each against the action trace, the answer and the final screenshot. An answer
//            the trace does not support fails, and so does a filter that was never applied.
//
// The judge is o4-mini, the model WebJudge itself uses, and a different family from the agents'.
// Neither prompt names the agent. Writes judge.json next to result.json.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const JUDGE = process.env.H2H_JUDGE || 'openai/o4-mini';
const CHAT = 'https://nano-gpt.com/api/v1/chat/completions';

const LENIENT = `You are an expert evaluator judging whether a web automation agent completed a task.

Judging principles:
1. Outcome over journey — Did the user get what they needed?
2. Trust extractions only when supported — Specific details count only if the action trace shows the agent reached the source.
3. Accept reasonable interpretations — Semantic equivalence, paraphrasing, and concise summaries all count.
4. "Not found" is a valid answer — A thorough search that correctly finds nothing IS task completion.
5. No output = fail — An empty or purely navigational response is a failure.
6. Wrong information = fail — Incorrect facts, wrong prices, wrong dates are failures.

Scores are binary: 0 (fail) or 100 (pass). No partial credit.`;

const STRICT = `You are an expert evaluator of web agents, following the Online-Mind2Web evaluation protocol.

First, list the KEY POINTS of the task: every explicit requirement (each filter, sort order, quantity, date,
location, option, and the final action or information requested). Then decide whether EVERY key point was
satisfied, using the action trace, the agent's final answer and the screenshot of the final page.

A task fails if:
- any key point was not applied (e.g. a filter the task names was never set, or was set to a different value),
- the agent stopped before the final requested action,
- the answer states facts that contradict the screenshot, or that are implausible for this website,
- the agent answered from general knowledge instead of from the website.
Searching thoroughly and correctly reporting that something does not exist on the site counts as success.
Agents read page content without always showing a reading step, so do not fail a run only because the trace
has no explicit extraction action; judge whether the requirements were met.`;

async function ask(content) {
  const res = await fetch(CHAT, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.NANO_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: JUDGE, max_tokens: 4000, messages: [{ role: 'user', content }] }),
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`judge ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text).choices?.[0]?.message?.content ?? '';
}

function traceText(result) {
  return (result.trace || []).map((t, i) =>
    `${i + 1}. [${t.url || ''}] ${t.action}${t.outcome ? ` -> ${t.outcome}` : ''}`).join('\n').slice(0, 12000);
}

/**
 * The two prompts, built from the task, the trace and the answer only. Nothing that identifies the
 * agent (its name, model, version, token counts) is read here, which test/h2h.test.js checks.
 */
export function lenientPrompt(result) {
  return `${LENIENT}

TASK: ${result.task}

FINAL RESULT RESPONSE:
${result.final || '(no final answer)'}

Write your verdict as:
**Score:** 0 or 100
**Reasoning:** [Step-by-step explanation]`;
}

export function strictPrompt(result, hasImage) {
  return `${STRICT}

TASK: ${result.task}
STARTING WEBSITE: ${result.website}

ACTION TRACE:
${traceText(result) || '(none)'}

AGENT'S FINAL ANSWER:
${result.final || '(no final answer)'}

${hasImage ? 'The screenshot of the final page is attached.' : 'No screenshot of the final page is available.'}

Reply in this format:
KEY POINTS: <numbered list>
ANALYSIS: <each key point: satisfied or not, with the evidence>
Status: "success" or "failure"`;
}

export async function judge(dir) {
  const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
  const shot = join(dir, 'final.png');
  const image = existsSync(shot) ? readFileSync(shot).toString('base64') : null;
  const out = { judge: JUDGE };

  // Three votes per rubric, majority wins: a single o4-mini verdict flipped between runs on the same
  // input often enough to decide a close comparison by itself.
  const votes = { lenient: [], strict: [] };
  for (let attempt = 0; attempt < 5 && votes.lenient.length < 3; attempt++) {
    try {
      const reply = await ask(lenientPrompt(result));
      const m = reply.match(/\*\*Score:\*\*\s*(\d+)/i) || reply.match(/Score:\s*(\d+)/i);
      if (m) { votes.lenient.push(Number(m[1]) >= 50); out.lenientReasoning ??= reply.slice(0, 2000); }
    } catch (error) { out.lenientError = error.message; }
  }

  for (let attempt = 0; attempt < 5 && votes.strict.length < 3; attempt++) {
    try {
      const text = strictPrompt(result, Boolean(image));
      const reply = await ask(image
        ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } }]
        : text);
      const m = reply.match(/Status:\s*"?(success|failure)"?/i);
      if (m) { votes.strict.push(m[1].toLowerCase() === 'success'); out.strictReasoning ??= reply.slice(0, 3000); }
    } catch (error) { out.strictError = error.message; }
  }

  const majority = (v) => (v.length ? v.filter(Boolean).length * 2 > v.length : undefined);
  out.lenient = majority(votes.lenient);
  out.strict = majority(votes.strict);
  out.votes = votes;

  // A verdict with no votes is an outage, not a judgement. Leave no judge.json so the run is judged again.
  if (out.lenient === undefined || out.strict === undefined) {
    throw new Error(`judge unavailable: ${out.lenientError || out.strictError || 'no parseable verdict'}`);
  }
  writeFileSync(join(dir, 'judge.json'), JSON.stringify(out, null, 1));
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const dir of process.argv.slice(2)) {
    const v = await judge(dir);
    console.log(dir, 'lenient', v.lenient, 'strict', v.strict, v.lenientError || v.strictError || '');
  }
}
