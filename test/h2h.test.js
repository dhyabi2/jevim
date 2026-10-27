import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// The benchmark task sets are third-party data and are not redistributed in this repository.
const HAVE_DATA = existsSync('bench/data/mind2web/Online_Mind2Web.json') && existsSync('bench/data/webvoyager/WebVoyager_data.jsonl');
const needsData = (name, fn) => test(name, { skip: !HAVE_DATA && 'benchmark data not downloaded' }, fn);

import { lenientPrompt, strictPrompt } from '../bench/h2h/judge.mjs';
import { summarise } from '../bench/h2h/report.mjs';
import { splits } from '../bench/h2h/run.mjs';

const RUN = {
  task: 'Find the cheapest red shoes', website: 'https://shop.test/', final: 'The cheapest is $12.',
  trace: [{ url: 'https://shop.test/', action: 'click link "Shoes"', outcome: 'ok' }],
};

test('the judge cannot tell which agent produced a run', () => {
  const ours = { ...RUN, agent: 'ours', model: 'm', calls: 3, tokens: { prompt: 900 }, artifact: 'goto ...' };
  const theirs = { ...RUN, agent: 'browser-use', version: '0.13.10', model: 'm', tokens: { prompt: 40000 } };
  assert.equal(lenientPrompt(ours), lenientPrompt(theirs));
  assert.equal(strictPrompt(ours, true), strictPrompt(theirs, true));
  for (const leak of ['browser-use', 'ours', '0.13.10', '40000']) {
    assert.ok(!strictPrompt(theirs, true).includes(leak), `strict prompt leaks ${leak}`);
    assert.ok(!lenientPrompt(theirs).includes(leak), `lenient prompt leaks ${leak}`);
  }
});

test('the lenient rubric reads the task and the answer only, as browser-use\'s own does', () => {
  const text = lenientPrompt(RUN);
  assert.ok(text.includes(RUN.task) && text.includes(RUN.final));
  assert.ok(!text.includes('click link'), 'no trace in the lenient prompt');
});

needsData('the dev and test splits are fixed, disjoint and stratified', () => {
  const tasks = JSON.parse(readFileSync('bench/data/mind2web/Online_Mind2Web.json', 'utf8'));
  const a = splits(tasks);
  const b = splits([...tasks].reverse());
  assert.deepEqual(a.dev.map((t) => t.task_id), b.dev.map((t) => t.task_id), 'input order does not matter');
  assert.deepEqual(a.test.map((t) => t.task_id), b.test.map((t) => t.task_id));
  const dev = new Set(a.dev.map((t) => t.task_id));
  assert.equal(a.test.filter((t) => dev.has(t.task_id)).length, 0);
  assert.equal(a.dev.length, 20);
  for (const level of ['easy', 'medium', 'hard']) assert.equal(a.test.filter((t) => t.level === level).length, 20);
});

test('a crashed, missing or unjudged run counts as a failure, not as a smaller denominator', () => {
  const dir = mkdtempSync(join(tmpdir(), 'h2h-'));
  const tasks = ['t1', 't2', 't3', 't4'].map((task_id) => ({ task_id, level: 'easy' }));
  writeFileSync(join(dir, 'tasks.json'), JSON.stringify(tasks));
  const put = (agent, id, result, judge) => {
    mkdirSync(join(dir, agent, id), { recursive: true });
    writeFileSync(join(dir, agent, id, 'result.json'), JSON.stringify(result));
    if (judge) writeFileSync(join(dir, agent, id, 'judge.json'), JSON.stringify(judge));
  };
  put('ours', 't1', { seconds: 10 }, { lenient: true, strict: true });
  put('ours', 't2', { error: 'timeout' }, { lenient: false, strict: false });
  put('ours', 't3', { seconds: 12 });                                   // never judged
  // t4 has no directory at all
  put('bu', 't1', { seconds: 30 }, { lenient: true, strict: false });
  put('bu', 't2', { seconds: 30 }, { lenient: true, strict: true });

  const s = summarise(dir);
  assert.deepEqual([s.agents.ours.strict.n, s.agents.ours.strict.of], [1, 4]);
  assert.deepEqual([s.agents.bu.lenient.n, s.agents.bu.lenient.of], [2, 4]);
  assert.equal(s.agents.ours.errors, 1);
  assert.equal(s.agents.ours.unjudged, 2);
  assert.deepEqual(s.paired.strict, { both: 0, onlyOurs: 1, onlyBu: 1, neither: 2, signTestP: 1 });
});

test('only a run the network killed is re-run; anything the agent did on a reachable site is scored', async () => {
  const { infrastructureFailure } = await import('../bench/h2h/run.mjs');
  assert.equal(infrastructureFailure({ error: 'fetch failed', steps: 0 }), true);
  assert.equal(infrastructureFailure({ final: '', errors: ['Connection error.', 'Connection error.'] }), true);
  assert.equal(infrastructureFailure({ final: '', errors: ['Navigation failed - site unavailable: https://x/'] }), true);
  assert.equal(infrastructureFailure({ error: 'fetch failed', steps: 12 }), false, 'a late outage after real work is scored');
  assert.equal(infrastructureFailure({ final: '', errors: ['Element not found'] }), false);
  assert.equal(infrastructureFailure({ error: 'timeout', steps: 25 }), false);
  assert.equal(infrastructureFailure({ final: 'an answer', steps: 5 }), false);
});

test('an answer taken from a different website is measured as leaving the task site', async () => {
  const { leftSite } = await import('../bench/h2h/report.mjs');
  const trace = (...urls) => ({ trace: urls.map((url) => ({ url, action: 'x' })) });
  assert.deepEqual(leftSite(trace('https://www.apartments.com/', 'https://www.zillow.com/detroit/'), 'https://www.apartments.com/'),
    { any: true, sites: ['zillow.com'] });
  assert.equal(leftSite(trace('https://careers.walmart.com/', 'https://www.walmart.com/x'), 'https://www.walmart.com/').any, false,
    'a subdomain of the task site is the task site');
  assert.equal(leftSite(trace('', 'about:blank', 'https://www.bbb.org/search'), 'https://www.bbb.org/').any, false);
});

needsData('the second held-out split is exactly the tasks in neither dev nor test', () => {
  const tasks = JSON.parse(readFileSync('bench/data/mind2web/Online_Mind2Web.json', 'utf8'));
  const { dev, test: first, test2 } = splits(tasks);
  const used = new Set([...dev, ...first].map((t) => t.task_id));
  assert.equal(test2.length, tasks.length - used.size);
  assert.equal(test2.filter((t) => used.has(t.task_id)).length, 0);
});

test('billing refusals, suspends and dead processes are re-queued; numbers inside answers are not', async () => {
  const { contaminated, partialJudgement } = await import('../bench/h2h/requeue.mjs');
  assert.equal(contaminated({ error: 'flash 402: {"error":"Insufficient balance"}' }), 'billing');
  assert.equal(contaminated({ errors: ['judge 429: rate limited'] }), 'billing');
  assert.equal(contaminated({ seconds: 7585.5, error: 'timeout' }), 'suspended');
  assert.equal(contaminated({ error: 'exit 0: WebSocket closed' }), 'process died');
  assert.equal(contaminated({ final: 'LG 27UP850N-W - $429.99', seconds: 160 }), null);
  assert.equal(contaminated({ trace: [{ url: 'https://www.windy.com/?23.598,58.402,5' }], seconds: 190 }), null);
  assert.equal(contaminated({ trace: [{ outcome: 'Saved page as PDF (868,402 bytes)' }], seconds: 220 }), null);
  assert.equal(contaminated({ error: 'timeout', seconds: 900.1 }), null, 'a genuine timeout stays a failure');
  assert.equal(contaminated({ error: 'Page.navigate timed out', seconds: 33 }), 'start page unreachable');
  assert.equal(contaminated({ error: 'Page.navigate timed out', seconds: 300, steps: 6 }), null, 'mid-run, it is the agent\'s failure');
  assert.equal(partialJudgement({ votes: { lenient: [true, true, false], strict: [true, false, false] } }), false);
  assert.equal(partialJudgement({ votes: { lenient: [true], strict: [true, false, false] } }), true);
});

needsData('the WebVoyager split is 4 tasks from each of its 15 sites, fixed and order-independent', async () => {
  const { webvoyager } = await import('../bench/h2h/run.mjs');
  const rows = readFileSync('bench/data/webvoyager/WebVoyager_data.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const a = webvoyager(rows);
  assert.equal(a.length, 60);
  assert.deepEqual(a.map((t) => t.task_id), webvoyager([...rows].reverse()).map((t) => t.task_id));
  const perSite = a.reduce((acc, t) => ({ ...acc, [t.level]: (acc[t.level] || 0) + 1 }), {});
  assert.equal(Object.keys(perSite).length, 15);
  assert.ok(Object.values(perSite).every((n) => n === 4));
});

needsData('the second WebVoyager split is 7 more per site, disjoint from the first', async () => {
  const { webvoyager } = await import('../bench/h2h/run.mjs');
  const rows = readFileSync('bench/data/webvoyager/WebVoyager_data.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const first = new Set(webvoyager(rows).map((t) => t.task_id));
  const second = webvoyager(rows, { perSite: 7, skip: 4 });
  assert.equal(second.length, 105);
  assert.equal(second.filter((t) => first.has(t.task_id)).length, 0);
  assert.equal(new Set(second.map((t) => t.task_id)).size, 105);
});
