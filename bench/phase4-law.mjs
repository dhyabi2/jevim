// Phase 4's own law, against real Chrome:
//
//   "a recorded script that scrolls a virtualised list, opens a second tab and dismisses a dialog
//    replays identically."
//
//   node bench/phase4-law.mjs
//
// All three hazards are on one page on purpose. Each of them individually breaks automation in a
// different way - a target that does not exist yet, a session left on the wrong page, a modal that
// wedges every command behind it - and a script is only replayable if none of them is in play.
//
// "Identically" is checked by comparing the full trace of two runs, not by both runs passing.

import { createServer } from 'node:http';

import { openCdpSession } from '../server/cdp-session.mjs';

const ROWS = 60;
const TARGET = 'Invoice 47';

const PAGE = `<!doctype html><html><body style="font-family:sans-serif;margin:0">
<div style="height:60px;padding:8px"><h3>Invoices</h3></div>

<!-- A virtualised list: only the rows near the viewport are in the DOM at all. Row ${TARGET.split(' ')[1]}
     does not exist until it is scrolled to - it is absent, not hidden. -->
<div id="list" style="position:relative;height:${ROWS * 40}px"></div>

<div style="padding:12px">
  <a id="opener" href="/second" target="_blank">Open the archive in a new tab</a>
  <button id="purge" onclick="if (confirm('Purge all invoices?')) document.title='PURGED'; else document.title='KEPT'">Purge all invoices</button>
</div>

<script>
  const list = document.getElementById('list');
  function render() {
    const top = window.scrollY, bottom = top + window.innerHeight;
    const first = Math.max(0, Math.floor((top - 60) / 40) - 2);
    const last = Math.min(${ROWS}, Math.ceil((bottom - 60) / 40) + 2);
    list.textContent = '';
    for (let i = first; i < last; i++) {
      const row = document.createElement('button');
      row.textContent = 'Invoice ' + i;
      row.style.cssText = 'position:absolute;top:' + (i * 40) + 'px;left:8px;width:220px';
      row.onclick = () => { document.title = 'OPENED ' + i; };
      list.appendChild(row);
    }
  }
  render();
  window.addEventListener('scroll', render, { passive: true });
</script>
</body></html>`;

const SECOND = `<!doctype html><title>Archive</title><body><main><h2>Archive</h2>
<button id="restore">Restore from archive</button></main></body>`;

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(req.url === '/second' ? SECOND : PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

/** The script. Three steps, each one of the three hazards, executed through the session. */
async function run(label) {
  const trace = [];
  const session = await openCdpSession(url, { headless: true });

  // Step 1: a row that is not in the DOM yet. Without a reveal pass this simply cannot resolve.
  const beforeReveal = session.index.some((e) => e.name === TARGET);
  const revealed = await session.reveal();
  const row = session.index.find((e) => e.name === TARGET);
  trace.push(['reveal', { visibleBefore: beforeReveal, found: Boolean(row), complete: revealed.complete }]);
  if (row) {
    await session.ops.goto(row);
    await new Promise((r) => setTimeout(r, 200));
    trace.push(['clicked-row', await session.title()]);
  }

  // Step 2: a click that opens a tab. Without following it the rest of the script runs on the old page.
  const opener = session.index.find((e) => /new tab/i.test(e.name));
  await session.ops.goto(opener);
  await new Promise((r) => setTimeout(r, 700));
  const followed = await session.followNewTab();
  trace.push(['followed-tab', {
    adopted: Boolean(followed && followed.adopted),
    sees: session.index.map((e) => e.name).sort(),
  }]);

  // Step 3: the dialog. Back on the first page, since the script's remaining step belongs there.
  await session.goTo(url);
  const purge = session.index.find((e) => /purge/i.test(e.name));
  await session.ops.goto(purge);
  await new Promise((r) => setTimeout(r, 400));
  trace.push(['dialog', { seen: session.events.dialogs.map((d) => `${d.type}:${d.message}`),
                          decided: await session.title() }]);

  await session.close();
  console.log(`${label}:`);
  for (const [step, detail] of trace) console.log('   ', step, JSON.stringify(detail));
  return trace;
}

const first = await run('run 1');
console.log();
const second = await run('run 2');

// "Handled" means the page the session reads is the one it acted on. Seeing the dialog is not enough:
// with the click routed to a stale tab, the dialog was seen, the title of the page being read stayed
// empty, and both runs agreed - so identical traces alone would have passed a broken session.
function handled(trace) {
  const [reveal, row, tab, dialog] = trace.map(([, detail]) => detail);
  return reveal.found && row === `OPENED ${TARGET.split(' ')[1]}` && tab.adopted
    && dialog.seen.length === 1 && dialog.decided === 'KEPT';
}

const same = JSON.stringify(first) === JSON.stringify(second);
console.log('\nreplays identically:', same ? 'YES' : 'NO');
if (!same) {
  console.log('  run 1:', JSON.stringify(first));
  console.log('  run 2:', JSON.stringify(second));
}
console.log('all three hazards handled:',
  handled(first) ? 'YES' : 'NO');

server.close();
process.exit(same && handled(first) ? 0 : 1);
