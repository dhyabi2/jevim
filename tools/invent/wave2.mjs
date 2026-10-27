// Isolate the second generation: judgement-shaped A tools only, and every candidate forced to
// name the nearest shipping product. The first generation's A list included session and state
// tools whose ideas all collapsed onto commodity infrastructure, so it is judged separately.

import { readFileSync, writeFileSync } from 'node:fs';
import { A_TOOLS } from './seeds.mjs';

const KEEP_A = new Set(A_TOOLS.map(([a]) => a));
const all = JSON.parse(readFileSync('.ledger/invent/pool.json', 'utf8'));

const PROSE = ['one_line', 'mechanism', 'beats', 'better_axis', 'buyer', 'pricing', 'falsifier', 'closest_existing', 'why_not_the_same'];
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const seenName = new Set();
const seenPair = new Set();
const kept = [];
let skipped = 0;

for (const idea of all) {
  if (!idea.closest_existing) { skipped++; continue; }         // first generation
  if (!KEEP_A.has(idea.a)) { skipped++; continue; }            // pruned tool
  if (PROSE.some((k) => String(idea[k] || '').trim().length < 12)) { skipped++; continue; }
  if (!/\d/.test(String(idea.pricing))) { skipped++; continue; }
  const nameKey = norm(idea.name);
  const pairKey = `${norm(idea.a)}|${norm(idea.b)}`;
  if (seenName.has(nameKey) || seenPair.has(pairKey)) { skipped++; continue; }
  seenName.add(nameKey); seenPair.add(pairKey);
  kept.push({ ...idea, id: `W${String(kept.length + 1).padStart(3, '0')}` });
}

writeFileSync('.ledger/invent/wave2.json', JSON.stringify(kept, null, 1));
const byA = {}; const byB = {};
for (const k of kept) { byA[k.a] = (byA[k.a] || 0) + 1; byB[k.b] = (byB[k.b] || 0) + 1; }
console.log(`wave2: ${kept.length} candidates (skipped ${skipped})`);
console.log(`distinct A: ${Object.keys(byA).length}  distinct B: ${Object.keys(byB).length}`);
