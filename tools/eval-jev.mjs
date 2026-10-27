// The experiment the whole thesis rests on: does the resolver hit the right element, and
// does it refuse when there is no right element?
//
// The dangerous cell is FALSE FIRE - it named a target on a page where none exists. Because
// the human already typed the verb, a false fire means the right verb on the wrong element.
// A false abstention is merely a fallback to hint labels, which is what users have today.
//
//   JEV_API_KEY=... node tools/eval-jev.mjs

import { openSession } from '../server/session.mjs';
import { createJevResolver } from '../src/resolve/jev.js';
import { httpTransport } from '../src/resolve/transport.js';

const KEY = process.env.JEV_API_KEY || process.env.NANO_API_KEY || process.env.NANO_KEY;
if (!KEY) { console.error('set JEV_API_KEY'); process.exit(2); }

const ABSTAIN = Symbol('abstain');

const CASES = [
  ['https://en.wikipedia.org/wiki/Bitcoin', 'the link to the history of bitcoin', /history of bitcoin/i],
  ['https://en.wikipedia.org/wiki/Bitcoin', 'the table of contents', /contents/i],
  ['https://en.wikipedia.org/wiki/Bitcoin', 'the talk page for this article', /talk/i],
  ['https://en.wikipedia.org/wiki/Bitcoin', 'log in to my account', /log in/i],
  ['https://en.wikipedia.org/wiki/Bitcoin', 'the article about proof of work', /proof of work/i],
  ['https://en.wikipedia.org/wiki/Bitcoin', 'search wikipedia', /search/i],
  ['https://en.wikipedia.org/wiki/Bitcoin', 'add this to my shopping basket', ABSTAIN],
  ['https://en.wikipedia.org/wiki/Bitcoin', 'check out and pay for my order', ABSTAIN],
  ['https://en.wikipedia.org/wiki/Bitcoin', 'book me a flight to Paris', ABSTAIN],
  ['https://news.ycombinator.com', 'submit a new story', /submit/i],
  ['https://news.ycombinator.com', 'log in', /login/i],
  ['https://news.ycombinator.com', 'show me the newest stories', /new/i],
  ['https://news.ycombinator.com', 'the jobs listings', /jobs/i],
  ['https://news.ycombinator.com', 'add this to my shopping cart', ABSTAIN],
  ['https://news.ycombinator.com', 'change my delivery address', ABSTAIN],
];

const resolver = createJevResolver({ transport: httpTransport({ apiKey: KEY }) });
const sessions = new Map();
const tally = { hit: 0, wrongTarget: 0, falseAbstain: 0, correctAbstain: 0, falseFire: 0 };
let cost = 0; const latencies = [];

for (const [url, query, expect] of CASES) {
  if (!sessions.has(url)) sessions.set(url, await openSession(url));
  const session = sessions.get(url);
  const target = { kind: 'search', query };
  const out = await resolver(target, session.index, { operator: 'goto', target });

  cost += out.usage?.cost ?? 0;
  if (out.ms) latencies.push(out.ms);

  let verdict;
  if (expect === ABSTAIN) {
    verdict = out.abstained ? 'correctAbstain' : 'falseFire';
  } else if (out.abstained) {
    verdict = 'falseAbstain';
  } else {
    verdict = expect.test(out.name || '') ? 'hit' : 'wrongTarget';
  }
  tally[verdict] += 1;

  const got = out.abstained ? `ABSTAIN` : `"${out.name}"`;
  const flag = verdict === 'falseFire' ? '  <<< FALSE FIRE' : '';
  console.log(`${verdict.padEnd(14)} ${got.padEnd(38)} conf=${(out.confidence ?? 0).toFixed(2)} cand=${String(out.candidates).padStart(3)} ${query}${flag}`);
}

const n = latencies.length;
latencies.sort((a, b) => a - b);
console.log(`
cases              ${CASES.length}
hit                ${tally.hit}
wrong target       ${tally.wrongTarget}
false abstention   ${tally.falseAbstain}   (degrades to hint labels)
correct abstention ${tally.correctAbstain}
FALSE FIRE         ${tally.falseFire}   (the only unsafe outcome)
latency median     ${latencies[Math.floor(n / 2)]}ms   p90 ${latencies[Math.floor(n * 0.9)]}ms
total cost         $${cost.toFixed(6)}  (${(cost / CASES.length).toFixed(6)} per motion)`);
