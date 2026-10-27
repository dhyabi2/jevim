# Plan: competing head-on as a web search API

**Constraint set by the owner: we compete in this category directly. Not a layer sold to the
incumbents, not a component inside someone else's product. A search API that developers call instead
of calling theirs.**

## Correcting the premise I had wrong

I previously argued that having no index was decisive and that we should sell a verification layer
instead. That reasoning does not hold. SerpAPI and Serper own no index - they read Google's result
pages. Tavily owns no index - it is a layer over other people's retrieval, and is being acquired.
Only Brave and Exa actually own crawls.

So in this category, competing without an index is the normal case. The index is not the moat. Price
and result quality are, and both are reachable.

## What the product is

A drop-in web search API. Same request shape as the one the caller is already using, so migration is
changing a base URL and a key - not a rewrite. Same response shape too, with our additions in extra
fields that an existing client can ignore.

Underneath, three stages:

1. **Fan out.** Query two or three upstream providers in parallel behind one adapter. Nobody's
   ranking is trusted; their results are candidates, not answers.
2. **Judge in one call.** All candidates go into a single batched decision: which actually answer the
   query, which are search-engine spam or AI content farms, which are the same story syndicated
   twice, which is the primary source rather than someone quoting it, which is too stale for a
   question about this month, and whether the query names the entity the results are about.
3. **Answer honestly.** Return results ordered by judged support with a calibrated confidence on each
   - and when nothing answers it, say so instead of returning the best of a bad set.

## Why this beats them on their own terms

**Price.** Parallel sells retrieval at $1 per 1,000. One batched judgement over ~40 candidates costs
$0.0002 because Jev charges $0.042 per million input tokens and nothing for output. So a judged
search is around **$0.0012**, against Tavily at $0.008 per query and SerpAPI at $3.75-7.25 per 1,000.
We can be several times cheaper *and* judged. That is not a positioning claim, it is arithmetic on
published prices.

**The answer they cannot give.** Every one of them returns the top *n* by construction. None can say
"the web does not answer this." Measured here: 5 of 5 correct refusals with **zero false fires**. For
anyone building an agent, a wrong-but-confident result is far more expensive than no result, because
it propagates into an answer a user believes.

**Free repeats.** A judgement cached against a stable fingerprint replays at zero cost and zero
network - already verified by law in this repo. Agents re-ask the same questions constantly; per-query
pricing cannot follow us down.

**Staleness.** We fingerprint what we judged, so we can say a result's verdict is no longer valid
because the page changed. A search result is a snapshot and nobody offers this.

## The battleground is a published number

This category competes on benchmarks. Linkup leads with 94% F-score on Verified SimpleQA. We have
8-15 case probes and no public number, and that - not features - is what currently disqualifies us.

So the benchmark comes before the product:

- Run **Verified SimpleQA and SimpleQA** ourselves, and report against the same metric the leaders
  publish, so the comparison is like for like.
- Report one metric nobody else foregrounds: the **confident-wrong rate** - answering with high
  confidence when the answer is not supported. That is the number our refusal should dominate, and it
  is the number that actually hurts an agent builder.
- Publish the harness and the per-question outputs, not only the score.
- Measure latency at p50 and p95 including the upstream fan-out. Sub-second is table stakes here and
  a fan-out plus a judgement call is our main latency risk.

If we cannot match the leaders on F-score while clearly beating them on confident-wrong rate and
price, we do not ship.

## Build order

1. **Harness and baselines first.** Verified SimpleQA and SimpleQA running against Brave, Parallel and
   Tavily as measured baselines, so every later number is comparable. Nothing else starts until this
   exists.
2. **Retrieval adapter.** One interface, several providers, parallel fan-out, per-provider cost and
   latency recorded on every call.
3. **Candidate index.** A result set becomes a judgeable index - url, title, snippet, published date,
   domain reputation signals, extracted passage - reusing the laundering, token budget and fingerprint
   machinery already built and verified for page elements.
4. **The judgement call.** One batched request: a Choice over candidates for which answers the query,
   the `__none__` sentinel for nothing does, Scores for staleness and primary-versus-secondary, Nouls
   for spam and content-farm detection. All of this is the existing resolver with different questions.
5. **Wire-compatible surface.** Match the request and response shape of the most-used incumbent so
   switching is a base URL, and put our extra fields alongside rather than replacing theirs.
6. **Cache and staleness.** Verdicts keyed by query hash plus candidate fingerprint; free on a hit;
   invalidated when the page fingerprint moves.
7. **Publish**: score, harness, per-question outputs, price and latency together.

## Cost per search, at the numbers we have

| | cost |
|---|---|
| upstream retrieval, one cheap provider | $0.001 |
| upstream fan-out, three providers | $0.003-0.009 |
| batched judgement over ~40 candidates | $0.0002 |
| **judged search, single provider** | **~$0.0012** |
| **judged search, three-provider fan-out** | **~$0.0092** |
| cached repeat | **$0** |

Fan-out is what threatens the price advantage. The eval has to answer whether two or three providers
actually beat one, because if one cheap provider plus judgement matches a fan-out, we are four times
cheaper than Tavily rather than level with it.

## What can kill this, stated now

- **F-score below the leaders.** If judging other people's candidates cannot match a purpose-built
  neural index, price and refusal will not save it. This is the main risk and the eval settles it.
- **Latency.** Fan-out plus a judgement call may not fit a sub-second budget. Type-ahead does not help
  here - there is no human typing. Mitigation is streaming first results while judgement completes,
  which weakens the refusal story because something has already been returned.
- **Upstream dependency.** We would resell providers who can reprice or cut us off; Brave has already
  retired its free tier. The adapter is the hedge and must exist from day one.
- **They add a confidence field.** Cheap for them to do. Our defence is calibration plus the cache
  plus staleness together, not the refusal alone.
- **Benchmark contamination.** SimpleQA is public and may sit in training data. Report a held-out set
  we build ourselves alongside the public number, or the number means nothing.

## Not in scope

No crawler, no index, no proxy or anti-bot infrastructure. We buy retrieval and compete on what is
returned. If the eval shows judged third-party candidates cannot reach the leaders' F-score, that is
the point to revisit - not something to engineer around first.
