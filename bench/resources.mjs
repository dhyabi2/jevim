// How much CPU and memory one agent session costs, per browser configuration, on Linux.
//
//   node bench/resources.mjs RECORD_DIR [RECORD_DIR ...]      (inside the deployment container)
//
// Each record is a recorded agent run (bench/h2h/replay_ours.mjs record); replaying it drives the browser
// through the same live sites the agent visited, with no model calls, so every configuration does the
// same work. Chrome's whole process tree is sampled from /proc every 250 ms: peak resident memory, and
// CPU seconds used (memory is PSS, the fair share of pages the processes share). Quality is checked the same way the replay comparison checks it - how many recorded
// actions still land, and whether the run ends on the same page - so a lighter browser cannot win by
// quietly doing less.
//
// Configurations are chosen with JEVIM_RES_CONFIGS (comma-separated): full, lean, shell.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { runAgent } from '../server/agent.mjs';

const TICK = (() => { try { return 100; } catch { return 100; } })();   // USER_HZ on Linux
const PAGE_KB = 4;

const CONFIGS = {
  full: { path: process.env.CHROME_FULL || '/usr/bin/google-chrome-stable', args: '' },
  // One renderer process for everything, no per-site isolation: the agent drives one tab at a time, and
  // the container is already the isolation boundary.
  lean: { path: process.env.CHROME_FULL || '/usr/bin/google-chrome-stable',
          args: '--renderer-process-limit=2 --disable-features=site-per-process,IsolateOrigins,Translate,OptimizationHints,MediaRouter --disable-site-isolation-trials --process-per-site --autoplay-policy=user-gesture-required --js-flags=--max-old-space-size=512' },
  shell: { path: process.env.CHROME_SHELL || '', args: '' },
};

/** Every process whose command line mentions this Chrome's profile directory. */
function treeStats() {
  let rssKb = 0;
  let ticks = 0;
  let procs = 0;
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!cmd.includes('jevim-chrome-')) continue;
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      ticks += Number(stat[11]) + Number(stat[12]);           // utime + stime
      // PSS, not RSS: Chrome's processes share most of their pages, and adding up RSS counted the shared
      // ones once per process - 2.5-3 GB for one session, which is not real memory.
      const pss = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m);
      rssKb += pss ? Number(pss[1]) : Number(stat[21]) * PAGE_KB;
      procs += 1;
    } catch { /* exited while we looked */ }
  }
  return { rssMb: rssKb / 1024, cpuS: ticks / TICK, procs };
}

const samePage = (a, b) => {
  const norm = (u) => { try { const x = new URL(u); return x.host.replace(/^www\./, '') + x.pathname.replace(/\/$/, ''); } catch { return u; } };
  return Boolean(a) && norm(a) === norm(b);
};

const base = { ...process.env };
const records = process.argv.slice(2);
const wanted = (process.env.JEVIM_RES_CONFIGS || 'full,lean,shell').split(',');
const results = {};

for (const name of wanted) {
  const cfg = CONFIGS[name];
  if (!cfg.path) { console.log(`${name}: no binary configured, skipped`); continue; }
  process.env.CHROME_PATH = cfg.path;
  process.env.JEVIM_CHROME_ARGS = `${base.JEVIM_CHROME_ARGS || ''} ${cfg.args}`.trim();
  const rows = [];
  for (const dir of records) {
    const record = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
    const task = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf8'));
    let peak = 0;
    let peakProcs = 0;
    let lastCpu = 0;
    const sampler = setInterval(() => {
      const s = treeStats();
      peak = Math.max(peak, s.rssMb);
      peakProcs = Math.max(peakProcs, s.procs);
      if (s.cpuS > 0) lastCpu = s.cpuS;
    }, 250);
    const started = Date.now();
    let out = null;
    try {
      out = await runAgent({ task: task.confirmed_task, website: task.website, replay: record.log || [],
                             chat: async () => ({ text: '' }) });
    } catch (error) { out = { error: error.message }; }
    clearInterval(sampler);
    const wall = (Date.now() - started) / 1000;
    const r = out.replay || { actions: 0, executed: 0, unresolved: 0, failed: 0, skipped: 0 };
    const attempted = r.executed + r.failed + r.unresolved;
    rows.push({ task: task.task_id.slice(0, 8), peakMb: Math.round(peak), procs: peakProcs, cpuS: Math.round(lastCpu * 10) / 10,
                wall: Math.round(wall), landed: r.executed, attempted, same: samePage(out.finalUrl, record.final_url) });
    console.log(name.padEnd(6), JSON.stringify(rows.at(-1)));
  }
  const sum = (k) => rows.reduce((a, b) => a + b[k], 0);
  results[name] = {
    runs: rows.length,
    peakMbAvg: Math.round(sum('peakMb') / rows.length), peakMbMax: Math.max(...rows.map((r) => r.peakMb)),
    cpuCoresWhileRunning: Math.round((sum('cpuS') / sum('wall')) * 100) / 100,
    landed: `${sum('landed')}/${sum('attempted')}`, samePage: `${rows.filter((r) => r.same).length}/${rows.length}`,
  };
}
console.log('\nSUMMARY', JSON.stringify(results, null, 1));
process.exit(0);
