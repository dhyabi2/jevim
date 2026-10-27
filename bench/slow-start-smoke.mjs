// A start page that stalls must not end the run before it begins.
//
//   node bench/slow-start-smoke.mjs
//
// The server holds the first request for 65 seconds - past Page.navigate's 60-second limit - and answers
// the next one at once. The session must retry and load the page, where it used to fail at 30 seconds.

import { createServer } from 'node:http';

import { openCdpSession } from '../server/cdp-session.mjs';

let requests = 0;
const server = createServer((req, res) => {
  if (req.url !== '/') { res.writeHead(404); res.end(); return; }
  requests += 1;
  const reply = () => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Loaded</title><button>Go</button>'); };
  if (requests === 1) setTimeout(reply, 65000); else reply();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const started = Date.now();
let title = null;
try {
  const session = await openCdpSession(url, { headless: true });
  title = await session.title();
  await session.close();
} catch (error) {
  console.log('failed:', error.message);
}
server.close();
console.log(`requests ${requests} · ${Math.round((Date.now() - started) / 1000)} s · title ${JSON.stringify(title)}`);
const ok = title === 'Loaded' && requests >= 2;
console.log('a stalled start page was retried and loaded:', ok ? 'YES' : 'NO');
process.exit(ok ? 0 : 1);
