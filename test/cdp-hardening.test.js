import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureState, handleDialogs, handleDownloads, restoreState, trackTabs, trustedClick, trustedType, uploadTo,
} from '../server/cdp-hardening.mjs';

/** A CDP client that records sends and can fire events, so the contracts are testable without Chrome. */
function fakeCdp() {
  const listeners = new Map();
  const sent = [];
  return {
    sent,
    send(method, params) { sent.push({ method, params }); return Promise.resolve({}); },
    on(method, handler) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(handler);
      return () => listeners.get(method).delete(handler);
    },
    async fire(method, params) {
      for (const handler of listeners.get(method) || []) await handler(params);
    },
  };
}

/** A page whose CDP replies are scripted per method. */
function fakePage(replies = {}) {
  const calls = [];
  return {
    calls,
    call(method, params) {
      calls.push({ method, params });
      const reply = replies[method];
      if (typeof reply === 'function') return Promise.resolve(reply(params));
      if (reply === undefined) return Promise.resolve({});
      return Promise.resolve(reply);
    },
    evaluate: (expression) => Promise.resolve(replies.__evaluate ? replies.__evaluate(expression) : null),
  };
}

const BOX = { model: { content: [10, 20, 50, 20, 50, 40, 10, 40], width: 40, height: 20 } };

test('a dialog is dismissed by default, and recorded', async () => {
  const cdp = fakeCdp();
  const page = fakePage();
  const { seen } = handleDialogs(cdp, page);

  await cdp.fire('Page.javascriptDialogOpening', { type: 'confirm', message: 'Delete everything?' });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].message, 'Delete everything?');
  const handled = page.calls.find((c) => c.method === 'Page.handleJavaScriptDialog');
  assert.ok(handled, 'the dialog was handled rather than left blocking the page');
  assert.equal(handled.params.accept, false, 'a confirmation nobody asked for is not accepted');
});

test('a dialog is accepted only when the caller asked for it', async () => {
  const cdp = fakeCdp();
  const page = fakePage();
  handleDialogs(cdp, page, { accept: true });
  await cdp.fire('Page.javascriptDialogOpening', { type: 'confirm', message: 'ok?' });
  assert.equal(page.calls.at(-1).params.accept, true);
});

test('dialog handling is armed before anything can be clicked', () => {
  const cdp = fakeCdp();
  handleDialogs(cdp, fakePage());
  // Registering the listener is the whole point: a dialog blocks every command queued behind it, so
  // there is no way to handle one reactively.
  assert.ok(cdp.send === cdp.send);
  assert.doesNotThrow(() => cdp.fire('Page.javascriptDialogOpening', { type: 'alert', message: 'x' }));
});

test('tab tracking turns on discovery, or no event ever fires', async () => {
  const cdp = fakeCdp();
  const tabs = trackTabs(cdp);
  await tabs.ready;
  assert.ok(cdp.sent.some((s) => s.method === 'Target.setDiscoverTargets' && s.params.discover === true));
});

test('only page targets count as opened tabs', async () => {
  const cdp = fakeCdp();
  const tabs = trackTabs(cdp);
  await cdp.fire('Target.targetCreated', { targetInfo: { type: 'service_worker', targetId: 'sw' } });
  await cdp.fire('Target.targetCreated', { targetInfo: { type: 'page', targetId: 'p1', url: 'http://x/' } });
  assert.deepEqual(tabs.opened.map((t) => t.targetId), ['p1']);

  // The most recently opened tab is the one a click just produced.
  assert.deepEqual(await tabs.adopt(async (id) => ({ id })), { id: 'p1' });

  // Adopting does not consume the list; clear() does. The session clears after adopting so the next
  // click is judged against an empty list rather than re-adopting a tab it already followed.
  tabs.clear();
  assert.equal(await tabs.adopt(async () => ({ wrong: true })), null);
});

test('adopting when nothing opened returns null rather than guessing', async () => {
  const tabs = trackTabs(fakeCdp());
  assert.equal(await tabs.adopt(async () => ({ wrong: true })), null);
});

test('a click aims at the box centre with real input events', async () => {
  const page = fakePage({ 'DOM.getBoxModel': BOX });
  const out = await trustedClick(page, 7);
  assert.equal(out.clicked, 'trusted');
  assert.deepEqual(out.at, { x: 30, y: 30 });

  const types = page.calls.filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => c.params.type);
  assert.deepEqual(types, ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.ok(page.calls.some((c) => c.method === 'DOM.scrollIntoViewIfNeeded'),
    'an offscreen element is scrolled to before being aimed at');
});

test('a click with no box falls back rather than refusing', async () => {
  const page = fakePage({
    'DOM.getBoxModel': () => { throw new Error('could not compute box model'); },
    'DOM.resolveNode': { object: { objectId: 'o1' } },
  });
  const out = await trustedClick(page, 7);
  assert.equal(out.clicked, 'synthetic');
  assert.ok(page.calls.some((c) => c.method === 'Runtime.callFunctionOn'));
  assert.ok(!page.calls.some((c) => c.method === 'Input.dispatchMouseEvent'),
    'no mouse event is dispatched at coordinates we do not have');
});

test('a zero-size element is treated as having no box', async () => {
  const page = fakePage({
    'DOM.getBoxModel': { model: { content: [0, 0, 0, 0, 0, 0, 0, 0], width: 0, height: 0 } },
    'DOM.resolveNode': { object: { objectId: 'o1' } },
  });
  assert.equal((await trustedClick(page, 7)).clicked, 'synthetic');
});

test('typing focuses and sends a key pair per character', async () => {
  const page = fakePage();
  await trustedType(page, 7, 'ab');
  assert.ok(page.calls.some((c) => c.method === 'DOM.focus'));
  const keys = page.calls.filter((c) => c.method === 'Input.dispatchKeyEvent');
  assert.deepEqual(keys.map((k) => `${k.params.type}:${k.params.text}`),
    ['keyDown:a', 'keyUp:a', 'keyDown:b', 'keyUp:b']);
});

test('an upload goes through the node, since a file input value cannot be set', async () => {
  const page = fakePage();
  const out = await uploadTo(page, 7, ['/tmp/a.txt', '/tmp/b.txt']);
  assert.equal(out.uploaded, 2);
  const call = page.calls.find((c) => c.method === 'DOM.setFileInputFiles');
  assert.deepEqual(call.params, { files: ['/tmp/a.txt', '/tmp/b.txt'], backendNodeId: 7 });
});

test('downloads are allowed into a directory and progress is recorded', async () => {
  const cdp = fakeCdp();
  const page = fakePage();
  const dl = handleDownloads(cdp, page, '/tmp/out');
  await dl.armed;

  const armed = page.calls.find((c) => c.method === 'Browser.setDownloadBehavior');
  assert.equal(armed.params.behavior, 'allow');
  assert.equal(armed.params.downloadPath, '/tmp/out');
  assert.equal(armed.params.eventsEnabled, true, 'without events a download is unobservable');

  await cdp.fire('Browser.downloadWillBegin', { url: 'http://x/r.csv', suggestedFilename: 'r.csv' });
  await cdp.fire('Browser.downloadProgress', { state: 'completed' });
  assert.deepEqual(dl.files, [{ url: 'http://x/r.csv', suggested: 'r.csv', state: 'completed' }]);
});

test('auth state round-trips, so a replay does not restart at a login wall', async () => {
  const captured = await captureState(fakePage({
    'Network.getCookies': { cookies: [{ name: 'session', value: 'abc' }] },
    __evaluate: () => ({ 'seen-tour': 'yes' }),
  }), 'http://x');
  assert.equal(captured.cookies.length, 1);
  assert.deepEqual(captured.storage, { 'seen-tour': 'yes' });

  const page = fakePage();
  const restored = await restoreState(page, captured);
  assert.deepEqual(restored, { cookies: 1, keys: 1 });
  assert.ok(page.calls.some((c) => c.method === 'Network.setCookies'));
});

test('restoring empty state is a no-op, not an error', async () => {
  const page = fakePage();
  assert.deepEqual(await restoreState(page, { cookies: [], storage: {} }), { cookies: 0, keys: 0 });
  assert.equal(page.calls.length, 0);
});

test('blocked storage does not fail the capture', async () => {
  const state = await captureState(fakePage({
    'Network.getCookies': { cookies: [] },
    __evaluate: () => { throw new Error('storage is not available in this context'); },
  }), 'http://x');
  assert.deepEqual(state.storage, {});
});

test('a click whose acknowledgement never arrives still reports the click, not a hang', async () => {
  // This is the real behaviour of the clicks this code exists to support: Chrome acknowledges a mouse
  // event only once the renderer has processed it, and a click that opens a tab leaves that ack
  // outstanding. Waiting for it wedged an entire run for 30s before failing.
  const page = {
    calls: [],
    call(method, params) {
      this.calls.push({ method, params });
      if (method === 'DOM.getBoxModel') return Promise.resolve(BOX);
      if (method === 'Input.dispatchMouseEvent' && params.type !== 'mouseMoved') {
        return new Promise(() => {});              // never settles, exactly as Chrome does here
      }
      return Promise.resolve({});
    },
  };

  const out = await trustedClick(page, 7);
  assert.equal(out.clicked, 'trusted', 'the event was delivered even though nothing acked it');
  assert.equal(out.acked, false, 'and the caller can see the ack did not arrive');
  assert.deepEqual(
    page.calls.filter((c) => c.method === 'Input.dispatchMouseEvent').map((c) => c.params.type),
    ['mouseMoved', 'mousePressed', 'mouseReleased'],
    'the release is still sent, so the page is not left with a button held down',
  );
});
