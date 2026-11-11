// What the browser side of a run costs, with the model taken out.
//
//   node bench/perf.mjs [--runs 3] [--json out.json]
//
// A local site with the shapes that make waiting hard - a click answered by a fetch after 50 ms, after
// 300 ms, after 1.2 s, by a bare timer with no network at all, a form that navigates, a 300-control
// page - driven by a scripted model that replies instantly. Every second measured here is the agent's
// own overhead: launching, waiting for the page, indexing, gating, acting.
//
// It is also the correctness check for any change to the waiting: the scripted model can only name an
// element that is in the index it was shown, so a wait that returns before the page has rendered the
// next control fails the run instead of making it look fast. The same recording is then replayed with
// no model, and must reach the same final page.

import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';

import { runAgent } from '../server/agent.mjs';
import { launch, connect } from '../server/cdp.mjs';

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
};
const RUNS = Number(arg('runs', 3));

const page = (title, body) => `<!doctype html><html><head><title>${title}</title>
<style>body{font:14px sans-serif} .grid{display:grid;grid-template-columns:repeat(6,1fr);gap:4px}</style></head>
<body><nav aria-label="Main"><a href="/">Home</a> <a href="/catalog">Catalog</a> <a href="/spa">Wizard</a> <a href="/form">Checkout form</a></nav>
${body}</body></html>`;

const ROUTES = {
  '/': () => page('Shop', `<h1>Shop</h1><p>Welcome to the shop.</p>
    <ul>${Array.from({ length: 40 }, (_, i) => `<li><a href="/item/${i}">Featured item ${i}</a></li>`).join('')}</ul>`),

  '/catalog': (q) => page('Catalog', `<h1>Catalog${q.get('q') ? ` results for ${q.get('q')}` : ''}</h1>
    <form action="/catalog"><input type="search" name="q" aria-label="Search products"></form>
    <button id="sort">Sort by price</button><span id="sorted"></span>
    ${Array.from({ length: 6 }, (_, s) => `<section><h2>Aisle ${s}</h2><div class="grid">${
      Array.from({ length: 50 }, (_, i) => `<button>Add product ${s * 50 + i}</button>`).join('')}</div></section>`).join('')}
    <script>
      document.getElementById('sort').onclick = async () => {
        await fetch('/api/delay?ms=300');
        document.getElementById('sorted').innerHTML = '<button id="done-sort">Sorted by price: lowest first</button>';
      };
    </script>`),

  // Each stage appears only after the previous one's work finishes; the delays are the test.
  '/spa': () => page('Wizard', `<h1>Wizard</h1><div id="stage"><button id="s1">Load step 1</button></div><p id="log"></p>
    <script>
      const stage = document.getElementById('stage');
      const show = (html) => { stage.innerHTML = html; };
      const log = (t) => { document.getElementById('log').textContent += t + ' '; };
      stage.addEventListener('click', async (e) => {
        const id = e.target.id;
        if (id === 's1') { await fetch('/api/delay?ms=50'); log('one'); show('<button id="s2">Load step 2</button>'); }
        if (id === 's2') { await fetch('/api/delay?ms=300'); log('two'); show('<button id="s3">Load step 3</button>'); }
        // No network at all: only a timer stands between the click and the next control.
        if (id === 's3') { setTimeout(() => { log('three'); show('<button id="s4">Load step 4</button>'); }, 200); }
        if (id === 's4') { await fetch('/api/delay?ms=1200'); log('four'); show('<a href="/form">Continue to checkout form</a>'); }
      });
    </script>`),

  '/form': () => page('Checkout', `<h1>Checkout</h1>
    <form action="/result">
      <label>Full name <input name="name"></label>
      <label>Email <input name="email" type="email"></label>
      <label>Shipping <select name="ship"><option>Standard</option><option>Express</option><option>Overnight</option></select></label>
      <label><input type="checkbox" name="gift" value="yes"> Gift wrap</label>
      <button type="submit">Place order</button>
    </form>`),

  '/result': (q) => page('Order placed', `<h1>Order placed</h1>
    <p id="summary">name=${q.get('name')}; email=${q.get('email')}; ship=${q.get('ship')}; gift=${q.get('gift') || 'no'}</p>`),
};

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/delay') {
    setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }, Number(url.searchParams.get('ms') || 0));
    return;
  }
  const route = ROUTES[url.pathname];
  res.writeHead(route ? 200 : 404, { 'content-type': 'text/html' });
  res.end(route ? route(url.searchParams) : page('Not found', '<h1>Not found</h1>'));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// The scripted model. Each step names its element by role and name; an element that is not in the index
// the agent sent is a failure of the agent's waiting, and is reported as one.
const el = (role, name) => (prompt) => {
  const found = prompt.match(new RegExp(`\\[(e\\d+)\\] ${role} "${name}"`));
  if (!found) throw new Error(`MISSING ${role} "${name}"`);
  return found[1];
};
const SCRIPT = [
  (p) => [{ action: 'click', id: el('link', 'Catalog')(p) }],
  (p) => [{ action: 'click', id: el('button', 'Sort by price')(p) }],
  (p) => [{ action: 'click', id: el('button', 'Sorted by price: lowest first')(p) }],
  (p) => [{ action: 'click', id: el('button', 'Add product 7')(p) }, { action: 'click', id: el('button', 'Add product 12')(p) }],
  (p) => [{ action: 'type', id: el('searchbox', 'Search products')(p), text: 'lamp', enter: true }],
  (p) => { if (!/Catalog results for lamp/.test(p)) throw new Error('MISSING search results text'); return [{ action: 'click', id: el('link', 'Wizard')(p) }]; },
  (p) => [{ action: 'click', id: el('button', 'Load step 1')(p) }],
  (p) => [{ action: 'click', id: el('button', 'Load step 2')(p) }],
  (p) => [{ action: 'click', id: el('button', 'Load step 3')(p) }],
  (p) => [{ action: 'click', id: el('button', 'Load step 4')(p) }],
  (p) => [{ action: 'click', id: el('link', 'Continue to checkout form')(p) }],
  (p) => [{ action: 'type', id: el('textbox', 'Full name')(p), text: 'Ada Lovelace' },
          { action: 'type', id: el('textbox', 'Email')(p), text: 'ada@example.com' },
          { action: 'select', id: el('combobox', 'Shipping')(p), option: 'Express' }],
  (p) => [{ action: 'click', id: el('checkbox', 'Gift wrap')(p) }],
  (p) => [{ action: 'click', id: el('button', 'Place order')(p) }],
  (p) => {
    const seen = (p.match(/name=[^|\n]*; gift=\w+/) || [''])[0];
    return [{ action: 'done', answer: seen }];
  },
];
const EXPECTED = 'name=Ada Lovelace; email=ada@example.com; ship=Express; gift=yes';

function scripted() {
  let step = 0;
  const missing = [];
  const chat = async (prompt) => {
    const make = SCRIPT[step];
    step += 1;
    if (!make) return { text: JSON.stringify({ actions: [{ action: 'done', answer: '' }] }) };
    try {
      return { text: JSON.stringify({ memory: '', next_goal: '', actions: make(prompt) }) };
    } catch (error) {
      missing.push(`step ${step}: ${error.message}`);
      return { text: JSON.stringify({ actions: [{ action: 'done', answer: `FAILED ${error.message}` }] }) };
    }
  };
  return { chat, missing };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ms = (n) => `${Math.round(n)} ms`;

async function timed(fn) { const t = performance.now(); const out = await fn(); return [performance.now() - t, out]; }

const results = { launch: [], live: [], replay: [], warmLive: [], warmReplay: [], failures: [] };
let recording = null;

for (let run = 0; run < RUNS; run++) {
  // Launch alone, so it can be told apart from the run.
  const [launchMs, chrome] = await timed(() => launch({ headless: true }));
  results.launch.push(launchMs);
  await chrome.close();

  // Cold: the run launches its own Chrome, as the plugin does.
  const model = scripted();
  let last = performance.now();
  const onStep = process.env.PERF_STEPS ? (s) => { const now = performance.now(); console.log(`    ${Math.round(now - last)} ms  ${s.summary} -> ${s.outcome}`); last = now; } : null;
  const [liveMs, out] = await timed(() => runAgent({ task: 'place the order', website: `${base}/`, chat: model.chat, maxSteps: 20, onStep }));
  results.live.push(liveMs);
  if (out.final !== EXPECTED) results.failures.push(`live run ${run}: answer ${JSON.stringify(out.final)} ${model.missing.join('; ')}`);
  recording = out.log;

  const [replayMs, again] = await timed(() => runAgent({ task: 'place the order', website: `${base}/`, chat: null, replay: recording }));
  results.replay.push(replayMs);
  if (!/\/result\?/.test(again.finalUrl) || again.replay.unresolved || again.replay.failed) {
    results.failures.push(`replay run ${run}: ${JSON.stringify(again.replay)} at ${again.finalUrl}`);
  }

  // Warm: Chrome is already running, as in the hosted server's pool.
  const warm = await launch({ headless: true });
  const cdp = await connect(warm.endpoint);
  const model2 = scripted();
  const [warmMs, out2] = await timed(() => runAgent({ task: 'place the order', website: `${base}/`, chat: model2.chat, maxSteps: 20, browser: { chrome: warm, cdp } }));
  results.warmLive.push(warmMs);
  if (out2.final !== EXPECTED) results.failures.push(`warm live run ${run}: answer ${JSON.stringify(out2.final)} ${model2.missing.join('; ')}`);
  const [warmReplayMs, again2] = await timed(() => runAgent({ task: 'place the order', website: `${base}/`, chat: null, replay: out2.log, browser: { chrome: warm, cdp } }));
  results.warmReplay.push(warmReplayMs);
  if (!/\/result\?/.test(again2.finalUrl) || again2.replay.unresolved || again2.replay.failed) {
    results.failures.push(`warm replay run ${run}: ${JSON.stringify(again2.replay)} at ${again2.finalUrl}`);
  }
  cdp.close();
  await warm.close();
}
server.close();

const actions = recording ? recording.length : 0;
const summary = {
  runs: RUNS,
  actions,
  launch_ms: Math.round(median(results.launch)),
  live_cold_ms: Math.round(median(results.live)),
  replay_cold_ms: Math.round(median(results.replay)),
  live_warm_ms: Math.round(median(results.warmLive)),
  replay_warm_ms: Math.round(median(results.warmReplay)),
  per_action_warm_replay_ms: actions ? Math.round(median(results.warmReplay) / actions) : null,
  failures: results.failures,
};
console.log(`browser-side cost, model excluded (${RUNS} runs, median; ${actions} recorded actions)`);
console.log(`  chrome launch              ${ms(summary.launch_ms)}`);
console.log(`  scripted run, cold chrome  ${ms(summary.live_cold_ms)}`);
console.log(`  replay, cold chrome        ${ms(summary.replay_cold_ms)}`);
console.log(`  scripted run, warm chrome  ${ms(summary.live_warm_ms)}`);
console.log(`  replay, warm chrome        ${ms(summary.replay_warm_ms)}   (${ms(summary.per_action_warm_replay_ms)} per action)`);
console.log(results.failures.length ? `  FAILURES:\n    ${results.failures.join('\n    ')}` : '  correctness: every run reached the expected final page');
if (arg('json')) writeFileSync(arg('json'), JSON.stringify(summary, null, 1));
process.exit(results.failures.length ? 1 : 0);
