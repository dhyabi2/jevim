// A page that freezes its own renderer must not take the run past its deadline.
//
//   node bench/hang-smoke.mjs
//
// Clicking "Freeze" starts an infinite loop in the page. From then on every CDP command against it
// waits out its own timeout. The run is given a 15-second deadline and must still end, promptly and
// with an answer - the one its memory holds.

import { createServer } from 'node:http';

import { runAgent } from '../server/agent.mjs';

const PAGE = `<!doctype html><title>Freezer</title>
<button onclick="setTimeout(() => { for (;;) {} }, 50)">Freeze</button><p>Price: $42</p>`;
const server = createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(PAGE); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

let step = 0;
const chat = async (prompt) => {
  step += 1;
  const id = (prompt.match(/\[(e\d+)\] button "Freeze"/) || [])[1];
  if (step === 1) return { text: JSON.stringify({ memory: 'The price is $42.', actions: [{ action: 'click', id }] }) };
  return { text: JSON.stringify({ memory: 'The price is $42.', actions: [{ action: 'scroll', direction: 'down' }] }) };
};

const started = Date.now();
const DEADLINE_S = 15;
const out = await runAgent({ task: 'find the price', website: url, chat, maxSteps: 25, deadline: Date.now() + DEADLINE_S * 1000 });
const seconds = (Date.now() - started) / 1000;
server.close();

console.log('answer:', JSON.stringify(out.final), '· steps', out.steps, '·', seconds.toFixed(1), 's');
// The deadline, plus the one action already in flight when it passes (bounded to 30 s past it), plus
// the bounded read of the final URL and the close.
const ok = seconds < DEADLINE_S + 30 + 25 + 15 && /\$42/.test(out.final);
console.log('a frozen page ended the run on time, with an answer:', ok ? 'YES' : 'NO');
process.exit(ok ? 0 : 1);
