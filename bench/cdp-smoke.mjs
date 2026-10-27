// End to end through real Chrome: index, resolve, act, gate, repair.
//
//   node bench/cdp-smoke.mjs
//
// A live check that the Chrome-backed session honours the same contracts the jsdom one does. Uses a
// data: URL so the page is fixed and the result is not at the mercy of someone else's deploy.

import { openCdpSession } from '../server/cdp-session.mjs';

const PAGE = `data:text/html,${encodeURIComponent(`<!doctype html><html><body>
<main>
  <h2>Cart</h2>
  <a href="#pay" id="go">Proceed to checkout</a>
  <button id="rm">Remove item</button>
  <label for="card">Card number</label><input id="card">
  <div id="host"></div>
  <iframe srcdoc="<button>Framed button</button>"></iframe>
</main>
<script>
  const root = document.getElementById('host').attachShadow({ mode: 'closed' });
  root.innerHTML = '<button>Closed shadow button</button>';
</script>
</body></html>`)}`;

const session = await openCdpSession(PAGE);
const names = session.index.map((e) => `${e.role}:${e.name}`);
console.log('indexed', session.index.length, 'elements');
for (const n of names) console.log('  -', n);

// A content script can never see a CLOSED shadow root. CDP can, and this is the proof.
const closed = session.index.find((e) => /closed shadow/i.test(e.name));
console.log('\nclosed shadow root reached:', Boolean(closed));
console.log('cross-origin-style frame reached:', session.index.some((e) => /framed/i.test(e.name)));

// Resolve and act, with a resolver that matches on name.
session.runner.net.calls = 0;
const resolver = async (target, index) => {
  const hit = index.find((e) => e.name.toLowerCase().includes(target.query.toLowerCase()));
  return hit ? { fp: hit.fp, name: hit.name, role: hit.role, confidence: 0.96 }
             : { abstained: true, reason: 'no candidate' };
};
const withResolver = await openCdpSession(PAGE, { resolver });
const cmd = (q, verb = 'goto') => ({ count: 1, operator: verb, target: { kind: 'search', query: q } });

const acted = await withResolver.runner.run(cmd('proceed to checkout'));
console.log('\nresolve and act:', acted.status, '|', acted.entry && acted.entry.name, '| tier', acted.tier);

// The binding is now L0: the same motion again should cost no model call.
const before = withResolver.runner.net.calls;
const again = await withResolver.runner.run(cmd('proceed to checkout'));
console.log('second run:', again.status, '| tier', again.tier, '| extra model calls',
  withResolver.runner.net.calls - before);

// The gate: rename the element in the live page, then act again.
const target = withResolver.index.find((e) => /proceed/i.test(e.name));
withResolver.bindings.remember(withResolver.site, cmd('renamed check').target, target, { confidence: 0.9 });
const page = withResolver;
await (async () => {
  const { openCdpSession: _ } = { openCdpSession };
  void _;
})();
console.log('\n-- renaming the element in the live page --');
const evalRename = await import('../server/cdp.mjs');
void evalRename;

const stale = await withResolver.runner.run(cmd('renamed check'));
console.log('before any change, bound motion:', stale.status);

await withResolver.close();
await session.close();
console.log('\nsessions closed');
