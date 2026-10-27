// Structural gate before human judgement. It rejects only things that are checkable without
// taste: a missing field, no price, a duplicate. Whether an idea is NEW, BETTER and PAID is a
// judgement and is made by hand afterwards - this just stops me reading 160 items to find the
// 20 that never filled in a buyer.

import { readFileSync, writeFileSync } from 'node:fs';

// Short names are real: vim, sed, awk, jq, dd, at. Only the prose fields get a length floor.
const PRESENT = ['name', 'a', 'b'];
const PROSE = ['one_line', 'mechanism', 'beats', 'better_axis', 'buyer', 'pricing', 'falsifier'];
const all = JSON.parse(readFileSync('.ledger/invent/pool.json', 'utf8'));

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const seenName = new Set();
const seenPair = new Set();
const kept = [];
const dropped = [];

for (const idea of all) {
  const missing = [
    ...PRESENT.filter((k) => !String(idea[k] || '').trim()),
    ...PROSE.filter((k) => String(idea[k] || '').trim().length < 12),
  ];
  if (missing.length) { dropped.push({ idea, why: `missing ${missing.join(',')}` }); continue; }
  // A price with no number is a wish, not a pricing model.
  if (!/\d/.test(String(idea.pricing))) { dropped.push({ idea, why: 'no number in pricing' }); continue; }
  const nameKey = norm(idea.name);
  if (seenName.has(nameKey)) { dropped.push({ idea, why: 'duplicate name' }); continue; }
  const pairKey = `${norm(idea.a)}|${norm(idea.b)}`;
  if (seenPair.has(pairKey)) { dropped.push({ idea, why: 'duplicate A x B pair' }); continue; }
  seenName.add(nameKey); seenPair.add(pairKey);
  kept.push({ ...idea, id: `Z${String(kept.length + 1).padStart(3, '0')}` });
}

writeFileSync('.ledger/invent/prefiltered.json', JSON.stringify(kept, null, 1));
writeFileSync('.ledger/invent/dropped.json', JSON.stringify(dropped, null, 1));
console.log(`in ${all.length} -> kept ${kept.length}, dropped ${dropped.length}`);
const why = {};
for (const d of dropped) why[d.why] = (why[d.why] || 0) + 1;
console.log(why);
