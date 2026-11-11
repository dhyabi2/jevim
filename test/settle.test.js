// Waiting for a page, and whose events are whose. No browser: CDP is faked, so what is checked is the
// bookkeeping - the part that silently goes wrong in a Chrome shared between runs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { attach } from '../server/cdp.mjs';
import { handleDialogs, trackTabs } from '../server/cdp-hardening.mjs';

function fakeCdp(replies = {}) {
  const listeners = new Map();
  const sent = [];
  return {
    sent,
    send(method, params, sessionId) {
      sent.push({ method, params, sessionId });
      const reply = replies[method];
      return Promise.resolve(typeof reply === 'function' ? reply(params) : reply || {});
    },
    on(method, handler) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(handler);
      return () => listeners.get(method).delete(handler);
    },
    fire(method, params, sessionId) { for (const handler of listeners.get(method) || []) handler(params, sessionId); },
    listening(method) { return (listeners.get(method) || new Set()).size; },
  };
}

// A watcher that reports a calm, complete page as soon as it is asked.
const CALM = {
  'Runtime.evaluate': { result: { objectId: 'w1' } },
  'Runtime.callFunctionOn': { result: { value: { n: 0, ready: true } } },
};

test('a tab somebody else opened is not this session\'s to follow', async () => {
  const cdp = fakeCdp();
  const tabs = trackTabs(cdp, (info) => info.openerId === 'mine');
  cdp.fire('Target.targetCreated', { targetInfo: { type: 'page', targetId: 'chrome-help', url: 'chrome://help/' } });
  cdp.fire('Target.targetCreated', { targetInfo: { type: 'page', targetId: 'theirs', openerId: 'other', url: 'http://x/' } });
  assert.equal(await tabs.adopt(async () => ({ wrong: true })), null);
  cdp.fire('Target.targetCreated', { targetInfo: { type: 'page', targetId: 'popup', openerId: 'mine', url: 'http://y/' } });
  assert.deepEqual(tabs.opened.map((t) => t.targetId), ['popup']);
});

test('another session\'s dialog is neither answered nor recorded', async () => {
  const cdp = fakeCdp();
  const calls = [];
  const page = { sessionId: 'S1', call: async (method) => { calls.push(method); } };
  const dialogs = handleDialogs(cdp, page);
  cdp.fire('Page.javascriptDialogOpening', { type: 'alert', message: 'their secret' }, 'S2');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(dialogs.seen, []);
  assert.deepEqual(calls, []);
  cdp.fire('Page.javascriptDialogOpening', { type: 'alert', message: 'ours' }, 'S1');
  await new Promise((r) => setImmediate(r));
  assert.equal(dialogs.seen.length, 1);
  assert.deepEqual(calls, ['Page.handleJavaScriptDialog']);
});

test('only this tab\'s own finite requests make it busy', () => {
  const cdp = fakeCdp();
  const page = attach(cdp, 'T1', 'S1');
  cdp.fire('Network.requestWillBeSent', { requestId: 'a', type: 'XHR' }, 'S2');          // another tab
  cdp.fire('Network.requestWillBeSent', { requestId: 'b', type: 'WebSocket' }, 'S1');    // never finishes
  cdp.fire('Network.requestWillBeSent', { requestId: 'c', type: 'Ping' }, 'S1');         // changes nothing
  assert.equal(page.busy(), false);
  cdp.fire('Network.requestWillBeSent', { requestId: 'd', type: 'Fetch' }, 'S1');
  assert.equal(page.busy(), true);
  cdp.fire('Network.loadingFinished', { requestId: 'd' }, 'S2');                         // not ours to finish
  assert.equal(page.busy(), true);
  cdp.fire('Network.loadingFinished', { requestId: 'd' }, 'S1');
  assert.equal(page.busy(), false);
});

test('a navigation drops the old document\'s requests, and a subframe\'s does not', () => {
  const cdp = fakeCdp();
  const page = attach(cdp, 'T1', 'S1');
  cdp.fire('Network.requestWillBeSent', { requestId: 'a', type: 'Fetch' }, 'S1');
  cdp.fire('Page.frameNavigated', { frame: { id: 'child', parentId: 'main' } }, 'S1');
  assert.equal(page.busy(), true);
  cdp.fire('Page.frameNavigated', { frame: { id: 'main' } }, 'S1');
  assert.equal(page.busy(), false);
});

test('a calm page settles at once, and the watcher is released', async () => {
  const cdp = fakeCdp(CALM);
  const page = attach(cdp, 'T1', 'S1');
  const out = await page.settled();
  assert.equal(out.settled, true);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(cdp.sent.some((s) => s.method === 'Runtime.releaseObject' && s.params.objectId === 'w1'));
});

test('a request in flight holds the wait until it finishes', async () => {
  const cdp = fakeCdp(CALM);
  const page = attach(cdp, 'T1', 'S1');
  cdp.fire('Network.requestWillBeSent', { requestId: 'slow', type: 'Fetch' }, 'S1');
  let done = false;
  const waiting = page.settled().then((out) => { done = true; return out; });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(done, false);
  cdp.fire('Network.loadingFinished', { requestId: 'slow' }, 'S1');
  assert.equal((await waiting).settled, true);
});

test('a page that never calms is given up on at the ceiling, not waited on forever', async () => {
  const cdp = fakeCdp({ ...CALM, 'Runtime.callFunctionOn': () => new Promise(() => {}) });
  const page = attach(cdp, 'T1', 'S1');
  const started = Date.now();
  const out = await page.settled({ ceilingMs: 150 });
  assert.equal(out.settled, false);
  assert.ok(Date.now() - started < 1500);
});

test('closing a tab removes its listeners', async () => {
  const cdp = fakeCdp();
  const page = attach(cdp, 'T1', 'S1');
  assert.equal(cdp.listening('Network.requestWillBeSent'), 1);
  await page.close();
  assert.equal(cdp.listening('Network.requestWillBeSent'), 0);
  assert.equal(cdp.listening('Page.frameNavigated'), 0);
});

test('a long name cut short in the index still matches the full live name at the gate', async () => {
  const { createCdpGate } = await import('../server/cdp-session.mjs');
  const { launder } = await import('../src/index/hostile.js');
  const full = 'Skytech Gaming Harpy Gaming PC, AMD Ryzen 7, NVIDIA GeForce RTX 32GB, 64GB DDR5 RAM, 2TB NVMe SSD, 1000W Gold PSU, Wi-Fi, Windows 11 Home';
  const node = (name) => ({ backendDOMNodeId: 7, role: { value: 'link' }, name: { value: name } });
  const page = (name) => ({ call: async (method) => (method === 'Accessibility.getPartialAXTree'
    ? { nodes: [node(name)] } : { model: { border: [0, 0, 100, 0, 100, 20, 0, 20] } }) });
  const entry = { backendDOMNodeId: 7, role: 'link', name: launder(full) };
  assert.ok(entry.name.length < full.length);
  assert.equal((await createCdpGate(page(full))(entry)).ok, true);
  // And a different element under the same node id is still refused.
  assert.equal((await createCdpGate(page('Delete my account and all of its data permanently'))(entry)).ok, false);
});
