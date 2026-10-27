// Generate point-product inventions from the dynamically discovered axes.
//
//   NANO_API_KEY=... node tools/invent2/generate.mjs <count>
//
// Nothing about which tools or which industries appears in this file: both axes come from
// .ledger/invent2/axes.json, which discover.mjs generates. The pair cursor persists, so the same
// (tool, task) pair is never asked twice across runs - 97 x 150 is 14,550 pairs, years of daily
// runs before the space is exhausted.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const KEY = process.env.NANO_API_KEY;
if (!KEY) { console.error('set NANO_API_KEY'); process.exit(2); }
const MODEL = process.env.INVENT_MODEL || 'deepseek/deepseek-v4-flash';
const WANT = Number(process.argv[2] || 40);
// Three per call, not five: at seventeen fields an idea, five ideas in one reply truncated the
// prose fields and 13 of 30 came back malformed.
const PER_CALL = 3;
const CONCURRENCY = 8;
const DIR = '.ledger/invent2';

const RULES = `Hard rules. An idea breaking any of them is worthless, so do not emit it:

1. NEW MECHANISM. The job may already be served - in a high-demand job it certainly is, because the
   most-demanded jobs are exactly the ones Microsoft, Google and Grammarly have shipped into. What
   must be new is the METHOD. A cheaper or nicer version of what the incumbent already does FAILS.
   It passes only if the incumbent reaches the same outcome by a fundamentally different mechanism
   and yours is better because of that difference. Name the incumbent and name the difference in
   method, not in wording: if you cannot say what it does differently in one sentence, you have a
   feature request rather than an invention.
2. BETTER. It must beat the current best way of doing the task on a stated, measurable axis.
3. PAID. A named buyer with a real budget pays for it. Free tools and consumer toys fail.
4. POINT PRODUCT. It must stand alone: one buyer, one job, useful on day one. Reading an export,
   a file, a CSV or an existing API as INPUT is completely fine - every business product does that.
   What fails is depending on a PLATFORM: needing sibling features to be worth anything, only paying
   off once a suite is adopted, assuming the customer already runs another product of yours, or
   handing its output to a second system that the customer must also buy from you. The test: could a
   small team sell only this, to one department, and have a business?

5. MASS MARKET. It must be the kind of product that could sell in the top 100 best-selling business
   software products: hundreds of thousands of potential buyers, not a specialist niche. Horizontal,
   not vertical. If it only applies to one industry, one regulation, one job title or one unusual
   situation, IT FAILS - no matter how valuable it would be to those few. The test: would a company
   in almost any industry recognise this job as one they do, and want it?

Also reject: anything needing new hardware; anything needing a dataset nobody has; anything whose
only claim is "AI-powered"; anything that is a metaphor with no mechanism; anything where the model
must count or do arithmetic; anything that is plumbing rather than judgement.`;

const SHAPE = `For each task, FIRST choose your own old tool, then apply it.

Choose an old, proven, freely available tool or convention whose DESIGN is a judgement-shaped
OPERATION: it takes something in, makes a decision or a selection about it, and emits a result. Its
reach was always limited because it could only match text, position or an exact value - never
meaning. Reject anything whose essence is plumbing: storage, transport, persistence, isolation,
scheduling, parallelism, compression, packaging. Those carry no judgement.

You are not given a list and you should not expect one. Range as widely as you can - anywhere old and
proven qualifies, technical or not - and pick the tool whose design genuinely fits the task rather
than the first one that comes to mind. Name it in "tool".

Then apply that design to the task, with a language model supplying the judgement the tool never had.
The design must do real work: if the name is the only thing borrowed, it fails.

Pitch it HORIZONTALLY. Judged rejections show this is where ideas die: given a task almost every
organisation does, the idea gets narrowed to one industry or one specialist role and then fails
rule 5. So:
  - the product must work UNCHANGED for a bank, a school, a factory, a shop and a council;
  - "buyer" must be a role that exists in nearly every company: an operations manager, a team lead,
    an IT administrator, a head of support, an office manager. NOT a claims adjuster, a medical
    coder, a safety officer, a project management office, a clinical informaticist;
  - "market_breadth" must name at least four UNRELATED industries that all do this job;
  - if your idea only makes sense once you say the name of an industry, you have the wrong idea.

One entry per pair, same order as the pairs. Return JSON only:
{"ideas":[{
 "tool": "the old tool whose design you chose",
 "tool_design": "that tool's operation in one line, stated so it applies outside its original domain",
 "name": "short product name",
 "one_line": "what it is, in one sentence a buyer would repeat",
 "plain": "explain it to someone with no technical background at all, in two sentences. No jargon, no tool names, no acronyms. Say what annoying job it does for people and why that matters.",
 "who_it_helps": "the everyday description of the person it helps, no job titles",
 "mechanism": "how the tool's design maps onto the task, concretely. Name what the model decides.",
 "endpoint": "the single primary API endpoint",
 "standalone": "the one job it does alone, on day one, with nothing else installed",
 "why_not_a_module": "why this is a business by itself, not a feature of a bigger system",
 "wedge": "the first customer's first week: what they send it and what they get back",
 "beats": "the named incumbent or current practice it replaces",
 "closest_existing": "the nearest product that actually ships, named. If none, say NONE.",
 "why_not_the_same": "why that product does not already do this. Be specific or the idea fails.",
 "better_axis": "the measurable axis it wins on, with a number where possible",
 "buyer": "the job title that signs the invoice",
 "market_breadth": "roughly how many organisations worldwide do this job, and why almost any industry does it",
 "pricing": "the model and a concrete number",
 "unit_economics": "why the margin works",
 "falsifier": "the single result that would prove this idea wrong"
}]}`;

const axes = JSON.parse(readFileSync(`${DIR}/axes.json`, 'utf8'));

// Demand is a property of the TASK, not of the idea, so it is filtered here rather than judged
// later. Four rounds of asking a judge "is this mass market?" accepted nothing out of ~250; the
// tasks themselves were the constraint. Only the high-demand end of the axis is used.
const DEMAND_FLOOR = Number(process.env.DEMAND_FLOOR || 70);
const ranked = [...axes.tasks]
  .filter((t) => (t.demand ?? 0) >= DEMAND_FLOOR)
  .sort((a, b) => (b.demand ?? 0) - (a.demand ?? 0));
if (!ranked.length) {
  console.error(`no task scores at or above ${DEMAND_FLOOR}; run discover.mjs or lower DEMAND_FLOOR`);
  process.exit(3);
}
axes.tasks = ranked;
console.error(`drawing from ${ranked.length} tasks at demand >= ${DEMAND_FLOOR}`);
const CURSOR = `${DIR}/cursor.json`;
const LOCK = `${DIR}/cursor.lock`;
mkdirSync(DIR, { recursive: true });

/**
 * Atomically reserve `n` pairs and return the first.
 *
 * Five generators run in parallel and all five read the cursor at startup, so the first attempt
 * produced 33 distinct pairs from five runs of 45. An exclusive-create lock file makes the
 * read-modify-write indivisible, so each shard gets its own range.
 */
async function claim(n) {
  for (let attempt = 0; attempt < 400; attempt++) {
    try {
      closeSync(openSync(LOCK, 'wx'));
      try {
        const at = existsSync(CURSOR) ? JSON.parse(readFileSync(CURSOR, 'utf8')).next : 0;
        writeFileSync(CURSOR, JSON.stringify({ next: at + n }));
        return at;
      } finally { unlinkSync(LOCK); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await new Promise((r) => setTimeout(r, 25 + Math.random() * 50));
    }
  }
  throw new Error('could not claim a cursor range');
}

// A stride coprime to the task count so consecutive runs sweep the list rather than walking it in
// order and spending days in one corner of it.
const STRIDE = 37;
const taskAt = (p) => axes.tasks[(p * STRIDE) % axes.tasks.length];

/**
 * Tools already used by something published, computed from the live file.
 *
 * There is no list of old tools anywhere in this pipeline. Telling the model which tools to consider
 * limited it to that list; a list discovered once and cached is static too. Instead the model is
 * given the SHAPE of tool to look for and picks one, and this is the only nudge it gets: the ones
 * already spent, so it reaches for something else.
 */
function toolsAlreadyUsed() {
  try {
    const file = JSON.parse(readFileSync('web/data/inventions.json', 'utf8'));
    const held = existsSync(`${DIR}/held-below-floor.json`)
      ? JSON.parse(readFileSync(`${DIR}/held-below-floor.json`, 'utf8')) : [];
    return [...new Set([...file.inventions, ...held].map((i) => i.tool).filter(Boolean))];
  } catch { return []; }
}
const USED = toolsAlreadyUsed();

async function chat(prompt) {
  const res = await fetch('https://nano-gpt.com/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 12000, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(240000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text).choices?.[0]?.message?.content ?? '';
}

export function firstJson(text) {
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

/**
 * Recover whatever complete idea objects a reply contains, even if it was cut off mid-array.
 *
 * A truncated reply used to lose all three ideas in the batch; most of the time two were already
 * complete and only the last was half-written. Scanning for balanced objects keeps those.
 */
function salvageIdeas(text) {
  const out = [];
  let depth = 0, inStr = false, esc = false, start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
    if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const obj = JSON.parse(text.slice(start, i + 1));
          if (obj && obj.name && obj.one_line) out.push(obj);
        } catch { /* a fragment that looked balanced but was not */ }
        start = -1;
      }
    }
  }
  return out;
}

async function batch(startPair) {
  const tasks = Array.from({ length: PER_CALL }, (_, k) => taskAt(startPair + k));
  const listed = tasks.map((task, k) =>
    `${k + 1}. TASK = ${task.task} (expensive because: ${task.why_expensive}; demand ${task.demand ?? '?'}/100)`).join('\n');
  const avoid = USED.length
    ? `\n\nThese tools have already been used by published ideas. Choose different ones:\n${USED.join(', ')}`
    : '';
  let ideas = [];
  try {
    const reply = await chat(`${RULES}\n\n${SHAPE}${avoid}\n\nInvent one for each task:\n${listed}`);
    try {
      ideas = firstJson(reply).ideas || [];
    } catch {
      // Truncated. Keep the ideas that did finish rather than discarding the batch.
      ideas = salvageIdeas(reply);
      if (ideas.length) console.error(`  pairs ${startPair}+ truncated, salvaged ${ideas.length}`);
    }
    return ideas.slice(0, PER_CALL).map((idea, k) => ({
      ...idea,
      // The tool is the model's own choice now, so it is read back from the reply.
      a: idea.tool || 'unstated', a_design: idea.tool_design || '',
      b: tasks[k].task, sector: tasks[k].sector, demand_of_task: tasks[k].demand ?? null,
      pair: startPair + k, model: MODEL, generated: new Date().toISOString(),
    }));
  } catch (error) {
    console.error(`  pairs ${startPair}+ failed: ${error.message}`);
    return [];
  }
}

const batches = Math.ceil(WANT / PER_CALL);
const first = await claim(batches * PER_CALL);
const starts = Array.from({ length: batches }, (_, n) => first + n * PER_CALL);
const collected = [];
for (let i = 0; i < starts.length; i += CONCURRENCY) {
  const slice = await Promise.all(starts.slice(i, i + CONCURRENCY).map(batch));
  for (const ideas of slice) collected.push(...ideas);
  console.error(`  ...${collected.length}`);
}

// Each shard writes its own file. Appending to one shared file lost writes when two processes
// read it at the same moment; verify.mjs globs the shards instead.
const shard = `${DIR}/raw-${randomUUID().slice(0, 8)}.json`;
writeFileSync(shard, JSON.stringify(collected, null, 1));
console.error(`${collected.length} generated into ${shard} (pairs ${first}..${first + batches * PER_CALL - 1})`);
