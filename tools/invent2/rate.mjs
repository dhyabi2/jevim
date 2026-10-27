// Score how widely needed each idea is, so the list can lead with the ones that matter to the most
// people rather than merely the newest.
//
//   NANO_API_KEY=... node tools/invent2/rate.mjs
//
// The score is an ESTIMATE of demand breadth: how many organisations do this job, how often, and
// how much they already spend doing it by hand. It is not usage data and the site says so - nobody
// is using these yet, they are ideas. Only unrated entries are scored, so reruns are cheap and a
// score never silently changes once published.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const KEY = process.env.NANO_API_KEY;
if (!KEY) { console.error('set NANO_API_KEY'); process.exit(2); }
const MODEL = process.env.INVENT_MODEL || 'deepseek/deepseek-v4-flash';
const OUT = 'web/data/inventions.json';
const BATCH = 5;

const SCALE = `Score each idea 0-100 for HOW WIDELY NEEDED it is. Judge only demand, never quality:

  90-100  almost every medium or large organisation does this job, every day, and pays people for it
  70-89   most organisations in several large industries do it regularly
  50-69   common across one large industry, or occasional across many
  30-49   a specialist job done by a minority of organisations
  10-29   niche: a small number of organisations, or rarely
  0-9     almost nobody actually does this

Anchor on three things: how many organisations do the job at all, how often they do it, and how much
they already spend doing it by hand. A job that is rare but enormously expensive each time scores
mid, not high - the scale measures breadth, not value per instance.

Also give "demand" - one short sentence, no jargon, saying who does this job and how often, that a
non-technical reader would understand.

Return JSON only: {"scores":[{"id":<the id given>,"rating":<0-100>,"demand":"..."}]}`;

async function chat(prompt) {
  const res = await fetch('https://nano-gpt.com/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 140)}`);
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
  throw new Error('unbalanced');
}

const file = JSON.parse(readFileSync(OUT, 'utf8'));
const todo = file.inventions.filter((i) => typeof i.rating !== 'number');
console.error(`${todo.length} of ${file.inventions.length} need a score`);

let done = 0;
for (let i = 0; i < todo.length; i += BATCH) {
  const slice = todo.slice(i, i + BATCH);
  const listed = slice.map((x) => `id ${x.id}: ${x.name} — the job it replaces: ${x.task}. Who pays: ${x.who_pays}.`).join('\n');
  try {
    const out = firstJson(await chat(`${SCALE}\n\n${listed}`));
    for (const s of out.scores || []) {
      const idea = file.inventions.find((x) => x.id === s.id);
      if (!idea) continue;
      idea.rating = Math.max(0, Math.min(100, Math.round(Number(s.rating) || 0)));
      idea.demand = String(s.demand || '').trim();
      done++;
    }
  } catch (error) {
    console.error(`  batch ${i} failed: ${error.message}`);
  }
  console.error(`  ...${done}/${todo.length}`);
}

// Unscored entries are left WITHOUT a rating rather than defaulted to zero: writing a zero would
// make them look scored and stop the next run from retrying them. The app sorts them last.
const unscored = file.inventions.filter((i) => typeof i.rating !== 'number').length;
if (unscored) console.error(`${unscored} still unscored; rerun to pick them up`);

// Scoring happens after publishing, so this is where a freshly scored idea meets the demand floor.
const FLOOR = Number(process.env.PUBLISH_FLOOR || 60);
const below = file.inventions.filter((i) => typeof i.rating === 'number' && i.rating < FLOOR);
if (below.length) {
  const path = '.ledger/invent2/held-below-floor.json';
  const prior = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  const names = new Set(prior.map((x) => x.name));
  writeFileSync(path, JSON.stringify([...prior, ...below.filter((b) => !names.has(b.name))], null, 1));
  file.inventions = file.inventions.filter((i) => !below.includes(i));
  console.error(`held ${below.length} below demand ${FLOOR}`);
}

file.inventions.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1) || b.id - a.id);
file.total = file.inventions.length;
file.updated = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(file, null, 1));
const rated = file.inventions.filter((x) => typeof x.rating === 'number');
const avg = rated.length ? (rated.reduce((s, x) => s + x.rating, 0) / rated.length).toFixed(1) : '0';
console.log(`scored ${done}, average ${avg}, top: ${file.inventions.slice(0, 3).map((x) => `${x.name} ${x.rating}`).join(', ')}`);
