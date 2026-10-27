import assert from 'node:assert/strict';
import test from 'node:test';

import { ACTIONS, MAX_ACTIONS, looping, parseAction, parseReply, prompt, row, siteOf, summarise } from '../src/agent/policy.js';

const INDEX = [
  { id: 'e0', role: 'searchbox', name: 'Search', fp: 'aaa0001', value: 'shoes' },
  { id: 'e1', role: 'button', name: 'Go', fp: 'aaa0002' },
  { id: 'e2', role: 'checkbox', name: 'Free shipping', fp: 'aaa0003', state: 'not checked', vp: 'below' },
];

test('a reply naming an id from the index becomes that element', () => {
  const { action, error } = parseAction('{"action":"click","id":"e1"}', INDEX);
  assert.equal(error, undefined);
  assert.equal(action.action, 'click');
  assert.equal(action.entry.fp, 'aaa0002');
});

test('an id that was not shown is rejected, never mapped to the nearest one', () => {
  const { action, error } = parseAction('{"action":"click","id":"e9"}', INDEX);
  assert.equal(action, undefined);
  assert.match(error, /not in the element list/);
});

test('a verb outside the closed set is rejected', () => {
  assert.match(parseAction('{"action":"execute_js","code":"alert(1)"}', INDEX).error, /unknown action/);
  assert.match(parseAction('{"action":"hover","id":"e1"}', INDEX).error, /unknown action/);
});

test('prose around the JSON is tolerated, prose instead of JSON is not', () => {
  assert.equal(parseAction('I will click Go.\n{"action":"click","id":"e1"}', INDEX).action.id, 'e1');
  assert.match(parseAction('click the Go button', INDEX).error, /no JSON/);
  assert.match(parseAction('{"action":"click", id: e1}', INDEX).error, /did not parse/);
  assert.match(parseAction(undefined, INDEX).error, /empty/);
});

test('each action checks its own required fields', () => {
  assert.match(parseAction('{"action":"type","id":"e0"}', INDEX).error, /needs "text"/);
  assert.match(parseAction('{"action":"select","id":"e0"}', INDEX).error, /needs "option"/);
  assert.match(parseAction('{"action":"goto","url":"javascript:alert(1)"}', INDEX).error, /http/);
  assert.equal(parseAction('{"action":"goto","url":"https://example.com/"}', INDEX).action.url, 'https://example.com/');
  assert.equal(parseAction('{"action":"done","answer":"42"}', INDEX).action.answer, '42');
  assert.equal(parseAction('{"action":"scroll","direction":"sideways"}', INDEX).action.direction, 'down');
});

test('the prompt shows ids, state and values, and only the closed actions', () => {
  const text = prompt({ task: 'find shoes', url: 'https://shop.test/', title: 'Shop', index: INDEX,
                        text: 'Welcome', history: [], step: 1, maxSteps: 10 });
  assert.match(text, /\[e2\] checkbox "Free shipping" not checked \(below the viewport\)/);
  assert.match(text, /\[e0\] searchbox "Search" value="shoes"/);
  for (const verb of ACTIONS) assert.match(text, new RegExp(`"action":"${verb}"`));
  assert.equal(row(INDEX[1]), '[e1] button "Go"');
});

test('the same action three times running is reported as a loop', () => {
  const click = parseAction('{"action":"click","id":"e1"}', INDEX).action;
  const line = summarise(click);
  assert.equal(looping([], click), false);
  assert.equal(looping([{ summary: line }], click), false);
  assert.equal(looping([{ summary: line }, { summary: line }], click), true);
  assert.equal(looping([{ summary: line }, { summary: 'scroll down' }], click), false);
});

test('a reply carries memory, a goal and up to three actions, each validated', () => {
  const r = parseReply(JSON.stringify({ memory: 'searched shoes', next_goal: 'filter',
    actions: [{ action: 'type', id: 'e0', text: 'red shoes' }, { action: 'click', id: 'e1' }] }), INDEX);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.actions.map((a) => a.action), ['type', 'click']);
  assert.equal(r.actions[1].entry.fp, 'aaa0002');
  assert.equal(r.memory, 'searched shoes');
  assert.equal(parseReply('{"action":"click","id":"e1"}', INDEX).actions.length, 1, 'a bare action is accepted');
});

test('one bad action rejects the whole reply rather than running half a plan', () => {
  const r = parseReply(JSON.stringify({ actions: [{ action: 'click', id: 'e1' }, { action: 'click', id: 'e99' }] }), INDEX);
  assert.match(r.error, /not in the element list/);
  assert.equal(r.actions, undefined);
  const many = Array.from({ length: MAX_ACTIONS + 1 }, () => ({ action: 'scroll', direction: 'down' }));
  assert.match(parseReply(JSON.stringify({ actions: many }), INDEX).error, /at most/);
  assert.match(parseReply('{"memory":"x"}', INDEX).error, /no "actions"/);
});

test('actions after "done" are dropped', () => {
  const r = parseReply(JSON.stringify({ actions: [{ action: 'done', answer: 'x' }, { action: 'click', id: 'e1' }] }), INDEX);
  assert.deepEqual(r.actions.map((a) => a.action), ['done']);
});

test('the agent cannot leave the task\'s website by goto', () => {
  const website = 'https://www.apartments.com/';
  assert.match(parseReply('{"actions":[{"action":"goto","url":"https://www.zillow.com/homes/"}]}', INDEX, { website }).error,
    /leaves apartments\.com/);
  assert.equal(parseReply('{"actions":[{"action":"goto","url":"https://apartments.com/houston-tx/"}]}', INDEX, { website }).error, undefined);
  assert.equal(siteOf('https://careers.walmart.com/x'), 'walmart.com');
  assert.equal(siteOf('https://www.bbc.co.uk/news'), 'bbc.co.uk');
});

test('a key press names one of the allowed keys, on an element or on the page', () => {
  assert.equal(parseAction('{"action":"key","id":"e1","key":"ArrowRight"}', INDEX).action.entry.fp, 'aaa0002');
  assert.equal(parseAction('{"action":"key","key":"Escape"}', INDEX).action.entry, undefined);
  assert.match(parseAction('{"action":"key","key":"F12"}', INDEX).error, /key must be one of/);
  assert.match(parseAction('{"action":"key","id":"e9","key":"Enter"}', INDEX).error, /not in the element list/);
});
