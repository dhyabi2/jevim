// The public API and live demo.
//
//   NANO_API_KEY=... JEVIM_BLOCK_PRIVATE=1 node server/public.mjs
//
// One free agent run per person (a salted hash of the client IP; the IP itself is never stored). An
// owner key in JEVIM_OWNER_KEYS has no limit. Runs are queued, at most JEVIM_CONCURRENCY at once, and each
// streams its steps and what the agent saw as server-sent events.
//
//   POST /api/v1/runs            {task, website}  -> 202 {id, status, position}
//   GET  /api/v1/runs/:id                          -> the run: status, steps, answer, cost
//   GET  /api/v1/runs/:id/events                   -> text/event-stream: step, frame, done
//   GET  /api/v1/quota                             -> {free_runs_left}
//   GET  /health                                   -> {ok, running, queued}

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createServer } from 'node:http';
import { isIP } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chatTransport } from '../src/generate/flash.js';
import { runAgent } from './agent.mjs';
import { connect, launch } from './cdp.mjs';
import { refreshRate } from './xno-rate.mjs';

const PORT = Number(process.env.PORT || 8790);
const DATA = process.env.JEVIM_DATA || join(process.cwd(), '.data');
const MODEL = process.env.JEVIM_MODEL || 'deepseek/deepseek-v4.1-flash';
const CONCURRENCY = Number(process.env.JEVIM_CONCURRENCY || 2);
const FREE_RUNS = Number(process.env.JEVIM_FREE_RUNS || 10);
const MAX_STEPS = Number(process.env.JEVIM_MAX_STEPS || 20);
const RUN_SECONDS = Number(process.env.JEVIM_RUN_SECONDS || 360);
const OWNER_KEYS = new Set((process.env.JEVIM_OWNER_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean));
// Addresses with no run limit, for the owner while testing (JEVIM_OWNER_IPS, comma-separated).
const OWNER_IPS = new Set((process.env.JEVIM_OWNER_IPS || '').split(',').map((k) => k.trim()).filter(Boolean));
const STATIC = fileURLToPath(new URL('../demo/', import.meta.url));

mkdirSync(DATA, { recursive: true });

// ---- quota: salted hashes of client IPs, persisted atomically -------------------------------------
const QUOTA_FILE = join(DATA, 'quota.json');
const quota = existsSync(QUOTA_FILE) ? JSON.parse(readFileSync(QUOTA_FILE, 'utf8')) : { salt: randomBytes(16).toString('hex'), used: {} };
const saveQuota = () => {
  writeFileSync(`${QUOTA_FILE}.tmp`, JSON.stringify(quota));
  renameSync(`${QUOTA_FILE}.tmp`, QUOTA_FILE);
};
saveQuota();
const who = (ip) => createHash('sha256').update(quota.salt + ip).digest('hex').slice(0, 24);
const runsLeft = (ip) => Math.max(0, FREE_RUNS - (quota.used[who(ip)] || 0));

// ---- validation: public http(s) sites only --------------------------------------------------------
export function privateAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')
    || v.startsWith('::ffff:') && privateAddress(v.slice(7));
}

export async function checkWebsite(raw) {
  let url;
  // A bare "example.com" gets https:// added; anything that already names another scheme is refused.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^https?:\/\//i.test(raw)) return { error: 'Only http and https sites can be used.' };
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return { error: 'That is not a web address.' }; }
  if (!['http:', 'https:'].includes(url.protocol)) return { error: 'Only http and https sites can be used.' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return { error: 'Only public websites can be used.' };
  let addresses;
  try { addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }); } catch { return { error: `Could not find ${host}.` }; }
  // Every address the name resolves to must be public, or a DNS answer could point the agent inward.
  if (!addresses.length || addresses.some((a) => privateAddress(a.address))) return { error: 'Only public websites can be used.' };
  return { url: url.href };
}

// ---- one shared, warm Chrome; an isolated browser context per run -----------------------------
// Every run used to get a Chrome of its own (15-26 processes each). Now one Chrome serves all runs, each
// in its own browser context - separate cookies, storage, cache and permissions, disposed when the run
// ends (bench/isolation-smoke.mjs) - so the browser, GPU and network processes are paid for once.
// The Chrome is health-checked before each run and replaced after RECYCLE_AFTER runs, so a slow leak
// inside Chrome cannot build up; a replaced one closes once its last run has finished.
const RECYCLE_AFTER = Number(process.env.JEVIM_RECYCLE_AFTER || 50);
let shared = null;
let launchingShared = null;

async function launchShared() {
  const chrome = await launch({ headless: true });
  return { chrome, cdp: await connect(chrome.endpoint), active: 0, runs: 0, retired: false };
}

async function healthy(b) {
  if (!b || b.retired) return false;
  return Promise.race([
    b.cdp.send('Browser.getVersion').then(() => true, () => false),
    new Promise((r) => setTimeout(() => r(false), 5000)),
  ]);
}

function retire(b) {
  b.retired = true;
  if (b.active === 0) { try { b.cdp.close(); } catch { /* gone */ } b.chrome.close().catch(() => null); }
}

async function sharedBrowser() {
  if (shared && shared.runs < RECYCLE_AFTER && await healthy(shared)) return shared;
  if (!launchingShared) {
    const old = shared;
    launchingShared = launchShared().then((b) => { shared = b; if (old) retire(old); return b; })
      .finally(() => { launchingShared = null; });
  }
  return launchingShared;
}

async function takeBrowser() {
  const b = await sharedBrowser();
  b.active += 1;
  b.runs += 1;
  return { chrome: b.chrome, cdp: b.cdp, isolate: true, owner: b };
}

function discard(browser) {
  const b = browser.owner;
  b.active -= 1;
  if (b.retired && b.active === 0) retire(b);
}
const refill = () => { sharedBrowser().catch(() => null); };
const pool = { get length() { return shared && !shared.retired ? 1 : 0; } };

// ---- the live view: the browser's own screencast, from its first paint ---------------------------
const FRAME_MS = 250;            // at most ~4 frames a second to each viewer
function screencast(session, run) {
  let page = null;
  let off = null;
  let last = 0;
  const start = async () => {
    if (session.rawPage === page) return;
    page = session.rawPage;
    if (off) off();
    const sid = page.sessionId;
    off = session.cdp.on('Page.screencastFrame', (params, from) => {
      if (from !== sid) return;
      page.call('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => null);
      const now = Date.now();
      if (now - last < FRAME_MS) return;
      last = now;
      run.frame = params.data;
      emit(run, 'frame', { image: params.data });
    });
    await page.call('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 1280, maxHeight: 900 }).catch(() => null);
  };
  return { start, stop: () => { if (off) off(); page?.call('Page.stopScreencast').catch(() => null); } };
}

// ---- cost: what the provider billed, in USD and in XNO at the hourly rate -------------------------
const RATE_FILE = join(DATA, 'xno-rate.json');
function readRate() {
  try { return JSON.parse(readFileSync(RATE_FILE, 'utf8')); } catch { return null; }
}
function costOf(usd) {
  if (typeof usd !== 'number') return null;
  const rate = readRate();
  return { usd: Math.round(usd * 1e6) / 1e6,
           xno: rate ? Math.round((usd / rate.usd_per_xno) * 1e6) / 1e6 : null,
           rate: rate ? { usd_per_xno: rate.usd_per_xno, source: rate.source, at: rate.at } : null };
}
if (!readRate()) refreshRate().catch(() => null);

// ---- runs: a queue, a concurrency limit, and listeners for the live view -------------------------
const runs = new Map();
const queue = [];
let running = 0;

const chatFor = () => {
  const text = chatTransport({ apiKey: process.env.NANO_API_KEY, model: MODEL, timeoutMs: 120000 });
  return async (prompt, { image } = {}) => {
    for (let attempt = 0; ; attempt++) {
      try {
        if (!image) return await text(prompt, { maxTokens: 1500 });
        const res = await fetch('https://nano-gpt.com/api/v1/chat/completions', {
          method: 'POST',
          headers: { authorization: `Bearer ${process.env.NANO_API_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: MODEL, max_tokens: 1500, messages: [{ role: 'user', content: [
            { type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }] }] }),
          signal: AbortSignal.timeout(120000),
        });
        const body = await res.text();
        if (res.status === 402 || /insufficient/i.test(body)) throw Object.assign(new Error('out of credit'), { fatal: true });
        if (!res.ok) throw new Error(`model ${res.status}`);
        const json = JSON.parse(body);
        return { text: json.choices?.[0]?.message?.content ?? '', usage: json.usage };
      } catch (error) {
        if (error.fatal || attempt >= 3) throw error;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
    }
  };
};

function publicView(run) {
  const { listeners, frame, ...rest } = run;
  return rest;
}

function emit(run, event, data) {
  for (const res of run.listeners) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function execute(run) {
  running += 1;
  run.status = 'running';
  run.started = new Date().toISOString();
  emit(run, 'status', { status: run.status });
  const started = Date.now();
  const browser = await takeBrowser().catch(() => null);
  let cast = null;
  try {
    const out = await runAgent({
      task: run.task, website: run.website, chat: chatFor(), vision: true, maxSteps: MAX_STEPS,
      deadline: Date.now() + RUN_SECONDS * 1000,
      browser,
      onSession: async (session) => { cast = screencast(session, run); await cast.start(); },
      onStep: async ({ step, url, summary, outcome }) => {
        const entry = { step, url, action: summary, outcome };
        run.steps.push(entry);
        emit(run, 'step', entry);
        if (cast) await cast.start();          // the agent may have moved to a new tab
      },
    });
    Object.assign(run, { status: out.done ? 'done' : 'stopped', answer: out.final, tokens: out.tokens,
      cost: costOf(out.cost_usd), model_calls: out.calls, replay_script: out.artifact });
  } catch (error) {
    run.status = 'failed';
    run.error = /out of credit/.test(error.message)
      ? 'The demo has run out of model credit for now. Your free run was not used - please try again later.'
      : 'The run could not be completed. Your free run was not used.';
    // A failure on our side must not cost the visitor their one free run.
    if (run.client) { quota.used[run.client] = Math.max(0, (quota.used[run.client] || 1) - 1); saveQuota(); }
  } finally {
    if (cast) cast.stop();
    if (browser) discard(browser);
    run.seconds = Math.round((Date.now() - started) / 100) / 10;
    run.finished = new Date().toISOString();
    running -= 1;
    emit(run, 'done', publicView(run));
    for (const res of run.listeners) res.end();
    run.listeners.clear();
    queue.forEach((r, i) => { r.position = i + 1; emit(r, 'status', { status: 'queued', position: r.position }); });
    pump();
  }
}

function pump() {
  while (running < CONCURRENCY && queue.length) execute(queue.shift());
}

// Forget finished runs after a day, so memory stays bounded.
setInterval(() => {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const [id, run] of runs) if (run.finished && Date.parse(run.finished) < cutoff) runs.delete(id);
}, 3600 * 1000).unref();

// ---- http -----------------------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
               '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
                          'access-control-allow-origin': '*', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) { body += chunk; if (body.length > 20000) throw new Error('too large'); }
  return JSON.parse(body || '{}');
}

const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const ownerKey = (req) => {
  if (OWNER_IPS.has(clientIp(req))) return true;
  const key = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return Boolean(key) && OWNER_KEYS.has(key);
};

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization',
                           'access-control-allow-methods': 'GET, POST' });
      return res.end();
    }
    if (path === '/health') return send(res, 200, { ok: true, running, queued: queue.length, warm_browsers: pool.length,
                                                     shared_browser_runs: shared ? shared.runs : 0, xno_rate: readRate() });

    if (path === '/api/v1/quota' && req.method === 'GET') {
      return send(res, 200, { free_runs_left: ownerKey(req) ? null : runsLeft(clientIp(req)), unlimited: ownerKey(req) });
    }

    if (path === '/api/v1/runs' && req.method === 'POST') {
      const body = await readJson(req).catch(() => null);
      if (!body) return send(res, 400, { error: 'Send JSON: {"task": "...", "website": "..."}' });
      const task = String(body.task || '').trim();
      if (task.length < 8 || task.length > 500) return send(res, 400, { error: 'Describe the task in 8 to 500 characters.' });
      const site = await checkWebsite(String(body.website || '').trim());
      if (site.error) return send(res, 400, { error: site.error });
      const ip = clientIp(req);
      const owner = ownerKey(req);
      if (!owner && runsLeft(ip) <= 0) {
        return send(res, 429, { error: 'You have used your free runs. Thank you for trying it!', free_runs_left: 0 });
      }
      if (!owner) { quota.used[who(ip)] = (quota.used[who(ip)] || 0) + 1; saveQuota(); }
      const run = { id: randomUUID(), task, website: site.url, status: 'queued', position: queue.length + 1,
                    created: new Date().toISOString(), steps: [], listeners: new Set() };
      // Not part of the public view: which quota entry to refund if the run fails on our side.
      Object.defineProperty(run, 'client', { value: owner ? null : who(ip), enumerable: false });
      runs.set(run.id, run);
      queue.push(run);
      pump();
      return send(res, 202, { id: run.id, status: run.status, position: run.status === 'queued' ? run.position : 0,
                              free_runs_left: owner ? null : runsLeft(ip),
                              links: { self: `/api/v1/runs/${run.id}`, events: `/api/v1/runs/${run.id}/events` } });
    }

    const match = path.match(/^\/api\/v1\/runs\/([0-9a-f-]{36})(\/events)?$/);
    if (match && req.method === 'GET') {
      const run = runs.get(match[1]);
      if (!run) return send(res, 404, { error: 'No such run.' });
      if (!match[2]) return send(res, 200, publicView(run));
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive',
                           'access-control-allow-origin': '*', 'x-accel-buffering': 'no' });
      res.write(`event: status\ndata: ${JSON.stringify({ status: run.status, position: run.position })}\n\n`);
      for (const step of run.steps) res.write(`event: step\ndata: ${JSON.stringify(step)}\n\n`);
      if (run.frame) res.write(`event: frame\ndata: ${JSON.stringify({ image: run.frame })}\n\n`);
      if (run.finished) { res.write(`event: done\ndata: ${JSON.stringify(publicView(run))}\n\n`); return res.end(); }
      run.listeners.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); run.listeners.delete(res); });
      return;
    }

    if (req.method === 'GET' && !path.startsWith('/api/')) {
      const file = normalize(join(STATIC, path === '/' ? 'index.html' : path));
      if (!file.startsWith(STATIC) || !existsSync(file)) return send(res, 404, { error: 'Not found.' });
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'public, max-age=300' });
      return res.end(readFileSync(file));
    }
    return send(res, 404, { error: 'Not found.' });
  } catch (error) {
    return send(res, 500, { error: 'Something went wrong.' });
  }
});

if (import.meta.url === `file://${process.argv[1]}`) {
  refill();
  const HOST = process.env.JEVIM_HOST || '0.0.0.0';   // the Hermes plugin sets 127.0.0.1
  server.listen(PORT, HOST, () => console.log(`jevim public api on ${HOST}:${PORT}`));
}
