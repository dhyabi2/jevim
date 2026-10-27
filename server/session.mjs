// A headless Jevim session: the same collector, parser, driver, runner and gate the
// extension ships, wired to a fetched page instead of a live tab.
//
// Nothing in src/ is modified or re-implemented here. If this file needed a fork of the
// grammar to work headlessly, the grammar would not be browser-independent - and the whole
// claim that a keystroke is a portable, replayable artifact would be weaker.

import { createDriver } from '../src/driver.js';
import { createBindings, memoryStore } from '../src/grammar/bindings.js';
import { createOps } from '../src/grammar/ops.js';
import { createRunner } from '../src/grammar/runner.js';
import { collect } from '../src/index/collect.js';
import { createGate } from '../src/index/gate.js';
import { serialize } from '../src/index/serialize.js';
import { createRepair } from '../src/resolve/repair.js';
import { createTypeAhead } from '../src/resolve/typeahead.js';
import { fetchPage, formTarget } from './page.mjs';

/** Split a key string into the same tokens a keydown listener would produce. */
export function lex(keys) {
  const tokens = [];
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] === '<') {
      const close = keys.indexOf('>', i);
      if (close > i) { tokens.push(keys.slice(i, close + 1)); i = close; continue; }
    }
    tokens.push(keys[i]);
  }
  return tokens;
}

export async function openSession(url, { store = memoryStore(), resolver = null, decide = null } = {}) {
  // Type-ahead only pays off when keystrokes arrive one at a time, which is why the API has
  // a streaming session endpoint as well as the one-shot one.
  const typeAhead = resolver ? createTypeAhead({ resolver }) : null;
  let page = await fetchPage(url);
  let index = collect(page.doc, page.env);
  const bindings = createBindings(store);
  const navigations = [];

  const build = () => {
    const ops = createOps(page.win);
    const runner = createRunner({
      site: new URL(page.url).hostname,
      bindings,
      ops,
      getIndex: () => index,
      resolver: typeAhead ? typeAhead.resolve : resolver,
      gate: createGate(page.doc, page.env),
      repair: decide ? createRepair({ decide }) : null,
    });
    return { ops, runner, driver: createDriver({ runner, typeAhead }) };
  };

  let wired = build();

  async function goTo(next) {
    navigations.push({ from: page.url, to: next });
    page = await fetchPage(next);
    index = collect(page.doc, page.env);
    wired = build();
  }

  /** Feed a key string; returns one result per token that produced one. */
  async function keys(text) {
    const out = [];
    for (const token of lex(text)) {
      const result = await wired.driver.handle(token);
      out.push({ token, ...strip(result) });
    }
    return out.filter((r) => r.status !== 'pending');
  }

  /**
   * Feed a single token and return its result, pending included. This is the endpoint a
   * streaming client uses: every character it forwards is a chance for the resolver to be
   * already finished by the time the caller sends <CR>.
   */
  async function key(token) {
    return { token, ...strip(await wired.driver.handle(token)) };
  }

  /** Follow the link a resolved `goto` landed on, the way a click would. */
  async function follow(entry) {
    const href = entry.el.getAttribute && entry.el.getAttribute('href');
    if (!href) return null;
    const next = new URL(href, page.url).toString();
    await goTo(next);
    return next;
  }

  /** Type into the currently resolved field and submit its form, if it is a GET form. */
  async function typeAndSubmit(entry, text) {
    entry.el.value = text;
    entry.el.dispatchEvent(new page.win.Event('input', { bubbles: true }));
    const target = formTarget(entry.el, page.doc, page.url);
    if (!target) return null;
    await goTo(target);
    return target;
  }

  return {
    keys,
    key,
    typeAhead,
    follow,
    typeAndSubmit,
    goTo,
    bindings,
    get page() { return page; },
    get index() { return index; },
    get runner() { return wired.runner; },
    get driver() { return wired.driver; },
    get navigations() { return navigations; },
    snapshot() {
      const out = serialize(index);
      return {
        url: page.url,
        title: page.doc.title,
        layout: page.layout,
        indexed: index.length,
        tokens: out.tokens,
        budget: out.budget,
        dropped: out.dropped,
        suspect: index.filter((e) => e.suspect).length,
        netCalls: wired.runner.net.calls,
        typeAhead: typeAhead ? { ...typeAhead.stats } : null,
      };
    },
  };
}

/** Index entries carry a live DOM node; it must never cross the wire. */
export function strip(result) {
  if (!result || typeof result !== 'object') return result;
  const out = { ...result };
  if (out.entry) {
    const { el, ...rest } = out.entry;
    void el;
    out.entry = rest;
  }
  if (out.results) out.results = out.results.map(strip);
  return out;
}
