// Head-to-head on Online-Mind2Web: our agent against open-source browser-use, same model, same tasks,
// same blind judge.
//
//   NANO_API_KEY=... node bench/h2h/run.mjs --split dev|test [--agents ours,bu] [--parallel 4] [--out DIR]
//
// The split is fixed and seeded. `dev` (20 tasks) is the only set our agent may be tuned on; `test`
// (60 tasks, disjoint from dev, stratified by difficulty) is run once per agent for the reported
// numbers. Tuning on the set you report is how a benchmark stops meaning anything.
//
// Results land in DIR/<agent>/<task_id>/{result.json,final.png,judge.json}. A task with a result.json
// is skipped, so an interrupted run resumes. `bench/h2h/report.mjs DIR` turns the directory into numbers.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { judge } from './judge.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) =>
  (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const SPLIT = args.split || 'dev';
const AGENTS = (args.agents || 'ours,bu').split(',');
const PARALLEL = Number(args.parallel || 4);
const OUT = args.out || `bench/out/h2h-${SPLIT}`;
const BU_PYTHON = process.env.BU_PYTHON || join(homedir(), 'work/bu-baseline/.venv/bin/python');

export function splits(tasks) {
  // A seeded shuffle, so the split is the same on every machine and every run.
  let seed = 20260927;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const byLevel = { easy: [], medium: [], hard: [] };
  for (const t of [...tasks].sort((a, b) => a.task_id.localeCompare(b.task_id))) byLevel[t.level]?.push(t);
  for (const list of Object.values(byLevel)) {
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  }
  const take = (list, from, n) => list.slice(from, from + n);
  // dev: 7 easy, 7 medium, 6 hard. test: 20 of each, taken after the dev tasks.
  const dev = [...take(byLevel.easy, 0, 7), ...take(byLevel.medium, 0, 7), ...take(byLevel.hard, 0, 6)];
  const test = [...take(byLevel.easy, 7, 20), ...take(byLevel.medium, 7, 20), ...take(byLevel.hard, 6, 20)];
  // test2: every task in neither dev nor test - the rest of the benchmark, for a second held-out run
  // large enough to separate the agents if they differ.
  const used = new Set([...dev, ...test].map((t) => t.task_id));
  const test2 = [...byLevel.easy, ...byLevel.medium, ...byLevel.hard].filter((t) => !used.has(t.task_id));
  return { dev, test, test2 };
}

/** Block until the model endpoint answers. A laptop that sleeps or changes networks mid-run is normal. */
async function waitForNetwork() {
  for (let waited = 0; ; waited += 30) {
    try {
      const res = await fetch('https://nano-gpt.com/api/v1/models', { signal: AbortSignal.timeout(10000),
        headers: { authorization: `Bearer ${process.env.NANO_API_KEY}` } });
      if (res.ok) return;
    } catch { /* offline */ }
    if (waited % 300 === 0) console.log(`network down; waiting (${waited}s so far)`);
    await new Promise((r) => setTimeout(r, 30000));
  }
}

/**
 * A run the network killed says nothing about the agent, so it is re-run rather than scored. Only an
 * outage qualifies: the model endpoint unreachable, or the start page unreachable, before the agent
 * took a real step. Anything the agent did wrong on a reachable site stays a failure.
 */
export function infrastructureFailure(r) {
  const outage = /fetch failed|Connection error|ECONNRESET|ENOTFOUND|EAI_AGAIN|site unavailable|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED/i;
  if (r.error && outage.test(r.error) && (r.steps ?? 0) <= 2) return true;
  const errors = r.errors || [];
  return !r.final && errors.length > 0 && errors.filter((e) => outage.test(String(e))).length * 2 >= errors.length;
}

/**
 * WebVoyager (He et al., 2024; Apache-2.0): 643 tasks on 15 live sites, none of them ever used here.
 * The held-out split takes 4 tasks per site with a seeded shuffle, 60 in all. Each task is mapped onto
 * the Online-Mind2Web row shape, with the site's name as its level.
 */
export function webvoyager(rows, { perSite = 4, skip = 0 } = {}) {
  let seed = 20260928;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const bySite = {};
  for (const r of [...rows].sort((a, b) => a.id.localeCompare(b.id))) (bySite[r.web_name] ||= []).push(r);
  const wv = [];
  for (const site of Object.keys(bySite).sort()) {
    const list = bySite[site];
    for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
    wv.push(...list.slice(skip, skip + perSite));
  }
  return wv.map((r) => ({ task_id: r.id.replace(/[^A-Za-z0-9_-]/g, '_'), confirmed_task: r.ques, website: r.web, level: r.web_name }));
}

function runOne(agent, task, dir) {
  mkdirSync(dir, { recursive: true });
  const taskFile = join(dir, 'task.json');
  writeFileSync(taskFile, JSON.stringify(task));
  const [cmd, argv] = agent === 'bu'
    ? [BU_PYTHON, ['bench/h2h/bu_run.py', taskFile, dir]]
    : [process.execPath, ['bench/h2h/ours_run.mjs', taskFile, dir]];
  // "oursv" is our agent with a screenshot per step: same code, one switch.
  const env = { ...process.env, H2H_VISION: agent === 'oursv' ? '1' : '0' };
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { stdio: ['ignore', 'ignore', 'pipe'], env });
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    // A hard ceiling above the agents' own timeouts, so one wedged Chrome cannot stall the batch.
    // SIGTERM first: the run's exit handler then takes its Chrome down with it. SIGKILL cannot be caught.
    const killer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10000).unref();
    }, 20 * 60 * 1000);
    child.on('close', (code) => {
      clearTimeout(killer);
      if (!existsSync(join(dir, 'result.json'))) {
        writeFileSync(join(dir, 'result.json'), JSON.stringify({ agent, task_id: task.task_id, task: task.confirmed_task,
          website: task.website, level: task.level, final: '', done: false, error: `exit ${code}: ${err.slice(-500)}` }));
      }
      resolve();
    });
  });
}

async function main() {
  const wvRows = () => readFileSync('bench/data/webvoyager/WebVoyager_data.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  // wv2: the next 7 tasks per site after the 4 that wv used, from the same seeded order - disjoint by
  // construction, and never looked at before it runs.
  const chosen = SPLIT === 'wv' ? webvoyager(wvRows())
    : SPLIT === 'wv2' ? webvoyager(wvRows(), { perSite: 7, skip: 4 })
    : splits(JSON.parse(readFileSync('bench/data/mind2web/Online_Mind2Web.json', 'utf8')))[SPLIT];
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'tasks.json'), JSON.stringify(chosen, null, 1));

  const jobs = [];
  for (const task of chosen) for (const agent of AGENTS) jobs.push({ agent, task, dir: join(OUT, agent, task.task_id) });
  const todo = jobs.filter((j) => !existsSync(join(j.dir, 'result.json')));
  console.log(`${SPLIT}: ${chosen.length} tasks x ${AGENTS.length} agents; ${todo.length} runs to do, ${PARALLEL} at a time`);

  let done = 0;
  const queue = [...todo];
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      await waitForNetwork();
      await runOne(job.agent, job.task, job.dir);
      const r = JSON.parse(readFileSync(join(job.dir, 'result.json'), 'utf8'));
      if (infrastructureFailure(r) && (job.tries = (job.tries || 0) + 1) < 3) {
        console.log(`      ${job.agent} ${job.task.task_id}: network outage, will re-run`);
        rmSync(job.dir, { recursive: true, force: true });
        queue.push(job);
        continue;
      }
      console.log(`[${++done}/${todo.length}] ${job.agent.padEnd(4)} ${job.task.level.padEnd(6)} ${String(r.seconds ?? '-').padStart(6)}s ${r.error ? 'ERROR ' + r.error.slice(0, 80) : (r.final || '').slice(0, 70).replace(/\n/g, ' ')}`);
    }
  }));

  // Judge after every agent has run, so judging never competes with the agents for the model endpoint.
  const unjudged = jobs.filter((j) => !existsSync(join(j.dir, 'judge.json')));
  const jqueue = [...unjudged];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let job = jqueue.shift(); job; job = jqueue.shift()) {
      await waitForNetwork();
      try { await judge(job.dir); } catch (error) {
        console.log('judge failed', job.dir, error.message);
        if ((job.judgeTries = (job.judgeTries || 0) + 1) < 3) jqueue.push(job);
      }
    }
  }));
  console.log(`judged ${unjudged.length}; now: node bench/h2h/report.mjs ${OUT}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
