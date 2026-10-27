// Record a run with a scripted model, then replay its log with no model at all.
//
//   node bench/replay-smoke.mjs
//
// The replay page is served with its elements in a different order and with different ids and
// classes, the churn a redeploy causes; the fingerprint must still find each one.

import { createServer } from 'node:http';

import { runAgent } from '../server/agent.mjs';

const page = (shuffled) => `<!doctype html><html><head><title>Shop</title></head><body>
${shuffled ? '<nav><a href="/about" class="x9">About</a></nav>' : ''}
<main>
  <input aria-label="Search products" id="${shuffled ? 'q2' : 'q'}" class="${shuffled ? 'css-81' : 'css-3'}">
  <button id="${shuffled ? 'b7' : 'go'}" onclick="location.href='/results?q=' + encodeURIComponent(document.querySelector('input').value)">Search</button>
</main></body></html>`;
const results = (q) => `<!doctype html><html><head><title>Results</title></head><body><h1>Results for ${q}</h1>
<a href="/item/1">Red shoe, $12</a> <a href="/item/2">Blue shoe, $30</a></body></html>`;

let shuffled = false;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.writeHead(200, { 'content-type': 'text/html' });
  if (url.pathname === '/results') res.end(results(url.searchParams.get('q')));
  else if (url.pathname.startsWith('/item')) res.end('<!doctype html><title>Item</title><h1>Red shoe</h1><p>$12</p>');
  else res.end(page(shuffled));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

let step = 0;
const id = (prompt, name) => (prompt.match(new RegExp(`\\[(e\\d+)\\] \\w+ "${name}"`)) || [])[1];
const chat = async (prompt) => {
  step += 1;
  if (step === 1) return { text: JSON.stringify({ actions: [
    { action: 'type', id: id(prompt, 'Search products'), text: 'shoe' },
    { action: 'click', id: id(prompt, 'Search') }] }) };
  if (step === 2) return { text: JSON.stringify({ actions: [{ action: 'click', id: id(prompt, 'Red shoe, \\$12') }] }) };
  return { text: JSON.stringify({ actions: [{ action: 'done', answer: 'Red shoe, $12' }] }) };
};

const recorded = await runAgent({ task: 'cheapest shoe', website: url, chat, maxSteps: 5 });
shuffled = true;
let calls = 0;
const replayed = await runAgent({ task: 'cheapest shoe', website: url, chat: async () => { calls += 1; return { text: '' }; },
                                  replay: recorded.log });
server.close();

console.log('recorded:', recorded.log.map((l) => `${l.action}${l.name ? ` "${l.name}"` : ''} -> ${l.outcome}`).join(' | '));
console.log('replay  :', JSON.stringify(replayed.replay), 'final', replayed.finalUrl.replace(url, '/'));
const same = replayed.finalUrl === recorded.finalUrl;
console.log('\nreplay reached the same final page:', same ? 'YES' : 'NO');
console.log('model calls during replay:', calls);
process.exit(same && calls === 0 && replayed.replay.unresolved === 0 ? 0 : 1);
