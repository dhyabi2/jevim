// Bring the 110 hand-verified inventions into the published file.
//
//   NANO_API_KEY=... node tools/invent2/backfill.mjs
//
// They were written for me, not for a reader: "three-way set comparison over clause ASTs" means
// nothing to anyone outside this project. This asks for a plain-language version of each and keeps
// the original wording alongside it. Their `checked` stamp stays "human", because I judged them one
// at a time - which is stronger evidence than the daily automated pass and should stay visible.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const KEY = process.env.NANO_API_KEY;
if (!KEY) { console.error('set NANO_API_KEY'); process.exit(2); }
const MODEL = process.env.INVENT_MODEL || 'deepseek/deepseek-v4-flash';
const OUT = 'web/data/inventions.json';
const BATCH = 6;

const w1 = JSON.parse(readFileSync('.ledger/invent/prefiltered.json', 'utf8'));
const w2 = JSON.parse(readFileSync('.ledger/invent/wave2.json', 'utf8'));
const byId = new Map([...w1, ...w2].map((x) => [x.id, x]));
const verdicts = {};
for (const f of ['verdicts-001', 'verdicts-002', 'verdicts-003', 'verdicts-004']) {
  Object.assign(verdicts, JSON.parse(readFileSync(`.ledger/invent/${f}.json`, 'utf8')));
}
const accepted = Object.entries(verdicts).filter(([, v]) => v.v === 'accept')
  .map(([id, v]) => ({ ...byId.get(id), why: v.r })).filter((x) => x && x.name);

const SECTOR = {
  'E2E test maintenance': 'Software testing', 'browser automation and navigation': 'Software automation',
  'RPA upkeep': 'Business automation', 'SOC alert triage': 'Cyber security',
  'contract review and redlining': 'Legal', 'e-discovery review': 'Legal',
  'patent prior-art search': 'Patents', 'medical coding': 'Healthcare billing',
  'insurance claims adjudication': 'Insurance', 'financial reconciliation and close': 'Accounting',
  'invoice and AP exception handling': 'Accounting', 'credit underwriting on thin files': 'Lending',
  'KYC and AML case review': 'Financial crime',
};

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

const plain = new Map();
for (let i = 0; i < accepted.length; i += BATCH) {
  const slice = accepted.slice(i, i + BATCH);
  const listed = slice.map((x, k) => `${k}. ${x.name}: ${x.one_line} (it replaces: ${x.beats})`).join('\n');
  const prompt = `Rewrite each of these product ideas for someone with no technical background and no
industry knowledge. No jargon, no acronyms, no tool names, no company names.

For each: "plain" is two short sentences saying what boring job it does for people and why anyone
should care. "who_it_helps" is an everyday description of the person it helps, with no job titles -
for example "people who check hospital paperwork" rather than "revenue cycle director".

Return JSON only: {"items":[{"id":0,"plain":"...","who_it_helps":"..."}]}

${listed}`;
  try {
    const out = firstJson(await chat(prompt));
    for (const item of out.items || []) {
      const idea = slice[item.id];
      if (idea && item.plain) plain.set(idea.name, item);
    }
  } catch (error) {
    console.error(`  batch ${i} failed: ${error.message}`);
  }
  console.error(`  ...${plain.size}/${accepted.length}`);
}

const current = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { inventions: [], runs: [] };
const existing = current.inventions || [];
const haveNames = new Set(existing.map((x) => String(x.name).toLowerCase()));
let nextId = existing.reduce((m, x) => Math.max(m, x.id || 0), 0) + 1;
const stamp = new Date().toISOString();

const added = accepted.filter((x) => !haveNames.has(x.name.toLowerCase())).map((x) => {
  const p = plain.get(x.name) || {};
  return {
    id: nextId++, published: stamp, name: x.name,
    plain: p.plain || x.one_line, who_it_helps: p.who_it_helps || '',
    one_line: x.one_line, sector: SECTOR[x.b] || x.b, tool: x.a, task: x.b,
    how_it_works: x.mechanism, works_alone: x.standalone || '',
    instead_of: x.beats, closest_today: x.closest_existing || 'not stated',
    different_because: x.why_not_the_same || '', better_at: x.better_axis,
    who_pays: x.buyer, price: x.pricing, first_week: x.wedge || '',
    wrong_if: x.falsifier, checked: 'human', check_note: x.why,
  };
});

const merged = { inventions: [...added, ...existing].sort((a, b) => b.id - a.id),
                 runs: [{ at: stamp, added: added.length, note: 'backfill of hand-verified set' },
                        ...(current.runs || [])] };
merged.total = merged.inventions.length;
merged.updated = stamp;
writeFileSync(OUT, JSON.stringify(merged, null, 1));
console.log(`backfilled ${added.length}, plain-language for ${plain.size}, total ${merged.total}`);
