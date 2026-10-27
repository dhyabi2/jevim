// The content script. Everything interesting lives in the modules above it; this is the
// wiring: keep the index fresh, turn events into tokens, and show what mode we are in.
//
// The resolver is injected here. With no key configured the layer runs entirely at L0 and
// never opens a socket; with one, a search motion resolves through Jev, primed character by
// character as the user types so the answer is usually back before they press Enter.

import { createDriver } from './driver.js';
import { createBindings } from './grammar/bindings.js';
import { isEditable, tokenize } from './grammar/keys.js';
import { createOps } from './grammar/ops.js';
import { INSERT } from './grammar/parser.js';
import { createRunner } from './grammar/runner.js';
import { collect } from './index/collect.js';
import { createGate } from './index/gate.js';
import { createJevResolver } from './resolve/jev.js';
import { httpTransport } from './resolve/transport.js';
import { createRepair } from './resolve/repair.js';
import { createTypeAhead } from './resolve/typeahead.js';
import { revealAll } from './index/reveal.js';
import { createSettler } from './index/settle.js';
import { domEnv } from './index/visibility.js';
import { createHints } from './hints.js';

(function boot(win) {
  const doc = win.document;
  const site = win.location.hostname;
  const env = domEnv(win);

  let index = [];

  // Quiescence rather than a bare dirty flag: on a live application something mutates constantly, so
  // "changed" carries almost no information and an index built mid-render is already wrong.
  const settler = createSettler(win);

  function refresh() {
    if (!settler.dirty) return index;
    index = collect(doc, env);
    settler.clean();
    return index;
  }

  /**
   * The index of the whole list, not of this viewport.
   *
   * Virtualised lists keep only visible rows in the DOM, so a motion aimed at a row further down can
   * never resolve against one viewport. Used for hints and for a resolution that found nothing.
   */
  async function refreshDeep() {
    const out = await revealAll(win, () => collect(doc, env));
    index = out.index;
    settler.clean();
    return out;
  }

  const bindings = createBindings(chromeStore(win));
  const ops = createOps(win);
  const gate = createGate(doc, env);

  // A key turns L1 on. Without one the grammar still works at L0, which is the floor.
  const apiKey = (win.__jevimConfig && win.__jevimConfig.apiKey) || null;
  const typeAhead = apiKey
    ? createTypeAhead({ resolver: createJevResolver({ transport: httpTransport({ apiKey }) }) })
    : null;

  // A bound motion whose element was renamed or moved repairs that one step instead of failing.
  const repair = apiKey
    ? createRepair({ decide: (body) => httpTransport({ apiKey })(body) })
    : null;
  const runner = createRunner({ site, bindings, ops, getIndex: refresh,
                                resolver: typeAhead ? typeAhead.resolve : null, gate, repair });
  const driver = createDriver({ runner, typeAhead });

  const hints = createHints(win, {
    onPick(entry) {
      ops.goto(entry.el);
      status(`goto ${entry.name || entry.role}`);
    },
  });

  doc.addEventListener('keydown', (event) => {
    if (isEditable(event.target) && driver.parser.mode !== INSERT && event.key !== 'Escape') return;
    const token = tokenize(event);
    if (!token) return;

    if (hints.feed(token)) { event.preventDefault(); return; }

    const before = driver.parser.mode;
    const result = driver.handle(token);
    if (result.status === 'ignored' && before !== INSERT) return;
    event.preventDefault();

    if (result.status === 'hint') {
      // Hints must cover the list, not the window, or a label can never be shown for a row that has
      // not been scrolled into existence.
      refreshDeep().then((out) => hints.show(out.index)).catch(() => hints.show(refresh()));
    }
    else if (result.status === 'confirm') confirmThen(result);
    else if (result.status === 'no-target' || result.status === 'abstained') {
      // Nothing matched in this viewport. Reveal the rest of the list and say so, because on a
      // virtualised list "not found" often only means "not yet rendered".
      refreshDeep().then((out) => {
        status(out.complete
          ? describe(result)
          : `${describe(result)} - list only partly revealed, try again`);
      }).catch(() => status(describe(result)));
    }
    else if (result.status !== 'pending') status(describe(result));
  }, true);

  function confirmThen(result) {
    const name = result.entry.name || result.entry.role;
    status(`${result.operator} "${name}"? press y to confirm`);
    doc.addEventListener('keydown', function once(event) {
      doc.removeEventListener('keydown', once, true);
      event.preventDefault();
      if (event.key !== 'y') { status('cancelled'); return; }
      status(describe(driver.handle('<Esc>') && runner.run(result.command, { confirmed: true })));
    }, true);
  }

  function describe(result) {
    if (!result) return '';
    if (result.status === 'done') return `${result.tier} ${result.result}`;
    if (result.status === 'refused') return `refused: ${result.reason}`;
    if (result.status === 'stale') {
      return `stale: ${result.reason}${result.repairFailed ? ` (repair: ${result.repairFailed})` : ''}`;
    }
    if (result.repaired) return `${result.tier} ${result.result} (repaired)`;
    if (result.status === 'needs-resolver') return 'no binding yet (block 3 resolves this)';
    return result.status;
  }

  let bar = null;
  function status(text) {
    if (!bar) {
      bar = doc.createElement('div');
      bar.className = 'jevim-status';
      doc.body.appendChild(bar);
    }
    bar.textContent = `${driver.parser.mode}  ${text}`;
    bar.style.opacity = '1';
    win.clearTimeout(status.timer);
    status.timer = win.setTimeout(() => { bar.style.opacity = '0'; }, 1800);
  }

  win.__jevim = { driver, refresh, refreshDeep, bindings, typeAhead, settler };
})(window);

/** chrome.storage-backed store with the same shape as `memoryStore`, cached in memory. */
function chromeStore(win) {
  const cache = new Map();
  const api = win.chrome && win.chrome.storage ? win.chrome.storage.local : null;
  if (api) {
    api.get('jevim:bindings', (data) => {
      for (const [site, value] of Object.entries((data || {})['jevim:bindings'] || {})) {
        if (!cache.has(site)) cache.set(site, value);
      }
    });
  }
  return {
    read: (site) => cache.get(site) || {},
    write: (site, value) => {
      cache.set(site, value);
      if (api) api.set({ 'jevim:bindings': Object.fromEntries(cache) });
    },
    sites: () => [...cache.keys()],
  };
}
