import assert from 'node:assert/strict';
import test from 'node:test';

import { createDriver } from '../src/driver.js';
import { createBindings, memoryStore } from '../src/grammar/bindings.js';
import { createRunner } from '../src/grammar/runner.js';
import { collect } from '../src/index/collect.js';
import { createGate } from '../src/index/gate.js';
import { page } from './helpers.mjs';

/** Tokens must be fed in order; the driver is async now that L1 is a network call. */
async function feed(driver, tokens) {
  const out = [];
  for (const token of tokens) out.push(await driver.handle(token));
  return out;
}

const SITE = 'shop.example';
const MARKUP = `
  <main>
    <section><h3>Cart</h3>
      <a href="/checkout" id="go" data-rect="0,0,140,30">Checkout</a>
      <button id="rm" data-rect="150,0,80,30">Remove</button>
    </section>
  </main>`;

/** Page, driver, and a record of which elements an operator was actually applied to. */
function harness() {
  const { win, doc, env } = page(MARKUP);
  const index = collect(doc, env);
  const bindings = createBindings(memoryStore());
  const applied = [];

  const checkout = index.find((e) => e.name === 'Checkout');
  const remove = index.find((e) => e.name === 'Remove');
  bindings.remember(SITE, { kind: 'search', query: 'checkout' }, checkout.fp, { confidence: 0.96 });
  bindings.remember(SITE, { kind: 'search', query: 'remove' }, remove.fp, { confidence: 0.99 });

  const runner = createRunner({
    site: SITE,
    bindings,
    ops: { goto: (el) => { applied.push(el.id); return 'clicked'; },
           dismiss: (el) => { applied.push(el.id); return 'hidden'; } },
    // The index is captured once, exactly as the lazy rebuild does in the extension.
    getIndex: () => index,
    gate: createGate(doc, env),
  });

  return { driver: createDriver({ runner }), runner, bindings, doc, win, applied, index };
}

const GOTO_CHECKOUT = ['g', '/', 'c', 'h', 'e', 'c', 'k', 'o', 'u', 't', '<CR>'];

test('an unchanged target passes the gate and the operator fires', async () => {
  const { driver, applied } = harness();
  const result = (await feed(driver, GOTO_CHECKOUT)).at(-1);
  assert.equal(result.status, 'done');
  assert.deepEqual(applied, ['go']);
});

test('a target renamed after collection is refused, not clicked', async () => {
  const { driver, doc, applied, bindings } = harness();
  // The page mutates after the index was built: the lazy rebuild has not run yet.
  doc.getElementById('go').textContent = 'Continue to payment';

  const result = (await feed(driver, GOTO_CHECKOUT)).at(-1);
  assert.equal(result.status, 'stale');
  assert.equal(result.reason, 'target name changed');
  assert.deepEqual(applied, [], 'nothing was clicked');
  assert.equal(bindings.lookup(SITE, { kind: 'search', query: 'checkout' }), null, 'binding forgotten');
});

test('a target removed from the document is refused, not clicked', async () => {
  const { driver, doc, applied } = harness();
  doc.getElementById('go').remove();
  const result = (await feed(driver, GOTO_CHECKOUT)).at(-1);
  assert.equal(result.status, 'stale');
  assert.equal(result.reason, 'target left the document');
  assert.deepEqual(applied, []);
});

test('a target hidden after collection is refused, not clicked', async () => {
  const { driver, doc, applied } = harness();
  doc.getElementById('go').setAttribute('aria-hidden', 'true');
  const result = (await feed(driver, GOTO_CHECKOUT)).at(-1);
  assert.equal(result.status, 'stale');
  assert.equal(result.reason, 'target is no longer visible');
  assert.deepEqual(applied, []);
});

test('a target that moved to a different landmark is refused, not clicked', async () => {
  const { driver, doc, applied } = harness();
  const moved = doc.getElementById('go');
  const nav = doc.createElement('nav');
  doc.querySelector('main').appendChild(nav);
  nav.appendChild(moved);

  const result = (await feed(driver, GOTO_CHECKOUT)).at(-1);
  assert.equal(result.status, 'stale');
  assert.equal(result.reason, 'target moved');
  assert.deepEqual(applied, []);
});

test('the gate runs after the confirmation, so a change during the prompt is caught', async () => {
  const { driver, runner, doc, applied } = harness();
  const keys = ['d', '/', 'r', 'e', 'm', 'o', 'v', 'e', '<CR>'];
  const asked = (await feed(driver, keys)).at(-1);
  assert.equal(asked.status, 'confirm');
  assert.deepEqual(applied, [], 'nothing fired before the user answered');

  // The page changes while the confirmation is on screen.
  doc.getElementById('rm').textContent = 'Delete everything';

  const answered = await runner.run(asked.command ?? { count: 1, operator: 'dismiss', target: { kind: 'search', query: 'remove' } },
    { confirmed: true });
  assert.equal(answered.status, 'stale');
  assert.deepEqual(applied, [], 'the confirmed action did not fire on the changed element');
});

test('the gate makes no network calls', async () => {
  const { driver, runner, doc } = harness();
  doc.getElementById('go').textContent = 'Changed';
  await feed(driver, GOTO_CHECKOUT);
  assert.equal(runner.net.calls, 0);
});
