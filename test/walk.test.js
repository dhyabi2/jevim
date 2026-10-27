import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import { collect } from '../src/index/collect.js';
import { createGate } from '../src/index/gate.js';
import { walk } from '../src/index/walk.js';

/** A page with a shadow root and a same-origin frame, measured with a fixed rect. */
function boundaryPage() {
  const dom = new JSDOM(`<!doctype html><body><main>
    <button id="plain">Plain button</button>
    <div id="host"></div>
    <iframe id="frame"></iframe>
  </main></body>`, { pretendToBeVisual: true });
  const win = dom.window;
  const doc = win.document;

  const root = doc.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML = '<button>Shadow button</button><input aria-label="Shadow field">';

  const frameDoc = doc.getElementById('frame').contentDocument;
  frameDoc.body.innerHTML = '<button>Frame button</button><a href="/x">Frame link</a>';

  const env = {
    style: (el) => (el.ownerDocument.defaultView || win).getComputedStyle(el),
    viewport: () => ({ w: 1000, h: 800 }),
    rect: () => ({ left: 0, top: 10, width: 120, height: 30, right: 120, bottom: 40 }),
  };
  return { win, doc, env };
}

test('the walk crosses open shadow roots and same-origin frames', () => {
  const { doc } = boundaryPage();
  const found = [...walk(doc, 'button,input,a[href]')].map((x) => ({
    text: (x.el.getAttribute('aria-label') || x.el.textContent || '').trim(),
    boundary: x.boundary.join('>'),
  }));
  const names = found.map((f) => f.text);
  assert.ok(names.includes('Plain button'), 'light DOM');
  assert.ok(names.includes('Shadow button'), 'inside an open shadow root');
  assert.ok(names.includes('Shadow field'), 'shadow input');
  assert.ok(names.includes('Frame button'), 'inside a same-origin frame');
  assert.ok(names.includes('Frame link'), 'frame link');
  assert.equal(found.find((f) => f.text === 'Shadow button').boundary, 'shadow:div');
  assert.match(found.find((f) => f.text === 'Frame button').boundary, /^frame:/);
});

test('the index now contains what querySelectorAll could never see', () => {
  const { doc, env } = boundaryPage();
  const index = collect(doc, env);
  const names = index.map((e) => e.name);
  assert.equal(doc.querySelectorAll('button').length, 1, 'the light DOM really has only one button');
  assert.ok(index.length >= 5, `indexed ${index.length}, expected at least 5`);
  for (const expected of ['Plain button', 'Shadow button', 'Shadow field', 'Frame button', 'Frame link']) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
});

test('the same name on either side of a shadow boundary keeps distinct fingerprints', () => {
  const dom = new JSDOM('<!doctype html><body><main><button>Submit</button><div id="h"></div></main></body>',
    { pretendToBeVisual: true });
  const doc = dom.window.document;
  doc.getElementById('h').attachShadow({ mode: 'open' }).innerHTML = '<button>Submit</button>';
  const env = { style: (el) => dom.window.getComputedStyle(el), viewport: () => ({ w: 900, h: 700 }),
                rect: () => ({ left: 0, top: 5, width: 90, height: 24, right: 90, bottom: 29 }) };

  const index = collect(doc, env);
  const submits = index.filter((e) => e.name === 'Submit');
  assert.equal(submits.length, 2);
  assert.notEqual(submits[0].fp, submits[1].fp, 'a shadow boundary is part of identity');
  assert.notEqual(submits[0].anc, submits[1].anc);
});

test('a cross-origin frame is skipped rather than throwing', () => {
  const dom = new JSDOM('<!doctype html><body><main><button>Visible</button><iframe src="https://other.example/x"></iframe></main></body>',
    { pretendToBeVisual: true });
  const doc = dom.window.document;
  const env = { style: (el) => dom.window.getComputedStyle(el), viewport: () => ({ w: 900, h: 700 }),
                rect: () => ({ left: 0, top: 5, width: 90, height: 24, right: 90, bottom: 29 }) };
  const index = collect(doc, env);
  assert.deepEqual(index.map((e) => e.name), ['Visible']);
});

test('the gate still recognises an element reached through a boundary', () => {
  const { doc, env } = boundaryPage();
  const index = collect(doc, env);
  const gate = createGate(doc, env);
  const shadowButton = index.find((e) => e.name === 'Shadow button');
  assert.ok(shadowButton);
  assert.equal(gate(shadowButton).ok, true, 'an unchanged shadow element passes');

  shadowButton.el.textContent = 'Renamed';
  assert.equal(gate(shadowButton).ok, false, 'a renamed shadow element is refused');
});

test('deep nesting terminates instead of hanging', () => {
  const dom = new JSDOM('<!doctype html><body><div id="d0"></div></body>', { pretendToBeVisual: true });
  const doc = dom.window.document;
  let host = doc.getElementById('d0');
  for (let i = 0; i < 30; i++) {
    const root = host.attachShadow({ mode: 'open' });
    const next = doc.createElement('div');
    root.append(next);
    host = next;
  }
  const found = [...walk(doc, 'div')];
  assert.ok(found.length > 0);
  assert.ok(found.length < 40, `walked ${found.length}; the depth cap should stop it`);
});
