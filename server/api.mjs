// The HTTP surface. Four endpoints, each a thin shell over the same session object.

import { randomUUID } from 'node:crypto';

import { memoryStore } from '../src/grammar/bindings.js';
import { createJevResolver } from '../src/resolve/jev.js';
import { httpTransport } from '../src/resolve/transport.js';
import { openSession, strip } from './session.mjs';

// A key in the environment turns L1 on for every endpoint. Without one the API answers at L0
// and reports `needs-resolver`, which is the honest state rather than a silent downgrade.
const KEY = process.env.JEV_API_KEY || process.env.NANO_API_KEY;
const jev = () => (KEY ? createJevResolver({ transport: httpTransport({ apiKey: KEY }) }) : null);

// Streaming sessions, so a caller can forward keystrokes as the user makes them and get the
// type-ahead benefit a one-shot request cannot have: there is no typing time to hide inside
// a single POST carrying the whole motion.
const LIVE = new Map();
const TTL_MS = 5 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [id, entry] of LIVE) if (now - entry.touched > TTL_MS) LIVE.delete(id);
}

/** POST /v1/index  {url} -> the element index a model would be given. */
export async function index({ url, limit = 25 }) {
  const session = await openSession(url);
  return {
    ...session.snapshot(),
    sample: session.index.slice(0, limit).map(({ el, ...rest }) => { void el; return rest; }),
  };
}

/** POST /v1/keys  {url, keys, bindings?} -> what the grammar did, keystroke by keystroke. */
export async function keys({ url, keys: text, bindings: seed = {} }) {
  const session = await openSession(url, { store: memoryStore(seed), resolver: jev() });
  const trace = await session.keys(text);
  return { ...session.snapshot(), trace, keymap: session.bindings.toKeymap() };
}

/**
 * POST /v1/task  {start, steps} -> a whole task.
 *
 * A step is one of:
 *   {keys}                    feed keys to the grammar
 *   {pick: {role|name}}       stand in for the human choosing from hint labels, and bind it
 *   {type, submit}            type into the last resolved field and submit its form
 *   {follow: true}            follow the last resolved link
 *   {extract: "article"}      pull readable text off the current page
 *   {report: true}            not implemented: needs the L2 tier
 */
export async function task({ start, steps = [] }) {
  const session = await openSession(start, { resolver: jev() });
  const log = [];
  let last = null;

  for (const step of steps) {
    if (step.keys) {
      const trace = await session.keys(step.keys);
      last = [...trace].reverse().find((r) => r.entry) || last;
      log.push({ step: `keys ${step.keys}`, trace, netCalls: session.runner.net.calls });
      continue;
    }

    if (step.pick) {
      const match = session.index.find((e) =>
        (!step.pick.role || e.role === step.pick.role) &&
        (!step.pick.name || new RegExp(step.pick.name, 'i').test(e.name)));
      if (!match) { log.push({ step: 'pick', status: 'no-match', want: step.pick }); continue; }
      last = { entry: match };
      if (step.bindAs) {
        session.bindings.remember(new URL(session.page.url).hostname,
          { kind: 'search', query: step.bindAs }, match.fp,
          { confidence: step.confidence ?? null, source: step.source || 'hint-pick' });
      }
      const { el, ...rest } = match; void el;
      log.push({ step: 'pick', status: 'picked', entry: rest, boundAs: step.bindAs || null });
      continue;
    }

    if (step.type !== undefined) {
      const entry = resolveLive(session, last);
      if (!entry) { log.push({ step: 'type', status: 'no-target' }); continue; }
      const next = await session.typeAndSubmit(entry, step.type);
      log.push({ step: `type "${step.type}"`, status: next ? 'submitted' : 'typed', navigatedTo: next });
      last = null;
      continue;
    }

    if (step.follow) {
      const entry = resolveLive(session, last);
      const next = entry ? await session.follow(entry) : null;
      log.push({ step: 'follow', status: next ? 'navigated' : 'no-link', navigatedTo: next });
      last = null;
      continue;
    }

    if (step.extract) {
      log.push({ step: 'extract', status: 'ok', ...extract(session, step.chars || 1200) });
      continue;
    }

    if (step.report) {
      log.push({
        step: 'report',
        status: 'not-implemented',
        tier: 'L2',
        reason: 'Writing prose is generation. Jev returns a Choice, a Score or a Noul and is '
              + 'explicitly not trained to generate text, so a report cannot come from the L1 '
              + 'tier. It needs the block 6 escalation, which is not built.',
        offered: 'the extract step returns the source text a generative model would write from',
      });
      continue;
    }

    log.push({ step: JSON.stringify(step), status: 'unknown-step' });
  }

  return { start, final: session.snapshot(), navigations: session.navigations, log,
           keymap: session.bindings.toKeymap(), totalNetworkCalls: session.runner.net.calls };
}

/** POST /v1/session {url} -> { session } : opens a streaming session. */
export async function openStream({ url, bindings: seed = {} }) {
  sweep();
  const session = await openSession(url, { store: memoryStore(seed), resolver: jev() });
  const id = randomUUID();
  LIVE.set(id, { session, touched: Date.now() });
  return { session: id, ...session.snapshot(), l1: Boolean(KEY) };
}

/**
 * POST /v1/session/key {session, token} -> the result for that one token.
 *
 * Forward one keystroke per call, exactly as they happen. Each character of a search query
 * primes the resolver, so by the time <CR> arrives the answer is usually already in hand.
 */
export async function streamKey({ session: id, token }) {
  sweep();
  const entry = LIVE.get(id);
  if (!entry) throw new Error('no such session (they expire after five minutes)');
  entry.touched = Date.now();
  const result = await entry.session.key(token);
  return { ...result, netCalls: entry.session.runner.net.calls,
           typeAhead: entry.session.typeAhead ? { ...entry.session.typeAhead.stats } : null };
}

/** POST /v1/session/close {session} */
export async function closeStream({ session: id }) {
  return { closed: LIVE.delete(id) };
}

// The entry recorded a step ago points at a node in the previous document if we navigated
// since; re-find it in the current index by fingerprint.
function resolveLive(session, last) {
  if (!last || !last.entry) return null;
  return session.index.find((e) => e.fp === last.entry.fp) || last.entry;
}

function extract(session, chars) {
  const doc = session.page.doc;
  const main = doc.querySelector('#mw-content-text, main, article') || doc.body;
  const paragraphs = [...main.querySelectorAll('p')]
    .map((p) => p.textContent.replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 80);
  const headings = [...main.querySelectorAll('h2')].map((h) => h.textContent.trim());
  const facts = {};
  main.querySelectorAll('.infobox tr').forEach((tr) => {
    const k = tr.querySelector('th'); const v = tr.querySelector('td');
    if (k && v) facts[k.textContent.trim().slice(0, 32)] = v.textContent.replace(/\s+/g, ' ').trim().slice(0, 80);
  });
  return {
    title: doc.title,
    headings: headings.slice(0, 12),
    facts: Object.fromEntries(Object.entries(facts).slice(0, 12)),
    lead: paragraphs.slice(0, 3).map((t) => t.slice(0, chars / 3)),
    paragraphCount: paragraphs.length,
  };
}

export { strip };
