// The experiment everything else rests on.
//
//   node bench/fingerprint-vs-selector.mjs
//
// Repair, pinning, the free cache and staleness all assume a stable element identity. If a fingerprint
// does not survive a real redesign better than a CSS selector, that assumption is false and those
// features are built on sand.
//
// Method: take two Wayback snapshots of the same page years apart. On the OLD one, record every
// interactive element twice - once as our fingerprint, once as the kind of CSS selector a recorder like
// Playwright codegen would emit. On the NEW one, count how many of each still identify exactly one
// element. The CSS selector is the control, and it is generated generously - id first, then a stable
// attribute, then a class path, then nth-child - so the comparison is not rigged.

import { writeFileSync, mkdirSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { collect } from '../src/index/collect.js';

const PAGES = [
  ['wikipedia', 'https://en.wikipedia.org/wiki/Bitcoin'],
  ['hackernews', 'https://news.ycombinator.com/'],
  ['bbc', 'https://www.bbc.com/news'],
  ['python', 'https://www.python.org/'],
  ['gnu', 'https://www.gnu.org/'],
  ['w3c', 'https://www.w3.org/'],
  ['apache', 'https://httpd.apache.org/'],
  ['debian', 'https://www.debian.org/'],
  ['mozilla', 'https://www.mozilla.org/en-US/'],
  ['nasa', 'https://www.nasa.gov/'],
  ['imdb', 'https://www.imdb.com/'],
  ['stackoverflow', 'https://stackoverflow.com/'],
  ['github', 'https://github.com/'],
  ['npm', 'https://www.npmjs.com/'],
  ['mdn', 'https://developer.mozilla.org/en-US/'],
  ['reuters', 'https://www.reuters.com/'],
  ['guardian', 'https://www.theguardian.com/international'],
  ['craigslist', 'https://newyork.craigslist.org/'],
  ['sourceforge', 'https://sourceforge.net/'],
  ['archive', 'https://archive.org/'],
];

const OLD = process.env.OLD_STAMP || '20230115';
const NEW = process.env.NEW_STAMP || '20260601';

// The availability API returns an empty result intermittently for pages that certainly are archived -
// Wikipedia answered for 2023 and not 2026, Python the reverse - so it is retried with backoff.
async function snapshot(url, stamp, attempts = 4) {
  let closest = null;
  for (let attempt = 0; attempt < attempts && !closest; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 1200 * attempt));
    try {
      const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}&timestamp=${stamp}`;
      const found = await fetch(api, { headers: { 'user-agent': 'jevim-bench/0.1' } }).then((r) => r.json());
      const c = found.archived_snapshots && found.archived_snapshots.closest;
      if (c && c.available) closest = c;
    } catch { /* retry */ }
  }
  if (!closest) return null;
  // `id_` returns the original bytes rather than the archive's rewritten page.
  const raw = closest.url.replace(/\/(\d{14})\//, '/$1id_/');
  const res = await fetch(raw, { headers: { 'user-agent': 'jevim-bench/0.1' } });
  if (!res.ok) return null;
  return { html: await res.text(), stamp: closest.timestamp, url: raw };
}

/**
 * The selector a recorder would emit, generated generously so the control is a fair fight.
 *
 * An id if it looks authored rather than generated; then a stable test or name attribute; then a class
 * path; then a structural nth-child path. This is the ladder Playwright codegen and Cypress selector
 * playgrounds walk.
 */
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
      const siblings = [...node.parentElement.children].filter((s) => s.tagName === node.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
}
const CSS_escape = (v) => String(v).replace(/(["\\\]\[\.#:>~+*^$|()])/g, '\\$1');

/** jsdom has no layout, so geometry is synthesised in document order. Both sides are scored alike. */
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
  return { index: collect(win.document, env), doc: win.document };
}

const rows = [];
for (const [name, url] of PAGES) {
  try {
    const [before, after] = await Promise.all([snapshot(url, OLD), snapshot(url, NEW)]);
    if (!before || !after) { console.error(`${name}: no snapshot pair`); continue; }
    if (before.stamp.slice(0, 6) === after.stamp.slice(0, 6)) {
      console.error(`${name}: both snapshots from the same month, skipping`);
      continue;
    }

    const oldSide = indexOf(before.html, url);
    const newSide = indexOf(after.html, url);
    const newByFp = new Set(newSide.index.map((e) => e.fp));
    const newNames = new Set(newSide.index.filter((e) => e.name).map((e) => e.name.toLowerCase()));

    // The population matters more than the metric here.
    //
    // Scoring every element conflates two different things. A news headline that changed is CONTENT
    // change: the accessible name is different, so the fingerprint is different by design and counting
    // that as a failure measures the wrong thing. Structural resilience is about an element that is
    // STILL THERE being found after the markup around it changed.
    //
    // So the population is elements whose name still appears on the new page. Among those, the question
    // is the real one: given the thing persisted, which addressing scheme still locates it.
    const named = oldSide.index.filter((e) => e.name);
    const persisted = named.filter((e) => newNames.has(e.name.toLowerCase())).slice(0, 60);

    let fpSurvived = 0;
    let selSurvived = 0;
    let selAmbiguous = 0;

    for (const entry of persisted) {
      if (newByFp.has(entry.fp)) fpSurvived++;
      const selector = selectorFor(entry.el);
      let matches = [];
      try { matches = [...newSide.doc.querySelectorAll(selector)]; } catch { matches = []; }
      if (matches.length === 1) selSurvived++;
      else if (matches.length > 1) selAmbiguous++;
    }

    rows.push({ name, named: named.length, tracked: persisted.length, fpSurvived, selSurvived,
                selAmbiguous, from: before.stamp, to: after.stamp });
    console.error(`${name.padEnd(14)} persisted=${String(persisted.length).padStart(2)}/${String(named.length).padStart(3)}  fp ${String(fpSurvived).padStart(2)}  css ${String(selSurvived).padStart(2)} (+${selAmbiguous} ambig)  ${before.stamp.slice(0, 6)} -> ${after.stamp.slice(0, 6)}`);
    await new Promise((r) => setTimeout(r, 800));
  } catch (error) {
    console.error(`${name}: ${error.message}`);
  }
}

mkdirSync('bench/out', { recursive: true });
writeFileSync('bench/out/fingerprint-vs-selector.json', JSON.stringify(rows, null, 1));

const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
const n = sum('tracked');
const pct = (v) => `${((v / (n || 1)) * 100).toFixed(1)}%`;
console.log(`
pages compared             ${rows.length}
named elements on old page ${sum('named')}
still present on new page  ${n}   <- the population scored
fingerprint located it     ${sum('fpSurvived')}  (${pct(sum('fpSurvived'))})
css selector located it    ${sum('selSurvived')}  (${pct(sum('selSurvived'))})
css matched several        ${sum('selAmbiguous')}  (${pct(sum('selAmbiguous'))}) - a silent wrong-element risk`);
