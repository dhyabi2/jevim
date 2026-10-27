// The closed-loop agent against real Chrome: observe, ask, act, record.
//
// The decisions live in src/agent/policy.js; this file supplies the browser. Element actions go
// through the session's runner, so each one is gated (identity re-checked in the same tick as the
// click) and bound to a fingerprint, and the run leaves an artifact whose element steps replay with no
// model.

import { format } from '../src/artifact.js';
import { looping, parseReply, prompt, summarise } from '../src/agent/policy.js';
import { openCdpSession } from './cdp-session.mjs';

const SETTLE_CEILING_MS = 8000;
const READ_CHUNK = 6000;

/** Visible text in the viewport, top to bottom, without scripts, styles or hidden nodes. */
const VISIBLE_TEXT = `(() => {
  // Text is read the way a person reads it: pieces inside one block element run together, and " | "
  // separates blocks. Joining every text node with a separator turned a heading set one letter per
  // span - as example.com now does - into "T | h | i | s", and the model reported the page had no heading.
  const h = innerHeight; const out = []; let n = 0; let cur = ''; let prev = null;
  const blocks = new WeakMap();
  const blockOf = (el) => {
    const start = el;
    while (el && el !== document.body) {
      if (blocks.has(el)) return blocks.get(el);
      const d = getComputedStyle(el).display;
      if (!d.startsWith('inline') && d !== 'contents') break;
      el = el.parentElement;
    }
    const b = el || document.body;
    blocks.set(start, b);
    return b;
  };
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  while (walker.nextNode() && n < 6000) {
    const t = walker.currentNode; const el = t.parentElement;
    if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
    const raw = t.textContent.replace(/\\s+/g, ' ');
    if (!raw.trim()) { if (cur && !cur.endsWith(' ')) cur += ' '; continue; }
    const r = el.getBoundingClientRect(); if (r.bottom < 0 || r.top > h || r.width === 0) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const b = blockOf(el);
    if (b !== prev) { if (cur.trim()) { out.push(cur.trim()); n += cur.length; } cur = ''; prev = b; }
    cur += raw;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.join(' | ').replace(/ {2,}/g, ' ');
})()`;

/** A readyState-and-quiet wait that survives the execution context being replaced mid-navigation. */
async function settle(session, { minMs = 400 } = {}) {
  const started = Date.now();
  await new Promise((r) => setTimeout(r, minMs));
  let lastLen = -1;
  let stable = 0;
  while (Date.now() - started < SETTLE_CEILING_MS) {
    try {
      const state = await session.evaluate('[document.readyState, document.body ? document.body.innerHTML.length : 0]');
      if (state && state[0] === 'complete' && state[1] === lastLen) { if (++stable >= 2) return; }
      else stable = 0;
      lastLen = state ? state[1] : -1;
    } catch { stable = 0; }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function onNode(page, backendNodeId, fn, args = []) {
  const { object } = await page.call('DOM.resolveNode', { backendNodeId });
  const out = await page.call('Runtime.callFunctionOn', {
    objectId: object.objectId, functionDeclaration: fn, returnByValue: true,
    arguments: args.map((value) => ({ value })),
  });
  return out.result ? out.result.value : undefined;
}

const KEY_CODES = { Enter: 13, Escape: 27, Tab: 9, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
                    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };

/** One real key press, the way a keyboard sends it. */
async function pressKey(page, name) {
  const code = KEY_CODES[name];
  const key = { key: name === 'Space' ? ' ' : name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  await page.call('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
  if (name === 'Enter') await page.call('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...key });
  if (name === 'Space') await page.call('Input.dispatchKeyEvent', { type: 'char', text: ' ', ...key });
  await page.call('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

const pressEnter = (page) => pressKey(page, 'Enter');

// How long one action (including the index rebuild after it) may take. A hung renderer makes every CDP
// command wait out its own 30-second timeout, and rebuilding the index issues hundreds of them; without
// a bound, one step on such a page ran past the whole run's ceiling and the run ended with no answer.
const ACTION_MS = 60000;

/** `promise`, or `fallback` once `ms` has passed - whichever comes first. The loser is abandoned. */
function within(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), Math.max(0, ms)); }),
  ]);
}

/** The replayable form of an executed action: its parameters, plus the element's identity. */
function logEntry(action, outcome) {
  const out = { action: action.action, outcome: String(outcome).slice(0, 80) };
  for (const key of ['text', 'enter', 'option', 'direction', 'url', 'find', 'answer']) {
    if (action[key] !== undefined) out[key] = action[key];
  }
  if (action.entry) Object.assign(out, { fp: action.entry.fp, role: action.entry.role, name: action.entry.name });
  return out;
}

/**
 * Run one task to completion or to the step budget.
 *
 * `chat(prompt) -> { text, usage }` is the model. Returns the answer, the full trace, the token count,
 * and the artifact text.
 */
export async function runAgent({ task, website, chat, maxSteps = 25, headless = true, onStep = null,
                                 screenshotTo = null, vision = false, deadline = Infinity, replay = null,
                                 browser = null, onSession = null,
                                 throttleThinking = process.env.JEVIM_THROTTLE_THINKING === '1', thinkMs = 0 }) {
  const started = Date.now();
  // Chrome is launched unmasked (see launch in cdp.mjs), so the first request already looks like a browser.
  // `browser` is an already-running Chrome ({ chrome, cdp }) from a warm pool, so a run starts without
  // waiting for a launch; the caller owns it and closes it. `onSession` gets the live session at once,
  // before the first model call, which is what lets a viewer watch the page from its first paint.
  // With a live viewer, open on a blank page, let the viewer attach, and only then load the site - so the
  // page is seen loading from its first paint instead of appearing only once it has settled.
  const session = await openCdpSession(onSession ? 'about:blank' : website, { headless, ...(browser || {}) });
  if (onSession) {
    await onSession(session);
    await session.rawPage.call('Page.navigate', { url: website }).catch(() => null);
  }
  await within(settle(session), 20000, null);
  await within(session.refresh().catch(() => null), ACTION_MS, null);

  const history = [];
  const recorded = [];
  // Every executed action with its concrete parameters and, for element actions, the fingerprint.
  // This is the replayable record: `runAgent({ replay: log })` re-executes it with no model at all.
  const log = [];
  const replayStats = replay ? { actions: replay.length, executed: 0, unresolved: 0, failed: 0 } : null;
  const tokens = { prompt: 0, completion: 0 };
  let calls = 0;
  let costUsd = 0;
  let turns = 0;
  let readOffset = 0;
  let note = '';
  let memory = '';
  let answer = null;
  let finalUrl = '';
  let outOfTime = false;

  // With vision on, each step also carries a small JPEG of the viewport. The index stays the only thing
  // an action can target; the picture is context, for charts, layouts and widgets the AX tree flattens.
  let image = null;
  // While the model thinks - most of a run's wall time - the page gets a twentieth of the CPU. Freezing it
  // outright (Page.setWebLifecycleState) stopped its timers for good in headless Chrome, so the page is
  // slowed, never stopped: it is exactly as alive when the agent acts again.
  const throttle = async (rate) => {
    if (!throttleThinking) return;
    await session.rawPage.call('Emulation.setCPUThrottlingRate', { rate }).catch(() => null);
  };
  const ask = async (text) => {
    await throttle(20);
    try { return await askFull(text); } finally { await throttle(1); }
  };
  const askFull = async (text) => {
    // A model call gets whatever time is left, never more: one call stuck in retries used to hold a
    // single step past the run's ceiling, and the run then ended with no answer at all.
    const left = deadline - Date.now() + 60000;
    const reply = await (Number.isFinite(left)
      ? Promise.race([chat(text, image ? { image } : {}),
                      new Promise((r) => setTimeout(() => r({ text: '', timedOut: true }), Math.max(1000, left)))])
      : chat(text, image ? { image } : {}));
    if (reply.timedOut) { outOfTime = true; return reply; }
    calls += 1;
    tokens.prompt += reply.usage?.prompt_tokens || 0;
    tokens.completion += reply.usage?.completion_tokens || 0;
    // What the provider actually billed, when it says (NanoGPT reports usage.cost in USD per call).
    if (typeof reply.usage?.cost === 'number') costUsd += reply.usage.cost;
    return reply;
  };

  try {
    // Replay: the recorded actions in order, each element re-found by fingerprint in the live index.
    // No prompt is built and no model is called; a step whose element is gone is counted, not guessed.
    if (replay) {
      for (const entry of replay) {
        // Like browser-use's skip_failures: an action that failed when recorded is not re-attempted.
        if (entry.action !== 'done' && !/^(ok|selected|scrolled|navigated|went back|found|read|not a native|finished)/.test(entry.outcome || '')) {
          replayStats.skipped = (replayStats.skipped || 0) + 1;
          continue;
        }
        let action = { ...entry };
        // A replay makes no model calls; thinkMs stands in for them when measuring what a live run costs.
        if (thinkMs) { await throttle(20); await new Promise((r) => setTimeout(r, thinkMs)); await throttle(1); }
        if (entry.fp) {
          let found = session.index.find((e) => e.fp === entry.fp);
          if (!found) { await session.reveal({ maxSteps: 6 }).catch(() => null); found = session.index.find((e) => e.fp === entry.fp); }
          if (!found) { replayStats.unresolved += 1; history.push({ summary: `${entry.action} ${entry.role} "${entry.name}"`, outcome: 'unresolved', url: '' }); continue; }
          action.entry = found;
          action.id = found.id;
        }
        if (action.action === 'done') { answer = entry.answer ?? ''; break; }
        const before = await within(session.evaluate('location.href').catch(() => ''), 5000, '');
        let outcome;
        try { outcome = await execute(action); } catch (error) { outcome = `error: ${String(error.message).slice(0, 160)}`; }
        const ok = /^(ok|selected|scrolled|navigated|went back|found|read|not a native)/.test(outcome);
        if (ok) replayStats.executed += 1; else replayStats.failed += 1;
        history.push({ summary: summarise(action), outcome, url: before, fp: action.entry?.fp });
        if (onStep) await onStep({ step: history.length, url: before, summary: summarise(action), outcome, fp: action.entry?.fp });
      }
      replay = null;   // falls through to the shared cleanup below
    }
    for (let step = 1; step <= maxSteps && answer === null && !replayStats && !outOfTime; step++) {
      turns = step;
      // Past the deadline and the grace for one action in flight: stop, and answer from memory.
      if (Date.now() > deadline + 30000) { outOfTime = true; break; }
      const [url, title, text] = await within(Promise.all([
        session.evaluate('location.href').catch(() => ''),
        session.evaluate('document.title').catch(() => ''),
        session.evaluate(VISIBLE_TEXT).catch(() => ''),
      ]), 20000, ['', '', '']);
      const index = session.index;
      image = vision ? await within(session.rawPage.call('Page.captureScreenshot',
        { format: 'jpeg', quality: 55, clip: { x: 0, y: 0, width: 1280, height: 900, scale: 0.6 } })
        .then((shot) => shot.data).catch(() => null), 15000, null) : null;
      const view = { task, website, url, title, index, text, history, memory, step, maxSteps };
      // An empty answer always fails, and a run that spends its last step still searching returns one.
      // Near the end the model is told to wrap up; on the last step "done" is the only thing accepted.
      // Out of steps or nearly out of time: either way this is the step that must answer.
      const last = step === maxSteps || Date.now() > deadline;
      if (last) note = 'This is your LAST step. Reply with "done" now: give the best, most complete answer from what you have found, and say what could not be completed.';
      else if (step === maxSteps - 3 && !note) note = 'Only 3 steps remain. Finish the task, or prepare to answer with what you have.';
      let parsed = parseReply((await ask(prompt({ ...view, note }))).text, index, { website });
      // A malformed reply is asked again at once, with the reason, rather than spending a step on it.
      if (parsed.error) {
        const reason = parsed.error;
        parsed = parseReply((await ask(prompt({ ...view, note: `Your reply was rejected: ${reason}. Reply again with one valid JSON object.` }))).text, index, { website });
        if (parsed.error) {
          history.push({ summary: 'invalid reply', outcome: parsed.error, url });
          note = `Your last reply was rejected: ${parsed.error}.`;
          continue;
        }
      }
      note = '';
      if (parsed.memory) memory = parsed.memory;
      if (last && !parsed.actions.some((a) => a.action === 'done')) {
        // Still no answer on the last step: the memory the model kept is the best account of the run.
        parsed.actions = [{ action: 'done', answer: memory ? `Not completed within the step or time limit. Progress: ${memory}` : '' }];
      }

      // Up to three actions, in order. Ids are positions in the index the model saw, and the index is
      // rebuilt after every action, so each later action is re-found by FINGERPRINT in the fresh index:
      // the stable identity is what makes chaining safe. One that cannot be re-found, a page change, or
      // a failed action ends the chain.
      for (const [i, planned] of parsed.actions.entries()) {
        let action = planned;
        if (i > 0 && action.entry) {
          const again = session.index.find((e) => e.fp === action.entry.fp);
          if (!again) { note = 'The page changed after your first action; the rest of your actions were not run.'; break; }
          action = { ...action, entry: again, id: again.id };
        }
        const summary = summarise(action);
        if (looping(history, action)) {
          note = `You have done "${summary}" repeatedly without progress. Choose something different.`;
        }
        const before = await within(session.evaluate('location.href').catch(() => ''), 5000, '');
        let outcome;
        try {
          const budget = Math.min(ACTION_MS, deadline - Date.now() + 30000);
          outcome = await within(execute(action), budget, 'error: the page did not respond in time');
        } catch (error) {
          outcome = `error: ${String(error.message).slice(0, 160)}`;
        }
        if (Date.now() > deadline + 30000) outOfTime = true;
        history.push({ summary, outcome, url: before, fp: action.entry?.fp });
        log.push(logEntry(action, outcome));
        // `screenshot` is what the model saw this step (vision on), so a live view shows the same thing.
        if (onStep) await onStep({ step, url: before, summary, outcome, fp: action.entry?.fp, screenshot: image, memory });
        if (answer !== null || outOfTime) break;
        const ok = /^(ok|selected|scrolled|navigated|went back|found|read|not a native)/.test(outcome);
        if (!ok) { await within(session.refresh().catch(() => null), 20000, null); break; }
        const after = await within(session.evaluate('location.href').catch(() => ''), 5000, '');
        if (after !== before) break;
      }
    }
    if (answer === null && memory) answer = `Not completed within the step or time limit. Progress: ${memory}`;
  } catch (error) {
    if (!replayStats) throw error;
  } finally {
    finalUrl = await within(session.evaluate('location.href').catch(() => ''), 10000, '');
    if (screenshotTo) {
      try {
        const shot = await within(session.rawPage.call('Page.captureScreenshot', { format: 'png' }), 15000, null);
        if (!shot) throw new Error('no screenshot');
        (await import('node:fs')).writeFileSync(screenshotTo, Buffer.from(shot.data, 'base64'));
      } catch { /* the page may be gone */ }
    }
    await within(session.close().catch(() => {}), 15000, null);
  }

  return {
    final: answer ?? '',
    done: answer !== null,
    steps: turns,
    actions: history.length,
    calls,
    tokens,
    cost_usd: Math.round(costUsd * 1e6) / 1e6,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    trace: history,
    artifact: format({ meta: { name: task, url: website }, steps: recorded }),
    pinnedSteps: recorded.filter((s) => s.fp).length,
    log,
    finalUrl,
    ...(replayStats ? { replay: replayStats } : {}),
  };

  /** One action. Returns the outcome line the model sees next step. */
  async function execute(action) {
    const page = session.rawPage;
    switch (action.action) {
      case 'done':
        answer = action.answer;
        return 'finished';

      case 'click':
      case 'type':
      case 'select': {
        const entry = action.entry;
        const target = { kind: 'search', query: `${entry.role} ${entry.name}`.replace(/"/g, "'").slice(0, 120) };
        session.bindings.remember(session.site, target, entry, { source: 'agent' });
        // The runner, not a raw click: the gate re-reads the element from Chrome immediately before
        // acting, and refuses if it is gone or has become something else since it was shown.
        const operator = action.action === 'click' ? 'goto' : action.action === 'type' ? 'change' : 'select';
        const ran = await session.runner.run({ count: 1, operator, target }, { confirmed: true });
        if (ran.status !== 'done') return `not done: ${ran.status}${ran.reason ? ` (${ran.reason})` : ''}`;

        let result = 'ok';
        if (action.action === 'type') {
          await session.ops.type(entry, action.text);
          if (action.enter) await pressEnter(page);
        } else if (action.action === 'select') {
          result = await onNode(page, entry.backendDOMNodeId, `function(label){
            if (this.tagName !== 'SELECT') return 'not a native select';
            const want = label.trim().toLowerCase();
            const opt = [...this.options].find(o => o.text.trim().toLowerCase() === want)
              || [...this.options].find(o => o.text.trim().toLowerCase().includes(want));
            if (!opt) return 'no option matching: ' + [...this.options].slice(0, 15).map(o => o.text.trim()).join(' / ');
            this.value = opt.value;
            this.dispatchEvent(new Event('input', {bubbles:true}));
            this.dispatchEvent(new Event('change', {bubbles:true}));
            return 'selected ' + opt.text.trim();
          }`, [action.option]);
          if (result === 'not a native select') {
            await session.ops.goto(entry);
            result = 'not a native select; clicked it to open - choose the option next';
          }
        }
        recorded.push({ verb: action.action === 'click' ? 'goto' : action.action, target, fp: entry.fp,
                        role: entry.role, name: entry.name,
                        ...(action.action === 'type' ? { value: action.text } : {}) });
        await settle(session);
        await adoptNewTab();
        await session.refresh();
        return result;
      }

      case 'key': {
        if (action.entry) {
          // Focus through the gate first, so a key never lands on an element that changed identity.
          const target = { kind: 'search', query: `${action.entry.role} ${action.entry.name}`.replace(/"/g, "'").slice(0, 120) };
          session.bindings.remember(session.site, target, action.entry, { source: 'agent' });
          const ran = await session.runner.run({ count: 1, operator: 'select', target }, { confirmed: true });
          if (ran.status !== 'done') return `not done: ${ran.status}${ran.reason ? ` (${ran.reason})` : ''}`;
          await page.call('DOM.focus', { backendNodeId: action.entry.backendDOMNodeId }).catch(() => null);
        }
        await pressKey(page, action.key);
        await settle(session, { minMs: 250 });
        await session.refresh();
        return 'ok';
      }

      case 'scroll': {
        await session.evaluate(`window.scrollBy(0, ${action.direction === 'up' ? '-' : ''}Math.round(innerHeight * 0.8))`);
        await new Promise((r) => setTimeout(r, 400));
        await session.refresh();
        return 'scrolled';
      }

      case 'goto': {
        await page.call('Page.navigate', { url: action.url });
        await settle(session, { minMs: 800 });
        await session.refresh();
        readOffset = 0;
        return 'navigated';
      }

      case 'back': {
        await session.evaluate('history.back()').catch(() => null);
        await settle(session, { minMs: 800 });
        await session.refresh();
        return 'went back';
      }

      case 'read': {
        const all = String(await session.evaluate('document.body ? document.body.innerText : ""').catch(() => ''))
          .replace(/\n{2,}/g, '\n');
        if (action.find) {
          // The text around each occurrence, so a pricing table halfway down a long page is one step away.
          const needle = String(action.find).toLowerCase();
          const hay = all.toLowerCase();
          const parts = [];
          for (let at = hay.indexOf(needle); at !== -1 && parts.join('').length < READ_CHUNK; at = hay.indexOf(needle, at + 600)) {
            parts.push(all.slice(Math.max(0, at - 300), at + 600));
          }
          note = parts.length ? `Page text around "${action.find}":\n${parts.join('\n...\n').slice(0, READ_CHUNK)}`
                              : `"${action.find}" does not appear in the page text.`;
          return parts.length ? `found ${parts.length} place(s)` : 'not found on the page';
        }
        const chunk = all.slice(readOffset, readOffset + READ_CHUNK);
        readOffset += READ_CHUNK;
        note = `Page text (continue with "read" for more):\n${chunk || '(no more text)'}`;
        return chunk ? `read ${chunk.length} characters` : 'no more text';
      }

      default:
        return 'unsupported';
    }
  }

  // A click that opened a tab moves the task there; followNewTab clears the list once adopted.
  async function adoptNewTab() {
    if (!session.events.tabsOpened.length) return;
    const followed = await session.followNewTab().catch(() => null);
    if (followed) await settle(session);
  }
}
