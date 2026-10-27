// Which part of the fingerprint is brittle?
//
//   node bench/identity-variants.mjs
//
// The first run of the survival experiment put our fingerprint at 54.7% against a CSS selector's 67.4%,
// which by the plan's own kill criterion ends the direction. Before accepting that, the formula and the
// concept have to be told apart: content-addressed identity might be sound while MY choice of what to
// hash is brittle.
//
// Two suspects, both mine:
//
//   landmark ancestry - a redesign that wraps content in a new <section> or <nav> changes the chain, so
//                       the fingerprint moves even though the element did not
//   global ordinal    - position among same-named siblings is computed over the whole collected set, so
//                       any element added or removed anywhere can shift it
//
// Snapshots are cached on disk, because the Wayback availability API is rate-limited enough that
// re-fetching dominated the last run and only 3 of 20 pages came back.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { collect } from '../src/index/collect.js';

const CACHE = 'bench/data/snapshots';
const OLD = process.env.OLD_STAMP || '20230115';
const NEW = process.env.NEW_STAMP || '20260601';

const PAGES = [
  ['wikipedia', 'https://en.wikipedia.org/wiki/Bitcoin'],
  ['hackernews', 'https://news.ycombinator.com/'],
  ['python', 'https://www.python.org/'],
  ['gnu', 'https://www.gnu.org/'],
  ['debian', 'https://www.debian.org/'],
  ['mozilla', 'https://www.mozilla.org/en-US/'],
  ['w3c', 'https://www.w3.org/'],
  ['apache', 'https://httpd.apache.org/'],
  ['sourceforge', 'https://sourceforge.net/'],
  ['archive', 'https://archive.org/'],
  ['nasa', 'https://www.nasa.gov/'],
  ['mdn', 'https://developer.mozilla.org/en-US/'],
  ['stackoverflow', 'https://stackoverflow.com/'],
  ['github', 'https://github.com/'],
  ['npm', 'https://www.npmjs.com/'],
  ['imdb', 'https://www.imdb.com/'],
  ['craigslist', 'https://newyork.craigslist.org/'],
  ['guardian', 'https://www.theguardian.com/international'],
  ['bbc', 'https://www.bbc.com/news'],
  ['reuters', 'https://www.reuters.com/'],
  ['kernel', 'https://www.kernel.org/'],
  ['postgres', 'https://www.postgresql.org/'],
  ['sqlite', 'https://sqlite.org/index.html'],
  ['nginx', 'https://nginx.org/'],
  ['curl', 'https://curl.se/'],
];

mkdirSync(CACHE, { recursive: true });
const cacheKey = (url, stamp) => `${CACHE}/${createHash('sha1').update(url + stamp).digest('hex').slice(0, 16)}.json`;

async function snapshot(url, stamp) {
  const file = cacheKey(url, stamp);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1500 * attempt));
    try {
      const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}&timestamp=${stamp}`;
      const found = await fetch(api, { headers: { 'user-agent': 'jevim-bench/0.1' } }).then((r) => r.json());
      const closest = found.archived_snapshots && found.archived_snapshots.closest;
      if (!closest || !closest.available) continue;
      const raw = closest.url.replace(/\/(\d{14})\//, '/$1id_/');
      const res = await fetch(raw, { headers: { 'user-agent': 'jevim-bench/0.1' } });
      if (!res.ok) continue;
      const payload = { html: await res.text(), stamp: closest.timestamp };
      writeFileSync(file, JSON.stringify(payload));
      return payload;
    } catch { /* retry */ }
  }
  return null;
}

const CSS_escape = (v) => String(v).replace(/(["\\\]\[\.#:>~+*^$|()])/g, '\\$1');
function selectorFor(el) {
  const generated = (v) => /\d{4,}|^[a-f0-9]{8,}$|^:/.test(v || '');
  if (el.id && !generated(el.id)) return `#${CSS_escape(el.id)}`;
  for (const attr of ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label']) {
    const v = el.getAttribute(attr);
    if (v) return `${el.tagName.toLowerCase()}[${attr}="${CSS_escape(v)}"]`;
  }
  const parts = [];
  let node = el;
  for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth++) {
    let part = node.tagName.toLowerCase();
    const classes = [...(node.classList || [])].filter((c) => !generated(c)).slice(0, 2);
    if (classes.length) part += '.' + classes.map(CSS_escape).join('.');
    else if (node.parentElement) {
      const sibs = [...node.parentElement.children].filter((s) => s.tagName === node.tagName);
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

// Candidate identities. `current` is what ships; the rest strip one suspect at a time.
const IDENTITIES = {
  current: (e) => `${e.role}|${e.name.toLowerCase()}|${e.anc}|${e.ordinal ?? 0}`,
  noAncestry: (e) => `${e.role}|${e.name.toLowerCase()}|${e.ordinal ?? 0}`,
  noOrdinal: (e) => `${e.role}|${e.name.toLowerCase()}|${e.anc}`,
  nameAndRole: (e) => `${e.role}|${e.name.toLowerCase()}`,
  withContext: (e) => `${e.role}|${e.name.toLowerCase()}|${(e.ctx || '').toLowerCase()}`,
};

function indexOf(html, url) {
  const dom = new JSDOM(html, { url });
  const win = dom.window;
  let cursor = 0;
  const boxes = new WeakMap();
  const env = {
    style: (el) => win.getComputedStyle(el),
    viewport: () => ({ w: 1280, h: 900 }),
    rect: (el) => {
      if (boxes.has(el)) return boxes.get(el);
      const top = (cursor += 20);
      const box = { left: 8, top, width: 120, height: 18, right: 128, bottom: top + 18 };
      boxes.set(el, box);
      return box;
    },
  };
  // Ordinals are needed per identity, so they are recomputed below rather than taken from collect.
  return { index: collect(win.document, env), doc: win.document };
}

/** Recompute the ordinal under a given identity, so each variant is scored on its own terms. */
function keyed(index, identity) {
  const seen = new Map();
  const keys = [];
  for (const e of index) {
    const base = identity({ ...e, ordinal: 0 });
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    keys.push(identity === IDENTITIES.noOrdinal || identity === IDENTITIES.nameAndRole || identity === IDENTITIES.withContext
      ? base : `${base}#${n}`);
  }
  return keys;
}

const totals = { tracked: 0, css: 0, cssAmbiguous: 0 };
for (const k of Object.keys(IDENTITIES)) totals[k] = 0;
const pages = [];

for (const [name, url] of PAGES) {
  const [before, after] = [await snapshot(url, OLD), await snapshot(url, NEW)];
  if (!before || !after || before.stamp.slice(0, 6) === after.stamp.slice(0, 6)) {
    console.error(`${name}: no usable pair`);
    continue;
  }
  const oldSide = indexOf(before.html, url);
  const newSide = indexOf(after.html, url);
  const newNames = new Set(newSide.index.filter((e) => e.name).map((e) => e.name.toLowerCase()));

  const named = oldSide.index.filter((e) => e.name);
  const persistedIdx = named.map((e, i) => ({ e, i })).filter(({ e }) => newNames.has(e.name.toLowerCase()));
  if (!persistedIdx.length) { console.error(`${name}: nothing persisted`); continue; }

  const row = { name, tracked: persistedIdx.length, from: before.stamp, to: after.stamp, css: 0, cssAmbiguous: 0 };

  for (const [label, identity] of Object.entries(IDENTITIES)) {
    const oldKeys = keyed(oldSide.index, identity);
    const newKeys = new Set(keyed(newSide.index, identity));
    let hit = 0;
    for (const { e } of persistedIdx) {
      const at = oldSide.index.indexOf(e);
      if (at >= 0 && newKeys.has(oldKeys[at])) hit++;
    }
    row[label] = hit;
    totals[label] += hit;
  }

  for (const { e } of persistedIdx) {
    let matches = [];
    try { matches = [...newSide.doc.querySelectorAll(selectorFor(e.el))]; } catch { matches = []; }
    if (matches.length === 1) row.css++;
    else if (matches.length > 1) row.cssAmbiguous++;
  }
  totals.tracked += row.tracked;
  totals.css += row.css;
  totals.cssAmbiguous += row.cssAmbiguous;
  pages.push(row);
  console.error(`${name.padEnd(13)} n=${String(row.tracked).padStart(3)}  css ${String(row.css).padStart(3)}  cur ${String(row.current).padStart(3)}  noAnc ${String(row.noAncestry).padStart(3)}  noOrd ${String(row.noOrdinal).padStart(3)}  n+r ${String(row.nameAndRole).padStart(3)}  ctx ${String(row.withContext).padStart(3)}`);
}

mkdirSync('bench/out', { recursive: true });
writeFileSync('bench/out/identity-variants.json', JSON.stringify({ pages, totals }, null, 1));

const n = totals.tracked || 1;
const pct = (v) => `${((v / n) * 100).toFixed(1)}%`;
console.log(`
pages compared        ${pages.length}
elements still present ${totals.tracked}   <- scored population

css selector          ${String(totals.css).padStart(4)}  ${pct(totals.css)}   (+${totals.cssAmbiguous} ambiguous)
fingerprint, current  ${String(totals.current).padStart(4)}  ${pct(totals.current)}
  without ancestry    ${String(totals.noAncestry).padStart(4)}  ${pct(totals.noAncestry)}
  without ordinal     ${String(totals.noOrdinal).padStart(4)}  ${pct(totals.noOrdinal)}
  role and name only  ${String(totals.nameAndRole).padStart(4)}  ${pct(totals.nameAndRole)}
  role, name, context ${String(totals.withContext).padStart(4)}  ${pct(totals.withContext)}`);
