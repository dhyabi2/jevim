// Merge the accepted ideas into the published file, newest first.
//
//   node tools/invent2/publish.mjs
//
// The published file IS the registry the novelty guard reads, so publishing and deduplicating can
// never disagree. Ids are permanent once assigned: a reader who bookmarks #idea-41 keeps it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const DIR = '.ledger/invent2';
const OUT = 'web/data/inventions.json';

const accepted = existsSync(`${DIR}/accepted.json`) ? JSON.parse(readFileSync(`${DIR}/accepted.json`, 'utf8')) : [];

// Rule 5 has to be enforced on the IDEA, not only on the task it came from.
// Generating from a task scored 70+ does not keep the idea broad: the first two survivors came from
// tasks at 70+ and then narrowed to project management offices and formal ethics teams, scoring 45
// and 35. A task everyone does can still produce a product only specialists want.
const PUBLISH_FLOOR = Number(process.env.PUBLISH_FLOOR || 60);
const current = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { inventions: [], runs: [] };
const inventions = current.inventions || [];

const nextId = inventions.reduce((max, i) => Math.max(max, i.id || 0), 0) + 1;
const today = new Date().toISOString();

// Only the fields a reader needs. The full record stays in the ledger; the published file is what
// ships to a browser, so it carries no internal scoring or prompt text.
const fresh = accepted.map((idea, k) => ({
  id: nextId + k,
  published: today,
  name: idea.name,
  plain: idea.plain,
  who_it_helps: idea.who_it_helps,
  one_line: idea.one_line,
  sector: idea.sector,
  tool: idea.a,
  tool_design: idea.a_design,
  task: idea.b,
  how_it_works: idea.mechanism,
  works_alone: idea.standalone,
  instead_of: idea.beats,
  closest_today: idea.closest_existing,
  different_because: idea.why_not_the_same,
  better_at: idea.better_axis,
  who_pays: idea.buyer,
  price: idea.pricing,
  first_week: idea.wedge,
  wrong_if: idea.falsifier,
  checked: idea.checked || 'model',
}));

// Fresh entries have no rating yet - rate.mjs runs next - so the floor is applied to everything
// that already has one. An idea that scores below it is moved to the holding file rather than
// deleted: it passed the product rules and only failed on breadth, which is a judgement that could
// change if the floor changes.
const all = [...fresh, ...inventions];
const publishable = all.filter((i) => typeof i.rating !== 'number' || i.rating >= PUBLISH_FLOOR);
const held = all.filter((i) => typeof i.rating === 'number' && i.rating < PUBLISH_FLOOR);
if (held.length) {
  const path = `${DIR}/held-below-floor.json`;
  const prior = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  const names = new Set(prior.map((x) => x.name));
  writeFileSync(path, JSON.stringify([...prior, ...held.filter((h) => !names.has(h.name))], null, 1));
}

const merged = { inventions: publishable.sort((a, b) => b.id - a.id),
                 runs: [{ at: today, added: fresh.length, held: held.length }, ...(current.runs || [])].slice(0, 120) };
merged.total = merged.inventions.length;
merged.updated = today;

writeFileSync(OUT, JSON.stringify(merged, null, 1));
console.log(`published +${fresh.length}, total ${merged.total}`);
