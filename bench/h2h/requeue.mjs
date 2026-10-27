// Find the runs of a head-to-head that the model provider refused to serve, and queue them again.
//
//   node bench/h2h/requeue.mjs bench/out/h2h-test2            (dry run: lists what would be re-run)
//   node bench/h2h/requeue.mjs bench/out/h2h-test2 --apply    (removes them; then re-run run.mjs)
//
// A run is re-queued when any model call in it was refused for billing - HTTP 402 or 429, or an
// "insufficient balance" message - because such a run may have been degraded mid-task even when it
// finished. The same rule applies to both agents. A run killed by a machine suspend (wall-clock time far
// beyond the ceiling) is re-queued too. Judgements are removed with the run they judged; a judge.json
// that is missing is simply judged again by run.mjs.

import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Error responses only. A bare 402 or 429 matched a map coordinate, a price and a file size in answers.
const BILLING = /insufficient[ _-]?balance|\\?"status\\?":\s*4(?:02|29)\b|\b(?:HTTP|status|error|judge|flash|chat|vision chat)\s*:?\s*4(?:02|29)\b|rate_limit_exceeded|Add funds/i;
const CEILING_S = 900;

export function contaminated(result) {
  if (BILLING.test(JSON.stringify(result))) return 'billing';
  if ((result.seconds ?? 0) > CEILING_S + 120) return 'suspended';
  // The agent process died without writing its own result, so the harness wrote this one. Three
  // browser-use processes died together the moment the machine woke from a suspend.
  if (result.seconds === undefined && /^exit /.test(result.error || '')) return 'process died';
  // The start page never loaded - during a network drop - before the agent took a step. browser-use's
  // form of the same failure ("site unavailable") is already an outage in run.mjs; this is ours.
  if (/Page\.navigate timed out/.test(result.error || '') && !(result.steps > 0)) return 'start page unreachable';
  return null;
}

/** A judgement with fewer than three votes on either rubric was cut short (refused calls), not decided. */
export function partialJudgement(judge) {
  const v = judge.votes || {};
  return (v.lenient || []).length < 3 || (v.strict || []).length < 3;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  const apply = process.argv.includes('--apply');
  const hits = [];
  const rejudge = [];
  for (const agent of readdirSync(dir).filter((a) => !a.endsWith('.json'))) {
    for (const id of readdirSync(join(dir, agent))) {
      const file = join(dir, agent, id, 'result.json');
      if (!existsSync(file)) continue;
      const why = contaminated(JSON.parse(readFileSync(file, 'utf8')));
      if (why) { hits.push({ agent, id, why }); continue; }
      const jfile = join(dir, agent, id, 'judge.json');
      if (existsSync(jfile) && partialJudgement(JSON.parse(readFileSync(jfile, 'utf8')))) rejudge.push(jfile);
    }
  }
  console.log(`${rejudge.length} judgements with fewer than 3 votes to redo`);
  const count = (key) => hits.reduce((acc, h) => ({ ...acc, [h[key]]: (acc[h[key]] || 0) + 1 }), {});
  console.log(`${hits.length} runs to re-run`, count('agent'), count('why'));
  if (apply) {
    for (const h of hits) rmSync(join(dir, h.agent, h.id), { recursive: true, force: true });
    for (const f of rejudge) rmSync(f, { force: true });
    console.log('removed; now: node bench/h2h/run.mjs --split <split> --agents <agents>');
  }
}
