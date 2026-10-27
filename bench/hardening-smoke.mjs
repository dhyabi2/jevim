// The four things that break automation on real sites, each exercised against real Chrome.
//
//   node bench/hardening-smoke.mjs
//
// Served over local HTTP rather than a data: URL on purpose: a data: URL has an opaque origin, so
// cookies and localStorage are unavailable there and the auth-state half could not be tested at all.

import { createServer } from 'node:http';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openCdpSession } from '../server/cdp-session.mjs';

const PAGE = `<!doctype html><html><body>
<main>
  <h2>Account</h2>
  <button id="confirmer" onclick="if (confirm('Delete everything?')) document.title='ACCEPTED'; else document.title='DISMISSED'">Delete account</button>
  <a id="opener" href="/second" target="_blank">Open settings in a new tab</a>
  <label for="doc">Attach a document</label><input id="doc" type="file">
  <a id="dl" href="/report.csv" download>Download report</a>
</main>
<script>
  document.cookie = 'session=abc123; path=/';
  localStorage.setItem('seen-tour', 'yes');
</script>
</body></html>`;

const SECOND = `<!doctype html><html><body><main><h2>Settings</h2>
<button id="save">Save settings</button></main></body></html>`;

const server = createServer((req, res) => {
  if (req.url === '/second') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(SECOND); }
  if (req.url === '/report.csv') {
    res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' });
    return res.end('a,b\n1,2\n');
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const downloadDir = await mkdtemp(join(tmpdir(), 'jevim-dl-'));
const uploadPath = join(await mkdtemp(join(tmpdir(), 'jevim-up-')), 'evidence.txt');
await writeFile(uploadPath, 'uploaded by the hardening smoke test\n');

const click = async (id) => {
  const entry = session.index.find((e) => e.name.toLowerCase().includes(id));
  if (!entry) throw new Error(`no element matching ${id}`);
  await session.ops.goto(entry);
  return entry;
};

const session = await openCdpSession(url, { downloadTo: downloadDir });
console.log('indexed', session.index.length, 'elements\n');

// 1. A dialog. Without interception this click blocks the page AND every command behind it, and the
//    run hangs rather than fails - which is the worst possible failure mode.
console.log('1. native dialog');
await click('delete account');
await new Promise((r) => setTimeout(r, 400));
const title = await session.title();
console.log('   dialogs seen:', JSON.stringify(session.events.dialogs));
console.log('   page decided:', title, title === 'DISMISSED' ? '(dismissed by default - correct)' : '(WRONG)');

// 2. A click that opens a tab. The old session would keep working against the original page.
console.log('\n2. new tab');
await click('open settings');
await new Promise((r) => setTimeout(r, 600));
console.log('   tabs opened:', JSON.stringify(session.events.tabsOpened));
const followed = await session.followNewTab();
console.log('   followed:', JSON.stringify(followed));
console.log('   now sees:', session.index.map((e) => e.name).join(', '));

// 3. Upload. A file input's value cannot be set from script at all; this is the only route.
console.log('\n3. file upload');
const back = await openCdpSession(url, { chrome: session.chrome, cdp: session.cdp, downloadTo: downloadDir });
const input = back.index.find((e) => /document/i.test(e.name));
if (input) {
  console.log('   uploading to:', `${input.role}:${input.name}`);
  console.log('   result:', JSON.stringify(await back.upload(input, [uploadPath])));
  console.log('   page reports:', await back.evaluate(`document.getElementById('doc').files[0]?.name || 'none'`));
} else {
  console.log('   NO FILE INPUT INDEXED - the index is dropping file inputs');
}

// 4. Download. Otherwise a click that downloads produces nothing observable.
console.log('\n4. download');
const dl = back.index.find((e) => /download report/i.test(e.name));
if (dl) await back.ops.goto(dl);
await new Promise((r) => setTimeout(r, 900));
console.log('   events:', JSON.stringify(back.events.downloads));
console.log('   on disk:', JSON.stringify(await readdir(downloadDir)));

// 5. Authenticated state across a replay. Every script otherwise restarts at a login wall.
console.log('\n5. auth state survives a fresh session');
const state = await back.captureState();
console.log('   captured:', state.cookies.length, 'cookies,', Object.keys(state.storage).length, 'storage keys');
const fresh = await openCdpSession(url, { chrome: session.chrome, cdp: session.cdp, state });
console.log('   restored cookie:', await fresh.evaluate(`document.cookie`));
console.log('   restored storage:', await fresh.evaluate(`localStorage.getItem('seen-tour')`));

await fresh.close(); await back.close(); await session.close();
server.close();
