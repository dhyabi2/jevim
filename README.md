# Jevim

**One core, six APIs.** A web page is reduced to an index of visible interactive elements, each
addressed by a stable fingerprint. A decision model picks which element a stated intent means,
with a calibrated confidence and the ability to refuse. A generative model authors sequences.
Code executes, gates and replays them for free.

The thing this sells is the **artifact**: a fingerprint-addressed motion script that AI wrote
once, that replays with no model at all, that refuses when the page changed, and that a person
can read and diff in review.

## Use it from Hermes (plugin, runs locally, open source)

    hermes plugins install dhyabi2/jevim
    export NANO_API_KEY=<any nano-gpt key>      # model tiers; jevim_index and jevim_test_run need none

**Free for any agent. One ask:** the agent reads THE CANON ([canon/THE-CANON.md](canon/THE-CANON.md), pinned by
sha256 `c806d4ef...fb41`), calls `jevim_canon_confirm` with the five short-form lines in its own words, and gets back a
confirmation and a receipt hash; after that every tool is free. The acknowledgement is stored locally and sent nowhere.

Ten tools in one plugin (two for the Canon, eight for the browser): `jevim_browse` (autonomous browser agent in real Chrome), `jevim_index`, `jevim_ground`,
`jevim_form_fill`, `jevim_survey`, `jevim_script_author`, `jevim_script_run`, `jevim_test_run`, plus a
`jevim-browser` skill. Nothing calls a hosted service: the plugin starts this repo's own servers on `127.0.0.1`
(private and local addresses are refused). Needs Node 20+, and Chrome for `jevim_browse`.
**Cost: about $0.0004 (0.001 XNO) for a simple run, 1.8x to 3.6x fewer tokens than browser-use on the same tasks,
$0 to replay a finished script.** Numbers, the hosted pay-per-call API (0.05 XNO per run, settled in Nano) and every
endpoint are in [VEND.md](VEND.md). Licence: MIT.

## Why these three tiers

| tier | what it is | when it runs | cost |
| --- | --- | --- | --- |
| **L0** code | execute, gate, count, replay | always | **$0** |
| **L1** [Jev](https://typesafe.ai) | pick one element from an enumerated set, with confidence and a refusal | per action | **$0.000077** |
| **L2** flash | generate plans, scripts, predicates, prose | authoring only, once | ~$0.0002 |

Jev's only outputs are Choice, Score and Noul — it selects, it cannot generate. Vim's grammar is
the only mainstream UI grammar whose every slot is a finite enumeration. **Vim's grammar is
Jev's type signature**, which is why the model never has to invent an action, only choose a
target. The human types the verb, so a mistake can mis-aim but never invent.

The generative tier is deliberately kept out of the hot path: its latency and non-determinism
live at authoring time, which is acceptable only because what it produces is reviewable text.

## The six APIs

    npm install && npm test          # 82 tests, no network
    JEV_API_KEY=<nano-gpt key> npm run serve

| endpoint | use case | measured |
| --- | --- | --- |
| `POST /v1/ground` | agent grounding: intent → one element, or a refusal | 10/10 correct, **0 false fires** |
| `POST /v1/navigate/survey` | crawler brain: page kind, next page, consent wall, login, paywall — in **one** call | $0.0002, correct on HN |
| `POST /v1/form/fill` | fill a form from data you have; never mis-fills | 4/4 placed, card number correctly **refused** |
| `POST /v1/script/author` | describe a task → a motion script, generated then screened | 1.9 s, $0.0002 |
| `POST /v1/script/run` | replay a script; unpinned steps resolve once and come back pinned | 2 calls → pinned |
| `POST /v1/test/run` | the same replay read as a test verdict | **0 network calls, deterministic** |

Plus the interaction layer the rest is built on: `/v1/index`, `/v1/keys`, and `/v1/session` +
`/v1/session/key` for streaming keystrokes.

### The loop, end to end

```
POST /v1/script/author  {"url": "https://news.ycombinator.com",
                         "task": "open the newest stories, then open the jobs page"}
  -> goto  search:"new link"
     goto  search:"jobs link"                     1.9s, $0.0002, screened 0.81 / 0.87

POST /v1/script/run     {url, script}
  -> passed, networkCalls 2, both steps L1
     goto  search:"new link"   fp=1ac4we5  conf=0.97
     goto  search:"jobs link"  fp=19wbfn1  conf=1.00

POST /v1/test/run       {url, script: <the pinned one>}
  -> verdict pass, deterministic true, networkCalls 0, both steps L0
```

AI authors it once. It runs free forever. That is the whole product.

## Why type-ahead matters

A motion is typed `g` `/` `c`-`h`-`e`-`c`-`k`-`o`-`u`-`t` `⏎`. Typing takes 1.5–2.5 s; the
resolver takes 656 ms. The latency budget was always inside the user's own typing.

| | wait at `⏎` |
| --- | --- |
| no type-ahead | 656 ms on every motion |
| **streamed through `/v1/session/key`** | **10 ms median**, 7/10 under 50 ms, accuracy unchanged |

Answers stabilise far earlier than the query ends: "log in to my account" is decided at `log`.

## Safety, as mechanisms not intentions

- **The human types the verb.** The model only ever picks a target.
- **Sentinel abstention.** A `__none__` option inside the same Choice, so refusal lives in one
  calibrated distribution. 5/5 correct refusals on pages with no such element, 0 false fires.
- **Per-operator floors.** `goto` 0.45, `dismiss` 0.85. At confidence 0.80 `goto` acts and
  `dismiss` refuses.
- **The atomic fingerprint gate.** Identity is re-checked in the same tick as the action, after
  any confirmation prompt. A renamed, moved, hidden or removed target yields `stale`.
- **Hostile text is laundered** before it can reach a model: zero-width and bidi characters
  stripped, names truncated, aria-hidden and offscreen elements never indexed. Of six hostile
  shapes planted live, four never reached the index, one was flagged, one was truncated.
- **Generated scripts cannot invent a verb.** `artifact.parse` rejects anything outside the
  closed sets, and Jev screens each generated step against the stated intent.

## Layout matters more than it looks

On wikipedia.org the collector sees **32 elements in Chrome and 383 headless**, because jsdom
never fetches stylesheets. Geometry is most of the pruning power, so the extension is the
primary runtime and the headless API is for replay, testing and CI.

Fingerprints, by contrast, are layout-independent: a binding learned in Chrome resolved on a
server that never rendered the page, which is what makes a keymap shareable.

## Layout of the repo

    src/index/      DOM -> element index, laundering, fingerprints, the gate
    src/grammar/    the modal grammar, bindings, macros, the runner
    src/resolve/    prefilter, question building, transports, type-ahead
    src/generate/   the L2 generator, grammar-bounded and screened
    src/usecases/   ground, form, navigate, script
    src/artifact.js the motion-script format
    server/         the HTTP API
    ext/            Chrome MV3 extension (built: npm run build)
    .ledger/        laws, verifications and measured evidence

## Honest state

Built and verified: blocks 1–4 with **7 laws, all passing**, unwind clean, receipt chain intact.

**Not built:** block 5 (shadow promotion), block 6 (deep self-healing regeneration), the vision
tier for canvas and semantics-free DOMs.

**Unproven, and it decides the testing positioning:** whether fingerprints survive real site
change better than CSS selectors. The experiment is Wayback snapshots of the same sites months
apart — record on the old, replay on the new. Until that runs, the maintenance-reduction claim
is an argument, not a result.

Evaluation sets are 8–15 cases: probes, not benchmarks. Block 4's brainstorm is marked
provisional because the ideas came from chat models rather than the methodology engine, which
was down.
