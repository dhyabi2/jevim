# Vend API and cost

Jevim's browser agent is open source (this repo, MIT) and runs on your own machine through the Hermes plugin. It is
also offered as a hosted, pay-per-call service settled in **Nano (XNO)** through Vend's x402 paywall, for agents that
cannot run Chrome. Both come from the same code. The hosted API needs no change for the Hermes list submission: the
source it runs is here.

## What one browser run costs

| way to run it | you pay | measured |
| --- | --- | --- |
| **Hermes plugin (this repo)** | only your model tokens | **$0.0003 to $0.0004 (about 0.001 XNO) for a simple 1 to 3 step task**, 7 to 10 s, on a 2 vCPU box, 2026-10-27 |
| **Hosted, x402 in XNO** | **0.05 XNO per run**, flat | price in `.env.example`, set by the operator |
| **Replay of a pinned script** | **$0** (no model call) | `jevim_test_run`: 0 network calls, deterministic |
| One element grounded (L1) | $0.000077 | per action |
| One page survey | $0.0002 | one call |

Why it is cheap: the agent sends the model a compact element index (a page of 231 elements was **2,579 tokens**)
instead of a screenshot-and-DOM dump, and a finished run becomes a script that replays with no model at all.

### Against browser-use, same tasks, same judge

Head-to-head, 325 real tasks (`bench/h2h`, results in `bench/results/*.txt`; the task sets are downloaded by
`bench/h2h`, not redistributed here):

| benchmark | tokens per task, Jevim (median) | browser-use (median) | fewer tokens | strict success, Jevim vs browser-use |
| --- | --- | --- | --- | --- |
| WebVoyager, 105 tasks | 53,871 | 98,197 | **1.8x** | 44.8% vs 43.8% |
| Online-Mind2Web, 220 tasks | 55,946 | 202,123 | **3.6x** | 29.5% vs 28.2% |

Success rates are statistically level (paired sign test p = 0.80 strict on Mind2Web); the claim is the cost, not
accuracy. Cost scales with tokens, so a run costs roughly a half to a quarter as much.

## Hosted endpoints (Vend, MIT: https://github.com/dhyabi2/vend)

All settle in XNO over x402: call, receive HTTP 402 with the price and pay-to address, send the Nano block, retry with
the block hash. No signup, no key. Prices in XNO per call, read from Vend's source (`VEND_PRICE_*`).

| endpoint | price | what it does |
| --- | --- | --- |
| `GET /api/v1/browser-agent?task=&website=` | 0.05 | **this repo's browser agent**; returns a job id |
| `GET /api/v1/browser-agent/jobs/{id}` | free | status, steps, answer |
| `GET /api/v1/browser-agent/jobs/{id}/events` | free | live server-sent events |
| `GET /api/v1/extract?url=` | 0.0001 | clean text or markdown of a page |
| `GET /api/v1/check-link?url=` | 0.0001 | status, timing, redirect chain |
| `GET /api/v1/status?url=` | 0.0001 | status, redirects, TLS expiry, drift |
| `GET /api/v1/links?url=` | 0.0001 | every anchor as JSON |
| `GET /api/v1/select?url=&selector=` | 0.0001 | CSS-selector field extraction |
| `GET /api/v1/web-search?q=` | 0.0001 | web search |
| `GET /api/v1/geoip?ip=` | 0.0001 | IP geolocation |
| `GET /api/v1/arxiv-paper?arxiv_id=` | 0.0001 | arXiv metadata |
| `GET /api/v1/domain-info?domain=` | 0.0005 | DNS, WHOIS, SSL, headers |
| `GET /api/v1/youtube-transcript?url=` | 0.0005 | captions with timestamps |
| `GET /api/v1/nano-info?account=` | 0.0005 | Nano account intelligence |
| `GET /api/v1/pdf-extract?url=` | 0.0005 | page-structured PDF text |
| `GET /api/v1/ai-jobs?q=` | 0.0002 | live AI job postings |

The remaining Vend endpoints (screenshot, render, meta, table, batch-status, mcp-find, wiki-summary,
hn-news, address-verdict) are listed with their prices in the Vend repo's README and at `/.well-known/x402` of the
hosted service. The hosted base URL is `https://extract.paypercall.dev`.

## Payout address

Payment goes to whatever you set in `NANO_AGENT_ACCOUNT` (a `nano_...` address; never a seed). The gateway in
`vend-gateway/` refuses to start without a valid one, so no address is baked into the code. To run your own paid
instance: copy `.env.example`, set `NANO_AGENT_ACCOUNT`, `VEND_DIR` (a checkout of dhyabi2/vend) and
`JEVIM_AGENT_URL`, then follow `vend-gateway/README.md`.
