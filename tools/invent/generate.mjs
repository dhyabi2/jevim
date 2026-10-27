// Generate Z candidates from explicit (A, B) pairs.
//
//   NANO_API_KEY=... node tools/invent/generate.mjs <pairs>
//
// The pair space is enumerated with a cursor in .ledger/invent/cursor.json, so no pair is ever
// asked twice - the first version picked with a modulo formula and 65 of 160 candidates came
// back as duplicate pairs. A and B are zipped back in by index rather than trusted from the
// model's reply, which was dropping the field a fifth of the time.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { A_TOOLS, B_TASKS } from './seeds.mjs';

const KEY = process.env.NANO_API_KEY || process.env.NANO_API_KEY;
if (!KEY) { console.error('set NANO_API_KEY'); process.exit(2); }

const MODEL = process.env.INVENT_MODEL || 'deepseek/deepseek-v4-flash';
const WANT = Number(process.argv[2] || 40);
const PER_CALL = 5;
const CONCURRENCY = 8;

const RULES = `Hard rules. An idea that breaks any of them is worthless, so do not emit it:
1. NEW. Not a shipping product today. If a named vendor already sells it, it fails.
2. BETTER. It must beat the current best way of doing B on a stated, measurable axis.
3. PAID. A named buyer with a real budget pays for it. Free tools and consumer toys fail.
Also reject: anything needing new hardware; anything needing a dataset nobody has; anything
whose only claim is "AI-powered"; anything that is a metaphor with no mechanism; anything where
the model must count, do arithmetic, or be trusted with no way to say "I don't know".

Judged rejections from the last round, so do not repeat their shapes: session persistence,
sandboxing, bounded concurrency, delta file transfer, byte-exact capture and replay, polling
replaced by event subscription, priority scheduling, pipelines of steps, page-change watching,
schema extraction from a page, test impact analysis, and retiring stale records. All of those
are already shipping products or carry no judgement at all.`;

const SHAPE = `Take what made A a good DESIGN and apply that design to B, with a language model
supplying the judgement A never had. The design must do real work - if the name is the only
thing borrowed from A, it fails.

Return JSON only, one entry per pair, in the same order as the pairs:
{"ideas":[{
 "name": "short product name",
 "one_line": "what it is, in one sentence a buyer would repeat",
 "mechanism": "how A's design maps onto B, concretely. Name the API shape and what the model decides.",
 "endpoint": "primary API endpoint, e.g. POST /v1/...",
 "novel": "why this does not exist today",
 "beats": "the named incumbent or current practice it replaces",
 "closest_existing": "the nearest product that actually ships today, named. If none, say NONE.",
 "why_not_the_same": "why closest_existing does not already do this. Be specific or the idea fails.",
 "better_axis": "the measurable axis it wins on, with a number where possible",
 "buyer": "the job title that signs the invoice",
 "pricing": "the model and a concrete number",
 "unit_economics": "why the margin works",
 "falsifier": "the single result that would prove this idea wrong"
}]}`;

const CURSOR = '.ledger/invent/cursor.json';
mkdirSync('.ledger/invent', { recursive: true });
let cursor = existsSync(CURSOR) ? JSON.parse(readFileSync(CURSOR, 'utf8')).next : 0;

/** Pair p enumerates the whole A x B space exactly once. */
const pairAt = (p) => [A_TOOLS[p % A_TOOLS.length], B_TASKS[Math.floor(p / A_TOOLS.length) % B_TASKS.length]];

async function chat(prompt) {
  const res = await fetch('https://nano-gpt.com/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text).choices?.[0]?.message?.content ?? '';
}

function firstJson(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('no JSON');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('unbalanced JSON');
}

async function batch(startPair) {
  const pairs = Array.from({ length: PER_CALL }, (_, k) => pairAt(startPair + k));
  const listed = pairs.map(([[a, aDesc], [b, bDesc]], k) =>
    `${k + 1}. A = ${a} (${aDesc})\n   B = ${b} (expensive because: ${bDesc})`).join('\n');
  try {
    const out = firstJson(await chat(`${RULES}\n\n${SHAPE}\n\nInvent one Z for each pair:\n${listed}`));
    // Zip A and B back in by index: the model is not trusted to echo them.
    return (out.ideas || []).slice(0, PER_CALL).map((idea, k) => ({
      ...idea, a: pairs[k][0][0], b: pairs[k][1][0], pair: startPair + k, model: MODEL,
    }));
  } catch (error) {
    console.error(`  pairs ${startPair}+ failed: ${error.message}`);
    return [];
  }
}

const starts = [];
for (let n = 0; n < Math.ceil(WANT / PER_CALL); n++) { starts.push(cursor); cursor += PER_CALL; }

const collected = [];
for (let i = 0; i < starts.length; i += CONCURRENCY) {
  const slice = await Promise.all(starts.slice(i, i + CONCURRENCY).map(batch));
  for (const ideas of slice) collected.push(...ideas);
  console.error(`  ...${collected.length}`);
}

writeFileSync(CURSOR, JSON.stringify({ next: cursor }));
const path = '.ledger/invent/pool.json';
const prior = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
writeFileSync(path, JSON.stringify([...prior, ...collected], null, 1));
console.error(`${collected.length} new, ${prior.length + collected.length} in pool, cursor at ${cursor}`);
