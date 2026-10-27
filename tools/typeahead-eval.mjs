// Does type-ahead hide the resolver?
//
// The first attempt fired on every character and still made the user wait: the last call
// started on the last keystroke, so nothing was hidden. The insight it exposed is that the
// answer for a PREFIX is usually the answer for the whole query - "histo" already resolves to
// "History of bitcoin". So the question is not "is the answer for the exact final string
// ready" but "has the answer stabilised before <CR>".
//
// Policy measured here: single-flight, coalescing. At most one call in the air; fire again
// only once at least STEP more characters have arrived. On <CR>, accept the newest completed
// answer whose query is a prefix of the final query.
//
//   JEV_API_KEY=... node tools/typeahead-eval.mjs

import { openSession } from '../server/session.mjs';
import { createJevResolver } from '../src/resolve/jev.js';
import { httpTransport } from '../src/resolve/transport.js';

const KEY = process.env.JEV_API_KEY || process.env.NANO_API_KEY;
if (!KEY) { console.error('set JEV_API_KEY'); process.exit(2); }

const MS_PER_CHAR = Number(process.env.MS_PER_CHAR || 180);
const STEP = Number(process.env.STEP || 3);
const MIN_CHARS = 3;
// An answer from a very short prefix is not trustworthy: "sub" abstained where "submit"
// resolves. A prefix answer is only accepted once the prefix is at least this long.
// Measured: a floor of 5 made things worse (5/8 free, 223ms mean) than no floor
// (6/8 free, 80ms mean). It rejects good early answers more often than it catches bad
// ones. Default off; the better mitigation is a stability rule, noted in the ranking.
const MIN_ACCEPT = Number(process.env.MIN_ACCEPT || 0);

const CASES = [
  ['https://en.wikipedia.org/wiki/Bitcoin', 'history of bitcoin'],
  ['https://en.wikipedia.org/wiki/Bitcoin', 'talk page'],
  ['https://en.wikipedia.org/wiki/Bitcoin', 'proof of work'],
  ['https://en.wikipedia.org/wiki/Bitcoin', 'log in to my account'],
  ['https://news.ycombinator.com', 'submit'],
  ['https://news.ycombinator.com', 'newest stories'],
  ['https://news.ycombinator.com', 'jobs'],
  ['https://news.ycombinator.com', 'add this to my shopping cart'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const resolver = createJevResolver({ transport: httpTransport({ apiKey: KEY }) });
const sessions = new Map();
const rows = [];
const label = (r) => (r.abstained ? 'ABSTAIN' : r.name);

for (const [url, query] of CASES) {
  if (!sessions.has(url)) sessions.set(url, await openSession(url));
  const index = sessions.get(url).index;

  const done = [];          // completed { query, result, at }
  let inflight = null;      // { query, promise }
  let firedAt = -Infinity;  // characters typed when the in-air call was fired
  let calls = 0;

  const fire = (prefix, typed) => {
    calls += 1;
    firedAt = typed;
    const target = { kind: 'search', query: prefix };
    const promise = resolver(target, index, { operator: 'goto', target })
      .then((result) => { done.push({ query: prefix, result, at: Date.now() }); inflight = null; return result; });
    inflight = { query: prefix, promise };
  };

  const started = Date.now();
  for (let i = 1; i <= query.length; i++) {
    await sleep(MS_PER_CHAR);
    const prefix = query.slice(0, i);
    if (prefix.trim().length < MIN_CHARS) continue;
    if (!inflight && i - firedAt >= STEP) fire(prefix, i);
  }
  const typingDone = Date.now();

  // <CR>. Use the newest completed answer that is a prefix of what was typed.
  let usable = [...done].reverse().find((d) => query.startsWith(d.query) && d.query.trim().length >= Math.min(MIN_ACCEPT, query.trim().length));
  let waited = 0;
  if (!usable) {
    if (inflight) await inflight.promise;
    else fire(query, query.length), await inflight.promise;
    usable = [...done].reverse().find((d) => query.startsWith(d.query));
    waited = Date.now() - typingDone;
  }

  // Ground truth: what the resolver says for the complete query.
  const target = { kind: 'search', query };
  const full = await resolver(target, index, { operator: 'goto', target });

  const agreed = label(usable.result) === label(full);
  const earliest = done.find((d) => label(d.result) === label(full));
  const cost = done.reduce((a, d) => a + (d.result.usage?.cost ?? 0), 0) + (full.usage?.cost ?? 0);

  rows.push({ query, waited, calls, agreed, cost,
              stabilisedAt: earliest ? earliest.query.length : null, len: query.length });
  console.log(`${String(waited).padStart(5)}ms wait  calls ${String(calls).padStart(2)}  ${agreed ? 'AGREES' : 'DIFFERS'}  stable@${earliest ? earliest.query.length : '-'}/${query.length}  used "${label(usable.result)}" vs full "${label(full)}"   ${query}`);
}

const free = rows.filter((r) => r.waited === 0).length;
const right = rows.filter((r) => r.waited === 0 && r.agreed).length;
const avgWait = Math.round(rows.reduce((a, r) => a + r.waited, 0) / rows.length);
const avgCalls = (rows.reduce((a, r) => a + r.calls, 0) / rows.length).toFixed(1);
const cost = rows.reduce((a, r) => a + r.cost, 0) / rows.length;
console.log(`
typed at            ${MS_PER_CHAR}ms/char, single-flight, refire every ${STEP} chars, accept prefix >= ${MIN_ACCEPT}
ready on <CR>       ${free}/${rows.length}
ready AND correct   ${right}/${rows.length}
mean extra wait     ${avgWait}ms
calls per motion    ${avgCalls}
cost per motion     $${cost.toFixed(6)}  (includes the ground-truth call this harness adds)`);
