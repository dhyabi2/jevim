import assert from 'node:assert/strict';
import test from 'node:test';

import { createDriver } from '../src/driver.js';
import { createBindings, memoryStore } from '../src/grammar/bindings.js';
import { createRunner } from '../src/grammar/runner.js';
import { collect } from '../src/index/collect.js';
import { createGate } from '../src/index/gate.js';
import { FLOORS, createJevResolver } from '../src/resolve/jev.js';
import { contentWords, prefilter } from '../src/resolve/prefilter.js';
import { NONE, buildRequest, rubric } from '../src/resolve/questions.js';
import { page } from './helpers.mjs';

const SITE = 'shop.example';
const MARKUP = `
  <main>
    <section><h3>Cart</h3>
      <a href="/checkout" id="go" data-rect="0,0,140,30">Checkout</a>
      <button id="rm" data-rect="150,0,80,30">Remove item</button>
    </section>
    <section><h3>Offers</h3>
      <a href="/offers" id="of" data-rect="0,60,140,30">See offers</a>
      <input type="search" id="q" aria-label="Search the shop" data-rect="0,100,200,30">
    </section>
  </main>`;

function harness(answerFor) {
  const { win, doc, env } = page(MARKUP);
  const index = collect(doc, env);
  const bindings = createBindings(memoryStore());
  const applied = [];
  const sent = [];

  const transport = async (body) => { sent.push(body); return answerFor(body); };
  const resolver = createJevResolver({ transport });

  const runner = createRunner({
    site: SITE,
    bindings,
    ops: { goto: (el) => { applied.push(el.id); return 'clicked'; },
           dismiss: (el) => { applied.push(el.id); return 'hidden'; } },
    getIndex: () => index,
    resolver,
    gate: createGate(doc, env),
  });
  return { driver: createDriver({ runner }), runner, bindings, index, applied, sent, doc };
}

async function feed(driver, tokens) {
  const out = [];
  for (const token of tokens) out.push(await driver.handle(token));
  return out;
}

const answer = (choice, confidence, noul = 0.9) => ({
  answers: { target: { choice, confidence, probabilities: { [choice]: confidence } },
             pageFits: { noul } },
});

const GOTO = (q) => ['g', '/', ...q.split(''), '<CR>'];
const DISMISS = (q) => ['d', '/', ...q.split(''), '<CR>'];

test('the prefilter narrows a literal query to the matching elements', () => {
  const { doc, env } = page(MARKUP);
  const index = collect(doc, env);
  const { candidates, strategy } = prefilter({ kind: 'search', query: 'offers' }, index);
  assert.equal(strategy, 'substring+ranked');
  // A name hit outranks a context hit, and the section-mate is kept because sharing a
  // heading with the query is real evidence, not noise.
  assert.equal(candidates[0].name, 'See offers', 'the literal match leads');
  assert.ok(candidates.some((c) => c.name === 'Checkout'),
    'the ranked head is unioned in, so one substring cannot hide the real target');
});

test('stopwords do not count as literal matches', () => {
  assert.deepEqual(contentWords('the cheapest one'), ['cheapest']);
  assert.deepEqual(contentWords('the one'), [], 'a query of pure stopwords has nothing literal');
});

test('a query with no literal match falls back to the ranked index, not to nothing', () => {
  const { doc, env } = page(MARKUP);
  const index = collect(doc, env);
  const { candidates, strategy } = prefilter({ kind: 'search', query: 'the cheapest one' }, index);
  assert.equal(strategy, 'ranked');
  assert.equal(candidates.length, index.length);
});

test('every option carries a rubric, including the sentinel', () => {
  const { doc, env } = page(MARKUP);
  const index = collect(doc, env);
  const body = buildRequest({ command: { operator: 'goto', target: { kind: 'search', query: 'pay' } }, candidates: index });
  const criteria = body.questions.target.criteria;
  assert.ok(criteria[NONE], 'the sentinel is an option');
  for (const [id, text] of Object.entries(criteria)) {
    assert.ok(typeof text === 'string' && text.length > 8, `${id} has no rubric`);
  }
  assert.equal(rubric(index[0]), `link "Checkout" in Cart`);
  assert.equal(body.questions.pageFits.type, 'noul');
  assert.equal(body.model, 'typesafe/jev-latest');
});

test('a confident choice resolves, fires the operator, and reports tier L1', async () => {
  const h = harness((body) => {
    const id = Object.keys(body.questions.target.criteria).find((k) => k !== NONE);
    return answer(id, 0.93);
  });
  const result = (await feed(h.driver, GOTO('offers'))).at(-1);
  assert.equal(result.status, 'done');
  assert.equal(result.tier, 'L1');
  assert.equal(result.confidence, 0.93);
  assert.deepEqual(h.applied, ['of']);
  assert.equal(h.runner.net.calls, 1);
});

test('the sentinel makes the resolver abstain instead of naming a best-of-bad options', async () => {
  const h = harness(() => answer(NONE, 0.88, 0.04));
  const result = (await feed(h.driver, GOTO('wishlist'))).at(-1);
  assert.equal(result.status, 'abstained');
  assert.equal(result.tier, 'L1');
  assert.match(result.reason, /nothing matches "wishlist"/);
  assert.deepEqual(h.applied, [], 'the verb did not fire');
});

test('a destructive verb needs far more confidence than a navigational one', async () => {
  assert.ok(FLOORS.dismiss > FLOORS.goto, 'floors must scale with what going wrong costs');

  const confident = 0.8;
  const goto = harness((body) => answer(Object.keys(body.questions.target.criteria)[0], confident));
  const gotoResult = (await feed(goto.driver, GOTO('offers'))).at(-1);
  assert.equal(gotoResult.status, 'done', 'goto acts at 0.80');

  const dismiss = harness((body) => answer(Object.keys(body.questions.target.criteria)[0], confident));
  const dismissResult = (await feed(dismiss.driver, DISMISS('remove'))).at(-1);
  assert.equal(dismissResult.status, 'abstained', 'dismiss does not act at 0.80');
  assert.match(dismissResult.reason, /below the dismiss floor of 0\.85/);
  assert.deepEqual(dismiss.applied, []);
});

test('a model that names an id outside the candidate set is refused', async () => {
  const h = harness(() => answer('e999', 0.99));
  const result = (await feed(h.driver, GOTO('offers'))).at(-1);
  assert.equal(result.status, 'abstained');
  assert.match(result.reason, /not a candidate/);
  assert.deepEqual(h.applied, []);
});

test('a resolver that throws degrades to abstention, never to a thrown keystroke', async () => {
  const h = harness(() => { throw new Error('ECONNRESET'); });
  const result = (await feed(h.driver, GOTO('offers'))).at(-1);
  assert.equal(result.status, 'abstained');
  assert.match(result.reason, /resolver unavailable: ECONNRESET/);
  assert.deepEqual(h.applied, []);
});

test('an L0 binding still costs nothing once the motion has been resolved once', async () => {
  const h = harness((body) => {
    const id = Object.keys(body.questions.target.criteria).find((k) => k !== NONE);
    return answer(id, 0.97);
  });
  const first = (await feed(h.driver, GOTO('offers'))).at(-1);
  assert.equal(first.tier, 'L1');
  assert.equal(h.runner.net.calls, 1);

  h.bindings.remember(SITE, { kind: 'search', query: 'offers' }, first.entry.fp, { confidence: 0.97, source: 'jev' });

  const second = (await feed(h.driver, GOTO('offers'))).at(-1);
  assert.equal(second.tier, 'L0');
  assert.equal(h.runner.net.calls, 1, 'the bound motion made no further call');
});

test('the request never carries a live DOM node and only carries the pruned candidates', async () => {
  const h = harness((body) => answer(Object.keys(body.questions.target.criteria)[0], 0.9));
  await feed(h.driver, GOTO('offers'));
  const [body] = h.sent;
  const text = JSON.stringify(body);
  assert.ok(!text.includes('data-rect'), 'no raw DOM in the request');
  assert.ok(!text.includes('[object'), 'no serialised node in the request');
  assert.ok(body.state.length <= h.index.length, 'only the pre-filtered candidates were sent');
  assert.ok(body.state.every((row) => /^e\d+: /.test(row)), 'state is id-plus-rubric rows');
});

test('one misleading substring cannot hide the real target from the model', () => {
  // The Hacker News failure, as a fixture: the query's word "show" matches several items by
  // name while the element the user means is called "new".
  const { doc, env } = page(`
    <main>
      <a href="/newest" data-rect="0,0,60,20">new</a>
      <a href="/show" data-rect="70,0,60,20">show</a>
      <a href="/s1" data-rect="0,30,300,20">Show HN: cursed fonts</a>
      <a href="/s2" data-rect="0,60,300,20">Show HN: whiteboard</a>
      <a href="/s3" data-rect="0,90,300,20">Show HN: file encryption</a>
    </main>`);
  const index = collect(doc, env);
  const { candidates } = prefilter({ kind: 'search', query: 'show me the newest stories' }, index);
  assert.ok(candidates.some((c) => c.name === 'new'),
    'the real target must survive the prefilter even when it matches no query word');
});
