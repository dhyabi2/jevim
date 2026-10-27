// Does real Chrome close the fidelity gap jsdom opened?
//
//   node bench/fidelity.mjs
//
// Measured earlier: wikipedia.org gave 32 indexable elements in the extension against 383 headless,
// because jsdom never fetches stylesheets and geometry is most of the collector's pruning power. Every
// headless number was therefore untrustworthy. This scores the same pages three ways.

import { axIndex } from '../server/ax-index.mjs';
import { connect, launch, open } from '../server/cdp.mjs';
import { collect } from '../src/index/collect.js';
import { fetchPage } from '../server/page.mjs';

const PAGES = [
  'https://www.wikipedia.org',
  'https://news.ycombinator.com',
  'https://en.wikipedia.org/wiki/Bitcoin',
  'https://www.debian.org',
];

const chrome = await launch();
const cdp = await connect(chrome.endpoint);
const rows = [];

for (const url of PAGES) {
  // jsdom, the old headless path.
  let jsdomCount = 0;
  try {
    const page = await fetchPage(url);
    jsdomCount = collect(page.doc, page.env).length;
  } catch { jsdomCount = -1; }

  const page = await open(cdp, url);

  // Real Chrome, DOM collector, running inside the page.
  const domInChrome = await page.evaluate(`
    (() => {
      const SEL = 'a[href],button,input,select,textarea,summary,[contenteditable=""],[contenteditable="true"],[tabindex]:not([tabindex="-1"]),[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="option"],[role="switch"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="slider"]';
      let visible = 0;
      for (const el of document.querySelectorAll(SEL)) {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 3 || r.height < 3) continue;
        if (r.right <= 0 || r.bottom <= 0) continue;
        visible++;
      }
      return visible;
    })()
  `);

  const ax = await axIndex(page);
  await page.close();

  rows.push({ url, jsdomCount, domInChrome, ax: ax.index.length, axNodes: ax.axNodes,
              considered: ax.considered });
  const short = url.replace(/^https?:\/\//, '').slice(0, 30);
  console.log(`${short.padEnd(31)} jsdom ${String(jsdomCount).padStart(4)}  chrome-dom ${String(domInChrome).padStart(4)}  chrome-ax ${String(ax.index.length).padStart(4)}  (of ${ax.considered} interactive in ${ax.axNodes} ax nodes)`);
}

cdp.close();
await chrome.close();

console.log('\nthe gap jsdom opened, per page:');
for (const r of rows) {
  const ratio = r.domInChrome ? (r.jsdomCount / r.domInChrome).toFixed(1) : '-';
  console.log(`  ${r.url.replace(/^https?:\/\//, '').slice(0, 30).padEnd(31)} jsdom overcounts by ${ratio}x`);
}
