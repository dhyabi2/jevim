// The first real Jev call: a real page, the real collector, the real resolver.
// Needs JEV_API_KEY (NanoGPT) in the environment.

import { openSession } from '../server/session.mjs';
import { createJevResolver } from '../src/resolve/jev.js';
import { httpTransport } from '../src/resolve/transport.js';

const KEY = process.env.JEV_API_KEY || process.env.NANO_API_KEY || process.env.NANO_KEY;
const PROVIDER = process.env.JEV_PROVIDER || 'nanogpt';
if (!KEY) { console.error('set JEV_API_KEY (and optionally JEV_PROVIDER)'); process.exit(2); }

const URL_ = process.argv[2] || 'https://en.wikipedia.org/wiki/Bitcoin';
const QUERIES = process.argv.slice(3);
const MOTIONS = QUERIES.length ? QUERIES : [
  'the table of contents',
  'edit this article',
  'the link to the history of bitcoin',
  'add this to my shopping basket',
];

const resolver = createJevResolver({ transport: httpTransport({ apiKey: KEY, provider: PROVIDER }) });
const session = await openSession(URL_);
console.log(`${URL_}\nindexed ${session.index.length}\n`);

for (const query of MOTIONS) {
  const target = { kind: 'search', query };
  const out = await resolver(target, session.index, { operator: 'goto', target });
  const verdict = out.abstained ? `ABSTAIN (${out.reason})` : `-> ${out.role} "${out.name}"`;
  console.log(`"${query}"
  ${verdict}
  strategy=${out.strategy} candidates=${out.candidates} confidence=${out.confidence ?? '-'} pageFits=${out.pageFits ?? '-'} ${out.ms ?? '?'}ms`);
  if (out.usage) console.log(`  usage ${JSON.stringify(out.usage)}`);
}
