window.__jevimDemo=(function(){

const INVISIBLE = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const MAX_NAME = 120;
function launder(text, max = MAX_NAME) {
  if (typeof text !== 'string') return '';
  const cleaned = text
    .replace(INVISIBLE, '')
    .replace(CONTROL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max ? cleaned.slice(0, max - 1).trimEnd() + '\u2026' : cleaned;
}
function hadInvisibles(text) {
  return typeof text === 'string' && (INVISIBLE.test(text) || CONTROL.test(text));
}


function domEnv(win) {
  const doc = win.document;
  return {
    rect: (el) => el.getBoundingClientRect(),
    style: (el) => win.getComputedStyle(el),
    viewport: () => ({
      w: win.innerWidth || doc.documentElement.clientWidth,
      h: win.innerHeight || doc.documentElement.clientHeight,
    }),
  };
}
const MIN_SIZE = 3;
function ariaHidden(el) {
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (node.getAttribute('aria-hidden') === 'true') return true;
    if (node.hasAttribute('inert')) return true;
    if (node.hasAttribute('hidden')) return true;
  }
  return false;
}
function isVisible(el, env) {
  if (ariaHidden(el)) return false;
  if (el.tagName === 'INPUT' && el.type === 'hidden') return false;
  if (el.disabled === true) return false;
  const style = env.style(el);
  if (!style) return false;
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  const opacity = parseFloat(style.opacity);
  if (!Number.isNaN(opacity) && opacity === 0) return false;
  const r = env.rect(el);
  if (!r) return false;
  if (r.width < MIN_SIZE || r.height < MIN_SIZE) return false;
  const { w, h } = env.viewport();
  if (r.right <= 0 || r.bottom <= 0) return false;
  if (r.left >= w * 4 || r.top >= h * 20) return false;
  return true;
}
function viewportBucket(el, env) {
  const r = env.rect(el);
  const { w, h } = env.viewport();
  if (r.bottom <= 0) return 'above';
  if (r.top >= h) return 'below';
  const col = r.left < w / 3 ? 'l' : r.left < (2 * w) / 3 ? 'c' : 'r';
  const row = r.top < h / 3 ? 't' : r.top < (2 * h) / 3 ? 'm' : 'b';
  return row + col;
}
function readingOrder(el, env) {
  const r = env.rect(el);
  return [Math.round(r.top / 24), Math.round(r.left)];
}


const IMPLICIT_ROLE = {
  A: 'link', BUTTON: 'button', SUMMARY: 'disclosure', SELECT: 'select',
  TEXTAREA: 'textbox', OPTION: 'option', LABEL: 'label',
};
const INPUT_ROLE = {
  submit: 'button', button: 'button', reset: 'button', image: 'button',
  checkbox: 'checkbox', radio: 'radio', range: 'slider', file: 'file',
  search: 'searchbox', email: 'textbox', password: 'password', number: 'textbox',
  tel: 'textbox', url: 'textbox', text: 'textbox',
};
function roleOf(el) {
  const explicit = launder(el.getAttribute('role') || '', 32).split(' ')[0];
  if (explicit) return explicit;
  if (el.tagName === 'A') return el.hasAttribute('href') ? 'link' : 'generic';
  if (el.tagName === 'INPUT') return INPUT_ROLE[(el.type || 'text').toLowerCase()] || 'textbox';
  if (el.isContentEditable) return 'textbox';
  return IMPLICIT_ROLE[el.tagName] || 'generic';
}
function labelledBy(el, doc) {
  const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
  if (!ids.length) return '';
  return ids
    .map((id) => doc.getElementById(id))
    .filter(Boolean)
    .map((node) => node.textContent || '')
    .join(' ');
}
function associatedLabel(el, doc) {
  if (el.id) {
    const forLabel = doc.querySelector(`label[for="${CSS_escape(el.id)}"]`);
    if (forLabel) return forLabel.textContent || '';
  }
  const wrapper = el.closest ? el.closest('label') : null;
  return wrapper ? wrapper.textContent || '' : '';
}
function CSS_escape(value) {
  return value.replace(/["\\]/g, '\\$&');
}
function accessibleName(el, doc) {
  const candidates = [
    el.getAttribute('aria-label'),
    labelledBy(el, doc),
    associatedLabel(el, doc),
    el.getAttribute('alt'),
    el.tagName === 'INPUT' && el.type === 'image' ? el.getAttribute('alt') : '',
    el.value && el.tagName === 'INPUT' && INPUT_ROLE[el.type] === 'button' ? el.value : '',
    el.textContent,
    el.getAttribute('placeholder'),
    el.getAttribute('title'),
    el.getAttribute('name'),
  ];
  for (const candidate of candidates) {
    const name = launder(candidate || '', MAX_NAME);
    if (name) return name;
  }
  return '';
}
function nearestContext(el, doc) {
  const SECTION = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
      if (sib.matches && sib.matches(SECTION)) return launder(sib.textContent, 60);
      const nested = sib.querySelector ? sib.querySelector(SECTION) : null;
      if (nested) return launder(nested.textContent, 60);
    }
    const label = node.getAttribute && node.getAttribute('aria-label');
    if (label) return launder(label, 60);
  }
  void doc;
  return '';
}


const LANDMARK = new Set([
  'HEADER', 'NAV', 'MAIN', 'ASIDE', 'FOOTER', 'FORM', 'SECTION', 'ARTICLE', 'DIALOG', 'TABLE',
]);
function ancestry(el) {
  const chain = [];
  for (let node = el.parentElement; node && node.nodeType === 1; node = node.parentElement) {
    const role = node.getAttribute('role');
    if (LANDMARK.has(node.tagName)) chain.push(node.tagName.toLowerCase());
    else if (role) chain.push(launder(role, 24).split(' ')[0]);
    if (chain.length >= 4) break;
  }
  return chain.reverse();
}
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}
function fingerprint({ role, name, el, ordinal = 0, boundary = [] }) {
  const chain = [...boundary, ...ancestry(el)].join('>');
  const parts = [role, name.toLowerCase(), chain, String(ordinal)];
  return hash(parts.join('|'));
}
function withOrdinals(entries) {
  const seen = new Map();
  return entries.map((entry) => {
    const key = [entry.role, entry.name.toLowerCase(),
      [...(entry.boundary || []), ...ancestry(entry.el)].join('>')].join('|');
    const ordinal = seen.get(key) || 0;
    seen.set(key, ordinal + 1);
    return { ...entry, ordinal };
  });
}


const INTERACTIVE = [
  'a[href]', 'button', 'input', 'select', 'textarea', 'summary', '[contenteditable=""]',
  '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
  '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="tab"]',
  '[role="menuitem"]', '[role="option"]', '[role="switch"]', '[role="textbox"]',
  '[role="searchbox"]', '[role="combobox"]', '[role="slider"]',
].join(',');
function collect(doc, env, { limit = 400 } = {}) {
  const raw = [];
  for (const { el, offset, boundary } of walk(doc, INTERACTIVE)) {
    const local = shift(env, offset);
    if (!isVisible(el, local)) continue;
    const rawName = el.getAttribute('aria-label') || el.textContent || '';
    const owner = el.ownerDocument || doc;
    raw.push({
      el,
      boundary,
      offset,
      role: roleOf(el),
      name: accessibleName(el, owner),
      ctx: launder(nearestContext(el, owner), 60),
      vp: viewportBucket(el, local),
      suspect: hadInvisibles(rawName),
      order: readingOrder(el, local),
    });
  }
  raw.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
  const ranked = rank(raw).slice(0, limit);
  return withOrdinals(ranked).map((entry, i) => ({
    id: `e${i}`,
    fp: fingerprint(entry),
    role: entry.role,
    name: entry.name,
    anc: fullAncestry(entry),
    boundary: entry.boundary,
    offset: entry.offset,
    ctx: entry.ctx,
    vp: entry.vp,
    suspect: entry.suspect,
    el: entry.el,
  }));
}
function fullAncestry(entry) {
  return [...(entry.boundary || []), ...ancestry(entry.el)].join('>');
}
function rank(entries) {
  const band = (entry) => (entry.vp === 'above' ? 1 : entry.vp === 'below' ? 2 : 0);
  return entries
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => {
      const byBand = band(a.entry) - band(b.entry);
      if (byBand) return byBand;
      const byName = (a.entry.name ? 0 : 1) - (b.entry.name ? 0 : 1);
      if (byName) return byName;
      return a.i - b.i;
    })
    .map(({ entry }) => entry);
}


function createGate(doc, env) {
  return function gate(entry) {
    const el = entry.el;
    if (!el || !el.isConnected) {
      return { ok: false, reason: 'target left the document' };
    }
    const local = shift(env, entry.offset);
    if (!isVisible(el, local)) return { ok: false, reason: 'target is no longer visible' };
    if (roleOf(el) !== entry.role) return { ok: false, reason: 'target role changed' };
    const owner = el.ownerDocument || doc;
    if (accessibleName(el, owner) !== entry.name) return { ok: false, reason: 'target name changed' };
    const chain = [...(entry.boundary || []), ...ancestry(el)].join('>');
    if (chain !== entry.anc) return { ok: false, reason: 'target moved' };
    return { ok: true, reason: '' };
  };
}


const CHARS_PER_TOKEN = 3;
function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
function line(entry) {
  const parts = [entry.id, entry.role];
  if (entry.name) parts.push(JSON.stringify(entry.name));
  if (entry.ctx) parts.push('@' + JSON.stringify(entry.ctx));
  parts.push(entry.vp);
  if (entry.suspect) parts.push('!suspect');
  return parts.join(' ');
}
function serialize(entries, { budget = 12000 } = {}) {
  const lines = entries.map(line);
  let used = 0;
  let kept = 0;
  for (const text of lines) {
    const cost = estimateTokens(text) + 1; // +1 for the separator
    if (used + cost > budget) break;
    used += cost;
    kept += 1;
  }
  return {
    state: lines.slice(0, kept),
    tokens: used,
    kept,
    dropped: entries.length - kept,
    budget,
  };
}


const OPERATORS = {
  g: { id: 'goto', destructive: false, desc: 'follow or activate the target' },
  y: { id: 'yank', destructive: false, desc: 'copy the target text or href' },
  c: { id: 'change', destructive: true, desc: 'focus the target and clear it' },
  d: { id: 'dismiss', destructive: true, desc: 'hide or close the target' },
  v: { id: 'select', destructive: false, desc: 'select the target' },
};
const TEXT_OBJECTS = {
  p: { id: 'post', desc: 'a post, card or list item' },
  f: { id: 'form', desc: 'the enclosing form' },
  r: { id: 'row', desc: 'a table or list row' },
  a: { id: 'article', desc: 'the main article body' },
  s: { id: 'section', desc: 'the enclosing section or landmark' },
};
const EDGES = {
  g: { id: 'first', desc: 'first target on the page' },
  G: { id: 'last', desc: 'last target on the page' },
  '}': { id: 'nextSection', desc: 'next section' },
  '{': { id: 'prevSection', desc: 'previous section' },
};
const DESTRUCTIVE = new Set(
  Object.values(OPERATORS).filter((op) => op.destructive).map((op) => op.id),
);


function tokenize(event) {
  const named = {
    Escape: '<Esc>', Enter: '<CR>', Tab: '<Tab>', Backspace: '<BS>', ' ': '<Space>',
    ArrowUp: '<Up>', ArrowDown: '<Down>', ArrowLeft: '<Left>', ArrowRight: '<Right>',
  };
  const base = named[event.key] || event.key;
  if (base.length > 1 && !base.startsWith('<')) return null; // Shift, Meta, dead keys
  let token = base;
  if (event.ctrlKey) token = wrap('C', token);
  if (event.altKey) token = wrap('A', token);
  if (event.metaKey) token = wrap('D', token);
  return token;
}
function wrap(prefix, token) {
  const inner = token.startsWith('<') ? token.slice(1, -1) : token;
  return `<${prefix}-${inner}>`;
}
function isEditable(el) {
  if (!el) return false;
  const editableAttr = el.getAttribute && el.getAttribute('contenteditable');
  if (el.isContentEditable || editableAttr === '' || editableAttr === 'true') return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file'].includes(
    (el.type || 'text').toLowerCase(),
  );
}


const NORMAL = 'normal';
const INSERT = 'insert';
const AWAIT_MOTION = 'await-motion';
const AWAIT_OBJECT = 'await-object';
const SEARCH = 'search';
const AWAIT_REGISTER = 'await-register';
const DEFAULT_OPERATOR = 'goto';
function createParser() {
  let mode = NORMAL;
  let state = NORMAL;
  let count = '';
  let operator = null;
  let inner = true;
  let query = '';
  let pendingRegister = null;
  function reset() {
    state = NORMAL;
    count = '';
    operator = null;
    inner = true;
    query = '';
    pendingRegister = null;
  }
  function emit(target) {
    const command = {
      count: count ? parseInt(count, 10) : 1,
      operator: operator || DEFAULT_OPERATOR,
      target,
    };
    reset();
    return { status: 'command', command };
  }
  function feed(token) {
    if (token === null || token === undefined) return { status: 'ignored' };
    if (token === '<Esc>') {
      const wasInsert = mode === INSERT;
      mode = NORMAL;
      reset();
      return wasInsert ? { status: 'mode', mode: NORMAL } : { status: 'pending' };
    }
    if (mode === INSERT) return { status: 'ignored' };
    switch (state) {
      case SEARCH:
        if (token === '<CR>') {
          const text = query;
          if (!text) { reset(); return { status: 'invalid', reason: 'empty query' }; }
          return emit({ kind: 'search', query: text });
        }
        if (token === '<BS>') {
          query = query.slice(0, -1);
          return { status: 'pending', query, operator: operator || DEFAULT_OPERATOR };
        }
        if (token.length === 1) {
          query += token;
          return { status: 'pending', query, operator: operator || DEFAULT_OPERATOR };
        }
        return { status: 'pending', query, operator: operator || DEFAULT_OPERATOR };
      case AWAIT_OBJECT: {
        const object = TEXT_OBJECTS[token];
        if (!object) { reset(); return { status: 'invalid', reason: `no text object ${token}` }; }
        return emit({ kind: 'textobject', id: object.id, inner });
      }
      case AWAIT_REGISTER: {
        if (!/^[a-z0-9]$/.test(token)) {
          reset();
          return { status: 'invalid', reason: 'register must be a-z or 0-9' };
        }
        const action = pendingRegister;
        reset();
        return { status: 'command', command: { count: 1, operator: action, target: { kind: 'register', id: token } } };
      }
      case AWAIT_MOTION:
      case NORMAL:
      default:
        return normal(token);
    }
  }
  function normal(token) {
    if (/^[1-9]$/.test(token) || (count && token === '0')) {
      count += token;
      return { status: 'pending' };
    }
    if (state === AWAIT_MOTION) {
      if (token === 'i' || token === 'a') {
        inner = token === 'i';
        state = AWAIT_OBJECT;
        return { status: 'pending' };
      }
      return motion(token, true);
    }
    if (token === 'i') { mode = INSERT; reset(); return { status: 'mode', mode: INSERT }; }
    if (token === 'q' || token === '@') {
      pendingRegister = token === 'q' ? 'macro-record' : 'macro-replay';
      state = AWAIT_REGISTER;
      return { status: 'pending' };
    }
    if (OPERATORS[token]) {
      operator = OPERATORS[token].id;
      state = AWAIT_MOTION;
      return { status: 'pending' };
    }
    return motion(token, false);
  }
  function motion(token, afterOperator) {
    if (token === 'f') return emit({ kind: 'hint' });
    if (token === '/') { state = SEARCH; query = ''; return { status: 'pending' }; }
    if (token === 'n') return emit({ kind: 'repeat' });
    if (EDGES[token]) return emit({ kind: 'edge', id: EDGES[token].id });
    if (afterOperator) { reset(); return { status: 'invalid', reason: `no motion ${token}` }; }
    reset();
    return { status: 'ignored' };
  }
  return {
    feed,
    reset,
    get mode() { return mode; },
    setMode(next) { mode = next; reset(); },
    get pending() { return state !== NORMAL || count !== '' || operator !== null; },
  };
}


function motionKey(target) {
  switch (target.kind) {
    case 'search': return `search:${target.query.toLowerCase()}`;
    case 'textobject': return `object:${target.inner ? 'i' : 'a'}:${target.id}`;
    case 'edge': return `edge:${target.id}`;
    case 'hint': return 'hint';
    default: return `${target.kind}`;
  }
}
function memoryStore(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    read: (site) => data.get(site) || {},
    write: (site, value) => { data.set(site, value); },
    sites: () => [...data.keys()],
  };
}
function createBindings(store) {
  
  function lookup(site, target) {
    const entry = store.read(site)[motionKey(target)];
    return entry ? entry.fp : null;
  }
  
  function describe(site, target) {
    const entry = store.read(site)[motionKey(target)];
    return entry && entry.descriptor ? { ...entry.descriptor, fp: entry.fp } : null;
  }
  
  function remember(site, target, what, { confidence = null, source = 'user', descriptor = null } = {}) {
    const fromEntry = what && typeof what === 'object';
    const fp = fromEntry ? what.fp : what;
    const derived = fromEntry
      ? { role: what.role, name: what.name, ctx: what.ctx, anc: what.anc }
      : descriptor;
    const site_map = { ...store.read(site) };
    const key = motionKey(target);
    const previous = site_map[key];
    site_map[key] = {
      fp,
      uses: (previous && previous.fp === fp ? previous.uses : 0) + 1,
      confidence,
      source,
      descriptor: derived || (previous && previous.descriptor) || null,
    };
    store.write(site, site_map);
    return site_map[key];
  }
  function forget(site, target) {
    const site_map = { ...store.read(site) };
    delete site_map[motionKey(target)];
    store.write(site, site_map);
  }
  
  function toKeymap() {
    const lines = [];
    for (const site of store.sites().sort()) {
      const site_map = store.read(site);
      const keys = Object.keys(site_map).sort();
      if (!keys.length) continue;
      lines.push(`site ${site}`);
      for (const key of keys) {
        const entry = site_map[key];
        const confidence = entry.confidence === null ? '-' : entry.confidence.toFixed(2);
        lines.push(`  ${key} -> ${entry.fp}  uses=${entry.uses} conf=${confidence} via=${entry.source}`);
      }
    }
    return lines.join('\n');
  }
  return { lookup, describe, remember, forget, toKeymap };
}


function createMacros() {
  const registers = new Map();
  let recording = null;
  let buffer = [];
  function startRecording(register) {
    recording = register;
    buffer = [];
  }
  function stopRecording() {
    if (recording === null) return null;
    registers.set(recording, buffer.slice());
    const register = recording;
    recording = null;
    buffer = [];
    return register;
  }
  
  function capture(token) {
    if (recording !== null) buffer.push(token);
  }
  function get(register) {
    return registers.get(register) || null;
  }
  
  function replay(register, feed) {
    const tokens = get(register);
    if (!tokens) return null;
    return tokens.map((token) => feed(token));
  }
  return {
    startRecording,
    stopRecording,
    capture,
    get,
    replay,
    get recording() { return recording; },
  };
}


function createOps(win) {
  const doc = win.document;
  return {
    goto(el) {
      if (typeof el.focus === 'function') el.focus();
      el.click();
      return 'clicked';
    },
    yank(el) {
      const text = el.getAttribute('href') || el.value || el.textContent || '';
      const trimmed = text.trim();
      if (win.navigator && win.navigator.clipboard) win.navigator.clipboard.writeText(trimmed);
      return trimmed;
    },
    change(el) {
      if (typeof el.focus === 'function') el.focus();
      if ('value' in el) {
        el.value = '';
        el.dispatchEvent(new win.Event('input', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = '';
      }
      return 'cleared';
    },
    dismiss(el) {
      el.style.display = 'none';
      el.setAttribute('data-jevim-dismissed', '1');
      return 'hidden';
    },
    select(el) {
      const range = doc.createRange();
      range.selectNodeContents(el);
      const selection = win.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return 'selected';
    },
  };
}


function createRunner({ site, bindings, ops, getIndex, resolver = null, gate = null, repair = null }) {
  const net = { calls: 0 };
  function byFingerprint(index, fp) {
    return index.find((entry) => entry.fp === fp) || null;
  }
  function edgeTarget(index, id) {
    if (!index.length) return null;
    if (id === 'first') return index[0];
    if (id === 'last') return index[index.length - 1];
    const contexts = [...new Set(index.map((entry) => entry.ctx).filter(Boolean))];
    if (!contexts.length) return null;
    const first = index.find((entry) => entry.ctx === contexts[id === 'nextSection' ? 0 : contexts.length - 1]);
    return first || null;
  }
  
  async function resolve(command) {
    const index = getIndex();
    const { target } = command;
    if (target.kind === 'hint') return { tier: 'L0', entry: null, hint: true };
    if (target.kind === 'edge') {
      const entry = edgeTarget(index, target.id);
      return entry ? { tier: 'L0', entry } : { tier: 'none' };
    }
    const fp = bindings.lookup(site, target);
    if (fp) {
      const entry = byFingerprint(index, fp);
      if (entry) return { tier: 'L0', entry };
      const described = bindings.describe(site, target);
      bindings.forget(site, target);
      if (repair && described) {
        net.calls += 1;
        const fixed = await repair(described, index);
        if (!fixed.abstained && fixed.fp) {
          const entry2 = byFingerprint(index, fixed.fp);
          if (entry2) {
            bindings.remember(site, target, entry2, { confidence: fixed.confidence, source: 'repair' });
            return { tier: 'L0', entry: entry2, repaired: { from: described.fp, to: fixed.fp, confidence: fixed.confidence } };
          }
        }
        return { tier: 'stale', reason: 'the bound element is no longer on the page',
                 repairFailed: fixed.reason, described };
      }
    }
    if (!resolver) return { tier: 'needs-resolver' };
    net.calls += 1;
    const resolved = await resolver(target, index, command);
    if (!resolved) return { tier: 'none' };
    if (resolved.abstained) return { tier: 'L1', abstained: true, reason: resolved.reason, resolution: resolved };
    if (!resolved.fp) return { tier: 'none', resolution: resolved };
    return { tier: 'L1', entry: byFingerprint(index, resolved.fp), confidence: resolved.confidence, resolution: resolved };
  }
  
  async function run(command, { confirmed = false, attempted = false } = {}) {
    const resolution = await resolve(command);
    if (resolution.hint) return { status: 'hint', tier: 'L0' };
    if (resolution.tier === 'needs-resolver') return { status: 'needs-resolver', tier: 'none' };
    if (resolution.tier === 'stale') {
      return { status: 'stale', tier: 'L0', reason: resolution.reason,
               repairFailed: resolution.repairFailed };
    }
    if (resolution.abstained) {
      return { status: 'abstained', tier: 'L1', reason: resolution.reason, resolution: resolution.resolution };
    }
    if (resolution.tier === 'none' || !resolution.entry) {
      return { status: 'no-target', tier: 'none', repairFailed: resolution.repairFailed };
    }
    const { entry, tier } = resolution;
    if (entry.suspect) return { status: 'refused', reason: 'hidden text on target', tier, entry };
    if (DESTRUCTIVE.has(command.operator) && !confirmed) {
      return { status: 'confirm', tier, entry, operator: command.operator };
    }
    if (gate) {
      const verdict = gate(entry);
      if (!verdict.ok) {
        bindings.forget(site, command.target);
        if (repair && !attempted) {
          net.calls += 1;
          const fixed = await repair(entry, getIndex());
          if (!fixed.abstained && fixed.fp) {
            const replacement = byFingerprint(getIndex(), fixed.fp);
            bindings.remember(site, command.target, replacement || fixed.fp,
              { confidence: fixed.confidence, source: 'repair' });
            const retried = await run(command, { confirmed, attempted: true });
            return { ...retried, repaired: { from: entry.fp, to: fixed.fp, confidence: fixed.confidence } };
          }
          return { status: 'stale', reason: verdict.reason, tier, entry,
                   repairFailed: fixed.reason };
        }
        return { status: 'stale', reason: verdict.reason, tier, entry };
      }
    }
    const op = ops[command.operator];
    if (!op) return { status: 'no-op', tier, entry };
    const result = op(entry.el);
    return { status: 'done', tier, entry, result, confidence: resolution.confidence ?? null,
             resolution: resolution.resolution ?? null,
             repaired: resolution.repaired ?? undefined };
  }
  return { run, resolve, net, index: getIndex };
}


function createDriver({ runner, parser = createParser(), macros = createMacros(), typeAhead = null }) {
  let pending = [];
  let replaying = false;
  function commit(discard) {
    if (!discard && macros.recording !== null && !replaying) {
      for (const token of pending) macros.capture(token);
    }
    pending = [];
  }
  async function handle(token, { confirmed = false } = {}) {
    if (macros.recording !== null && token === 'q' && !parser.pending) {
      pending = [];
      return { status: 'macro-stopped', register: macros.stopRecording() };
    }
    pending.push(token);
    const result = parser.feed(token);
    if (result.status !== 'command') {
      if (result.status !== 'pending') commit(false);
      if (typeAhead && result.query && !replaying) {
        try { typeAhead.prime(result.query, runner.index(), { operator: result.operator }); }
        catch { /* a keystroke is never worth failing over */ }
      }
      return result;
    }
    const { command } = result;
    if (command.operator === 'macro-record') {
      commit(true);
      macros.startRecording(command.target.id);
      return { status: 'macro-recording', register: command.target.id };
    }
    if (command.operator === 'macro-replay') {
      commit(true);
      return replay(command.target.id);
    }
    commit(false);
    return { ...(await runner.run(command, { confirmed })), command };
  }
  async function replay(register) {
    const tokens = macros.get(register);
    if (!tokens) return { status: 'no-macro', register };
    replaying = true;
    const before = runner.net.calls;
    const results = [];
    for (const token of tokens) results.push(await handle(token));
    replaying = false;
    return { status: 'macro-replayed', register, results, netCalls: runner.net.calls - before };
  }
  return { handle, macros, parser, runner };
}


const ALPHABET = 'sadfjklewcmpgh';
function labels(count) {
  if (count <= 0) return [];
  const chars = ALPHABET.split('');
  if (count <= chars.length) return chars.slice(0, count);
  const width = Math.ceil(Math.log(count) / Math.log(chars.length));
  const out = [];
  for (let i = 0; i < count; i++) {
    let n = i;
    let label = '';
    for (let d = 0; d < width; d++) {
      label = chars[n % chars.length] + label;
      n = Math.floor(n / chars.length);
    }
    out.push(label);
  }
  return out;
}
function createHints(win, { onPick }) {
  const doc = win.document;
  let layer = null;
  let map = new Map();
  let typed = '';
  function show(index) {
    hide();
    layer = doc.createElement('div');
    layer.className = 'jevim-hints';
    map = new Map();
    const marks = labels(index.length);
    index.forEach((entry, i) => {
      const rect = entry.el.getBoundingClientRect();
      const mark = doc.createElement('span');
      mark.className = 'jevim-hint';
      mark.textContent = marks[i];
      mark.style.left = `${win.scrollX + rect.left}px`;
      mark.style.top = `${win.scrollY + rect.top}px`;
      layer.appendChild(mark);
      map.set(marks[i], entry);
    });
    doc.body.appendChild(layer);
    typed = '';
  }
  function hide() {
    if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
    layer = null;
    map = new Map();
    typed = '';
  }
  
  function feed(token) {
    if (!layer) return false;
    if (token === '<Esc>') { hide(); return true; }
    if (token.length !== 1) return false;
    typed += token;
    const hit = map.get(typed);
    if (hit) { hide(); onPick(hit); return true; }
    const live = [...map.keys()].some((label) => label.startsWith(typed));
    if (!live) hide();
    return true;
  }
  return { show, hide, feed, get active() { return layer !== null; } };
}

return {collect,domEnv,createGate,createBindings,memoryStore,createOps,createRunner,createDriver,createHints,tokenize,serialize};})();