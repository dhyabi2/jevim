// Record one of our runs, or replay its log with no model, for the replay comparison.
//
//   node bench/h2h/replay_ours.mjs record TASK.json OUT_DIR
//   node bench/h2h/replay_ours.mjs replay OUT_DIR TAG
//
// Same shape as bench/h2h/bu_replay.py. `record` is a normal run (with a screenshot per step, the
// pre-registered primary variant) that also keeps its action log. `replay` re-executes the log in a
// fresh browser, each element re-found by fingerprint; the model is a stub that counts calls, so a
// replay that needed one would show it.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chatTransport } from '../../src/generate/flash.js';
import { runAgent } from '../../server/agent.mjs';

const MODEL = process.env.H2H_MODEL || 'deepseek/deepseek-v4.1-flash';
const [mode, a, b] = process.argv.slice(2);

async function visionChat() {
  const text = chatTransport({ apiKey: process.env.NANO_API_KEY, model: MODEL, timeoutMs: 120000 });
  const stats = { calls: 0, prompt_tokens: 0, completion_tokens: 0 };
  const send = async (prompt, { image } = {}) => {
    if (!image) return text(prompt, { maxTokens: 1500 });
    const res = await fetch('https://nano-gpt.com/api/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.NANO_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 1500, messages: [{ role: 'user', content: [
        { type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }] }] }),
      signal: AbortSignal.timeout(120000),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`vision chat ${res.status}: ${body.slice(0, 200)}`);
    const json = JSON.parse(body);
    return { text: json.choices?.[0]?.message?.content ?? '', usage: json.usage };
  };
  const chat = async (prompt, opts) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await send(prompt, opts);
        stats.calls += 1;
        stats.prompt_tokens += out.usage?.prompt_tokens || 0;
        stats.completion_tokens += out.usage?.completion_tokens || 0;
        return out;
      } catch (error) {
        if (attempt >= 5) throw error;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
    }
  };
  return { chat, stats };
}

if (mode === 'record') {
  const task = JSON.parse(readFileSync(a, 'utf8'));
  mkdirSync(b, { recursive: true });
  writeFileSync(join(b, 'task.json'), JSON.stringify(task));
  const { chat, stats } = await visionChat();
  const started = Date.now();
  const out = { agent: 'ours', task_id: task.task_id, website: task.website };
  try {
    const run = await runAgent({ task: task.confirmed_task, website: task.website, chat, vision: true,
                                 maxSteps: 25, deadline: Date.now() + 810000 });
    Object.assign(out, { final: run.final, steps: run.steps, actions: run.log.length, final_url: run.finalUrl, log: run.log });
  } catch (error) { out.error = String(error.message).slice(0, 300); }
  Object.assign(out, { seconds: Math.round((Date.now() - started) / 100) / 10, llm: stats });
  writeFileSync(join(b, 'record.json'), JSON.stringify(out, null, 1));
} else {
  const record = JSON.parse(readFileSync(join(a, 'record.json'), 'utf8'));
  const task = JSON.parse(readFileSync(join(a, 'task.json'), 'utf8'));
  const stats = { calls: 0, prompt_tokens: 0, completion_tokens: 0 };
  const started = Date.now();
  const out = { agent: 'ours', tag: b };
  try {
    const run = await runAgent({ task: task.confirmed_task, website: task.website, replay: record.log || [],
                                 chat: async () => { stats.calls += 1; return { text: '' }; } });
    Object.assign(out, { ...run.replay, final_url: run.finalUrl });
  } catch (error) { out.error = String(error.message).slice(0, 300); }
  Object.assign(out, { seconds: Math.round((Date.now() - started) / 100) / 10, llm: stats });
  writeFileSync(join(a, `replay-${b}.json`), JSON.stringify(out, null, 1));
}
process.exit(0);
