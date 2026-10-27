// Authoring-time vision against real Chrome and the real vision model.
//
//   NANO_API_KEY=... node bench/vision-smoke.mjs
//
// The unit tests prove the logic with the model and the browser faked. This proves the parts that
// cannot be faked: that a screenshot of a canvas plus a plain-english description comes back as a point
// Chrome can turn into a node, and that clicking the stored region lands where it was authored.
//
// The page draws a bar chart on a canvas and records where it was clicked, so "did it hit the right
// bar" has an answer rather than an impression.

import { createServer } from 'node:http';

import { openCdpSession } from '../server/cdp-session.mjs';
import { clickRegion, identifyByVision, visionTransport } from '../server/vision.mjs';
import { trustedClick } from '../server/cdp-hardening.mjs';
import { ELEMENT, REGION } from '../src/generate/vision.js';

const PAGE = `<!doctype html><html><body style="font-family:sans-serif;margin:24px">
<h2>Quarterly revenue</h2>
<canvas id="chart" width="600" height="300" style="border:1px solid #ccc"></canvas>
<p id="hit">no click yet</p>
<button id="export" style="padding:8px 16px">Export to CSV</button>
<script>
  const bars = [['Q1',80,'#9ab'],['Q2',150,'#9ab'],['Q3',260,'#c44'],['Q4',120,'#9ab']];
  const c = document.getElementById('chart'), g = c.getContext('2d');
  g.font = '14px sans-serif';
  bars.forEach(([label, h, colour], i) => {
    const x = 40 + i * 140;
    g.fillStyle = colour; g.fillRect(x, 300 - h, 90, h);
    g.fillStyle = '#000'; g.fillText(label, x + 30, 295 - h);
  });
  c.addEventListener('click', (e) => {
    const r = c.getBoundingClientRect();
    const x = e.clientX - r.left;
    const i = Math.floor((x - 40) / 140);
    document.getElementById('hit').textContent =
      (i >= 0 && i < 4 ? bars[i][0] : 'outside any bar') + ' at x=' + Math.round(x);
  });
</script>
</body></html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const key = process.env.NANO_API_KEY;
if (!key) { console.error('NANO_API_KEY is not set; this bench needs the real vision model'); process.exit(1); }
const ask = visionTransport({ apiKey: key });

const session = await openCdpSession(url, { headless: true });
console.log('indexed', session.index.length, 'elements:',
  session.index.map((e) => `${e.role}:${e.name || '(unnamed)'}`).join(', '));
console.log('-> a canvas chart is, to the accessibility tree, nothing at all\n');

// 1. The thing no DOM index can reach: one bar inside a canvas.
const started = Date.now();
const found = await identifyByVision(session, 'the tall dark red bar in the bar chart', { ask });
console.log('1. vision identification of a canvas bar');
console.log('   ', JSON.stringify({ found: found.found, kind: found.kind, point: found.point,
                                    reason: found.reason }), `in ${Date.now() - started}ms`);
if (found.usage) console.log('    tokens in:', found.usage.prompt_tokens);
if (found.refined) console.log('    first look pointed at', JSON.stringify(found.coarse),
                               '; the close look at the canvas moved it to', JSON.stringify(found.point));

if (found.kind === REGION) {
  console.log('    bound to node', found.backendNodeId, 'at offset',
    JSON.stringify(found.offset), '- a fraction of the canvas, not a pixel');

  // 2. Replay the stored binding. No vision call, no model call: read the box, click the fraction.
  const replay = await clickRegion(session.rawPage, found, {
    click: async (point) => {
      await session.rawPage.call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point, buttons: 0 });
      await session.rawPage.call('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
      await session.rawPage.call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 1, clickCount: 1 });
    },
  });
  await new Promise((r) => setTimeout(r, 250));
  const hit = await session.evaluate(`document.getElementById('hit').textContent`);
  console.log('\n2. replay from the stored region, with no vision call');
  console.log('    clicked at', JSON.stringify(replay.at), 'in box', JSON.stringify(replay.box));
  console.log('    the page says it hit:', hit);
  console.log('   ', /Q3/.test(hit) ? 'CORRECT - the Q3 bar is the tall red one'
                                    : 'WRONG BAR - vision pointed at the wrong place');
} else if (found.kind === ELEMENT) {
  console.log('    bound to fingerprint', found.fp, '- vision was only the lookup');
}

// 3. An element that IS in the index: vision should resolve to its fingerprint, not a coordinate,
//    because a fingerprint has a gate and repair behind it and a coordinate has neither.
const button = await identifyByVision(session, 'the Export to CSV button', { ask });
console.log('\n3. vision on something the index already knows');
console.log('   ', JSON.stringify({ found: button.found, kind: button.kind, fp: button.fp,
                                    name: button.name, reason: button.reason }));
console.log('   ', button.kind === ELEMENT
  ? 'CORRECT - an indexed element binds to its fingerprint, which has a gate and repair behind it'
  : 'FELL BACK TO A REGION - a coordinate has neither a gate nor repair');

await session.close();
server.close();
