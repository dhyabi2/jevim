import assert from 'node:assert/strict';
import test from 'node:test';

import { format, isPinned, parse } from '../src/artifact.js';
import { createBindings, memoryStore } from '../src/grammar/bindings.js';
import { createRunner } from '../src/grammar/runner.js';
import { collect } from '../src/index/collect.js';
import { createGate } from '../src/index/gate.js';
import { fill } from '../src/usecases/form.js';
import { ground } from '../src/usecases/ground.js';
import { PAGE_KINDS, sample, survey } from '../src/usecases/navigate.js';
import { run } from '../src/usecases/script.js';
import { page } from './helpers.mjs';

const SITE = 'shop.example';
const SHOP = `
  <main>
    <section><h3>Checkout</h3>
      <a href="/pay" data-rect="0,0,140,30">Proceed to payment</a>
      <button data-rect="150,0,90,30">Cancel order</button>
    </section>
    <form><h3>Card</h3>
      <input type="text" aria-label="Name on card" data-rect="0,60,200,30">
      <input type="text" aria-label="Card number" data-rect="0,100,200,30">
      <input type="text" aria-label="Postcode" data-rect="0,140,200,30">
    </form>
  </main>`;

function fixture(markup = SHOP) {
  const { win, doc, env } = page(markup);
  const index = collect(doc, env);
  return { win, doc, env, index };
}

/** A resolver that answers by matching the intent against each element's name. */
function nameResolver({ floorOverride = 0.9, missing = [] } = {}) {
  return async (target, index) => {
    const query = target.query.toLowerCase();
    if (missing.some((m) => query.includes(m))) {
      return { abstained: true, reason: `nothing matches "${target.query}"`, candidates: index.length };
    }
    // Score like the real resolver would: a whole-phrase match beats a single shared word,
    // or "card number" lands on "Name on card" and the test measures the stub, not the code.
    const words = query.split(' ').filter(Boolean);
    const scored = index
      .map((e) => {
        const name = e.name.toLowerCase();
        const overlap = words.filter((w) => name.includes(w)).length;
        return { e, score: (name.includes(query) ? 100 : 0) + overlap };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const hit = scored.length ? scored[0].e : null;
    if (!hit) return { abstained: true, reason: 'no candidate', candidates: index.length };
    return { fp: hit.fp, name: hit.name, role: hit.role, confidence: floorOverride, candidates: index.length };
  };
}

// ---------------------------------------------------------------- artifact

test('a motion script round-trips through parse and format', () => {
  const text = `# name: checkout
# url: https://shop.example/cart
goto    search:"proceed to payment"  fp=abc1234  conf=0.94
type    search:"card number"  value=$CARD
goto    edge:last
`;
  const parsed = parse(text);
  assert.equal(parsed.meta.name, 'checkout');
  assert.equal(parsed.steps.length, 3);
  assert.deepEqual(parsed.steps[0].target, { kind: 'search', query: 'proceed to payment' });
  assert.equal(parsed.steps[1].value, '$CARD');
  assert.deepEqual(parse(format(parsed)).steps, parsed.steps, 'format then parse is identity');
});

test('a script cannot name a verb outside the closed set', () => {
  assert.throws(() => parse('exfiltrate  search:"cookies"'), /unknown verb exfiltrate/);
  assert.throws(() => parse('goto  sql:"drop table"'), /unknown target kind sql/);
  assert.throws(() => parse('goto  object:i:nonsense'), /unknown text object/);
});

test('a script is only pinned when every step carries a fingerprint', () => {
  assert.equal(isPinned(parse('goto search:"pay" fp=a1\ngoto edge:last')), true);
  assert.equal(isPinned(parse('goto search:"pay" fp=a1\ngoto search:"cancel"')), false);
});

// ---------------------------------------------------------------- ground

test('grounding returns an element with a confidence', async () => {
  const { index } = fixture();
  const out = await ground({ resolver: nameResolver(), index, intent: 'proceed to payment' });
  assert.equal(out.grounded, true);
  assert.equal(out.name, 'Proceed to payment');
  assert.ok(out.fingerprint);
  assert.equal(out.confidence, 0.9);
});

test('grounding refuses with a reason rather than guessing', async () => {
  const { index } = fixture();
  const out = await ground({ resolver: nameResolver({ missing: ['basket'] }), index, intent: 'shopping basket' });
  assert.equal(out.grounded, false);
  assert.match(out.reason, /nothing matches/);
  assert.equal(out.fingerprint, undefined);
});

// ---------------------------------------------------------------- form

test('form filling places values and reports what it could not place', async () => {
  const { index } = fixture();
  const typed = [];
  const out = await fill({
    resolver: nameResolver({ missing: ['vat'] }),
    index,
    values: { 'card number': '4111', postcode: 'SW1A', 'vat number': 'GB123' },
    apply: (field, value) => typed.push([field.name, value]),
  });

  assert.equal(out.placed.length, 2);
  assert.equal(out.unplaced.length, 1);
  assert.equal(out.unplaced[0].label, 'vat number');
  assert.equal(out.needsHuman, true);
  assert.equal(out.complete, false);
  assert.deepEqual(typed.map(([name]) => name).sort(), ['Card number', 'Postcode']);
});

test('a value below the floor is left unplaced, never written somewhere plausible', async () => {
  const { index } = fixture();
  const typed = [];
  const out = await fill({
    resolver: nameResolver({ floorOverride: 0.3 }),
    index,
    values: { postcode: 'SW1A' },
    apply: (field, value) => typed.push([field.name, value]),
  });
  assert.deepEqual(typed, [], 'nothing was written');
  assert.equal(out.placed.length, 0);
  assert.match(out.unplaced[0].reason, /below 0\.6/);
});

test('form filling only ever considers actual fields', async () => {
  const { index } = fixture();
  const seen = [];
  await fill({
    resolver: async (target, fields) => { seen.push(fields.map((f) => f.role)); return { abstained: true, reason: 'x' }; },
    index,
    values: { postcode: 'SW1A' },
  });
  assert.ok(seen[0].every((role) => role === 'textbox'), `saw ${seen[0]}`);
  assert.ok(!seen[0].includes('link'), 'a link is never a candidate for a value');
});

// ---------------------------------------------------------------- navigate

test('the crawler survey answers every question in one call', async () => {
  const { index } = fixture(`
    <main><h1>Results</h1>
      <a href="/p/1" data-rect="0,0,200,20">Widget one</a>
      <a href="/p/2" data-rect="0,30,200,20">Widget two</a>
      <a href="/page/2" data-rect="0,60,80,20">Next page</a>
      <button data-rect="0,90,120,20">Accept cookies</button>
      <a href="/login" data-rect="0,120,80,20">Sign in</a>
    </main>`);

  let calls = 0;
  const decide = async (body) => {
    calls += 1;
    const byName = (needle) => {
      const id = Object.entries(body.questions.nextPage.criteria)
        .find(([, text]) => text.toLowerCase().includes(needle));
      return id ? id[0] : '__none__';
    };
    return { answers: {
      kind: { choice: 'listing', confidence: 0.91 },
      nextPage: { choice: byName('next page'), confidence: 0.96 },
      consentAccept: { choice: byName('accept cookies'), confidence: 0.99 },
      loginLink: { choice: byName('sign in'), confidence: 0.88 },
      paywalled: { noul: 0.05 },
    } };
  };

  const out = await survey({ decide, index });
  assert.equal(calls, 1, 'one call, not five');
  assert.equal(out.kind.value, 'listing');
  assert.equal(out.nextPage.name, 'Next page');
  assert.equal(out.consentAccept.name, 'Accept cookies');
  assert.equal(out.loginLink.name, 'Sign in');
  assert.ok(out.paywalled < 0.1);
  assert.ok(Object.keys(PAGE_KINDS).includes(out.kind.value));
});

test('the survey reports a missing next page as null instead of inventing one', async () => {
  const { index } = fixture();
  const decide = async () => ({ answers: {
    kind: { choice: 'detail', confidence: 0.8 },
    nextPage: { choice: '__none__', confidence: 0.97 },
    consentAccept: { choice: '__none__', confidence: 0.95 },
    loginLink: { choice: '__none__', confidence: 0.9 },
    paywalled: { noul: 0.02 },
  } });
  const out = await survey({ decide, index });
  assert.equal(out.nextPage, null);
  assert.equal(out.consentAccept, null);
  assert.equal(out.kind.value, 'detail');
});

// ---------------------------------------------------------------- script / test

function scriptSession(markup = SHOP, { resolver = null } = {}) {
  const { win, doc, env, index } = fixture(markup);
  const bindings = createBindings(memoryStore());
  const applied = [];
  const runner = createRunner({
    site: SITE, bindings,
    ops: { goto: (el) => { applied.push(el.getAttribute('aria-label') || el.textContent.trim()); return 'clicked'; },
           change: (el) => { applied.push(`change:${el.getAttribute('aria-label')}`); return 'cleared'; },
           select: (el) => { applied.push(`assert:${el.textContent.trim()}`); return 'selected'; } },
    getIndex: () => index, resolver, gate: createGate(doc, env),
  });
  return { session: { site: SITE, index, bindings, runner }, applied, index, doc, win };
}

test('a fully pinned script replays with zero model calls', async () => {
  const h = scriptSession();
  const pay = h.index.find((e) => e.name === 'Proceed to payment');
  const script = parse(`goto search:"proceed to payment" fp=${pay.fp}`);

  const out = await run({ session: h.session, script });
  assert.equal(out.passed, true);
  assert.equal(out.networkCalls, 0, 'a pinned script is free');
  assert.equal(out.pinned, true);
  assert.deepEqual(h.applied, ['Proceed to payment']);
});

test('an unpinned script resolves once and comes back pinned', async () => {
  const h = scriptSession(SHOP, { resolver: nameResolver() });
  const script = parse('goto search:"proceed to payment"');
  assert.equal(isPinned(script), false);

  const out = await run({ session: h.session, script });
  assert.equal(out.passed, true);
  assert.equal(out.networkCalls, 1);
  assert.match(out.script, /fp=[a-z0-9]+/, 'the replayed script is now pinned');
  assert.equal(isPinned(parse(out.script)), true);
});

test('a script whose element changed fails as stale at the right step, and stops', async () => {
  const h = scriptSession();
  const pay = h.index.find((e) => e.name === 'Proceed to payment');
  const cancel = h.index.find((e) => e.name === 'Cancel order');
  const script = parse(`goto search:"pay" fp=${pay.fp}\ngoto search:"cancel" fp=${cancel.fp}`);

  // The page changes under the first step.
  h.doc.querySelector('a[href="/pay"]').textContent = 'Pay with card';

  const out = await run({ session: h.session, script });
  assert.equal(out.passed, false);
  assert.equal(out.failedAt, 1);
  assert.equal(out.failure.status, 'stale');
  assert.match(out.failure.reason, /name changed/);
  assert.deepEqual(h.applied, [], 'nothing was clicked, and step 2 never ran');
});

test('a type step records the value it would write', async () => {
  const h = scriptSession();
  const card = h.index.find((e) => e.name === 'Card number');
  const script = parse(`type search:"card number" value=$CARD fp=${card.fp}`);
  const out = await run({ session: h.session, script, values: { CARD: '4111' } });
  assert.equal(out.passed, true);
  assert.equal(out.steps[0].typed, '4111');
  assert.deepEqual(h.applied, ['change:Card number']);
});

test('the survey looks at both ends of the index, because pagination lives in the footer', () => {
  const index = Array.from({ length: 200 }, (_, i) => ({ id: `e${i}`, fp: `f${i}`, role: 'link', name: `item ${i}`, ctx: '' }));
  const picked = sample(index, 60);
  assert.equal(picked.length, 60);
  assert.ok(picked.some((e) => e.id === 'e0'), 'the head is present');
  assert.ok(picked.some((e) => e.id === 'e199'), 'the footer is present');
});

test('the survey ignores unnamed elements, which is what let the footer through', () => {
  // The Hacker News shape: named entries early, a named "More" late, unnamed junk last.
  const index = [
    ...Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, fp: `a${i}`, role: 'link', name: `story ${i}`, ctx: '' })),
    { id: 'more', fp: 'zz', role: 'link', name: 'More', ctx: '' },
    ...Array.from({ length: 40 }, (_, i) => ({ id: `u${i}`, fp: `b${i}`, role: 'link', name: '', ctx: '' })),
  ];
  const picked = sample(index, 20);
  assert.ok(picked.every((e) => e.name), 'no unnamed element is offered to a semantic question');
  assert.ok(picked.some((e) => e.name === 'More'), 'the late named element survives');
});
