import assert from 'node:assert/strict';
import test from 'node:test';

import { createDriver } from '../src/driver.js';
import { createBindings, memoryStore } from '../src/grammar/bindings.js';
import { createRunner } from '../src/grammar/runner.js';
import { collect } from '../src/index/collect.js';
import { createGate } from '../src/index/gate.js';
import { createTypeAhead } from '../src/resolve/typeahead.js';
import { page } from './helpers.mjs';

const SITE = 'shop.example';
const MARKUP = `
  <main><section><h3>Cart</h3>
    <a href="/checkout" id="go" data-rect="0,0,140,30">Checkout</a>
    <button id="rm" data-rect="150,0,80,30">Remove item</button>
  </section></main>`;

/** A resolver whose answer per query is scripted, and which records what it was asked. */
function harness({ answers, latencyMs = 0 } = {}) {
  const { doc, env } = page(MARKUP);
  const index = collect(doc, env);
  const asked = [];
  const applied = [];

  const inner = async (target) => {
    asked.push(target.query);
    if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
    const key = Object.keys(answers).filter((k) => target.query.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    const chosen = answers[key ?? '*'] ?? { abstained: true, reason: 'none' };
    if (chosen.abstained) return { ...chosen };
    return { fp: index.find((e) => e.name === chosen.name).fp, confidence: chosen.confidence ?? 0.9 };
  };

  const typeAhead = createTypeAhead({ resolver: inner });
  const runner = createRunner({
    site: SITE,
    bindings: createBindings(memoryStore()),
    ops: { goto: (el) => { applied.push(el.id); return 'clicked'; } },
    getIndex: () => index,
    resolver: typeAhead.resolve,
    gate: createGate(doc, env),
  });
  return { driver: createDriver({ runner, typeAhead }), runner, typeAhead, asked, applied, index };
}

async function feed(driver, text) {
  const out = [];
  for (const token of text) out.push(await driver.handle(token));
  return out;
}
const CR = '<CR>';

test('the query is primed character by character as it is typed', async () => {
  const h = harness({ answers: { '*': { name: 'Checkout' } } });
  await feed(h.driver, ['g', '/', ...'checkout']);
  // step is 3, so "che", "ckou"... not every character, and single-flight bounds it further.
  assert.ok(h.asked.length >= 1, 'something was primed while typing');
  assert.ok(h.asked.length < 8, `primed ${h.asked.length} times, expected coalescing`);
  assert.ok(h.asked.every((q) => 'checkout'.startsWith(q)), 'only prefixes actually typed were asked');
});

test('a stable prefix answer is used, so <CR> resolves without a fresh call', async () => {
  const h = harness({ answers: { '*': { name: 'Checkout' } } });
  await feed(h.driver, ['g', '/', ...'checkout']);
  const asked = h.asked.length;
  const result = (await feed(h.driver, [CR])).at(-1);

  assert.equal(result.status, 'done');
  assert.ok(['exact', 'prefix', 'awaited'].includes(result.resolution.typeahead), result.resolution.typeahead);
  assert.equal(h.asked.length, asked, 'no extra resolver call on <CR>');
  assert.deepEqual(h.applied, ['go']);
});

test('a premature abstention from a short prefix is never accepted as the answer', async () => {
  // The real failure this rule exists for: "sub" abstains where "submit" resolves. With a
  // call in flight the prefix answer is the only one available, and it must not be used.
  const h = harness({
    answers: { sub: { abstained: true, reason: 'nothing matches' }, submit: { name: 'Checkout' } },
    latencyMs: 40,
  });
  await feed(h.driver, ['g', '/', ...'sub']);
  assert.equal(h.typeAhead.stats.primed, 1, 'one prime, so nothing for it to agree with');

  const result = (await feed(h.driver, [...'mit', CR])).at(-1);
  assert.equal(result.status, 'done', 'the premature abstention was not accepted');
  assert.equal(result.resolution.abstained, undefined);
  assert.deepEqual(h.applied, ['go']);
});

test('priming never fires for a query shorter than the minimum', async () => {
  const h = harness({ answers: { '*': { name: 'Checkout' } } });
  await feed(h.driver, ['g', '/', 'c', 'h']);
  assert.equal(h.asked.length, 0, 'two characters is not worth a call');
});

test('an answer for text the user backspaced away is never used', async () => {
  // Priming on "checkz" is legitimate - the user typed it. Using that answer for "checkout"
  // is not, because "checkout" does not start with "checkz".
  const h = harness({ answers: { '*': { name: 'Checkout' } }, latencyMs: 5 });
  await feed(h.driver, ['g', '/', ...'checkz', '<BS>', ...'out', CR]);
  const used = h.applied;
  assert.deepEqual(used, ['go']);
  const stale = h.asked.filter((q) => !'checkout'.startsWith(q));
  assert.ok(stale.every((q) => q === 'checkz'), `unexpected primes: ${JSON.stringify(h.asked)}`);
});

test('state does not leak between motions', async () => {
  const h = harness({ answers: { '*': { name: 'Checkout' } } });
  await feed(h.driver, ['g', '/', ...'checkout', CR]);
  h.asked.length = 0;
  await feed(h.driver, ['g', '/', ...'remove', CR]);
  assert.ok(h.asked.length >= 1, 'the second motion resolved on its own evidence');
  assert.ok(h.asked.every((q) => 'remove'.startsWith(q)), `leaked: ${JSON.stringify(h.asked)}`);
});

test('a non-search motion bypasses type-ahead entirely', async () => {
  const h = harness({ answers: { '*': { name: 'Checkout' } } });
  const result = (await feed(h.driver, ['g', 'g'])).at(-1);
  assert.equal(result.status, 'done');
  assert.equal(h.asked.length, 0, 'an edge motion needs no model at all');
});

test('a priming error cannot break the keystroke that caused it', async () => {
  const { doc, env } = page(MARKUP);
  const index = collect(doc, env);
  const typeAhead = createTypeAhead({ resolver: () => { throw new Error('boom'); } });
  const runner = createRunner({
    site: SITE, bindings: createBindings(memoryStore()), ops: { goto: () => 'clicked' },
    getIndex: () => index, resolver: typeAhead.resolve, gate: createGate(doc, env),
  });
  const driver = createDriver({ runner, typeAhead });
  const results = await feed(driver, ['g', '/', ...'checkout']);
  assert.ok(results.every((r) => r.status === 'pending'), 'typing survived a throwing resolver');
});
