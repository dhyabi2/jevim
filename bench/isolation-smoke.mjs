// Sessions sharing one Chrome must share nothing a site can see.
//
//   node bench/isolation-smoke.mjs
//
// Two sessions open the same site in one Chrome, each in its own browser context. The first sets a
// cookie and a localStorage key; the second, loading the same origin, must see neither.

import { createServer } from 'node:http';

import { connect, launch } from '../server/cdp.mjs';
import { openCdpSession } from '../server/cdp-session.mjs';

const server = createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>Site</title><button>Go</button>'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const chrome = await launch({ headless: true });
const cdp = await connect(chrome.endpoint);
const a = await openCdpSession(url, { chrome, cdp, isolate: true });
await a.evaluate(`document.cookie = 'visitor=alice; path=/'; localStorage.setItem('card', '4242'); 'set'`);
const b = await openCdpSession(url, { chrome, cdp, isolate: true });
const seen = await b.evaluate(`JSON.stringify({ cookie: document.cookie, card: localStorage.getItem('card') })`);
const own = await a.evaluate(`JSON.stringify({ cookie: document.cookie, card: localStorage.getItem('card') })`);
await a.close(); await b.close();
const contexts = (await cdp.send('Target.getBrowserContexts')).browserContextIds.length;
cdp.close(); await chrome.close(); server.close();

console.log('session A sees its own:', own);
console.log('session B sees:', seen);
console.log('contexts left after both closed:', contexts);
const ok = seen === JSON.stringify({ cookie: '', card: null }) && own.includes('alice') && contexts === 0;
console.log('visitors sharing a Chrome are isolated:', ok ? 'YES' : 'NO');
process.exit(ok ? 0 : 1);
