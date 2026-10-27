// The controls the benchmark showed the agent could not operate, against real Chrome:
//
//   node bench/controls-smoke.mjs
//
//   1. a sortable table: sort by a column by clicking its header
//   2. a slider: move it with the keyboard
//   3. a filter whose label gains a count while the model is deciding: still the same control, so the
//      gate lets the click through (a genuinely different element is refused; see agent-smoke.mjs)

import { createServer } from 'node:http';

import { runAgent } from '../server/agent.mjs';

const PAGE = `<!doctype html><title>Stats</title>
<table><thead><tr>
  <th role="columnheader" tabindex="0" onclick="document.body.dataset.sorted='blk'">Player</th>
  <th role="columnheader" tabindex="0" onclick="document.body.dataset.sorted='blk'; document.title='sorted'">BLK</th>
</tr></thead><tbody><tr><td>A</td><td>3</td></tr></tbody></table>
<input type="range" aria-label="Minimum price" min="0" max="10" value="0" oninput="document.body.dataset.price=this.value">
<button id="stars" onclick="document.body.dataset.stars='on'">5 stars</button>
<script>
  // The count arrives late, while the model is thinking about its next step.
  setTimeout(() => { document.getElementById('stars').textContent = '5 stars (12)'; }, 4000);
</script>`;

const server = createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(PAGE); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

let step = 0;
const id = (prompt, re) => (prompt.match(re) || [])[1];
const chat = async (prompt) => {
  step += 1;
  if (step === 1) return { text: JSON.stringify({ actions: [
    { action: 'click', id: id(prompt, /\[(e\d+)\] columnheader "BLK"/) },
    { action: 'key', id: id(prompt, /\[(e\d+)\] slider "Minimum price"/), key: 'ArrowRight' }] }) };
  if (step === 2) {
    const stars = id(prompt, /\[(e\d+)\] button "5 stars"/);
    await new Promise((r) => setTimeout(r, 4500));        // the label becomes "5 stars (12)" meanwhile
    return { text: JSON.stringify({ actions: [{ action: 'click', id: stars }] }) };
  }
  return { text: JSON.stringify({ actions: [{ action: 'done', answer: 'ok' }] }) };
};

const out = await runAgent({ task: 'sort, slide, filter', website: url, chat, maxSteps: 5 });
server.close();
for (const t of out.trace) console.log('   ', t.summary, '->', t.outcome);
const byAction = (re) => out.trace.find((t) => re.test(t.summary));
const sorted = /^ok/.test(byAction(/^click columnheader "BLK"/)?.outcome || '');
const slid = /^ok/.test(byAction(/^press ArrowRight/)?.outcome || '');
const filtered = /^ok/.test(byAction(/^click button "5 stars"/)?.outcome || '');
console.log('\nsorted by a column header:', sorted ? 'YES' : 'NO');
console.log('moved a slider with the keyboard:', slid ? 'YES' : 'NO');
console.log('clicked a filter whose count changed meanwhile:', filtered ? 'YES' : 'NO');
process.exit(sorted && slid && filtered ? 0 : 1);
