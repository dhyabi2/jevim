// A headless session backed by real Chrome.
//
// The jsdom session is replaced rather than supplemented. It reported 383 indexable elements on
// wikipedia.org where Chrome sees 32, so any number it produced was untrustworthy; the accessibility
// tree scores 33 on the same page. Keeping both would mean keeping a path that lies.
//
// The interface matches the jsdom session, so the runner, driver, bindings, artifacts and every use case
// work against it unchanged. What differs is underneath: there is no local DOM, so entries carry a
// `backendDOMNodeId` and every action and every gate check goes back through CDP to the page.

import { createBindings, memoryStore } from '../src/grammar/bindings.js';
import { createDriver } from '../src/driver.js';
import { createRunner } from '../src/grammar/runner.js';
import { createRepair } from '../src/resolve/repair.js';
import { serialize } from '../src/index/serialize.js';
import { axIndex } from './ax-index.mjs';
import { sameName } from '../src/index/samename.js';
import { revealAllCdp } from './reveal.mjs';
import { blockPrivateAddresses, connect, launch, open } from './cdp.mjs';
import { captureState, handleDialogs, handleDownloads, restoreState, trackTabs,
         trustedClick, trustedType, uploadTo } from './cdp-hardening.mjs';

/** Call a function with the node as `this`, which is the simplest reliable way to act on it. */
async function onNode(page, backendNodeId, body, args = []) {
  const { object } = await page.call('DOM.resolveNode', { backendNodeId });
  try {
    const out = await page.call('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: body,
      arguments: args.map((v) => ({ value: v })),
      returnByValue: true,
      awaitPromise: true,
    });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || 'call failed');
    return out.result.value;
  } finally {
    await page.call('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
  }
}

function createCdpOps(page) {
  return {
    // Real input events, not element.click(). Without user activation a target="_blank" link opens
    // nothing at all, and any page that checks event.isTrusted ignores the click entirely.
    goto: (entry) => trustedClick(page, entry.backendDOMNodeId),
    yank: (entry) => onNode(page, entry.backendDOMNodeId,
      'function(){ return (this.getAttribute && this.getAttribute("href")) || this.value || this.textContent || ""; }'),
    change: (entry) => onNode(page, entry.backendDOMNodeId,
      'function(){ if (this.focus) this.focus(); if ("value" in this) { this.value = ""; this.dispatchEvent(new Event("input",{bubbles:true})); } return "cleared"; }'),
    type: (entry, text) => trustedType(page, entry.backendDOMNodeId, text),
    dismiss: (entry) => onNode(page, entry.backendDOMNodeId,
      'function(){ this.style.display = "none"; return "hidden"; }'),
    select: (entry) => onNode(page, entry.backendDOMNodeId,
      'function(){ return this.textContent || ""; }'),
  };
}

/**
 * The gate, over CDP.
 *
 * Same contract as the DOM gate: identity is re-checked immediately before the action. Here that means
 * asking Chrome for the node's accessibility entry again and comparing role and name - so the check is
 * against the engine's own current view rather than a cached approximation.
 *
 * It is async, unlike the DOM gate, because the answer lives in the browser.
 */
function createCdpGate(page) {
  return async function gate(entry) {
    if (!entry.backendDOMNodeId) return { ok: false, reason: 'target has no node id' };
    let partial;
    try {
      partial = await page.call('Accessibility.getPartialAXTree',
        { backendNodeId: entry.backendDOMNodeId, fetchRelatives: false });
    } catch {
      return { ok: false, reason: 'target left the document' };
    }
    const node = (partial.nodes || []).find((n) => n.backendDOMNodeId === entry.backendDOMNodeId)
      || (partial.nodes || [])[0];
    if (!node) return { ok: false, reason: 'target left the document' };
    if (node.ignored) return { ok: false, reason: 'target is no longer visible' };

    const role = String(node.role && node.role.value || '').toLowerCase();
    const name = String(node.name && node.name.value || '').trim();
    if (role !== entry.role) return { ok: false, reason: 'target role changed' };
    if (!sameName(entry.name, name)) return { ok: false, reason: 'target name changed' };

    // Still rendered? A node can keep its role and name while losing its box.
    try {
      const { model } = await page.call('DOM.getBoxModel', { backendNodeId: entry.backendDOMNodeId });
      const [x1, y1, , , x3, y3] = model.border;
      if (Math.abs(x3 - x1) < 3 || Math.abs(y3 - y1) < 3) {
        return { ok: false, reason: 'target is no longer visible' };
      }
    } catch {
      return { ok: false, reason: 'target is no longer visible' };
    }
    return { ok: true, reason: '' };
  };
}

/**
 * Open a Chrome-backed session.
 *
 * Owns the browser unless one is handed in, so a benchmark can share a single Chrome across hundreds of
 * pages instead of paying a launch each time.
 */
export async function openCdpSession(url, { store = memoryStore(), resolver = null, decide = null,
                                            chrome = null, cdp = null, headless = true,
                                            acceptDialogs = false, downloadTo = null,
                                            state = null, isolate = false } = {}) {
  const ownsChrome = !chrome;
  const browser = chrome || await launch({ headless });
  const client = cdp || await connect(browser.endpoint);
  // Sharing a Chrome: each session gets a browser context of its own, disposed when it closes, so
  // visitors sharing the process share nothing else (cookies, storage, cache, permissions).
  const context = isolate && !ownsChrome
    ? (await client.send('Target.createBrowserContext', { disposeOnDetach: true })).browserContextId : undefined;
  let page = await open(client, url, { browserContextId: context });

  // Armed before anything is clicked. A dialog blocks the page AND every command queued behind it, so
  // handling one after it appears is already too late.
  // `page` is replaced by goTo and followNewTab. Everything that lives for the whole session - the ops,
  // the gate, the dialog and download handlers - goes through `live`, which always forwards to the
  // current one. Handing them `page` itself pinned them to the first tab: after a navigation the clicks
  // went to a page the session was no longer reading, and a bench comparing two runs could not tell,
  // because both runs were wrong the same way.
  const live = {
    call: (method, params) => page.call(method, params),
    evaluate: (expression) => page.evaluate(expression),
  };

  const dialogs = handleDialogs(client, live, { accept: acceptDialogs });
  const tabs = trackTabs(client);
  await tabs.ready;
  const downloads = downloadTo ? handleDownloads(client, live, downloadTo) : null;
  if (downloads) await downloads.armed;
  if (state) await restoreState(page, state);
  tabs.clear();

  let index = [];
  let stale = true;
  const site = new URL(url).hostname;

  async function refresh() {
    if (!stale) return index;
    const out = await axIndex(page);
    index = out.index;
    stale = false;
    return index;
  }
  await refresh();

  const bindings = createBindings(store);
  const ops = createCdpOps(live);
  const runner = createRunner({
    site, bindings,
    // Ops here take the entry rather than an element, because there is no element on this side.
    ops: Object.fromEntries(Object.entries(ops).map(([verb, fn]) => [verb, (_el, entry) => fn(entry)])),
    getIndex: () => index,
    resolver,
    gate: createCdpGate(live),
    repair: decide ? createRepair({ decide }) : null,
  });

  return {
    site,
    get index() { return index; },
    get page() { return { url: page.url || url }; },
    bindings,
    runner,
    driver: createDriver({ runner }),
    refresh: async () => { stale = true; return refresh(); },

    /**
     * Scroll the page and merge what appears, so a motion can reach row 400 of a virtualised list.
     * The merged index replaces the current one, and `complete` says whether the list ran out.
     */
    async reveal(options = {}) {
      const out = await revealAllCdp(page, async () => {
        const fresh = await axIndex(page);
        return fresh.index;
      }, options);
      index = out.index;
      stale = false;
      return { revealed: out.index.length, steps: out.steps, complete: out.complete };
    },

    /** What blocked, what opened, what downloaded - the things a script otherwise cannot observe. */
    get events() {
      return {
        dialogs: dialogs.seen,
        tabsOpened: tabs.opened.map((t) => ({ url: t.url, title: t.title })),
        downloads: downloads ? downloads.files : [],
      };
    },

    /** Follow a click that opened a tab. Without this the run continues against the wrong page. */
    async followNewTab() {
      const adopted = await tabs.adopt(async (targetId) => {
        const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
        const call = (method, params) => client.send(method, params, sessionId);
        await call('Page.enable'); await call('Runtime.enable');
        await call('DOM.enable'); await call('Accessibility.enable');
        await call('Network.enable'); await blockPrivateAddresses(call, client, sessionId);
        return { sessionId, call,
          evaluate: async (expression) => {
            const out = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
            return out.result.value;
          },
          close: () => client.send('Target.closeTarget', { targetId }) };
      });
      if (!adopted) return null;
      page = adopted;
      tabs.clear();
      stale = true;
      await refresh();
      return { adopted: true, indexed: index.length };
    },

    upload: (entry, paths) => uploadTo(page, entry.backendDOMNodeId, paths),
    // Exposed so a caller can act on one entry without going through the grammar, and so the browser
    // can be shared between sessions instead of launching Chrome once per page.
    ops,
    chrome: browser,
    cdp: client,
    evaluate: (expression) => page.evaluate(expression),
    // The live page handle, for the authoring-time tools (vision) that need CDP directly. Named `raw`
    // so nothing in the hot path reaches for it by accident.
    get rawPage() { return page; },
    title: () => page.evaluate('document.title'),
    captureState: () => captureState(page, new URL(url).origin),
    async goTo(next) {
      await page.close();
      page = await open(client, next);
      stale = true;
      await refresh();
    },
    snapshot() {
      const out = serialize(index);
      return {
        url, layout: 'chrome', indexed: index.length, tokens: out.tokens, budget: out.budget,
        dropped: out.dropped, suspect: index.filter((e) => e.suspect).length,
        netCalls: runner.net.calls,
      };
    },
    async close() {
      dialogs.stop();
      tabs.stop();
      if (downloads) downloads.stop();
      await page.close().catch(() => {});
      if (context) await client.send('Target.disposeBrowserContext', { browserContextId: context }).catch(() => {});
      if (!cdp) client.close();
      if (ownsChrome) await browser.close();
    },
  };
}
