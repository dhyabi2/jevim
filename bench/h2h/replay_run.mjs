// Replay head-to-head: record a run with each agent, then replay each with that agent's own replay.
//
//   node bench/h2h/replay_run.mjs record [--out DIR] [--parallel 4]
//   node bench/h2h/replay_run.mjs replay TAG [--out DIR]       (run again later, with a new TAG)
//   node bench/h2h/replay_run.mjs report [--out DIR]
//
// Tasks are the dev split. Ours replays its action log, each element re-found by fingerprint with no
// model; browser-use replays with Agent.load_and_rerun(skip_failures=True), matching elements by its
// own hash and xpath, and may call its LLM while doing so. Measured per replay: whether it reached the
// same final page as the recording, how many recorded actions it executed, and what it cost.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { splits } from './run.mjs';

const [mode, maybeTag] = process.argv.slice(2);
const flag = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? dflt : process.argv[i + 1]; };
const OUT = flag('out', 'bench/out/replay');
const PARALLEL = Number(flag('parallel', 4));
const PY = process.env.BU_PYTHON || join(homedir(), 'work/bu-baseline/.venv/bin/python');

const sh = (cmd, args) => new Promise((resolve) => {
  const child = spawn(cmd, args, { stdio: 'ignore', env: process.env });
  const killer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 10000).unref(); }, 20 * 60 * 1000);
  child.on('close', () => { clearTimeout(killer); resolve(); });
});

async function pool(jobs) {
  const queue = [...jobs];
  let done = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) { await job(); console.log(`  ${++done}/${jobs.length}`); }
  }));
}

/** Same page, ignoring fragments, trailing slashes and query order. */
export function samePage(a, b) {
  const norm = (u) => {
    try {
      const x = new URL(u);
      const q = [...x.searchParams.entries()].sort().map(([k, v]) => `${k}=${v}`).join('&');
      return `${x.host.replace(/^www\./, '')}${x.pathname.replace(/\/$/, '')}?${q}`;
    } catch { return u || ''; }
  };
  return Boolean(a) && norm(a) === norm(b);
}

const tasks = () => splits(JSON.parse(readFileSync('bench/data/mind2web/Online_Mind2Web.json', 'utf8'))).dev;

if (mode === 'record') {
  const jobs = [];
  for (const t of tasks()) {
    const file = join(OUT, 'tasks', `${t.task_id}.json`);
    (await import('node:fs')).mkdirSync(join(OUT, 'tasks'), { recursive: true });
    writeFileSync(file, JSON.stringify(t));
    const ours = join(OUT, 'ours', t.task_id);
    const bu = join(OUT, 'bu', t.task_id);
    if (!existsSync(join(ours, 'record.json'))) jobs.push(() => sh(process.execPath, ['bench/h2h/replay_ours.mjs', 'record', file, ours]));
    if (!existsSync(join(bu, 'record.json'))) jobs.push(() => sh(PY, ['bench/h2h/bu_replay.py', 'record', file, bu]));
  }
  console.log(`recording ${jobs.length} runs`);
  await pool(jobs);
} else if (mode === 'replay') {
  const tag = maybeTag;
  const jobs = [];
  for (const agent of ['ours', 'bu']) {
    for (const id of readdirSync(join(OUT, agent))) {
      const dir = join(OUT, agent, id);
      if (!existsSync(join(dir, 'record.json')) || existsSync(join(dir, `replay-${tag}.json`))) continue;
      jobs.push(agent === 'ours'
        ? () => sh(process.execPath, ['bench/h2h/replay_ours.mjs', 'replay', dir, tag])
        : () => sh(PY, ['bench/h2h/bu_replay.py', 'replay', dir, tag]));
    }
  }
  console.log(`replaying ${jobs.length} runs as "${tag}"`);
  await pool(jobs);
} else {
  const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
  for (const agent of ['ours', 'bu']) {
    if (!existsSync(join(OUT, agent))) continue;
    const ids = readdirSync(join(OUT, agent));
    const records = ids.map((id) => ({ id, rec: read(join(OUT, agent, id, 'record.json')) }))
      .filter((r) => r.rec && !r.rec.error && r.rec.final_url && (r.rec.actions || 0) > 0);
    const tags = [...new Set(ids.flatMap((id) => readdirSync(join(OUT, agent, id))
      .filter((f) => f.startsWith('replay-')).map((f) => f.slice(7, -5))))].sort();
    console.log(`\n${agent === 'bu' ? 'browser-use' : 'ours'}: ${records.length} usable recordings`);
    for (const tag of tags) {
      const rows = records.map(({ id, rec }) => ({ rec, rep: read(join(OUT, agent, id, `replay-${tag}.json`)) })).filter((r) => r.rep);
      const same = rows.filter((r) => samePage(r.rep.final_url, r.rec.final_url)).length;
      const calls = rows.reduce((n, r) => n + (r.rep.llm?.calls || 0), 0);
      const tokens = rows.reduce((n, r) => n + (r.rep.llm?.prompt_tokens || 0) + (r.rep.llm?.completion_tokens || 0), 0);
      const recTokens = rows.reduce((n, r) => n + (r.rec.llm?.prompt_tokens || 0) + (r.rec.llm?.completion_tokens || 0), 0);
      const secs = rows.map((r) => r.rep.seconds).filter(Number.isFinite).sort((x, y) => x - y);
      const failedActions = rows.reduce((n, r) => n + (agent === 'ours' ? (r.rep.unresolved || 0) + (r.rep.failed || 0) : (r.rep.errored || 0)), 0);
      const crashed = rows.filter((r) => r.rep.error).length;
      console.log(`  replay "${tag}": ${rows.length} replays · same final page ${same}/${rows.length} · ` +
        `actions that failed or could not be found ${failedActions} · crashed ${crashed} · ` +
        `LLM calls ${calls} (${tokens} tokens, recording used ${recTokens}) · seconds p50 ${secs[Math.floor(secs.length / 2)] ?? '-'}`);
    }
  }
}
