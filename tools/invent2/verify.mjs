// Automated verification, for the days nobody is watching.
//
//   NANO_API_KEY=... node tools/invent2/verify.mjs
//
// A daily unattended run cannot wait for me to judge 40 ideas by hand, so a second model applies
// the same four rules. It is deliberately a DIFFERENT model from the generator: a model grading its
// own output approves nearly everything, which is the first lesson in this project's ledger.
//
// Everything published is stamped `checked: "model"`, never "human". The app says so. An automated
// pass is weaker evidence than a hand pass and the label should not pretend otherwise.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { screen } from './novelty.mjs';

const KEY = process.env.NANO_API_KEY;
if (!KEY) { console.error('set NANO_API_KEY'); process.exit(2); }
const JUDGE = process.env.VERIFY_MODEL || 'deepseek/deepseek-v4-pro';
const DIR = '.ledger/invent2';
const PUBLISHED = 'web/data/inventions.json';

const CRITERIA = `You are a hostile reviewer of product ideas. Reject by default; accept only what
survives all four rules. Being wrong in the accepting direction is much worse than being wrong in
the rejecting direction.

1. NEW MECHANISM. In a high-demand job the category is already served; that is expected and is NOT
   by itself a rejection. What must be new is the METHOD. Reject if this is only a cheaper, faster
   or better-worded version of what the incumbent already does, or if the stated difference is a
   difference in description rather than in mechanism. Accept if the incumbent reaches the same
   outcome by a fundamentally different method and this one is better because of that. A feature
   existing inside a big platform is not a rejection on its own - judge whether that platform does
   it THIS WAY. Be alert to false novelty claims: if the description contradicts the claimed
   difference, reject.
2. BETTER. It must beat current practice on a stated axis that someone could measure. A vague
   "faster and more accurate" is a reject.
3. PAID. A named buyer with a real budget. If the buyer is a developer wanting convenience, or the
   value is documentation or internal tidiness, reject.
4. POINT PRODUCT. It must stand alone: one buyer, one job, useful on day one. Consuming an export,
   a file, a CSV or an existing API as INPUT is FINE and is not a failure - every business product
   reads data from a system of record, and rejecting for that would reject every real product. What
   fails is PLATFORM dependence: it needs sibling features to be worth anything, it only pays off
   after a suite is adopted, it assumes the customer already runs another product from the same
   vendor, or its output is useless unless the customer also buys a second thing from that vendor.

Also reject: plumbing with no judgement (storage, transport, persistence, isolation, scheduling,
parallelism, packaging); a metaphor where the borrowed name does no work; anything needing the model
to count or do arithmetic; anything needing hardware or a dataset nobody has.

For each idea return: {"id": <index>, "verdict": "accept" | "reject", "rule": <the rule number that
failed, or 0>, "reason": "<one specific sentence; name the product or the missing thing>"}

Do NOT judge market size here. How many organisations want it is measured separately as a number and
filtered with a threshold, because asking a judge for a yes/no on "is this mass market" rejected
everything: the honest answer is almost always "somewhere in between".

Return JSON only: {"results":[...]}`;

async function chat(prompt, maxTokens = 6000) {
  const res = await fetch('https://nano-gpt.com/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: JUDGE, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(300000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text).choices?.[0]?.message?.content ?? '';
}

/**
 * Recover the verdicts a truncated judge reply did contain.
 *
 * The generator already salvages truncated output; the verifier did not, so one cut-off reply threw
 * away a whole batch of eight ideas unjudged. Any object carrying an id and a verdict is usable.
 */
function salvageResults(text) {
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
          if (obj && typeof obj.id === 'number' && obj.verdict) out.push(obj);
        } catch { /* not a verdict */ }
        start = -1;
      }
    }
  }
  return out;
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

// Structural gate: a field the generator skipped means the idea was never really formed.
//
// Names are short by nature and must only be checked for PRESENCE. A blanket ten-character floor
// rejected 54 of 79 good candidates because their tool was "diff", "lint", "cron" or "comm" and
// their product was "StockDiff" or "GateCheck". This is the second time a length floor has thrown
// away valid short names in this project; only prose gets a length check.
const PRESENT = ['name', 'tool', 'endpoint'];
const PROSE = ['one_line', 'plain', 'mechanism', 'standalone', 'why_not_a_module', 'market_breadth',
  'beats', 'closest_existing', 'why_not_the_same', 'better_axis', 'buyer', 'pricing', 'falsifier'];

// Generators shard their output, so collect every shard.
const raw = readdirSync(DIR).filter((f) => /^raw-.*\.json$/.test(f))
  .flatMap((f) => JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8')));
const published = existsSync(PUBLISHED) ? JSON.parse(readFileSync(PUBLISHED, 'utf8')).inventions || [] : [];
const seenRaw = new Set(published.map((p) => p.pair));
const candidates = raw.filter((r) => !seenRaw.has(r.pair));

const structural = [];
const wellFormed = [];
for (const idea of candidates) {
  const missing = [
    ...PRESENT.filter((k) => !String(idea[k] || '').trim()),
    ...PROSE.filter((k) => String(idea[k] || '').trim().length < 10),
  ];
  if (missing.length || !/\d/.test(String(idea.pricing || ''))) {
    structural.push({ idea, why: `incomplete: ${missing.join(', ') || 'no number in pricing'}` });
  } else wellFormed.push(idea);
}

// Novelty before quality: no point paying a judge to grade a duplicate.
const judgeDuplicate = async (idea, nearest) => {
  try {
    const prompt = `Is this new idea the same invention as any of the existing ones? Different
wording or a different industry label does not make it different; the same mechanism solving the
same job for the same buyer does make it the same.

NEW: ${idea.name} — ${idea.one_line} — mechanism: ${idea.mechanism}

EXISTING:
${nearest.map((n, i) => `${i + 1}. ${n.name} — ${n.one_line}`).join('\n')}

Return JSON only: {"duplicate": true|false, "same_as": "name or empty", "reason": "one sentence"}`;
    return firstJson(await chat(prompt, 800));
  } catch { return null; }
};

const { fresh, rejected: dupes } = await screen(wellFormed, published, { judge: judgeDuplicate });
console.error(`candidates ${candidates.length} | malformed ${structural.length} | duplicates ${dupes.length} | to judge ${fresh.length}`);

const accepted = [];
const failed = [];
// Five per judge call, not eight: longer replies truncate.
for (let i = 0; i < fresh.length; i += 5) {
  const slice = fresh.slice(i, i + 5);
  const listed = slice.map((idea, k) => `IDEA ${k}
name: ${idea.name}
one line: ${idea.one_line}
mechanism: ${idea.mechanism}
stands alone: ${idea.standalone}
not a module because: ${idea.why_not_a_module}
replaces: ${idea.beats}
closest existing: ${idea.closest_existing} — difference claimed: ${idea.why_not_the_same}
wins on: ${idea.better_axis}
buyer: ${idea.buyer} — price: ${idea.pricing}`).join('\n\n');
  try {
    const reply = await chat(`${CRITERIA}\n\n${listed}`);
    let results;
    try { results = firstJson(reply).results || []; }
    catch {
      results = salvageResults(reply);
      console.error(`  judge batch ${i} truncated, salvaged ${results.length} of ${slice.length}`);
    }
    for (const r of results) {
      const idea = slice[r.id];
      if (!idea) continue;
      if (r.verdict === 'accept') accepted.push({ ...idea, checked: 'model', judge: JUDGE, check_note: r.reason || '' });
      else failed.push({ idea, why: `rule ${r.rule}: ${r.reason}` });
    }
  } catch (error) {
    console.error(`  judge batch ${i} failed: ${error.message}`);
  }
}

writeFileSync(`${DIR}/accepted.json`, JSON.stringify(accepted, null, 1));
writeFileSync(`${DIR}/rejected.json`, JSON.stringify([...structural, ...dupes, ...failed], null, 1));
console.log(`accepted ${accepted.length} / ${candidates.length}  (malformed ${structural.length}, duplicate ${dupes.length}, failed rules ${failed.length})`);
