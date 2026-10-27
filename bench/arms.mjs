// The three arms under test.
//
//   model-only   a generative model answers from what it already knows. No search.
//   search-raw   retrieve, then a generative model reads the candidates and answers. This is what a
//                plain search API plus an LLM gets you, and it never refuses.
//   judged       retrieve, propose candidate answers, then Jev CHOOSES among them against a
//                __none__ sentinel and a confidence floor. This is our product.
//
// The judged arm respects what Jev is: it selects, it cannot generate. So generation proposes the
// candidate answer spans and Jev decides which one the evidence actually supports, or none. That
// division - generate the options, select among them - is the pattern the whole project rests on.

import { retrieve } from './retrieval.mjs';

const KEY = process.env.NANO_API_KEY;
const GEN = process.env.GEN_MODEL || 'deepseek/deepseek-v4-flash';
const DECISIONS = 'https://nano-gpt.com/api/v1/systemone';
const CHAT = 'https://nano-gpt.com/api/v1/chat/completions';
export const NONE = '__none__';

async function chat(prompt, maxTokens = 600) {
  const res = await fetch(CHAT, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: GEN, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`gen ${res.status}: ${text.slice(0, 120)}`);
  const body = JSON.parse(text);
  return { text: body.choices?.[0]?.message?.content ?? '', cost: body.usage?.cost ?? 0 };
}

async function decide(body) {
  const started = Date.now();
  const res = await fetch(DECISIONS, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'typesafe/jev-latest', ...body }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`jev ${res.status}: ${text.slice(0, 120)}`);
  return { ...JSON.parse(text), ms: Date.now() - started };
}

const clean = (s) => String(s || '').trim().replace(/^["'\s]+|["'\s.]+$/g, '').slice(0, 120);

export async function modelOnly(question) {
  const { text, cost } = await chat(
    `Answer with the shortest possible factual answer - a name, date, number or title. Nothing else.\n\nQ: ${question}\nA:`, 60);
  return { arm: 'model-only', answer: clean(text), refused: false, cost, candidates: 0 };
}

export async function searchRaw(question, opts) {
  const { candidates, ms } = await retrieve(question, opts);
  if (!candidates.length) return { arm: 'search-raw', answer: '', refused: false, cost: 0, candidates: 0, retrievalMs: ms };
  const context = candidates.map((c, i) => `[${i + 1}] ${c.title}: ${c.text}`).join('\n\n');
  const { text, cost } = await chat(
    `Using the sources, answer with the shortest possible factual answer - a name, date, number or title. Nothing else.\n\n${context}\n\nQ: ${question}\nA:`, 60);
  return { arm: 'search-raw', answer: clean(text), refused: false, cost, candidates: candidates.length, retrievalMs: ms };
}

/**
 * Our arm. Generation proposes; Jev selects or refuses.
 *
 * `floor` is the calibrated confidence below which we decline to answer. Everything the project has
 * measured says this is where the value is: a refusal costs a missing answer, a wrong answer costs
 * the caller's credibility.
 */
export async function judged(question, { floor = 0.55, ...opts } = {}) {
  const { candidates, ms } = await retrieve(question, opts);
  if (!candidates.length) {
    return { arm: 'judged', answer: '', refused: true, reason: 'nothing retrieved', cost: 0, candidates: 0, retrievalMs: ms };
  }

  // Propose one candidate answer per source. Code never invents an option; the model that can
  // generate does that, and each option stays tied to the source it came from.
  const context = candidates.map((c, i) => `[${i + 1}] ${c.title}: ${c.text}`).join('\n\n');
  const { text: proposalText, cost: genCost } = await chat(
    `For each numbered source, give the shortest factual answer that source supports for the question, or the word NONE if that source does not answer it.

Reply as one line per source: <number>|<answer or NONE>

${context}

Question: ${question}`, 400);

  const proposals = new Map();
  for (const line of proposalText.split('\n')) {
    const m = line.match(/^\s*\[?(\d+)\]?\s*[|:.\-]\s*(.+)$/);
    if (!m) continue;
    const value = clean(m[2]);
    if (!value || /^none$/i.test(value)) continue;
    const source = candidates[Number(m[1]) - 1];
    if (source) proposals.set(value.toLowerCase(), { value, source });
  }

  if (!proposals.size) {
    return { arm: 'judged', answer: '', refused: true, reason: 'no source proposed an answer',
             cost: genCost, candidates: candidates.length, retrievalMs: ms };
  }

  // One batched decision over the proposed answers plus the sentinel.
  const options = [...proposals.values()];
  const criteria = Object.fromEntries(options.map((o, i) => [`a${i}`,
    `"${o.value}" - supported by ${o.source.title}`]));
  criteria[NONE] = 'The sources do not support any of these answers.';

  const verdict = await decide({
    state: candidates.map((c, i) => `[${i + 1}] ${c.title}: ${c.text}`),
    questions: {
      answer: { type: 'choice', instructions: `Which answer do these sources actually support for: "${question}"?`, criteria },
      grounded: { type: 'noul', instructions: `Do these sources contain the answer to: "${question}"?` },
    },
  });

  const picked = verdict.answers?.answer;
  const jevCost = verdict.usage?.cost ?? 0;
  const cost = genCost + jevCost;
  const base = { arm: 'judged', cost, candidates: candidates.length, retrievalMs: ms,
                 jevMs: verdict.ms, grounded: verdict.answers?.grounded?.noul ?? null };

  if (!picked) return { ...base, answer: '', refused: true, reason: 'no verdict' };
  if (picked.choice === NONE) {
    return { ...base, answer: '', refused: true, reason: 'sources support no answer', confidence: picked.confidence };
  }
  if (typeof picked.confidence === 'number' && picked.confidence < floor) {
    return { ...base, answer: '', refused: true,
             reason: `confidence ${picked.confidence.toFixed(2)} below ${floor}`, confidence: picked.confidence };
  }
  const chosen = options[Number(String(picked.choice).replace('a', ''))];
  if (!chosen) return { ...base, answer: '', refused: true, reason: 'chose an option that is not on the list' };
  return { ...base, answer: chosen.value, refused: false, confidence: picked.confidence, source: chosen.source.url };
}
