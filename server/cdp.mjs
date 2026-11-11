// A real browser, driven over the Chrome DevTools Protocol.
//
// jsdom was the wrong substrate and the numbers said so: it never fetches stylesheets, so wikipedia.org
// yielded 383 indexable elements against Chrome's 32. Geometry is most of the collector's pruning power,
// which means every headless measurement taken through jsdom was untrustworthy.
//
// CDP also reaches what a content script never can:
//
//   DOM.getDocument with pierce:true    closed shadow roots, and cross-origin frames
//   Accessibility.getFullAXTree         roles and names computed by Chrome itself, rather than the
//                                      approximation of the spec in accname.js
//
// No dependency: CDP is a WebSocket carrying JSON, and node has a WebSocket client built in.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** The user agent this Chrome would send if it were not headless, from its own version number. */
let cachedUserAgent = null;
function userAgent() {
  // Asked once per process: `chrome --version` starts a Chrome to print a line, and a server that
  // launches a browser per run was paying for that every time.
  if (cachedUserAgent) return cachedUserAgent;
  let major = '140';
  try {
    const out = execFileSync(CHROME, ['--version'], { encoding: 'utf8', timeout: 10000 });
    major = (out.match(/(\d+)\./) || [])[1] || major;
  } catch { /* keep the default */ }
  const platform = process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7'
    : process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  cachedUserAgent = `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  return cachedUserAgent;
}

// Requests a public deployment must never make on a visitor's behalf: this machine, its private network,
// and cloud metadata. Only applied when JEVIM_BLOCK_PRIVATE=1, so local development still reaches
// localhost test pages. The container the public service runs in is the first line; this is the second.
export const PRIVATE_URL_PATTERNS = [
  '*://localhost*', '*://127.*', '*://0.0.0.0*', '*://[::1]*', '*://[fc*', '*://[fd*', '*://[fe80*',
  '*://10.*', '*://192.168.*', '*://169.254.*', '*://100.64.*',
  ...Array.from({ length: 16 }, (_, i) => `*://172.${16 + i}.*`),
  '*://metadata.google.internal*',
];

/**
 * Fail every request to a private address in this tab, top-level navigations included.
 *
 * Network.setBlockedURLs looked like the tool for this and is not: it let a navigation to
 * http://127.0.0.1 load. The Fetch domain pauses each matching request before it is sent, and it is
 * failed there. `cdp` is the connection, `sessionId` the tab's session, `call` sends within it.
 */
// What an agent never needs and a page spends most of its CPU and memory on: ad auctions, trackers,
// session recorders, and video. Images stay - the agent's screenshots need them. On with JEVIM_BLOCK_HEAVY=1.
export const HEAVY_URL_PATTERNS = [
  ...['doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.com',
      'google-analytics.com', 'amazon-adsystem.com', 'adnxs.com', 'criteo.com', 'criteo.net', 'taboola.com',
      'outbrain.com', 'scorecardresearch.com', 'quantserve.com', 'hotjar.com', 'mixpanel.com', 'segment.io',
      'doubleverify.com', 'adsafeprotected.com', 'moatads.com', 'rubiconproject.com', 'pubmatic.com', 'openx.net',
      'casalemedia.com', 'teads.tv', '3lift.com', 'smartadserver.com', 'adform.net', 'media.net', 'rlcdn.com',
      'demdex.net', 'nr-data.net', 'fullstory.com', 'clarity.ms', 'bat.bing.com', 'analytics.tiktok.com',
      'ct.pinterest.com', 'px.ads.linkedin.com', 'ads-twitter.com', 'mc.yandex.ru', 'connect.facebook.net',
      'adsrvr.org', 'yieldmo.com', 'sharethrough.com', 'bidswitch.net', 'imasdk.googleapis.com']
    .flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]),
  '*.mp4', '*.mp4?*', '*.webm', '*.webm?*', '*.m3u8', '*.m3u8?*', '*.mpd', '*.m4s', '*.mov',
];

export async function blockPrivateAddresses(call, cdp = null, sessionId = null) {
  const heavy = process.env.JEVIM_BLOCK_HEAVY === '1' ? HEAVY_URL_PATTERNS : [];
  if (process.env.JEVIM_BLOCK_PRIVATE !== '1') {
    if (heavy.length) await call('Network.setBlockedURLs', { urls: heavy }).catch(() => null);
    return;
  }
  await call('Network.setBlockedURLs', { urls: [...PRIVATE_URL_PATTERNS, ...heavy] }).catch(() => null);
  if (!cdp) return;
  cdp.on('Fetch.requestPaused', (params, sid) => {
    if (sid !== sessionId) return;
    cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => null);
  });
  await call('Fetch.enable', { patterns: PRIVATE_URL_PATTERNS.map((urlPattern) => ({ urlPattern })) }).catch(() => null);
}

/** Launch a throwaway Chrome. A fresh user-data-dir every time, so no real profile is touched. */
export async function launch({ port = 0, headless = true, timeoutMs = 20000, stealth = true } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'jevim-chrome-'));
  const args = [
    headless ? '--headless=new' : '',
    // Pages that fight back start by asking whether they are automated. Headless Chrome answers twice:
    // navigator.webdriver is true, and the user agent says "HeadlessChrome". Cloudflare and Akamai then
    // serve a challenge or a 403 before the page exists. These are the same switches browser-use
    // launches with; set at launch they cover every tab, popup and worker, including the first request.
    ...(stealth ? ['--disable-blink-features=AutomationControlled', `--user-agent=${userAgent()}`] : []),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-sync', '--mute-audio',
    '--window-size=1280,900',
    // Chrome otherwise starts its bundled extensions' background pages, which no run uses.
    '--disable-component-extensions-with-background-pages', '--disable-default-apps',
    // Deployment-specific switches, e.g. inside a container: JEVIM_CHROME_ARGS="--no-sandbox --disable-dev-shm-usage".
    ...(process.env.JEVIM_CHROME_ARGS || '').split(/\s+/).filter(Boolean),
    // The startup tab. Left to itself Chrome opens its New Tab page there, which loads a Google iframe
    // over the network while the run's own first page is trying to load.
    'about:blank',
  ].filter(Boolean);

  const child = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  // Chrome outlives the process that launched it unless something kills it. A benchmark that times a
  // run out with process.exit leaked one Chrome per run, 295 processes in one evening, until new
  // pages could no longer navigate. Whatever ends this process ends its Chrome too.
  const reap = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
  process.once('exit', reap);
  const onSignal = {};
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    onSignal[signal] = () => { reap(); process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 })[signal]); };
    process.once(signal, onSignal[signal]);
  }
  // Every handler goes when this Chrome does. A long-running server launches one Chrome per run, and
  // leaving the signal handlers behind grew the process's listener lists without bound.
  child.once('exit', () => {
    process.removeListener('exit', reap);
    for (const [signal, handler] of Object.entries(onSignal)) process.removeListener(signal, handler);
  });

  // An exit handler cannot run when this process is SIGKILLed - which is exactly how a harness ends a
  // run that overstayed its limit - and the Chrome then lives on. Three such Chromes, each with a
  // renderer frozen in an infinite loop by a test page, burned eight hours of CPU and starved every
  // later Chrome until even example.com timed out. So a detached watchdog holds a pipe to this process;
  // the pipe closes however this process dies, and the watchdog kills Chrome and its profile.
  const watchdog = spawn(process.execPath, ['-e', `
    const pid = Number(process.argv[1]);
    process.stdin.resume();
    process.stdin.on('end', () => { try { process.kill(pid, 'SIGKILL'); } catch {} process.exit(0); });
    process.stdin.on('error', () => { try { process.kill(pid, 'SIGKILL'); } catch {} process.exit(0); });
    setInterval(() => { try { process.kill(pid, 0); } catch { process.exit(0); } }, 5000);
  `, String(child.pid)], { stdio: ['pipe', 'ignore', 'ignore'], detached: true });
  watchdog.unref();
  child.once('exit', () => { try { watchdog.kill(); } catch { /* gone */ } });

  // Chrome prints the actual port on stderr, which is how port 0 is resolved.
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('chrome did not report a debug port in time')), timeoutMs);
    let buffered = '';
    child.stderr.on('data', (chunk) => {
      buffered += chunk.toString();
      const found = buffered.match(/DevTools listening on (ws:\/\/\S+)/);
      if (found) { clearTimeout(timer); resolve(found[1]); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`chrome exited with ${code}`)); });
  });

  return {
    endpoint,
    async close() {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      await new Promise((r) => setTimeout(r, 120));
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

/** A CDP session: send a command, await its reply, subscribe to events. */
export async function connect(endpoint) {
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('cdp socket failed')), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  const pendingMethod = new Map();

  socket.addEventListener('message', (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      const method = pendingMethod.get(message.id);
      pendingMethod.delete(message.id);
      // The method is in the message so the failure names itself: a bare "Session with given id not
      // found" gives no way to tell which command was talking to a dead session.
      if (message.error) reject(new Error(`${method || 'cdp'}: ${message.error.message} (${message.error.code})`));
      else resolve(message.result);
      return;
    }
    const handlers = listeners.get(message.method);
    // The session id rides along, so a handler serving one tab can ignore another tab's events.
    if (handlers) for (const handler of handlers) handler(message.params, message.sessionId);
  });

  function send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      pendingMethod.set(id, method);
      socket.send(JSON.stringify(payload));
      // A hung command would otherwise wedge the whole run.
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); pendingMethod.delete(id); reject(new Error(`${method} timed out`)); }
      }, timeoutMs);
    });
  }

  function on(method, handler) {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(handler);
    return () => listeners.get(method).delete(handler);
  }

  return { send, on, close: () => socket.close() };
}

// ---- knowing when a page has stopped moving -----------------------------------------------------------
//
// The first version waited a fixed 400 ms after every action and then polled document.body.innerHTML.length
// every 250 ms until it read the same twice. That cost about a second per action when nothing was
// happening, serialised the whole DOM four times a second on a large page, and still missed any change
// that kept the length the same. What follows asks the page and the network directly instead:
//
//   mutations   a MutationObserver armed BEFORE the action, so what the action did synchronously counts
//   network     requests in flight for this tab, from CDP's own events
//   navigation  the main frame committing a new document, which invalidates the observer
//
// An action is settled when the document is complete, nothing has mutated for `quietMs`, and no request
// is in flight. An action that produced no sign of life at all is watched for `idleMs` before it is
// believed, because a bare timer gives no other warning that something is about to render.

export const SETTLE = {
  quietMs: Number(process.env.JEVIM_SETTLE_QUIET_MS || 120),
  idleMs: Number(process.env.JEVIM_SETTLE_IDLE_MS || 400),
  ceilingMs: Number(process.env.JEVIM_SETTLE_CEILING_MS || 8000),
};
// A fresh document gets a longer quiet window: frameworks hydrate in bursts with gaps between them.
export const SETTLE_NAV = { quietMs: 250, idleMs: 250 };

// Requests that never finish, or whose finishing changes nothing the agent can see.
const BACKGROUND_TYPES = new Set(['WebSocket', 'EventSource', 'Media', 'Ping', 'Preflight', 'CSPViolationReport', 'Prefetch']);
// A request still open after this long is a long-poll or a stream, not something to wait out.
const REQUEST_STALE_MS = 4000;

// Lives in the page only as an object this side holds a handle to: no global, nothing a page can detect.
// `style` attribute changes are ignored - an animation writes them every frame and never goes quiet.
const WATCHER = `(() => {
  const s = { n: 0, last: 0 };
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes' && r.attributeName === 'style') continue;
      s.n += 1; s.last = performance.now();
    }
  });
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  // Typing, ticking a box and choosing an option change a property, not the tree, so no mutation is
  // recorded for them. Their events are the sign that the action landed.
  const note = () => { s.n += 1; s.last = performance.now(); };
  for (const type of ['input', 'change', 'submit']) document.addEventListener(type, note, true);
  s.wait = (quiet, idle, ceiling) => new Promise((resolve) => {
    const t0 = performance.now();
    const tick = () => {
      const now = performance.now();
      const ready = document.readyState === 'complete';
      const calm = s.n === 0 ? now - t0 >= idle : now - s.last >= quiet;
      if ((ready && calm) || now - t0 >= ceiling) { resolve({ n: s.n, ready }); return; }
      setTimeout(tick, 16);
    };
    tick();
  });
  s.stop = () => { mo.disconnect(); for (const type of ['input', 'change', 'submit']) document.removeEventListener(type, note, true); };
  return s;
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A handle on one attached tab: commands, evaluation, and the settling described above.
 *
 * Everything it listens to is filtered to this tab's session and removed on close. The first version
 * counted every tab's requests in one number and never removed a listener, so in a Chrome shared between
 * runs one visitor's traffic kept another visitor's page from ever looking quiet.
 */
export function attach(cdp, targetId, sessionId) {
  const call = (method, params, timeoutMs) => cdp.send(method, params, sessionId, timeoutMs);
  const inflight = new Map();
  let navigations = 0;
  let onNavigate = [];
  const offs = [
    cdp.on('Network.requestWillBeSent', (p, sid) => {
      if (sid !== sessionId || BACKGROUND_TYPES.has(p.type)) return;
      inflight.set(p.requestId, Date.now());
    }),
    cdp.on('Network.loadingFinished', (p, sid) => { if (sid === sessionId) inflight.delete(p.requestId); }),
    cdp.on('Network.loadingFailed', (p, sid) => { if (sid === sessionId) inflight.delete(p.requestId); }),
    cdp.on('Page.frameNavigated', (p, sid) => {
      if (sid !== sessionId || p.frame.parentId) return;
      navigations += 1;
      inflight.clear();              // the old document's requests died with it
      const waiting = onNavigate; onNavigate = [];
      for (const wake of waiting) wake();
    }),
  ];
  const busy = () => {
    const now = Date.now();
    for (const [id, at] of inflight) if (now - at > REQUEST_STALE_MS) inflight.delete(id);
    return inflight.size > 0;
  };

  async function arm() {
    const out = await call('Runtime.evaluate', { expression: WATCHER, returnByValue: false }, 5000);
    if (out.exceptionDetails || !out.result.objectId) throw new Error('watcher did not start');
    return { objectId: out.result.objectId, navigations };
  }
  const disarm = (watcher) => {
    if (!watcher) return;
    call('Runtime.callFunctionOn', { objectId: watcher.objectId, functionDeclaration: 'function(){ this.stop(); }' }, 5000)
      .then(() => call('Runtime.releaseObject', { objectId: watcher.objectId }, 5000)).catch(() => null);
  };

  /** Wait until the page has stopped moving. `armed` is a watcher started before the action, if any. */
  async function settled({ quietMs = SETTLE.quietMs, idleMs = SETTLE.idleMs, ceilingMs = SETTLE.ceilingMs } = {}, armed = null) {
    const end = Date.now() + ceilingMs;
    let watcher = armed;
    let idle = idleMs;
    let quiet = quietMs;
    try {
      for (;;) {
        const left = end - Date.now();
        if (left <= 0) return { settled: false };
        // The document the watcher was armed in is gone: whatever it saw no longer describes the page.
        if (watcher && watcher.navigations !== navigations) { watcher = null; }
        if (!watcher) {
          quiet = Math.max(quiet, SETTLE_NAV.quietMs);
          idle = quiet;
          try { watcher = await arm(); } catch { await sleep(30); continue; }
        }
        let navigated = false;
        const nav = new Promise((resolve) => { onNavigate.push(() => { navigated = true; resolve(null); }); });
        const waited = call('Runtime.callFunctionOn', {
          objectId: watcher.objectId, returnByValue: true, awaitPromise: true,
          functionDeclaration: `function(){ return this.wait(${quiet}, ${idle}, ${left}); }`,
        }, left + 2000).then((out) => (out.exceptionDetails ? null : out.result.value), () => null);
        const seen = await Promise.race([waited, nav, sleep(left + 100).then(() => 'late')]);
        if (seen === 'late') return { settled: false };
        if (navigated || seen === null) { watcher = null; await sleep(10); continue; }
        if (busy()) {
          // A response is on its way and the page will render it: wait for it, then for the render.
          while (busy() && Date.now() < end && watcher.navigations === navigations) await sleep(15);
          idle = quiet;
          continue;
        }
        return { settled: true, mutations: seen.n };
      }
    } finally { disarm(watcher); }
  }

  return {
    targetId,
    sessionId,
    call,
    /** Evaluate in the page and return a JSON-serialisable result. */
    async evaluate(expression) {
      const out = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (out.exceptionDetails) throw new Error(out.exceptionDetails.text || 'evaluate failed');
      return out.result.value;
    },
    /**
     * Start watching before an action; `settled()` on what comes back waits for the action's effects.
     * Never throws: on a page that cannot be watched right now, the wait arms itself afterwards.
     */
    async watch() {
      const watcher = await arm().catch(() => null);
      return { settled: (options) => settled(options, watcher) };
    },
    settled,
    busy,
    async close() {
      for (const off of offs) off();
      await cdp.send('Target.closeTarget', { targetId });
    },
    detach() { for (const off of offs) off(); },
  };
}

/** Attach to a tab and switch on the domains every session uses. */
export async function attachTarget(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const page = attach(cdp, targetId, sessionId);
  // One wave, not five round trips: CDP runs a session's commands in the order they arrive.
  await Promise.all([
    page.call('Page.enable'), page.call('Runtime.enable'), page.call('Network.enable'),
    page.call('DOM.enable'), page.call('Accessibility.enable'),
  ]);
  await blockPrivateAddresses(page.call, cdp, sessionId);
  return page;
}

/**
 * Open a page and wait for it to settle.
 *
 * The load event is not enough, because a page that renders after its own fetches is still moving when
 * `load` fires; see `settled` for what "settled" means.
 */
export async function open(cdp, url, { ceilingMs = 15000, browserContextId = undefined } = {}) {
  // With a browserContextId the tab lives in its own context - separate cookies, storage and cache -
  // inside a Chrome other sessions share.
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', ...(browserContextId ? { browserContextId } : {}) });
  const page = await attachTarget(cdp, targetId);

  // A target created while another tab is foreground is a BACKGROUND tab, and Chrome throttles
  // background navigation hard enough that Page.navigate simply does not return - it hung for the full
  // 30s command timeout. Activating first is what makes a session opened after another one work at all.
  await cdp.send('Target.activateTarget', { targetId }).catch(() => null);

  // Page.navigate answers when the navigation commits, which on a slow connection or a heavy site can
  // take longer than the 30 s every other command gets: one run in six on WebVoyager failed right here,
  // before the agent took a step, where browser-use waited and loaded the page. So it gets 60 s, and one
  // retry after stopping whatever stalled.
  for (let attempt = 1; ; attempt++) {
    try {
      await page.call('Page.navigate', { url }, 60000);
      break;
    } catch (error) {
      if (attempt >= 2 || !/timed out/.test(error.message)) throw error;
      await page.call('Page.stopLoading').catch(() => null);
    }
  }
  if (url !== 'about:blank') await page.settled({ ...SETTLE_NAV, ceilingMs });
  return page;
}
