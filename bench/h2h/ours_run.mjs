// Run one Online-Mind2Web task with our agent, for the head-to-head.
//
//   NANO_API_KEY=... node bench/h2h/ours_run.mjs TASK.json OUT_DIR
//
// Same task row, same model and same output shape as bench/h2h/bu_run.py, so the judge cannot tell the
// two agents apart except by what they did.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { chatTransport } from '../../src/generate/flash.js';
import { runAgent } from '../../server/agent.mjs';

const MODEL = process.env.H2H_MODEL || 'deepseek/deepseek-v4.1-flash';
const MAX_STEPS = Number(process.env.H2H_MAX_STEPS || 25);
const TIMEOUT_MS = Number(process.env.H2H_TIMEOUT || 900) * 1000;

const [taskPath, outDir] = process.argv.slice(2);
const task = JSON.parse(readFileSync(taskPath, 'utf8'));
mkdirSync(outDir, { recursive: true });

const VISION = process.env.H2H_VISION === '1';
const text = chatTransport({ apiKey: process.env.NANO_API_KEY, model: MODEL, timeoutMs: 120000 });
// The same endpoint and model, with the screenshot as a second content part when there is one.
async function send(prompt, { maxTokens, image } = {}) {
  if (!image) return text(prompt, { maxTokens });
  const started = Date.now();
  const res = await fetch('https://nano-gpt.com/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.NANO_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } },
    ] }] }),
    signal: AbortSignal.timeout(120000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`vision chat ${res.status}: ${body.slice(0, 200)}`);
  const json = JSON.parse(body);
  return { text: json.choices?.[0]?.message?.content ?? '', usage: json.usage, ms: Date.now() - started };
}
// Retries with backoff on a transport failure: a dropped connection is not the agent's decision, and a
// network blip otherwise ends the task in three seconds as a "failure" that says nothing about the agent.
const chat = async (prompt, { image } = {}) => {
  for (let attempt = 0; ; attempt++) {
    try { return await send(prompt, { maxTokens: 1500, image }); } catch (error) {
      if (attempt >= 5) throw error;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
};

const result = { agent: VISION ? 'ours-vision' : 'ours', model: MODEL, task_id: task.task_id, task: task.confirmed_task,
                 website: task.website, level: task.level };
const started = Date.now();
try {
  const out = await Promise.race([
    runAgent({ task: task.confirmed_task, website: task.website, chat, maxSteps: MAX_STEPS, vision: VISION,
               deadline: Date.now() + TIMEOUT_MS - 180000,
               screenshotTo: join(outDir, 'final.png') }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)),
  ]);
  Object.assign(result, out, { trace: out.trace.map((h) => ({ url: h.url, action: h.summary, outcome: h.outcome })) });
  writeFileSync(join(outDir, 'artifact.txt'), out.artifact);
} catch (error) {
  Object.assign(result, { final: '', done: false, error: String(error.message).slice(0, 500),
                          seconds: Math.round((Date.now() - started) / 100) / 10 });
}
writeFileSync(join(outDir, 'result.json'), JSON.stringify(result, null, 1));
process.exit(0);
