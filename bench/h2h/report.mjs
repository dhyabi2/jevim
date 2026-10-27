// Turn a head-to-head run directory into numbers.
//
//   node bench/h2h/report.mjs bench/out/h2h-test [--json]
//
// Every number is computed from the result.json and judge.json files on disk, nothing is typed in.
// Success rates are over ALL tasks in the split: a crash, a timeout or an unjudged run counts as a
// failure for whichever agent it happened to, so an agent cannot improve its rate by failing loudly.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { siteOf } from '../../src/agent/policy.js';

/**
 * Did the run leave the task's website? Online-Mind2Web tasks are posed against one site, and an agent
 * that answers from a different one has done a different task. The judges are not told to enforce
 * this, so it is measured here and reported alongside, never folded silently into a score.
 */
export function leftSite(result, website) {
  const home = siteOf(website);
  const urls = (result.trace || []).map((t) => t.url).filter((u) => /^https?:/.test(u || ''));
  const away = urls.filter((u) => siteOf(u) !== home);
  return { any: away.length > 0, sites: [...new Set(away.map(siteOf))] };
}

export function summarise(dir) {
  const tasks = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8'));
  const agents = ['ours', 'oursv', 'bu'].filter((a) => existsSync(join(dir, a)));
  const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);

  const out = { dir, tasks: tasks.length, agents: {} , paired: {} };
  const rows = {};
  for (const agent of agents) {
    rows[agent] = tasks.map((t) => {
      const r = read(join(dir, agent, t.task_id, 'result.json')) || {};
      const j = read(join(dir, agent, t.task_id, 'judge.json')) || {};
      const away = leftSite(r, t.website);
      return { id: t.task_id, level: t.level, lenient: j.lenient === true, strict: j.strict === true,
               offSite: away.any, offSites: away.sites,
               judged: j.lenient !== undefined && j.strict !== undefined, error: Boolean(r.error),
               seconds: r.seconds ?? null, steps: r.steps ?? null,
               tokens: r.tokens ? (r.tokens.prompt || 0) + (r.tokens.completion || 0) : null,
               promptTokens: r.tokens?.prompt ?? null };
    });
    const list = rows[agent];
    const rate = (pred, of = list) => ({ n: of.filter(pred).length, of: of.length,
                                         pct: of.length ? Math.round((1000 * of.filter(pred).length) / of.length) / 10 : 0 });
    const byLevel = {};
    const levels = [...new Set(tasks.map((t) => t.level))];
    for (const level of levels) {
      const of = list.filter((r) => r.level === level);
      byLevel[level] = { strict: rate((r) => r.strict, of), lenient: rate((r) => r.lenient, of) };
    }
    const nums = (key) => list.map((r) => r[key]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
    const pctl = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * arr.length))] : null);
    const sum = (arr) => arr.reduce((a, b) => a + b, 0);
    out.agents[agent] = {
      strict: rate((r) => r.strict),
      lenient: rate((r) => r.lenient),
      byLevel,
      // The same rates with a pass that left the task's website counted as a failure.
      strictOnSite: rate((r) => r.strict && !r.offSite),
      lenientOnSite: rate((r) => r.lenient && !r.offSite),
      leftSite: list.filter((r) => r.offSite).length,
      errors: list.filter((r) => r.error).length,
      unjudged: list.filter((r) => !r.judged).length,
      seconds: { p50: pctl(nums('seconds'), 0.5), p95: pctl(nums('seconds'), 0.95) },
      steps: { p50: pctl(nums('steps'), 0.5) },
      tokensPerTask: { p50: pctl(nums('tokens'), 0.5), mean: nums('tokens').length ? Math.round(sum(nums('tokens')) / nums('tokens').length) : null },
    };
  }

  // Paired: the same task, both agents. This is the comparison a small sample can actually support.
  for (const mine of ['ours', 'oursv']) {
    if (!rows[mine] || !rows.bu) continue;
    for (const key of ['strict', 'lenient']) {
      let onlyOurs = 0, onlyBu = 0, both = 0, neither = 0;
      rows[mine].forEach((o, i) => {
        const b = rows.bu[i][key];
        if (o[key] && b) both++; else if (o[key]) onlyOurs++; else if (b) onlyBu++; else neither++;
      });
      out.paired[mine === 'ours' ? key : `${key} (with screenshots)`] =
        { both, onlyOurs, onlyBu, neither, signTestP: signTest(onlyOurs, onlyBu) };
    }
  }
  return out;
}

/** Two-sided exact sign test on the discordant pairs. */
function signTest(a, b) {
  const n = a + b;
  if (!n) return 1;
  const k = Math.min(a, b);
  let p = 0;
  let c = 1;
  for (let i = 0; i <= k; i++) { if (i) c = (c * (n - i + 1)) / i; p += c; }
  return Math.min(1, Math.round((2 * p / 2 ** n) * 1000) / 1000);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  const s = summarise(dir);
  if (process.argv.includes('--json')) { console.log(JSON.stringify(s, null, 1)); process.exit(0); }
  console.log(`${dir}: ${s.tasks} tasks\n`);
  const show = (r) => `${String(r.n).padStart(3)}/${r.of} ${String(r.pct).padStart(5)}%`;
  for (const [agent, a] of Object.entries(s.agents)) {
    console.log({ bu: 'browser-use', ours: 'ours (text)', oursv: 'ours (text + screenshot)' }[agent]);
    console.log(`  strict  ${show(a.strict)}    lenient ${show(a.lenient)}`);
    console.log(`  on the task's site only: strict ${show(a.strictOnSite)}    lenient ${show(a.lenientOnSite)}    (left the site in ${a.leftSite} runs)`);
    for (const [level, l] of Object.entries(a.byLevel)) console.log(`    ${level.padEnd(6)} strict ${show(l.strict)}  lenient ${show(l.lenient)}`);
    console.log(`  seconds p50 ${a.seconds.p50} p95 ${a.seconds.p95} · steps p50 ${a.steps.p50} · tokens/task p50 ${a.tokensPerTask.p50} mean ${a.tokensPerTask.mean}`);
    console.log(`  errors ${a.errors} · unjudged ${a.unjudged}\n`);
  }
  for (const [key, p] of Object.entries(s.paired)) {
    console.log(`paired ${key}: both ${p.both}, only ours ${p.onlyOurs}, only browser-use ${p.onlyBu}, neither ${p.neither} (sign test p=${p.signTestP})`);
  }
}
