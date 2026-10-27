// A live, visible demo of what works with no model at all.
//
//   node bench/demo-live.mjs [record-dir]
//
//   1. the index: what the tool sees on a real site, each element with its fingerprint
//   2. replay: a run the agent recorded on a benchmark task, re-executed on the live site from its
//      action log - every element re-found by fingerprint, zero model calls
//   3. the gate: a button renamed while "the model" decides is refused, not clicked

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { openCdpSession } from '../server/cdp-session.mjs';
import { runAgent } from '../server/agent.mjs';

const DIR = process.argv[2] || '/Users/mac/revmodelAndBrowseruser/bench/out/replay/ours/65c4030f22fb6eb101acfee4825f1318';
const record = JSON.parse(readFileSync(join(DIR, 'record.json'), 'utf8'));
const task = JSON.parse(readFileSync(join(DIR, 'task.json'), 'utf8'));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (s = '') => console.log(s);

// 1. The index
line(`\n== 1. What the tool sees on ${task.website}`);
const look = await openCdpSession(task.website, { headless: false });
await pause(2500);
const index = await look.refresh();
line(`   ${index.length} interactive elements indexed from Chrome's accessibility tree. The first 12:`);
for (const e of index.slice(0, 12)) line(`   ${e.id.padEnd(4)} ${e.role.padEnd(9)} ${JSON.stringify(e.name.slice(0, 50)).padEnd(54)} fp=${e.fp}`);
await pause(4000);
await look.close();

// 2. Replay
line(`\n== 2. Replaying a recorded benchmark run, with no model`);
line(`   task:  ${task.confirmed_task}`);
line(`   recorded answer: ${record.final.split('\n').slice(0, 3).join(' ').slice(0, 160)}...`);
let modelCalls = 0;
const started = Date.now();
const replay = await runAgent({
  task: task.confirmed_task, website: task.website, headless: false, replay: record.log,
  chat: async () => { modelCalls += 1; return { text: '' }; },
  onStep: async ({ summary, outcome, fp }) => {
    line(`   ${summary.slice(0, 80).padEnd(82)} ${fp ? `fp=${fp}` : ''.padEnd(10)} -> ${outcome.slice(0, 40)}`);
    await pause(2500);          // slow enough to watch
  },
});
line(`   executed ${replay.replay.executed}/${replay.replay.actions - (replay.replay.skipped || 0) - 1} actions, ` +
     `${replay.replay.unresolved} not found · model calls: ${modelCalls} · ${Math.round((Date.now() - started) / 1000)} s`);
line(`   ended on: ${replay.finalUrl}`);

// 3. The gate
line(`\n== 3. The gate: the page changes while the model is deciding`);
const PAGE = `<!doctype html><title>Checkout</title><h2>Your order</h2>
<button id="b" style="font-size:20px" onclick="document.body.style.background='#f88'; document.title='CLICKED: '+this.textContent">Buy now</button>
<script>setTimeout(() => { document.getElementById('b').textContent = 'Delete account'; }, 3000);</script>`;
const server = createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(PAGE); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
let step = 0;
const gate = await runAgent({
  task: 'buy the item', website: url, headless: false, maxSteps: 3,
  chat: async (prompt) => {
    step += 1;
    if (step === 1) {
      const id = (prompt.match(/\[(e\d+)\] button "Buy now"/) || [])[1];
      line(`   the model is shown [${id}] button "Buy now" and decides to click it... (thinking for 4 s)`);
      await pause(4000);                         // the page renames the button meanwhile
      return { text: JSON.stringify({ actions: [{ action: 'click', id }] }) };
    }
    return { text: JSON.stringify({ actions: [{ action: 'done', answer: 'stopped' }] }) };
  },
  onStep: async ({ summary, outcome }) => { line(`   ${summary} -> ${outcome}`); await pause(3000); },
});
server.close();
const click = gate.trace.find((t) => t.summary.startsWith('click'));
line(`   ${/stale/.test(click?.outcome || '') ? 'REFUSED: the button had become "Delete account", so nothing was clicked' : 'clicked'}`);
line('');
process.exit(0);
