// The things real applications do that break automation.
//
// Each of these was listed in the technical plan as an open hardening item, and each is a capability
// browser-use already has. None is interesting; all of them decide whether a script survives contact
// with a real site.
//
//   dialogs    alert, confirm and prompt block the page and every subsequent command with it
//   tabs       a click that opens a tab loses the session unless the new target is adopted
//   uploads    a file input cannot be typed into; the picker is native
//   downloads  a click that downloads silently does nothing observable
//   auth       cookies and storage must survive a replay or every script starts at a login wall

/**
 * Intercept dialogs before they can block.
 *
 * A native dialog stops the page AND every queued CDP command behind it, so this must be armed before
 * anything is clicked rather than handled once one appears. The default is to dismiss: a script that
 * did not ask for a confirmation should not silently accept one.
 */
export function handleDialogs(cdp, page, { accept = false, promptText = '' } = {}) {
  const seen = [];
  const off = cdp.on('Page.javascriptDialogOpening', async (params) => {
    seen.push({ type: params.type, message: params.message, at: new Date().toISOString() });
    try {
      await page.call('Page.handleJavaScriptDialog', { accept, promptText });
    } catch { /* it closed itself */ }
  });
  return { seen, stop: off };
}

/**
 * Follow a click that opens a new tab.
 *
 * Without this the run continues against the original page while the work happens somewhere the session
 * cannot see. Returns the adopted target, or null when nothing opened.
 */
export function trackTabs(cdp) {
  const opened = [];
  const off = cdp.on('Target.targetCreated', (params) => {
    if (params.targetInfo.type === 'page') opened.push(params.targetInfo);
  });
  // Without discovery turned on, Target.targetCreated never fires and a tab opens unnoticed. It is
  // browser-scoped, so it is sent with no sessionId.
  const ready = cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => null);

  return {
    opened,
    ready,
    stop: off,
    /** Attach to the most recently opened tab and return a page handle for it. */
    async adopt(open) {
      const latest = opened[opened.length - 1];
      if (!latest) return null;
      return open(latest.targetId);
    },
    clear() { opened.length = 0; },
  };
}

/**
 * Put a file into a file input.
 *
 * The native picker cannot be driven, and a file input's value cannot be set from script - the browser
 * forbids it. `DOM.setFileInputFiles` is the only way, and it needs the node rather than a selector.
 */
export async function uploadTo(page, backendNodeId, paths) {
  await page.call('DOM.setFileInputFiles', { files: paths, backendNodeId });
  return { uploaded: paths.length };
}

/**
 * Accept downloads into a directory and report what arrived.
 *
 * A click that triggers a download otherwise produces no observable effect at all, so a script cannot
 * tell success from silence.
 */
export function handleDownloads(cdp, page, directory) {
  const files = [];
  const offBegin = cdp.on('Browser.downloadWillBegin', (params) => {
    files.push({ url: params.url, suggested: params.suggestedFilename, state: 'started' });
  });
  const offProgress = cdp.on('Browser.downloadProgress', (params) => {
    const entry = files[files.length - 1];
    if (entry && params.state) entry.state = params.state;
  });

  const armed = page.call('Browser.setDownloadBehavior', {
    behavior: 'allow', downloadPath: directory, eventsEnabled: true,
  }).catch(() => null);

  return { files, armed, stop: () => { offBegin(); offProgress(); } };
}

/**
 * Carry authenticated state across a replay.
 *
 * Every script otherwise begins at a login wall, which makes the whole replay claim useless for anything
 * behind a sign-in. Cookies are the portable part; localStorage is per-origin and is captured separately.
 */
export async function captureState(page, origin) {
  const { cookies } = await page.call('Network.getCookies');
  let storage = {};
  try {
    storage = await page.evaluate(`
      (() => { try {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          out[k] = localStorage.getItem(k);
        }
        return out;
      } catch { return {}; } })()
    `);
  } catch { /* storage blocked */ }
  return { origin, cookies, storage };
}

export async function restoreState(page, state) {
  if (state.cookies && state.cookies.length) {
    await page.call('Network.setCookies', { cookies: state.cookies });
  }
  if (state.storage && Object.keys(state.storage).length) {
    const json = JSON.stringify(state.storage);
    await page.evaluate(`
      (() => { try {
        const data = ${json};
        for (const k of Object.keys(data)) localStorage.setItem(k, data[k]);
        return true;
      } catch { return false; } })()
    `);
  }
  return { cookies: (state.cookies || []).length, keys: Object.keys(state.storage || {}).length };
}

/**
 * A trusted click: real input events at the element's centre, not `element.click()`.
 *
 * The difference is user activation. A synthetic click carries none, so Chrome refuses to open the tab
 * a `target="_blank"` link asks for, and a page that checks `event.isTrusted` - which is exactly what
 * anti-bot and payment widgets do - ignores it. This is the same route a human's click takes.
 *
 * Falls back to the synthetic click when the element has no box to aim at: an element scrolled into a
 * clipped container still needs to be actionable, and a refused click is worse than an untrusted one.
 */
export async function trustedClick(page, backendNodeId, { scroll = true } = {}) {
  if (scroll) {
    await page.call('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => null);
  }

  let point = null;
  try {
    const { model } = await page.call('DOM.getBoxModel', { backendNodeId });
    const q = model.content;                                  // x1,y1 x2,y2 x3,y3 x4,y4
    const x = (q[0] + q[2] + q[4] + q[6]) / 4;
    const y = (q[1] + q[3] + q[5] + q[7]) / 4;
    if (model.width > 0 && model.height > 0) point = { x, y };
  } catch { /* no box: detached, or display:none */ }

  if (!point) {
    const { object } = await page.call('DOM.resolveNode', { backendNodeId });
    await page.call('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: 'function(){ if (this.focus) this.focus(); this.click(); }',
    });
    return { clicked: 'synthetic', reason: 'no box to aim at' };
  }

  const base = { ...point, button: 'left', buttons: 1, clickCount: 1 };
  await dispatch(page, { type: 'mouseMoved', ...point, buttons: 0 });
  const pressed = await dispatch(page, { type: 'mousePressed', ...base });
  const released = await dispatch(page, { type: 'mouseReleased', ...base });
  return { clicked: 'trusted', at: point, acked: pressed && released };
}

// How long to wait for an input command's acknowledgement before carrying on.
//
// Chrome acknowledges Input.dispatchMouseEvent only once the renderer has processed the event, and a
// click that opens a tab or starts a navigation can leave that ack outstanding indefinitely - the very
// clicks this function exists to make work. The event itself is already delivered, and CDP processes
// commands in order, so proceeding without the ack is safe; blocking on it is what wedges a run.
const ACK_MS = 2000;

async function dispatch(page, params) {
  let timer;
  try {
    return await Promise.race([
      page.call('Input.dispatchMouseEvent', params).then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), ACK_MS); }),
    ]);
  } finally { clearTimeout(timer); }
}

/**
 * Typing as real key events rather than an assignment to `.value`.
 *
 * Setting `.value` and firing `input` is enough for a controlled React input and not much else: it
 * skips keydown/keyup entirely, so a field with a key handler, an autocomplete that opens on keypress,
 * or a maxlength/IME behaviour all see nothing.
 */
export async function trustedType(page, backendNodeId, text) {
  await page.call('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => null);
  await page.call('DOM.focus', { backendNodeId });
  for (const ch of text) {
    await page.call('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, unmodifiedText: ch });
    await page.call('Input.dispatchKeyEvent', { type: 'keyUp', text: ch, unmodifiedText: ch });
  }
  return text;
}
