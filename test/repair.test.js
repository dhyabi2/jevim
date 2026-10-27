import assert from 'node:assert/strict';
import test from 'node:test';

import { createBindings, memoryStore } from '../src/grammar/bindings.js';
import { createRunner } from '../src/grammar/runner.js';
import { collect } from '../src/index/collect.js';
import { createGate } from '../src/index/gate.js';
import { REPAIR_FLOOR, createRepair } from '../src/resolve/repair.js';
import { page } from './helpers.mjs';

const SITE = 'shop.example';
const MARKUP = `
  <main><section><h3>Cart</h3>
    <a href="/checkout" id="go" data-rect="0,0,140,30">Checkout</a>
    <a href="/help" id="help" data-rect="150,0,80,30">Help</a>
    <button id="rm" data-rect="0,40,90,30">Remove</button>
  </section></main>`;

/**
 * Scripted decide transport. `want` names the element the repair should choose, matched against the
 * candidate rubric, because choosing by position made the test depend on index ordering.
 *
 * `getIndex` re-collects, which is what production does: a DOM mutation marks the index dirty and the
 * next read rebuilds it. Holding a fixed array here hid the renamed element from the repair entirely.
 */
function harness({ want = null, confidence = 0.9, none = false, throws = false } = {}) {
  const { doc, env } = page(MARKUP);
  const bindings = createBindings(memoryStore());
  const applied = [];
  const asked = [];
  const index = () => collect(doc, env);

  const decide = async (body) => {
    asked.push(body);
    if (throws) throw new Error('ECONNRESET');
    const criteria = body.questions.same.criteria;
    const ids = Object.keys(criteria).filter((k) => k !== '__none__');
    const chosen = want
      ? ids.find((id) => criteria[id].includes(want)) ?? ids[0]
      : ids[0];
    return { answers: { same: { choice: none ? '__none__' : chosen, confidence } } };
  };

  const runner = createRunner({
    site: SITE, bindings,
    ops: { goto: (el) => { applied.push(el.id); return 'clicked'; } },
    getIndex: index,
    gate: createGate(doc, env),
    repair: createRepair({ decide }),
  });
  return { runner, bindings, index, applied, asked, doc };
}

const GOTO = (query) => ({ count: 1, operator: 'goto', target: { kind: 'search', query } });

test('a renamed target is repaired and the step completes', async () => {
  const h = harness({ want: 'Continue to payment', confidence: 0.95 });
  const checkout = h.index().find((e) => e.name === 'Checkout');
  h.bindings.remember(SITE, GOTO('checkout').target, checkout, { confidence: 0.9 });

  // The page changes under the binding.
  h.doc.getElementById('go').textContent = 'Continue to payment';

  const out = await h.runner.run(GOTO('checkout'));
  assert.equal(out.status, 'done', out.reason);
  assert.ok(out.repaired, 'the result reports what was repaired');
  assert.equal(out.repaired.from, checkout.fp);
  assert.deepEqual(h.applied, ['go'], 'it acted on the renamed element');
});

test('the repaired binding is written back, so the next run needs no repair', async () => {
  const h = harness({ want: 'Pay now', confidence: 0.95 });
  const checkout = h.index().find((e) => e.name === 'Checkout');
  h.bindings.remember(SITE, GOTO('checkout').target, checkout, { confidence: 0.9 });
  h.doc.getElementById('go').textContent = 'Pay now';

  await h.runner.run(GOTO('checkout'));
  const callsAfterFirst = h.asked.length;
  assert.equal(callsAfterFirst, 1);

  const again = await h.runner.run(GOTO('checkout'));
  assert.equal(again.status, 'done');
  assert.equal(h.asked.length, callsAfterFirst, 'no second repair call');
});

test('only same-role candidates are offered to the repair', async () => {
  const h = harness({ want: 'Renamed', confidence: 0.95 });
  const checkout = h.index().find((e) => e.name === 'Checkout');
  h.bindings.remember(SITE, GOTO('checkout').target, checkout, { confidence: 0.9 });
  h.doc.getElementById('go').textContent = 'Renamed';

  await h.runner.run(GOTO('checkout'));
  const criteria = h.asked[0].questions.same.criteria;
  const offered = Object.keys(criteria).filter((k) => k !== '__none__');
  assert.ok(offered.length > 0);
  for (const id of offered) {
    assert.match(criteria[id], /^link /, `offered a non-link: ${criteria[id]}`);
  }
  assert.ok(!Object.values(criteria).some((t) => /^button /.test(t)), 'the button was never a candidate');
});

test('a repair below the floor is refused and the step stays stale', async () => {
  const h = harness({ want: 'Renamed', confidence: REPAIR_FLOOR - 0.1 });
  const checkout = h.index().find((e) => e.name === 'Checkout');
  h.bindings.remember(SITE, GOTO('checkout').target, checkout, { confidence: 0.9 });
  h.doc.getElementById('go').textContent = 'Renamed';

  const out = await h.runner.run(GOTO('checkout'));
  assert.equal(out.status, 'stale');
  assert.match(out.repairFailed, /below the repair floor/);
  assert.deepEqual(h.applied, [], 'nothing was clicked');
});

test('the repair floor is stricter than a fresh resolution', async () => {
  const { FLOORS } = await import('../src/resolve/jev.js');
  assert.ok(REPAIR_FLOOR > FLOORS.goto,
    'replacing something the user already bound is a larger claim than resolving a fresh motion');
});

test('when nothing on the page is the old element, it refuses', async () => {
  const h = harness({ none: true });
  const checkout = h.index().find((e) => e.name === 'Checkout');
  h.bindings.remember(SITE, GOTO('checkout').target, checkout, { confidence: 0.9 });
  h.doc.getElementById('go').textContent = 'Renamed';

  const out = await h.runner.run(GOTO('checkout'));
  assert.equal(out.status, 'stale');
  assert.match(out.repairFailed, /no element on the page is the old/);
  assert.deepEqual(h.applied, []);
});

test('a repair that throws degrades to stale, never to an action', async () => {
  const h = harness({ throws: true });
  const checkout = h.index().find((e) => e.name === 'Checkout');
  h.bindings.remember(SITE, GOTO('checkout').target, checkout, { confidence: 0.9 });
  h.doc.getElementById('go').textContent = 'Renamed';

  const out = await h.runner.run(GOTO('checkout'));
  assert.equal(out.status, 'stale');
  assert.match(out.repairFailed, /repair unavailable: ECONNRESET/);
  assert.deepEqual(h.applied, []);
});

test('repair is attempted once, not in a loop', async () => {
  // The repair picks an element that will itself fail the gate, because it is removed first.
  const { doc, env } = page(MARKUP);
  const index = collect(doc, env);
  const bindings = createBindings(memoryStore());
  const applied = [];
  let calls = 0;
  const help = index.find((e) => e.name === 'Help');
  const decide = async () => {
    calls++;
    return { answers: { same: { choice: help.id, confidence: 0.95 } } };
  };
  const runner = createRunner({
    site: SITE, bindings, ops: { goto: (el) => { applied.push(el.id); return 'clicked'; } },
    getIndex: () => collect(doc, env), gate: createGate(doc, env), repair: createRepair({ decide }),
  });
  const checkout = index.find((e) => e.name === 'Checkout');
  bindings.remember(SITE, GOTO('checkout').target, checkout, { confidence: 0.9 });
  doc.getElementById('go').textContent = 'Renamed';
  doc.getElementById('help').remove();

  const out = await runner.run(GOTO('checkout'));
  assert.equal(calls, 1, 'one repair attempt only');
  assert.equal(out.status, 'stale');
  assert.deepEqual(applied, []);
});

test('without a repairer the behaviour is unchanged', async () => {
  const { doc, env } = page(MARKUP);
  const index = collect(doc, env);
  const bindings = createBindings(memoryStore());
  const runner = createRunner({
    site: SITE, bindings, ops: { goto: () => 'clicked' },
    getIndex: () => index, gate: createGate(doc, env),
  });
  const checkout = index.find((e) => e.name === 'Checkout');
  bindings.remember(SITE, GOTO('checkout').target, checkout, { confidence: 0.9 });
  doc.getElementById('go').textContent = 'Renamed';

  const out = await runner.run(GOTO('checkout'));
  assert.equal(out.status, 'stale');
  assert.equal(out.repairFailed, undefined);
});

test('a confident L1 resolution is promoted, so the same motion is free next time', async () => {
  const { doc, env } = page(MARKUP);
  const bindings = createBindings(memoryStore());
  const applied = [];
  let calls = 0;
  const runner = createRunner({
    site: SITE, bindings,
    ops: { goto: (el) => { applied.push(el.id); return 'clicked'; } },
    getIndex: () => collect(doc, env),
    gate: createGate(doc, env),
    resolver: async (target, index) => {
      calls++;
      const hit = index.find((e) => e.name.toLowerCase().includes(target.query));
      return hit ? { fp: hit.fp, name: hit.name, role: hit.role, confidence: 0.96 }
                 : { abstained: true, reason: 'none' };
    },
  });

  const first = await runner.run(GOTO('checkout'));
  assert.equal(first.status, 'done');
  assert.equal(first.tier, 'L1');
  assert.equal(first.promoted, true, 'a confident resolution becomes a binding');

  const second = await runner.run(GOTO('checkout'));
  assert.equal(second.tier, 'L0', 'the second run is free');
  assert.equal(calls, 1, 'the resolver was consulted once');
  assert.deepEqual(applied, ['go', 'go']);
});

test('a resolution below the promotion floor still acts but is not remembered', async () => {
  const { doc, env } = page(MARKUP);
  const bindings = createBindings(memoryStore());
  let calls = 0;
  const runner = createRunner({
    site: SITE, bindings,
    ops: { goto: () => 'clicked' },
    getIndex: () => collect(doc, env),
    gate: createGate(doc, env),
    resolver: async (target, index) => {
      calls++;
      const hit = index.find((e) => e.name.toLowerCase().includes(target.query));
      // Above goto's floor of 0.45, below the promotion floor of 0.75.
      return { fp: hit.fp, name: hit.name, role: hit.role, confidence: 0.6 };
    },
  });

  const first = await runner.run(GOTO('checkout'));
  assert.equal(first.status, 'done', 'it still acted');
  assert.equal(first.promoted, undefined, 'but was not remembered');
  await runner.run(GOTO('checkout'));
  assert.equal(calls, 2, 'so it resolved again rather than reusing a shaky binding');
});
