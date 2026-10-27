// Run the benchmark.
//
//   NANO_API_KEY=... node bench/run.mjs [n] [concurrency]
//
// Grading follows SimpleQA: every answer is CORRECT, INCORRECT or NOT_ATTEMPTED, judged by a model
// against the reference answer. A refusal lands in NOT_ATTEMPTED, which is the whole point - the
// design moves failures out of INCORRECT and into NOT_ATTEMPTED, where they cost a missing answer
// rather than a false one.
//
// Reported metrics: SimpleQA's own F-score, so the number is comparable to what vendors publish, and
// the confident-wrong rate, which is the number we claim to lead and which nobody foregrounds.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { judged, modelOnly, searchRaw } from './arms.mjs';

const KEY = process.env.NANO_API_KEY;
if (!KEY) { console.error('set NANO_API_KEY'); process.exit(2); }
const GRADER = process.env.GRADER_MODEL || 'deepseek/deepseek-v4-pro';
const N = Number(process.argv[2] || 100);
const CONCURRENCY = Number(process.argv[3] || 6);

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift();
  return rows.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

/** A fixed pseudo-random sample, so every run scores the same questions. */
function sample(rows, n) {
  const keyed = rows.map((r) => ({ r, h: createHash('sha1').update(r.problem).digest('hex') }));
  keyed.sort((a, b) => (a.h < b.h ? -1 : 1));
  return keyed.slice(0, n).map((x) => x.r);
}

async function grade(question, reference, answer) {
  if (!answer) return 'NOT_ATTEMPTED';
  const prompt = `Grade the predicted answer against the reference for this question.

CORRECT: it contains the reference answer, allowing for different wording, extra detail, or a more or
less precise form of the same fact. Hedging is fine if the answer is there.
INCORRECT: it contradicts the reference or names something else.
NOT_ATTEMPTED: it declines, says it does not know, or gives no answer.

Question: ${question}
Reference: ${reference}
Predicted: ${answer}

Reply with exactly one word: CORRECT, INCORRECT or NOT_ATTEMPTED.`;
  const res = await fetch('https://nano-gpt.com/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: GRADER, max_tokens: 10, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) return 'ERROR';
  const body = await res.json();
  const word = String(body.choices?.[0]?.message?.content ?? '').toUpperCase();
  if (word.includes('NOT_ATTEMPTED') || word.includes('NOT ATTEMPTED')) return 'NOT_ATTEMPTED';
  if (word.includes('INCORRECT')) return 'INCORRECT';
  if (word.includes('CORRECT')) return 'CORRECT';
  return 'ERROR';
}

const ARMS = { 'model-only': modelOnly, 'search-raw': searchRaw, judged };

const rows = sample(parseCsv(readFileSync('bench/data/simpleqa.csv', 'utf8')), N);
console.error(`${rows.length} questions, ${Object.keys(ARMS).length} arms, concurrency ${CONCURRENCY}`);

const results = [];
let done = 0;
async function work(row) {
  for (const [name, fn] of Object.entries(ARMS)) {
    const started = Date.now();
    let out;
    try { out = await fn(row.problem); }
    catch (error) { out = { arm: name, answer: '', refused: false, error: error.message, cost: 0 }; }
    const verdict = out.error ? 'ERROR' : await grade(row.problem, row.answer, out.answer);
    results.push({ arm: name, question: row.problem, reference: row.answer, ...out,
                   verdict, totalMs: Date.now() - started });
  }
  done++;
  if (done % 10 === 0) console.error(`  ...${done}/${rows.length}`);
}

for (let i = 0; i < rows.length; i += CONCURRENCY) {
  await Promise.all(rows.slice(i, i + CONCURRENCY).map(work));
}

mkdirSync('bench/out', { recursive: true });
writeFileSync('bench/out/results.json', JSON.stringify(results, null, 1));

const harmonic = (a, b) => (a + b ? (2 * a * b) / (a + b) : 0);
const report = [];
for (const arm of Object.keys(ARMS)) {
  const rs = results.filter((r) => r.arm === arm && r.verdict !== 'ERROR');
  const n = rs.length;
  const correct = rs.filter((r) => r.verdict === 'CORRECT').length;
  const incorrect = rs.filter((r) => r.verdict === 'INCORRECT').length;
  const notAttempted = rs.filter((r) => r.verdict === 'NOT_ATTEMPTED').length;
  const attempted = correct + incorrect;
  const overall = n ? correct / n : 0;
  const givenAttempted = attempted ? correct / attempted : 0;
  const latencies = rs.map((r) => r.totalMs).sort((a, b) => a - b);
  report.push({
    arm, n, correct, incorrect, notAttempted,
    overall_accuracy: +(overall * 100).toFixed(1),
    accuracy_given_attempted: +(givenAttempted * 100).toFixed(1),
    f_score: +(harmonic(overall, givenAttempted) * 100).toFixed(1),
    confident_wrong_rate: +((incorrect / (n || 1)) * 100).toFixed(1),
    cost_per_query: +(rs.reduce((s, r) => s + (r.cost || 0), 0) / (n || 1)).toFixed(6),
    p50_ms: latencies[Math.floor(n / 2)] ?? 0,
    p95_ms: latencies[Math.floor(n * 0.95)] ?? 0,
  });
}
writeFileSync('bench/out/report.json', JSON.stringify(report, null, 1));

console.log('\narm          n   corr  incorr  n/att   F     conf-wrong   $/query    p50     p95');
for (const r of report) {
  console.log(`${r.arm.padEnd(12)} ${String(r.n).padStart(3)}  ${String(r.correct).padStart(4)}  ${String(r.incorrect).padStart(6)}  ${String(r.notAttempted).padStart(5)}  ${String(r.f_score).padStart(4)}  ${String(r.confident_wrong_rate).padStart(9)}%  ${r.cost_per_query.toFixed(6)}  ${String(r.p50_ms).padStart(5)}  ${String(r.p95_ms).padStart(5)}`);
}
