import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import { collect } from '../src/index/collect.js';
import { wrap } from '../server/page.mjs';
import { lex } from '../server/session.mjs';
import { page } from './helpers.mjs';

// A keymap is only shareable if a fingerprint means the same thing wherever it is computed.
// The browser measures real geometry; the headless server synthesises it. If fingerprints
// depended on layout at all, a binding learned in Chrome would be useless on the server and
// the "a .vimrc for the web" claim would be empty.

const MARKUP = `
  <main>
    <search><form action="/s"><input type="search" name="q" aria-label="Search Wikipedia"></form></search>
    <nav><a href="/en">English</a><a href="/de">Deutsch</a></nav>
    <section><h3>Cart</h3><button>Edit</button><button>Edit</button></section>
  </main>`;

test('fingerprints are identical under measured and synthetic layout', () => {
  // Browser-like: explicit geometry, as the extension sees it.
  const browser = page(MARKUP.replace(/<(input|a|button)/g, '<$1 data-rect="0,0,120,30"'));
  const measured = collect(browser.doc, browser.env);

  // Server-like: no layout engine, geometry invented from document order.
  const dom = new JSDOM(`<!doctype html><html><body>${MARKUP}</body></html>`, { url: 'https://example.org/' });
  const headless = wrap(dom, 'https://example.org/');
  const synthetic = collect(headless.doc, headless.env);

  assert.deepEqual(
    synthetic.map((e) => [e.role, e.name, e.anc, e.fp]),
    measured.map((e) => [e.role, e.name, e.anc, e.fp]),
    'the same elements must carry the same fingerprints in both runtimes',
  );
});

test('the two duplicate buttons stay distinguishable in both runtimes', () => {
  const dom = new JSDOM(`<!doctype html><html><body>${MARKUP}</body></html>`, { url: 'https://example.org/' });
  const headless = wrap(dom, 'https://example.org/');
  const edits = collect(headless.doc, headless.env).filter((e) => e.name === 'Edit');
  assert.equal(edits.length, 2);
  assert.notEqual(edits[0].fp, edits[1].fp);
});

test('the key lexer produces the same tokens a keydown listener would', () => {
  assert.deepEqual(lex('g/search<CR>'), ['g', '/', 's', 'e', 'a', 'r', 'c', 'h', '<CR>']);
  assert.deepEqual(lex('3dip'), ['3', 'd', 'i', 'p']);
  assert.deepEqual(lex('qa f q'), ['q', 'a', ' ', 'f', ' ', 'q']);
  assert.deepEqual(lex('<Esc><C-d>'), ['<Esc>', '<C-d>']);
});
