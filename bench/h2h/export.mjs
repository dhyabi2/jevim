// Export a judged head-to-head run as one committed JSON file: the summary plus, per task and agent,
// the verdicts, the answer, the URLs visited, tokens and seconds. The run folders themselves stay out of
// git (screenshots), so this file is what keeps every reported number checkable.
//
//   node bench/h2h/export.mjs bench/out/h2h-test2 bench/results/h2h-test2.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { summarise } from './report.mjs';

const [dir, out] = process.argv.slice(2);
const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
const tasks = read(join(dir, 'tasks.json'));
const summary = summarise(dir);
const agents = Object.keys(summary.agents);

const rows = tasks.map((t) => {
  const row = { task_id: t.task_id, level: t.level, task: t.confirmed_task, website: t.website };
  for (const agent of agents) {
    const r = read(join(dir, agent, t.task_id, 'result.json')) || {};
    const j = read(join(dir, agent, t.task_id, 'judge.json')) || {};
    const tok = r.tokens || {};
    row[agent] = {
      strict: j.strict ?? null, lenient: j.lenient ?? null, votes: j.votes ?? null,
      answer: String(r.final || '').slice(0, 400), error: r.error ?? null,
      seconds: r.seconds ?? null, steps: r.steps ?? null,
      tokens: (tok.prompt || 0) + (tok.completion || 0),
      urls: [...new Set((r.trace || []).map((x) => x.url).filter((u) => /^https?:/.test(u || '')))].sort().slice(0, 12),
    };
  }
  return row;
});

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({
  summary, judge: 'openai/o4-mini, 3 votes per rubric', model: 'deepseek/deepseek-v4.1-flash',
  browser_use_version: '0.13.10', rows,
}, null, 1));
console.log(`wrote ${out}: ${rows.length} tasks, agents ${agents.join(', ')}`);
