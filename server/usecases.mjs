// The five use-case endpoints. Each is a thin shell: all of them share one element index, one
// resolver, one grammar, one gate and one artifact format. That sharing is the point - the
// breadth comes from readers of the same core, not from five separate products.

import { parse } from '../src/artifact.js';
import { memoryStore } from '../src/grammar/bindings.js';
import { FLASH, chatTransport, generateScript, screenScript } from '../src/generate/flash.js';
import { createJevResolver } from '../src/resolve/jev.js';
import { httpTransport } from '../src/resolve/transport.js';
import { ground as groundIntent } from '../src/usecases/ground.js';
import { fill as fillForm } from '../src/usecases/form.js';
import { survey as surveyPage } from '../src/usecases/navigate.js';
import { run as runScript } from '../src/usecases/script.js';
import { compile, replay } from '../src/usecases/task.js';
import { openSession } from './session.mjs';

const KEY = () => process.env.JEV_API_KEY || process.env.NANO_API_KEY;
const need = () => { if (!KEY()) throw new Error('set JEV_API_KEY to enable the model tiers'); return KEY(); };

const resolver = () => createJevResolver({ transport: httpTransport({ apiKey: need() }) });
const decide = () => httpTransport({ apiKey: need() });
const chat = (model) => chatTransport({ apiKey: need(), model: model || FLASH });

async function session(url, seed = {}) {
  const s = await openSession(url, { store: memoryStore(seed), resolver: resolver(),
                                     decide: KEY() ? decide() : null });
  s.site = new URL(url).hostname;
  return s;
}

/** POST /v1/ground {url, intent, operator?} -> one element, or a refusal. */
export async function ground({ url, intent, operator = 'goto' }) {
  const s = await session(url);
  const out = await groundIntent({ resolver: resolver(), index: s.index, intent, operator });
  return { url: s.page.url, indexed: s.index.length, ...out };
}

/** POST /v1/form/fill {url, values} -> what was placed, and what needs a human. */
export async function formFill({ url, values = {}, floor = 0.6 }) {
  const s = await session(url);
  const out = await fillForm({ resolver: resolver(), index: s.index, values, floor });
  return { url: s.page.url, ...out };
}

/** POST /v1/navigate/survey {url} -> everything a crawler needs before it moves, in one call. */
export async function navigateSurvey({ url }) {
  const s = await session(url);
  const out = await surveyPage({ decide: decide(), index: s.index });
  return { url: s.page.url, indexed: s.index.length, ...out };
}

/** POST /v1/script/author {url, task} -> a motion script, generated then screened. */
export async function scriptAuthor({ url, task, name, model, screen = true }) {
  const s = await session(url);
  const generated = await generateScript({ chat: chat(model), task, index: s.index, url: s.page.url, name });
  const screened = screen
    ? await screenScript({ decide: decide(), task, steps: generated.steps })
    : null;
  return {
    url: s.page.url,
    script: generated.raw,
    steps: generated.steps,
    screen: screened ? screened.map((r) => ({ verb: r.step.verb, serves: r.serves })) : null,
    // A step the screen does not back should not run unreviewed, so say so rather than hide it.
    suspectSteps: screened ? screened.filter((r) => r.serves !== null && r.serves < 0.5).length : null,
    usage: generated.usage, authorMs: generated.ms, model: model || FLASH,
  };
}

/**
 * POST /v1/task {url, task} -> generate a plan, execute it once, return a pinned artifact.
 *
 * The first run costs model calls. Every run after it is `POST /v1/task/replay`, which costs nothing
 * and produces an identical trace. That is the difference from an agent: they plan every time.
 */
export async function taskCompile({ url, task, values = {}, model, screen = true }) {
  const s = await session(url);
  s.site = new URL(s.page.url).hostname;
  const generated = await generateScript({ chat: chat(model), task, index: s.index, url: s.page.url, name: task });
  const screener = screen && KEY()
    ? async (plan) => (await screenScript({ decide: decide(), task, steps: plan })).map((r) => r.serves)
    : null;
  const out = await compile({ session: s, task, plan: generated.steps, values, screen: screener });
  return { url: s.page.url, task, plannedBy: model || FLASH, ...out };
}

/** POST /v1/task/replay {url, script, values?} -> replay a compiled artifact, no model calls. */
export async function taskReplay({ url, script, values = {}, bindings = {} }) {
  const s = await session(url, bindings);
  s.site = new URL(s.page.url).hostname;
  const parsed = typeof script === 'string' ? parse(script) : script;
  const out = await replay({ session: s, script: parsed, values });
  return { url: s.page.url, ...out };
}

/** POST /v1/script/run {url, script, values?} -> a verdict and a pinned script. */
export async function scriptRun({ url, script, values = {}, bindings = {} }) {
  const s = await session(url, bindings);
  const parsed = typeof script === 'string' ? parse(script) : script;
  const out = await runScript({ session: s, script: parsed, values });
  return { url: s.page.url, ...out };
}

/**
 * POST /v1/test/run {url, script, values?} -> the same replay, read as a test.
 *
 * A test wants a verdict and an explanation, and it wants to know whether the run cost
 * anything: a fully pinned script replays with zero model calls, which is what makes a CI
 * suite free and deterministic.
 */
export async function testRun(input) {
  const out = await scriptRun(input);
  return {
    verdict: out.passed ? 'pass' : 'fail',
    failedAt: out.failedAt,
    failure: out.failure,
    deterministic: out.networkCalls === 0,
    networkCalls: out.networkCalls,
    steps: out.steps,
    script: out.script,
  };
}
