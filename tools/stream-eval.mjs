// End-to-end through the streaming API: what does the user actually wait at <CR>?
// Requires the server running with JEV_API_KEY set.  node tools/stream-eval.mjs [base]

const API = process.argv[2] || 'http://127.0.0.1:8791';
const MS_PER_CHAR = Number(process.env.MS_PER_CHAR || 180);
const post = async (p, b) => (await fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CASES = [
  ['https://en.wikipedia.org/wiki/Bitcoin', 'history of bitcoin', /history of bitcoin/i],
  ['https://en.wikipedia.org/wiki/Bitcoin', 'talk page for this article', /talk/i],
  ['https://en.wikipedia.org/wiki/Bitcoin', 'proof of work', /proof of work/i],
  ['https://en.wikipedia.org/wiki/Bitcoin', 'log in to my account', /log in/i],
  ['https://en.wikipedia.org/wiki/Bitcoin', 'add this to my shopping basket', null],
  ['https://en.wikipedia.org/wiki/Bitcoin', 'book me a flight to Paris', null],
  ['https://news.ycombinator.com', 'submit a new story', /submit/i],
  ['https://news.ycombinator.com', 'newest stories', /new/i],
  ['https://news.ycombinator.com', 'the jobs listings', /jobs/i],
  ['https://news.ycombinator.com', 'change my delivery address', null],
];

const rows = [];
const sessions = new Map();

for (const [url, query, expect] of CASES) {
  if (!sessions.has(url)) sessions.set(url, (await post('/v1/session', { url })).session);
  const id = sessions.get(url);

  for (const ch of ['g', '/', ...query]) { await post('/v1/session/key', { session: id, token: ch }); await sleep(MS_PER_CHAR); }
  const t = Date.now();
  const cr = await post('/v1/session/key', { session: id, token: '<CR>' });
  const waited = Date.now() - t;

  const name = cr.entry ? cr.entry.name : null;
  const abstained = cr.status === 'abstained';
  const ok = expect === null ? abstained : (!abstained && expect.test(name || ''));
  rows.push({ query, waited, ok, via: cr.resolution?.typeahead ?? '-', primes: cr.typeAhead?.primed ?? 0 });
  console.log(`${String(waited).padStart(5)}ms  ${ok ? 'OK  ' : 'BAD '}  via ${String(cr.resolution?.typeahead ?? '-').padEnd(8)} ${abstained ? 'ABSTAIN' : `"${name}"`}   ${query}`);
}
for (const id of sessions.values()) await post('/v1/session/close', { session: id });

const free = rows.filter((r) => r.waited < 50).length;
const correct = rows.filter((r) => r.ok).length;
const waits = rows.map((r) => r.waited).sort((a, b) => a - b);
console.log(`
cases                ${rows.length}
correct              ${correct}/${rows.length}
felt instant (<50ms) ${free}/${rows.length}
wait median          ${waits[Math.floor(waits.length / 2)]}ms   p90 ${waits[Math.floor(waits.length * 0.9)]}ms   max ${waits.at(-1)}ms
baseline (no type-ahead) 656ms median on every motion`);
