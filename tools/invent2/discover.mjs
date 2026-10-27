// Discover the two axes instead of hardcoding them.
//
//   NANO_API_KEY=... node tools/invent2/discover.mjs <a-rounds> <b-rounds>
//
// Round one used 20 tools and 60 domains that I wrote down myself, which caps the search at my own
// imagination and bakes my assumptions into every result. Here both axes are generated, described
// by SHAPE rather than by example, accumulated across rounds and deduplicated. Nothing about which
// tools or which industries is fixed in this file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const KEY = process.env.NANO_API_KEY || process.env.JEV_API_KEY;
if (!KEY) { console.error('set NANO_API_KEY'); process.exit(2); }
const MODEL = process.env.INVENT_MODEL || 'deepseek/deepseek-v4-flash';
const B_ROUNDS = Number(process.argv[2] || 6);
const PATH = '.ledger/invent2/axes.json';

const B_SHAPE = `B is a task in the WEB SEARCH API category that is expensive TODAY because a person
must read what a search returned and judge it.

Stay strictly inside this category. The product is something a developer calls over an API to search
the live web, or to do something with what a web search came back with. Everything that follows must
sit in that lane: if an idea would make sense without the web being involved, it is out of scope.

Today's search APIs return links, snippets and relevance scores. They do not judge. So the expensive
human work sits in everything that happens after the results arrive: deciding which results actually
answer the question, noticing that the top result is search-engine spam or an AI-written content farm,
spotting that a page is three years stale when the question needs this month, telling apart a primary
source from someone quoting it, catching that two results are the same story syndicated twice, judging
whether a page really supports the sentence that cited it, deciding when the search should be run again
with different words, and knowing when the honest answer is that the web does not say.

Who pays: the people building on search. Developers and teams wiring web search into AI assistants,
agents, research tools, monitoring and enrichment pipelines, and the people who then have to check
that output by hand because the search layer could not.

Each entry must name who does the work today, roughly what it costs them, and why anyone building on
web search hits it.

Exclude searching a company's own private documents - that is retrieval over internal data, not the
web. Exclude crawling and scraping infrastructure, proxies and anti-bot work. Exclude ranking research
that needs a search index nobody outside Google or Bing has.

Score each task for DEMAND, 0-100, meaning how many organisations do this job and how often:

  90-100  almost every organisation, every day
  70-89   most organisations in many industries, regularly
  50-69   common in one large industry, or occasional across many
  30-49   a specialist job done by a minority
  0-29    niche

Judge breadth only, not how valuable or interesting it is. Be honest and use the whole scale: a task
you had to name an industry to describe is not a 90.

Return JSON only: {"tasks":[{"task":"the task","why_expensive":"who does it and what it costs",
"sector":"the industry","demand":<0-100>}]}`;

async function chat(prompt, maxTokens = 5000) {
  const res = await fetch('https://nano-gpt.com/api/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(240000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text).choices?.[0]?.message?.content ?? '';
}

function firstJson(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('no JSON');
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('unbalanced JSON');
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
mkdirSync('.ledger/invent2', { recursive: true });
const axes = existsSync(PATH) ? JSON.parse(readFileSync(PATH, 'utf8')) : { tasks: [] };

/** Ask for more, telling the model only what it already produced so it does not repeat itself. */
async function harvest(shape, key, field, count, rounds) {
  for (let r = 0; r < rounds; r++) {
    const have = axes[key].map((x) => x[field]);
    const avoid = have.length ? `\n\nAlready collected, so return none of these and nothing that is
merely a rewording of them:\n${have.join('; ')}` : '';
    try {
      const out = firstJson(await chat(`${shape}\n\nReturn ${count} entries.${avoid}`));
      const list = out[key] || [];
      const seen = new Set(have.map(norm));
      let added = 0;
      for (const item of list) {
        const id = norm(item[field]);
        if (!id || seen.has(id)) continue;
        seen.add(id); axes[key].push(item); added++;
      }
      console.error(`  ${key} round ${r + 1}: +${added} (${axes[key].length} total)`);
    } catch (error) {
      console.error(`  ${key} round ${r + 1} failed: ${error.message}`);
    }
    writeFileSync(PATH, JSON.stringify(axes, null, 1));
  }
}

// Only the task axis is discovered. There is deliberately no list of old tools: handing the model a
// fixed roster of tools capped the search at whatever was in that roster, and a list discovered once
// and then reused is static in every way that matters. The generator is told what SHAPE of tool to
// reach for and chooses one itself, each time.
await harvest(B_SHAPE, 'tasks', 'task', 30, B_ROUNDS);
console.log(`${axes.tasks.length} tasks discovered`);
