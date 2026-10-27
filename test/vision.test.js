import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ELEMENT, REGION, bindPoint, identify, inBox, offsetIn, parsePoint, toViewport, visionPrompt,
} from '../src/generate/vision.js';

test('the prompt asks for percentages, not pixels', () => {
  const prompt = visionPrompt({ instruction: 'the blue bar for March', width: 1280, height: 800 });
  assert.match(prompt, /percentages/);
  assert.match(prompt, /1280 by 800/);
  assert.match(prompt, /reply with exactly: none/, 'there is a way to say the target is not visible');
});

test('a point is read from whatever shape the model replies in', () => {
  for (const reply of ['42.5,63.1', 'x=42.5%, y=63.1%', '{"x": 42.5, "y": 63.1}',
                       'The centre is at 42.5, 63.1 in the image.']) {
    assert.deepEqual(parsePoint(reply), { fx: 0.425, fy: 0.631 }, `failed on: ${reply}`);
  }
});

test('a reply that says the target is not visible is not a point', () => {
  assert.equal(parsePoint('none'), null);
  assert.equal(parsePoint('None - it is not in the screenshot'), null);
});

test('a garbled reply is refused rather than stored as a binding', () => {
  // This is the whole reason range is checked: an out-of-range number means the model answered in
  // pixels, or hallucinated, and clicking on it would be clicking somewhere arbitrary.
  assert.equal(parsePoint('540,1203'), null, 'pixels, not percentages');
  assert.equal(parsePoint('-5,50'), null);
  assert.equal(parsePoint('probably the top left somewhere'), null);
  assert.equal(parsePoint(''), null);
  assert.equal(parsePoint(undefined), null);
});

test('a normalised point maps to the viewport and back into a box', () => {
  assert.deepEqual(toViewport({ fx: 0.5, fy: 0.25 }, { width: 1280, height: 800 }), { x: 640, y: 200 });
  assert.deepEqual(inBox({ fx: 0.5, fy: 0.5 }, { x: 100, y: 200, w: 400, h: 300 }), { x: 300, y: 350 });
});

test('an offset inside a box is a fraction, and cannot escape the box', () => {
  const box = { x: 100, y: 100, w: 200, h: 100 };
  assert.deepEqual(offsetIn({ x: 200, y: 150 }, box), { fx: 0.5, fy: 0.5 });
  assert.deepEqual(offsetIn({ x: 50, y: 400 }, box), { fx: 0, fy: 1 }, 'clamped, not negative or past 1');
  assert.equal(offsetIn({ x: 1, y: 1 }, { x: 0, y: 0, w: 0, h: 0 }), null, 'a zero-size box has no inside');
});

test('a point on a known element binds to its fingerprint, not a coordinate', () => {
  const entry = { fp: 'abc1234', role: 'button', name: 'Export', backendDOMNodeId: 9 };
  const binding = bindPoint({ point: { x: 10, y: 10 }, backendNodeId: 9, entry });
  assert.equal(binding.kind, ELEMENT);
  assert.equal(binding.fp, 'abc1234');
  assert.equal(binding.offset, undefined, 'an element binding needs no offset - it has an identity');
});

test('a point inside a canvas binds to the canvas plus an offset', () => {
  const binding = bindPoint({
    point: { x: 300, y: 350 }, backendNodeId: 12, entry: null,
    box: { x: 100, y: 200, w: 400, h: 300 },
  });
  assert.equal(binding.kind, REGION);
  assert.equal(binding.backendNodeId, 12);
  assert.deepEqual(binding.offset, { fx: 0.5, fy: 0.5 });
});

test('a point on nothing is refused rather than turned into a guess', () => {
  assert.equal(bindPoint({ point: { x: 1, y: 1 }, backendNodeId: null, box: null }).kind, null);
  assert.equal(bindPoint({ point: { x: 1, y: 1 }, backendNodeId: 12, box: null }).kind, null);
});

/** Browser and model both faked; `identify` contains no network and no CDP of its own. */
function harness({ reply, nodeId = 9, index = [], box = null }) {
  const asked = [];
  return {
    asked,
    args: {
      instruction: 'the March bar in the revenue chart',
      capture: async () => ({ data: 'AAAA', width: 1000, height: 500 }),
      ask: async (call) => { asked.push(call); return { text: reply, usage: { prompt_tokens: 1100 } }; },
      nodeAt: async () => nodeId,
      boxOf: async () => box,
      index,
    },
  };
}

test('identification prefers an index entry, so vision is only the lookup', async () => {
  const index = [{ fp: 'ff00aa1', role: 'button', name: 'March', backendDOMNodeId: 9 }];
  const { args, asked } = harness({ reply: '50,40', index });
  const out = await identify(args);

  assert.equal(out.found, true);
  assert.equal(out.kind, ELEMENT);
  assert.equal(out.fp, 'ff00aa1');
  assert.deepEqual(out.point, { x: 500, y: 200 });
  assert.equal(asked.length, 1, 'exactly one vision call');
  assert.ok(asked[0].image, 'the screenshot was actually sent');
});

test('identification falls back to a region when the node is not in the index', async () => {
  const { args } = harness({ reply: '50,40', nodeId: 12, box: { x: 0, y: 0, w: 1000, h: 500 } });
  const out = await identify(args);
  assert.equal(out.found, true);
  assert.equal(out.kind, REGION);
  assert.deepEqual(out.offset, { fx: 0.5, fy: 0.4 });
});

test('a vision reply of none reports not-found and mints nothing', async () => {
  const out = await identify(harness({ reply: 'none' }).args);
  assert.equal(out.found, false);
  assert.match(out.reason, /did not locate/);
  assert.equal(out.fp, undefined);
});

test('no node at the located point reports not-found rather than clicking the page', async () => {
  const out = await identify(harness({ reply: '50,40', nodeId: null }).args);
  assert.equal(out.found, false);
  assert.match(out.reason, /no node/);
  assert.deepEqual(out.point, { x: 500, y: 200 });
});

test('a region is looked at twice, and the close look decides the stored offset', async () => {
  const replies = ['28,40', '61,70'];            // coarse: in the gap beside the bar; close: on it
  const asked = [];
  const crops = [];
  const box = { x: 100, y: 50, w: 600, h: 300 };
  const out = await identify({
    instruction: 'the tall red bar',
    capture: async () => ({ data: 'PAGE', width: 1000, height: 500 }),
    ask: async (call) => { asked.push(call); return { text: replies.shift(), usage: { prompt_tokens: 700 } }; },
    nodeAt: async () => 12,
    boxOf: async () => box,
    captureBox: async (b) => { crops.push(b); return { data: 'CROP', width: 800, height: 400 }; },
  });

  assert.equal(out.found, true);
  assert.equal(out.kind, REGION);
  assert.equal(asked.length, 2, 'one look at the page, one at the region');
  assert.equal(asked[1].image, 'CROP', 'the second look is at the crop, not the page again');
  assert.match(asked[1].prompt, /close-up crop/);
  assert.deepEqual(crops, [box], 'the crop is exactly the region node');
  assert.deepEqual(out.offset, { fx: 0.61, fy: 0.7 }, 'the stored offset is the close answer');
  assert.deepEqual(out.point, { x: 466, y: 260 });
  assert.equal(out.usage.prompt_tokens, 1400, 'both calls are counted');
});

test('a close look that cannot find the target refuses instead of keeping the coarse point', async () => {
  const replies = ['28,40', 'none'];
  const out = await identify({
    instruction: 'the tall red bar',
    capture: async () => ({ data: 'PAGE', width: 1000, height: 500 }),
    ask: async () => ({ text: replies.shift() }),
    nodeAt: async () => 12,
    boxOf: async () => ({ x: 0, y: 0, w: 600, h: 300 }),
    captureBox: async () => ({ data: 'CROP', width: 800, height: 400 }),
  });
  assert.equal(out.found, false);
  assert.match(out.reason, /refinement/);
  assert.equal(out.offset, undefined);
});

test('an indexed element is never refined - its fingerprint needs no second look', async () => {
  const index = [{ fp: 'ff00aa1', role: 'button', name: 'March', backendDOMNodeId: 9 }];
  const { args, asked } = harness({ reply: '50,40', index });
  let cropped = false;
  const out = await identify({ ...args, captureBox: async () => { cropped = true; return {}; } });
  assert.equal(out.kind, ELEMENT);
  assert.equal(asked.length, 1);
  assert.equal(cropped, false);
});

// --- the law: an element found by vision replays with no vision call ------------------------------

import { createBindings, memoryStore } from '../src/grammar/bindings.js';
import { createRunner } from '../src/grammar/runner.js';
import { collect } from '../src/index/collect.js';
import { createGate } from '../src/index/gate.js';
import { page } from './helpers.mjs';

const CANVAS_PAGE = `
  <main><section><h3>Revenue</h3>
    <canvas id="chart" data-rect="0,0,400,200"></canvas>
    <button id="export" data-rect="0,210,90,30">Export</button>
  </section></main>`;

test('an element identified by vision replays at L0 with no vision call and no resolver call', async () => {
  const { doc, env } = page(CANVAS_PAGE);
  const index = collect(doc, env);
  const bindings = createBindings(memoryStore());
  const applied = [];
  let visionCalls = 0;
  let resolverCalls = 0;

  // Authoring time: one vision call locates the element and hands back an index entry.
  const target = { kind: 'search', query: 'the export button under the chart' };
  const found = await identify({
    instruction: target.query,
    capture: async () => { visionCalls += 1; return { data: 'AAAA', width: 400, height: 240 }; },
    ask: async () => ({ text: '11,92' }),                 // inside the Export button's box
    nodeAt: async () => index.find((e) => e.name === 'Export').el,
    boxOf: async () => null,
    find: (node) => index.find((e) => e.el === node) || null,
  });
  assert.equal(found.kind, ELEMENT, 'vision resolved to a real element, not a coordinate');
  assert.equal(visionCalls, 1);

  // What vision produced is stored exactly as a resolver result would be: a fingerprint and a
  // descriptor. Nothing downstream can tell the difference, which is the point.
  const entry = index.find((e) => e.fp === found.fp);
  bindings.remember('shop.example', target, entry, { confidence: 1, source: 'vision' });

  const runner = createRunner({
    site: 'shop.example', bindings,
    ops: { goto: (el) => { applied.push(el.id); return 'clicked'; } },
    getIndex: () => index,
    resolver: async () => { resolverCalls += 1; throw new Error('the resolver must not be consulted'); },
    gate: createGate(doc, env),
  });

  for (const attempt of [1, 2, 3]) {
    const result = await runner.run({ count: 1, operator: 'goto', target });
    assert.equal(result.status, 'done', `replay ${attempt}`);
    assert.equal(result.tier, 'L0', `replay ${attempt} came from the binding, not a model`);
  }

  assert.equal(visionCalls, 1, 'vision was called once, at authoring time, and never again');
  assert.equal(resolverCalls, 0, 'and the replay did not fall through to the resolver either');
  assert.equal(runner.net.calls, 0, 'no network calls at all on the replay path');
  assert.deepEqual(applied, ['export', 'export', 'export']);

  // The keymap records how it was found, so a reader can tell a vision binding from a resolved one.
  assert.match(bindings.toKeymap(), /via=vision/);
});

test('a canvas region binding replays from the box, so it survives a resize', () => {
  // Authored against a 400x200 canvas: the March bar was a quarter of the way across.
  const binding = { kind: REGION, offset: { fx: 0.25, fy: 0.5 } };
  assert.deepEqual(inBox(binding.offset, { x: 0, y: 0, w: 400, h: 200 }), { x: 100, y: 100 });
  // The same binding on a window half again as wide still lands on the same bar.
  assert.deepEqual(inBox(binding.offset, { x: 0, y: 0, w: 600, h: 300 }), { x: 150, y: 150 });
});
