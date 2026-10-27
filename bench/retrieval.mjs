// Retrieval behind one interface, so the source is a config change rather than a rebuild.
//
// Wikipedia is the only provider wired live, because it is the only one with an open, permitted API
// and no key. DuckDuckGo was tested and rejected: it publishes no web-results API, and both
// html.duckduckgo.com and lite.duckduckgo.com answer 202 with a "select all squares containing a
// duck" CAPTCHA. Building a paid product on a scraped, challenged endpoint is not an option.
//
// Brave, Parallel and Tavily are written but inert until a key is present. They are how the real
// baseline gets measured; Wikipedia is how the pipeline gets measured today.

const UA = 'jevim-bench/0.1 (benchmark harness; contact: dhyabi@gmail.com)';

/** A provider returns `[{ url, title, text }]` - candidate passages, not answers. */
export const PROVIDERS = {
  /** MediaWiki search plus extracts. Open API, no key, permitted for this use. */
  async wikipedia(query, { limit = 5 } = {}) {
    const search = new URL('https://en.wikipedia.org/w/api.php');
    search.search = new URLSearchParams({
      action: 'query', list: 'search', srsearch: query, srlimit: String(limit),
      format: 'json', origin: '*',
    });
    const found = await fetch(search, { headers: { 'user-agent': UA } }).then((r) => r.json());
    const titles = (found.query?.search || []).map((s) => s.title);
    if (!titles.length) return [];

    const extract = new URL('https://en.wikipedia.org/w/api.php');
    extract.search = new URLSearchParams({
      action: 'query', prop: 'extracts', exintro: '1', explaintext: '1',
      titles: titles.join('|'), format: 'json', origin: '*',
    });
    const pages = await fetch(extract, { headers: { 'user-agent': UA } }).then((r) => r.json());
    return Object.values(pages.query?.pages || {})
      .filter((p) => p.extract)
      .map((p) => ({
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
        title: p.title,
        text: String(p.extract).slice(0, 1200),
      }));
  },

  async brave(query, { limit = 5 } = {}) {
    const key = process.env.BRAVE_API_KEY;
    if (!key) throw new Error('BRAVE_API_KEY not set');
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.search = new URLSearchParams({ q: query, count: String(limit) });
    const res = await fetch(url, { headers: { 'x-subscription-token': key, accept: 'application/json' } });
    const body = await res.json();
    return (body.web?.results || []).map((r) => ({ url: r.url, title: r.title, text: r.description || '' }));
  },

  async tavily(query, { limit = 5 } = {}) {
    const key = process.env.TAVILY_API_KEY;
    if (!key) throw new Error('TAVILY_API_KEY not set');
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: limit }),
    });
    const body = await res.json();
    return (body.results || []).map((r) => ({ url: r.url, title: r.title, text: r.content || '' }));
  },
};

export function available() {
  return ['wikipedia',
    ...(process.env.BRAVE_API_KEY ? ['brave'] : []),
    ...(process.env.TAVILY_API_KEY ? ['tavily'] : [])];
}

/** Fan out across providers and concatenate. One provider is the cheap case; several is the test. */
export async function retrieve(query, { providers = ['wikipedia'], limit = 5 } = {}) {
  const started = Date.now();
  const batches = await Promise.all(providers.map(async (name) => {
    try { return await PROVIDERS[name](query, { limit }); }
    catch { return []; }
  }));
  const seen = new Set();
  const candidates = [];
  for (const batch of batches) {
    for (const c of batch) {
      if (!c.text || seen.has(c.url)) continue;
      seen.add(c.url);
      candidates.push(c);
    }
  }
  return { candidates, ms: Date.now() - started };
}
