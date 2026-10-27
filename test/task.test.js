import assert from 'node:assert/strict';
import test from 'node:test';

import { parse } from '../src/artifact.js';
import { createBindings, memoryStore } from '../src/grammar/bindings.js';
import { createRunner } from '../src/grammar/runner.js';
import { collect } from '../src/index/collect.js';
import { createGate } from '../src/index/gate.js';
import { createRepair } from '../src/resolve/repair.js';
import { compile, replay } from '../src/usecases/task.js';
import { page } from './helpers.mjs';

const SITE = 'shop.example';
const MARKUP = `
  <main><section><h3>Cart</h3>
    <a href="/checkout" id="go" data-rect="0,0,140,30">Checkout</a>
    <input type="text" id="card" aria-label="Card number" data-rect="0,40,200,30">
    <button id="rm" data-rect="220,0,90,30">Remove item</button>
  </section></main>`;

function harness({ resolver = null, decide = null } = {}) {
  const { doc, env } = page(MARKUP);
  const bindings = createBindings(memoryStore());
  const applied = [];
  const index = () => collect(doc, env);
  const runner = createRunner({
    site: SITE, bindings,
    ops: {
      goto: (el) => { applied.push(`goto:${el.id}`); return 'clicked'; },
      change: (el) => { applied.push(`change:${el.id}`); return 'cleared'; },
      select: (el) => { applied.push(`assert:${el.id}`); return 'selected'; },
      dismiss: (el) => { applied.push(`dismiss:${el.id}`); return 'hidden'; },
    },
    getIndex: index, gate: createGate(doc, env), resolver,
    repair: decide ? createRepair({ decide }) : null,
  });
  const session = { site: SITE, bindings, runner, page: { url: 'https://shop.example/cart' },
                    get index() { return index(); } };
  return { session, applied, doc, index };
}

/** A resolver that matches the query against element names. */
const nameResolver = (confidence = 0.95) => async (target, index) => {
  const q = target.query.toLowerCase();
  const hit = index.find((e) => e.name.toLowerCase().includes(q.split(' ')[0]));
  return hit ? { fp: hit.fp, name: hit.name, role: hit.role, confidence }
             : { abstained: true, reason: 'no candidate' };
};

const PLAN = [
  { verb: 'goto', target: { kind: 'search', query: 'checkout' } },
  { verb: 'type', target: { kind: 'search', query: 'card' }, value: '$CARD' },
];

test('a plan compiles to a pinned artifact on the first run', async () => {
  const h = harness({ resolver: nameResolver() });
  const out = await compile({ session: h.session, task: 'pay', plan: structuredClone(PLAN),
                              values: { CARD: '4111' } });
  assert.equal(out.compiled, true, out.failure && out.failure.reason);
  assert.equal(out.ranSteps, 2);
  assert.match(out.script, /fp=[a-z0-9]+/);
  assert.equal(parse(out.script).steps.every((s) => s.fp), true, 'every step pinned');
  assert.deepEqual(h.applied, ['goto:go', 'change:card']);
});

test('replaying the artifact makes no model call at all', async () => {
  const h = harness({ resolver: nameResolver() });
  const first = await compile({ session: h.session, task: 'pay', plan: structuredClone(PLAN),
                               values: { CARD: '4111' } });
  assert.ok(first.networkCalls > 0, 'the first run resolved');

  const fresh = harness();
  const out = await replay({ session: fresh.session, script: parse(first.script), values: { CARD: '4111' } });
  assert.equal(out.passed, true, JSON.stringify(out.failure));
  assert.equal(out.networkCalls, 0);
  assert.equal(out.deterministic, true);
  assert.deepEqual(fresh.applied, ['goto:go', 'change:card']);
});

test('two replays produce an identical trace', async () => {
  const h = harness({ resolver: nameResolver() });
  const compiled = await compile({ session: h.session, task: 'pay', plan: structuredClone(PLAN),
                                   values: { CARD: '4111' } });
  const script = parse(compiled.script);
  const trace = (o) => o.steps.map((s) => `${s.verb}:${s.status}:${s.element && s.element.fingerprint}`);

  const a = await replay({ session: harness().session, script: parse(compiled.script) });
  const b = await replay({ session: harness().session, script: parse(compiled.script) });
  assert.deepEqual(trace(b), trace(a));
  assert.equal(a.networkCalls + b.networkCalls, 0);
  assert.equal(script.steps.length, 2);
});

test('a destructive step the screen does not back is not executed', async () => {
  const h = harness({ resolver: nameResolver() });
  const plan = [{ verb: 'dismiss', target: { kind: 'search', query: 'remove' } }];
  const out = await compile({
    session: h.session, task: 'tidy up', plan,
    screen: async () => [0.2],   // the screen does not believe this step serves the task
  });
  assert.equal(out.compiled, false);
  assert.match(out.reason, /destructive step/);
  assert.deepEqual(out.needsReview, ['dismiss']);
  assert.deepEqual(h.applied, [], 'nothing ran');
});

test('a destructive step the screen backs does run', async () => {
  const h = harness({ resolver: nameResolver() });
  const plan = [{ verb: 'dismiss', target: { kind: 'search', query: 'remove' } }];
  const out = await compile({ session: h.session, task: 'tidy up', plan, screen: async () => [0.9] });
  assert.equal(out.compiled, true, out.reason);
  assert.deepEqual(h.applied, ['dismiss:rm']);
});

test('a repaired step is re-pinned, so the next replay needs no repair', async () => {
  const decide = async (body) => {
    const ids = Object.keys(body.questions.same.criteria).filter((k) => k !== '__none__');
    const match = ids.find((id) => /Pay now/.test(body.questions.same.criteria[id])) ?? ids[0];
    return { answers: { same: { choice: match, confidence: 0.95 } } };
  };
  const h = harness({ resolver: nameResolver(), decide });
  const compiled = await compile({ session: h.session, task: 'pay', plan: structuredClone(PLAN),
                                   values: { CARD: '4111' } });
  const oldFp = parse(compiled.script).steps[0].fp;

  // The site is redesigned: the link is renamed.
  const next = harness({ decide });
  next.doc.getElementById('go').textContent = 'Pay now';

  const repaired = await replay({ session: next.session, script: parse(compiled.script) });
  assert.equal(repaired.passed, true, JSON.stringify(repaired.failure));
  assert.ok(repaired.networkCalls > 0, 'the repair cost one call');
  assert.equal(repaired.steps[0].repaired.from, oldFp);
  assert.deepEqual(next.applied, ['goto:go', 'change:card']);
});

test('a plan that fails midway still yields the pinned prefix', async () => {
  const h = harness({ resolver: nameResolver() });
  const plan = [
    { verb: 'goto', target: { kind: 'search', query: 'checkout' } },
    { verb: 'goto', target: { kind: 'search', query: 'nonexistent thing' } },
    { verb: 'goto', target: { kind: 'search', query: 'remove' } },
  ];
  const out = await compile({ session: h.session, task: 'partial', plan });
  assert.equal(out.compiled, false);
  assert.equal(out.failedAt, 2);
  assert.equal(out.ranSteps, 2, 'it stopped at the failure rather than continuing');
  assert.match(out.script, /fp=/, 'the prefix that did work is pinned and kept');
  assert.deepEqual(h.applied, ['goto:go']);
});
