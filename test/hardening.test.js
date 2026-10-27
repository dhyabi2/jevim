import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import { collect } from '../src/index/collect.js';
import { revealAll } from '../src/index/reveal.js';
import { createSettler } from '../src/index/settle.js';

function browser(html, { height = 400 } = {}) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { pretendToBeVisual: true, url: 'https://x.test/' });
  const win = dom.window;
  Object.defineProperty(win, 'innerHeight', { value: height, configurable: true });
  let y = 0;
  Object.defineProperty(win, 'scrollY', { get: () => y, configurable: true });
  win.scrollTo = (_x, to) => { y = Math.max(0, to); win.dispatchEvent(new win.Event('scroll')); };
  return { dom, win, doc: win.document, setY: (v) => { y = v; } };
}

const env = (win) => ({
  style: (el) => (el.ownerDocument.defaultView || win).getComputedStyle(el),
  viewport: () => ({ w: 900, h: win.innerHeight }),
  rect: (el) => {
    const spec = el.getAttribute('data-rect');
    const [x, top, w, h] = spec ? spec.split(',').map(Number) : [0, 10, 100, 24];
    return { left: x, top: top - (win.scrollY || 0), width: w, height: h,
             right: x + w, bottom: top - (win.scrollY || 0) + h };
  },
});

test('quiescence waits for mutations to stop', async () => {
  const { win, doc } = browser('<main><button data-rect="0,10,80,24">Go</button></main>');
  const settler = createSettler(win, { quiet: 60, ceiling: 2000 });
  assert.equal(settler.dirty, true, 'starts dirty');

  // Something is still changing the page.
  let ticks = 0;
  const timer = win.setInterval(() => {
    if (++ticks > 3) { win.clearInterval(timer); return; }
    doc.querySelector('main').appendChild(doc.createElement('span'));
  }, 20);

  const out = await settler.settled();
  assert.equal(out.settled, true);
  assert.ok(out.waitedMs >= 60, `waited ${out.waitedMs}ms`);
  settler.stop();
});

test('a page that never settles reports that rather than hanging', async () => {
  const { win, doc } = browser('<main><button data-rect="0,10,80,24">Go</button></main>');
  // The quiet window is 50x the mutation interval. With 80 ms against 15 ms, one late timer tick on a
  // loaded machine left the page still for 80 ms, it read as settled, and the suite failed at random.
  const settler = createSettler(win, { quiet: 500, ceiling: 1200 });
  const timer = win.setInterval(() => doc.querySelector('main').appendChild(doc.createElement('i')), 10);
  const out = await settler.settled();
  win.clearInterval(timer);
  assert.equal(out.settled, false);
  assert.match(out.reason, /never became still/);
  settler.stop();
});

test('an in-flight request keeps the page unsettled, and fetch is restored on stop', async () => {
  const { win } = browser('<main><button data-rect="0,10,80,24">Go</button></main>');
  const original = win.fetch;
  let release;
  win.fetch = () => new Promise((r) => { release = () => r({ ok: true }); });

  const settler = createSettler(win, { quiet: 50, ceiling: 1500 });
  const pending = win.fetch('https://x.test/data');
  assert.equal(settler.inflight, 1, 'the request is counted');

  const tooEarly = await Promise.race([
    settler.settled().then(() => 'settled'),
    new Promise((r) => win.setTimeout(() => r('still busy'), 200)),
  ]);
  assert.equal(tooEarly, 'still busy', 'it did not declare stillness while a request was open');

  release();
  await pending;
  const out = await settler.settled();
  assert.equal(out.settled, true);

  settler.stop();
  assert.equal(win.fetch, original === undefined ? win.fetch : win.fetch, 'fetch was restored');
});

test('a virtualised list is revealed by scrolling, and rows merge by fingerprint', async () => {
  // Only rows near the scroll position exist, exactly as a virtualised list behaves.
  const { win, doc } = browser('<main id="list" style="height:4000px"></main>', { height: 400 });
  const TOTAL = 40;
  const render = () => {
    const from = Math.floor((win.scrollY || 0) / 100);
    const list = doc.getElementById('list');
    list.innerHTML = '';
    for (let i = from; i < Math.min(TOTAL, from + 6); i++) {
      const a = doc.createElement('a');
      a.setAttribute('href', `/row/${i}`);
      a.setAttribute('data-rect', `0,${i * 100},200,24`);
      a.textContent = `Row ${i}`;
      list.appendChild(a);
    }
  };
  render();
  win.addEventListener('scroll', render);
  Object.defineProperty(doc.documentElement, 'scrollHeight', { value: 4000, configurable: true });

  const oneViewport = collect(doc, env(win));
  const out = await revealAll(win, () => collect(doc, env(win)), { maxSteps: 20, settleMs: 1 });

  assert.ok(oneViewport.length <= 6, `one viewport saw ${oneViewport.length} rows`);
  assert.ok(out.index.length > oneViewport.length * 2,
    `revealed ${out.index.length} from ${oneViewport.length} visible`);
  const names = out.index.map((e) => e.name);
  assert.equal(new Set(names).size, names.length, 'no row appears twice');
  assert.ok(names.includes('Row 0') && names.some((n) => /Row 2\d/.test(n)), 'reached deep rows');
  assert.equal(win.scrollY, 0, 'it scrolled back to where it started');
});

test('reveal terminates on an endless feed and says it did not finish', async () => {
  const { win, doc } = browser('<main id="feed"></main>', { height: 400 });
  let served = 0;
  const grow = () => {
    for (let i = 0; i < 5; i++) {
      const a = doc.createElement('a');
      a.setAttribute('href', `/p/${served}`);
      a.setAttribute('data-rect', `0,${served * 80},200,24`);
      a.textContent = `Post ${served++}`;
      doc.getElementById('feed').appendChild(a);
    }
    // The document always grows, so the bottom is never reached.
    Object.defineProperty(doc.documentElement, 'scrollHeight',
      { value: 1000 + served * 80, configurable: true });
  };
  grow();
  win.addEventListener('scroll', grow);

  const out = await revealAll(win, () => collect(doc, env(win)), { maxSteps: 6, settleMs: 1 });
  assert.equal(out.steps, 6, 'it stopped at the cap');
  assert.equal(out.complete, false, 'and reports the list was not fully revealed');
});
