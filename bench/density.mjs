// How many agent sessions fit on a machine: today's setup against the optimized one, same work.
//
//   JEVIM_DENSITY_MODE=baseline|optimized node bench/density.mjs RECORD_DIR ...   (inside the container)
//
// The recorded runs are replayed CONCURRENCY at a time, with THINK_MS of simulated model time before each
// action, because a live session spends most of its time waiting for the model and that is when a page
// burns CPU for nothing. Every Chrome process is sampled from /proc every 250 ms: memory is PSS summed
// over all of them (the fair share of pages Chrome's processes share), CPU is each process's last seen
// utime+stime summed over every process that existed, so processes that exit still count.
//
//   baseline   one Chrome per session, nothing blocked, the page at full speed while the model thinks
//   optimized  one shared Chrome with an isolated context per session, lean flags, ads/trackers/video
//              blocked (JEVIM_BLOCK_HEAVY), the page throttled 20x while the model thinks
//
// Quality is the replay's own measure: recorded actions that still land, and runs ending on the same page.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { runAgent } from '../server/agent.mjs';
import { connect, launch } from '../server/cdp.mjs';

const MODE = process.env.JEVIM_DENSITY_MODE || 'baseline';
const CONCURRENCY = Number(process.env.JEVIM_DENSITY_CONCURRENCY || 3);
const THINK_MS = Number(process.env.JEVIM_DENSITY_THINK_MS || 5000);
const LEAN = '--renderer-process-limit=4 --disable-features=Translate,OptimizationHints,MediaRouter --autoplay-policy=user-gesture-required --js-flags=--max-old-space-size=512';

if (MODE === 'optimized') {
  process.env.JEVIM_BLOCK_HEAVY = '1';
  process.env.JEVIM_CHROME_ARGS = `${process.env.JEVIM_CHROME_ARGS || ''} ${LEAN}`.trim();
}

const cpuByPid = new Map();
let peakPss = 0;
let peakProcs = 0;
function sample() {
  let pss = 0;
  let procs = 0;
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('jevim-chrome-')) continue;
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      cpuByPid.set(pid, (Number(stat[11]) + Number(stat[12])) / 100);
      const m = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').match(/^Pss:\s+(\d+)/m);
      pss += m ? Number(m[1]) : 0;
      procs += 1;
    } catch { /* gone */ }
  }
  peakPss = Math.max(peakPss, pss / 1024);
  peakProcs = Math.max(peakProcs, procs);
}

const samePage = (a, b) => {
  const norm = (u) => { try { const x = new URL(u); return x.host.replace(/^www\./, '') + x.pathname.replace(/\/$/, ''); } catch { return u; } };
  return Boolean(a) && norm(a) === norm(b);
};

const records = process.argv.slice(2);
const shared = MODE === 'optimized' ? await (async () => { const chrome = await launch({ headless: true }); return { chrome, cdp: await connect(chrome.endpoint) }; })() : null;
const timer = setInterval(sample, 250);
const started = Date.now();
const rows = [];
const queue = [...records];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  for (let dir = queue.shift(); dir; dir = queue.shift()) {
    const record = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
    const task = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf8'));
    let out;
    try {
      out = await runAgent({ task: task.confirmed_task, website: task.website, replay: record.log || [],
        chat: async () => ({ text: '' }), thinkMs: THINK_MS, throttleThinking: MODE === 'optimized',
        ...(shared ? { browser: { ...shared, isolate: true } } : {}) });
    } catch (error) { out = { error: error.message }; }
    const r = out.replay || { executed: 0, failed: 0, unresolved: 0 };
    rows.push({ landed: r.executed, attempted: r.executed + r.failed + r.unresolved, same: samePage(out.finalUrl, record.final_url),
                ...(out.error ? { error: String(out.error).slice(0, 120) } : {}) });
    console.log(MODE, dir.split('/').pop().slice(0, 8), JSON.stringify(rows.at(-1)));
  }
}));
clearInterval(timer);
sample();
if (shared) { shared.cdp.close(); await shared.chrome.close(); }
const wall = (Date.now() - started) / 1000;
const cpu = [...cpuByPid.values()].reduce((a, b) => a + b, 0);
const sum = (k) => rows.reduce((a, b) => a + b[k], 0);
console.log('\nRESULT', JSON.stringify({
  mode: MODE, sessions: rows.length, concurrency: CONCURRENCY, thinkMs: THINK_MS,
  peakMemoryMb: Math.round(peakPss), memoryPerConcurrentSessionMb: Math.round(peakPss / CONCURRENCY),
  cpuSeconds: Math.round(cpu), cpuSecondsPerSession: Math.round(cpu / rows.length), avgCoresBusy: Math.round((cpu / wall) * 100) / 100,
  wallSeconds: Math.round(wall), peakProcesses: peakProcs,
  landed: `${sum('landed')}/${sum('attempted')}`, samePage: `${rows.filter((r) => r.same).length}/${rows.length}`,
  crashed: rows.filter((r) => r.error).length,
}));
process.exit(0);
