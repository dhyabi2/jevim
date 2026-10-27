// The agent's two guarantees, against real Chrome with the model scripted:
//
//   node bench/agent-smoke.mjs
//
//   1. A target that changes between the observation the model saw and the click is refused by the
//      gate, not clicked. The page renames its "Buy" button to "Delete account" while the model is
//      thinking; an agent without the gate clicks "Delete account".
//   2. The steps that did act are recorded as fingerprint-pinned artifact lines.

import { createServer } from 'node:http';

import { runAgent } from '../server/agent.mjs';

const PAGE = `<!doctype html><html><head><title>Shop</title></head><body>
<input aria-label="Search" id="q">
<button id="buy" onclick="document.title = this.textContent === 'Buy' ? 'BOUGHT' : 'DELETED'">Buy</button>
<script>
  // While the model is deciding its next step, the page changes what the button is.
  document.getElementById('q').addEventListener('input', () => {
    setTimeout(() => { document.getElementById('buy').textContent = 'Delete account'; }, 2500);
  }, { once: true });
</script>
</body></html>`;

const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

// The scripted model: type into search, then (slowly) click the Buy button it was shown, then finish.
let step = 0;
let firstPrompt = '';
const chat = async (prompt) => {
  step += 1;
  if (step === 1) firstPrompt = prompt;
  const id = (name) => (prompt.match(new RegExp(`\\[(e\\d+)\\] \\w+ "${name}"`)) || [])[1];
  if (step === 1) return { text: JSON.stringify({ action: 'type', id: id('Search'), text: 'shoes' }) };
  if (step === 2) {
    const buy = id('Buy');
    await new Promise((r) => setTimeout(r, 3500));          // the page renames the button meanwhile
    return { text: JSON.stringify({ action: 'click', id: buy }) };
  }
  return { text: JSON.stringify({ action: 'done', answer: 'stopped' }) };
};

const out = await runAgent({ task: 'buy shoes', website: url, chat, maxSteps: 4 });
server.close();

const click = out.trace.find((t) => t.summary.startsWith('click'));
console.log('trace:');
for (const t of out.trace) console.log('   ', t.summary, '->', t.outcome);
console.log('\nartifact:\n' + out.artifact.split('\n').map((l) => '    ' + l).join('\n'));

const refused = Boolean(click && /^not done: stale/.test(click.outcome));
// Pinned, and parseable: the artifact is only replayable if it reads back as the steps it recorded.
const { parse } = await import('../src/artifact.js');
const back = parse(out.artifact);
const typed = out.trace.find((t) => t.summary.startsWith('type'));
const pinned = out.pinnedSteps === 1 && back.steps.length === 1 && back.steps[0].fp === typed?.fp;
// 3. What the model was shown: the page's visible text, without script source or empty fragments.
const seen = (firstPrompt.split('Visible text on the page:\n')[1] || '').split('\n\n')[0];
const readable = /\bBuy\b/.test(seen) && !/setTimeout|addEventListener/.test(seen) && !/\|\s*\|/.test(seen);
console.log('visible text shown to the model:', JSON.stringify(seen.slice(0, 120)));

console.log('\ngate refused a renamed target:', refused ? 'YES' : 'NO');
console.log('acted steps pinned by fingerprint:', pinned ? 'YES' : 'NO', `(${out.pinnedSteps} pinned)`);
console.log('page text reached the model intact:', readable ? 'YES' : 'NO');
process.exit(refused && pinned && readable ? 0 : 1);
