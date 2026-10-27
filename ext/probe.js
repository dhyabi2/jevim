window.__probe=(function(){

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

return function(budget){
const env=domEnv(window);const t0=performance.now();const index=collect(document,env);
const t1=performance.now();const out=serialize(index,{budget});
const bad=index.filter(e=>!isVisible(e.el,env));
const el=document.querySelectorAll('*').length;
return {url:location.hostname,domNodes:el,indexed:index.length,invisibleLeaked:bad.length,
tokens:out.tokens,budget:out.budget,kept:out.kept,dropped:out.dropped,collectMs:+(t1-t0).toFixed(1),
suspect:index.filter(e=>e.suspect).length,unnamed:index.filter(e=>!e.name).length,
sample:index.slice(0,4).map(e=>({id:e.id,fp:e.fp,role:e.role,name:e.name,ctx:e.ctx,vp:e.vp})),
leakedNode:JSON.stringify(out.state).includes('[object')};};})();