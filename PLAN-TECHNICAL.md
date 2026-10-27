# Technical plan: beating browser-use on engineering merit

## Where we actually stand

browser-use independently built our substrate. Their DOM distillation - strip the page to interactive
elements, label them, hand the model a clean text representation - is our element index. They shipped
it to a large user base, a cloud product, and **97.0% on Online-Mind2Web**.

So the substrate is not the differentiator. Three properties are, all verified by law in this repo and
none present in theirs:

| property | ours, measured | theirs |
|---|---|---|
| calibrated refusal | 5/5 correct, **0 false fires** | an index-picking model always picks an index |
| stable element identity | fingerprints, proven identical across Chrome and headless | indices are per-snapshot |
| deterministic replay | **0 network calls**, verified | re-plans every run |

And two things are simply wrong with our implementation:

- **The collector is blind to shadow DOM and iframes.** Measured: 1 of 3 interactive elements found on
  a page with one shadow root. `collect.js` uses `doc.querySelectorAll`, which stops at every shadow
  boundary and every frame. On component-based apps and any page with an embedded payment or auth
  frame, we index a fraction of the page and then resolve confidently against it.
- **Headless fidelity is bad.** jsdom never fetches stylesheets, so wikipedia.org yielded 383 elements
  against Chrome's 32. Geometry is most of the pruning power, so our own headless numbers cannot be
  trusted.

**Winning technically means: close their capability advantages, keep our three properties, and prove
it on their benchmark plus two metrics they do not publish.**

---

## Phase 0 - stop being wrong

Nothing else counts until this is done, because every measurement taken on a partial index is void.

### 0.1 Pierce every boundary

Two paths, because the extension and the headless runtime have different powers.

**Extension (content script).** Replace `doc.querySelectorAll` with a recursive walk that descends
into `element.shadowRoot` and into same-origin `iframe.contentDocument`. Carry the boundary into the
fingerprint's ancestry so an element inside a shadow root cannot collide with one outside it. This
reaches open shadow roots and same-origin frames - everything a page script is allowed to see.

**Headless and CI.** Drive real Chrome over CDP. `DOM.getDocument` with `pierce: true` returns closed
shadow roots and cross-origin frames, which a page script can never reach. One change closes four
gaps at once: open shadow, closed shadow, cross-origin frames, and real geometry.

*Law: every interactive element inside an open shadow root, a closed shadow root and a nested
same-origin frame appears in the index, each with a distinct fingerprint.*

### 0.2 Take the accessible name from Chrome, not from us

`accname.js` is our hand-rolled approximation of the accessible-name spec. Chrome already computes the
real thing. `Accessibility.getFullAXTree` over CDP gives computed roles and names, pierces shadow DOM
natively, and excludes what assistive technology would not see.

This is a strictly better substrate than DOM distillation: browser-use approximates semantics from the
DOM, while the AX tree *is* the semantics, computed by the engine. Keep the DOM walk as the extension
fallback and use the AX tree wherever CDP is available.

*Law: for a page with aria-labelledby, a label element and an aria-hidden subtree, our index matches
Chrome's own accessibility tree on role and name for every entry.*

### 0.3 Replace jsdom in the headless path

`server/page.mjs` becomes a CDP driver. Real layout, real stylesheets, real visibility. The synthetic
rect generator goes. The 383-versus-32 gap should close to near zero, and that closure is the test.

*Law: the headless index of a page differs from the same page's index in the extension by no more than
a stated tolerance.*

---

## Phase 1 - recover like they do, without losing determinism

Their loop re-observes and re-plans when the page is not what it expected. Our macro breaks. The
mechanism to close this is already specified and brainstormed: **repair the broken token, not the
plan.** On a `stale`, take the stored fingerprint's own parts, pull candidates from the current index
that match the stored role, send only those to one Choice with the existence sentinel, rebind that one
step, resume.

An agent re-plans the whole task; we re-bind a single leaf. One call on the one step that failed.

Constraint kept from the brainstorm: a repair that changes the element's role is not a repair.

*Law: a script whose target was renamed repairs that step and completes, and the repaired script is
written back pinned.*

---

## Phase 2 - multi-step, emitting an artifact

Match their autonomy on our terms. A plan is generated once by a generative model, executed under the
gate, and compiled into a fingerprint-pinned script that thereafter replays with zero model calls.

They plan on every run. We plan once and execute deterministically forever after. The artifact is the
product: reviewable text, diffable, and free to re-run.

Everything needed exists - `artifact.js`, the macro recorder, the binding store, the generator - so
this is wiring plus the screen that stops a generated step running unreviewed when it carries a
destructive verb.

*Law: every multi-step run leaves a pinned artifact that replays to an identical trace with zero
network calls.*

---

## Phase 3 - vision, at authoring time only

The last capability they have that we do not: canvas, and DOM that carries no semantics.

Use a vision model **once**, at authoring time, to identify the element; map what it found to a
fingerprint; cache it. The hot path stays DOM-only, so latency and determinism are untouched. This was
deferred twice as too expensive and is not: `deepseek-v4.1-flash` carries vision at $0.13 per million
input tokens.

*Law: an element identified only by vision is stored as a fingerprint and replays thereafter without a
vision call.*

---

## Phase 4 - hardening for pages that fight back

The unglamorous list that decides whether any of this survives a real application:

- **Virtualised and infinite lists.** Elements do not exist until scrolled into view. The index needs a
  scroll-and-extend pass with a bound, and the gate must treat "scrolled out of existence" separately
  from "removed".
- **Dynamic settle.** Replace the lazy dirty flag with a real quiescence signal - no DOM mutations and
  no in-flight requests for a short window - because an index built mid-render is a stale index.
- **Multiple tabs and windows.** A click that opens a tab currently loses the session.
- **Native dialogs.** `alert`, `confirm` and the file picker block everything; they must be intercepted
  before they are triggered, not after.
- **Downloads and uploads.** Both are ordinary steps in real workflows and neither is handled.
- **Authenticated state.** Cookies and storage need to survive a replay, or every script starts at a
  login wall.

*Law: a recorded script that scrolls a virtualised list, opens a second tab and dismisses a dialog
replays identically.*

---

## Phase 5 - prove it, on their benchmark and two of ours

A technical claim is worth nothing here without numbers, and they hold the number that exists.

1. **Online-Mind2Web**, the set they lead at 97.0%. With phases 1 and 2 done, attempt task success on
   the same set so the comparison is like for like.
2. **Per-step wrong-element rate.** Of the steps where an action was taken, how often was it the wrong
   element. They have no abstention, so every uncertain step becomes an action; ours becomes a refusal.
   This is the metric our architecture should dominate and nobody publishes it.
3. **Abstention precision and recall.** How often a refusal was correct, and how often we refused when
   the target was in fact present. The second number is the one that decides whether refusal is a
   feature or a nuisance - measured on our own probes it was 0 false refusals out of 10, on a sample
   far too small to publish.
4. **Replay stability across real site change.** Wayback snapshots of 20 sites months apart: record on
   the old, replay on the new, count surviving interactions against CSS selectors as the control.
   Nobody benchmarks this. It is also the single experiment that validates the fingerprint claim
   underneath everything above.
5. **Latency and cost per action**, p50 and p95, against their per-step model call.

---

## Progress

| phase | state |
|---|---|
| 0.1 pierce shadow roots and same-origin frames | **done**, law L9 |
| 0.2 accessible name from Chrome's AX tree | **done**, law L15 - 33 elements against Chrome's 32 where jsdom said 383 |
| 0.3 replace jsdom on the headless path | **done** - `server/cdp-session.mjs`; closed shadow roots and frames both reached |
| 5.4 fingerprints against CSS selectors | **done** - 93.5% against 57.0%, law L13 |
| 1 bind-time repair | **done**, law L10 |
| 2 multi-step compiled to an artifact | **done**, law L11 |
| 4 hardening: quiescence and virtualised lists | **done**, law L12 |
| 4 hardening: dialogs, tabs, uploads, downloads, auth | **done** in code, laws L16-L19; `bench/phase4-law.mjs` replays a virtualised list, a second tab and a dialog identically. Ledger: block 10 failed verification, 11 pending |
| L0 promotion (the annealing itself) | **done**, law L14 - it had never been wired; the second run of a motion was still paying |
| 3 vision at authoring time | **done**, laws L20-L21; ledger block 12 pending. Against the real model a single look missed the canvas bar in 3 runs of 5; a second look at the region alone hit it in 4 of 4 |
| 5.0 closed-loop agent | **done**, laws L22-L23 - `server/agent.mjs`: closed action set, gated clicks, fingerprint-pinned log |
| 5.1 Online-Mind2Web, head to head | **done**, law L26 - see below; ahead on the primary metric, not significantly |
| 5.2 / 5.3 wrong-element rate, abstention | not measured on Mind2Web; the gate's refusals are counted in traces but no ground truth exists for the other agent |
| 5.4 replay | **done**, law L27 - parity on fidelity, ours model-free and twice as fast |
| 5.5 latency and cost | **done** - in the head-to-head below |

### Phase 5 result

The published 97.0% is browser-use's cloud model `bu-max`, graded by a Claude prompt that reads only the
final answer (github.com/browser-use/online-mind2web). It is not comparable to the Online-Mind2Web
leaderboard, where the paper's human labels give open-source browser-use 90/300. So the comparison run
here is like for like instead: open-source browser-use 0.13.10 and our agent, the same model
(deepseek-v4.1-flash), the same 25-step limit, judged blind by o4-mini with browser-use's own rubric
(lenient) and a WebJudge-style one (strict). Tuned on a 20-task dev split; reported once on a 60-task
held-out split, pre-registered in commit cce3043. Per-task data: `bench/results/h2h-test.json`.

| held-out, 60 tasks | ours + screenshot | ours, text | browser-use |
|---|---|---|---|
| strict (primary) | **31.7%** | 30.0% | 23.3% |
| lenient (their rubric) | 35.0% | 33.3% | **41.7%** |
| strict, on the task's site only | **28.3%** | 25.0% | 21.7% |
| runs that left the task's site | 9 | 10 | 34 |
| median tokens per task | **~42k** | ~42k | ~201k |
| median seconds per task | **108** | 96 | 164 |

Primary difference: paired sign test p=0.30 - ahead, not proven ahead. browser-use wins its own
answer-only rubric mostly with answers from other sites than the task's. Replay (dev tasks, each agent's
own mechanism, immediately after recording): same final page 14/18 ours, 15/20 browser-use; actions
landed 89.5% against 88.2%; ours made 0 model calls against 23, median 54 s against 125 s.

All three held-out runs are complete (per-task data in `bench/results/`):

| held-out run | agent | strict: ours vs browser-use | lenient | tokens per task |
|---|---|---|---|---|
| Online-Mind2Web, 60 tasks | as registered | **31.7%** vs 23.3% (p=0.30) | 35.0% vs **41.7%** | 42k vs 201k |
| Online-Mind2Web, 220 tasks | as registered | **29.5%** vs 28.2% (p=0.80) | 35.0% vs **48.2%** | 56k vs 202k |
| WebVoyager, 60 unseen tasks | after fixes | **50.0%** vs 36.7% (p=0.13) | 35.0% vs **40.0%** | 46k vs 145k |
| WebVoyager, 105 more unseen | after fixes + navigation retry | 44.8% vs 43.8% (p=1.0) | 29.5% vs **35.2%** | 54k vs 98k |
| **all 445 held-out tasks** | | 36.2% vs 32.4% (p=0.17) | 33.7% vs **43.1%** (p=0.001) | 24.5M vs 80.3M total |

Pooled over the 280 Online-Mind2Web tasks, strict is 30.0% against 27.1% (p=0.43): a tie. browser-use
leads its own answer-only rubric there, largely with answers from sites other than the task's (it left
the task's site in 136 of 220 runs, we did in 15); counting only work on the task's site, we lead on both
rubrics. The 13-point WebVoyager lead of the first 60 tasks did not replicate on 105 more (pre-registered
in a5418d0): 47 against 46. Over all 445 held-out tasks, strict success is a tie with a small, unproven
edge to us, and browser-use leads the answer-only rubric. What holds on every run is cost (3.3x fewer tokens
in total), speed, staying on the task's site, and model-free replay. More task success has to come from the
agent's planning and reasoning, not from infrastructure: the last run had no errors and no failed starts.

The start-page weakness (one run in six failed to load within 30 s) is fixed in a5418d0: 0 of 210 runs failed there.

## Order, and why

    Phase 0   correctness      nothing measured before this is valid
    Phase 5.4 fingerprints     the cheapest experiment, and it gates phases 1-3
    Phase 1   repair           closes their recovery advantage
    Phase 2   multi-step       closes their autonomy advantage
    Phase 4   hardening        decides whether it survives real applications
    Phase 3   vision           closes the last capability gap
    Phase 5   full measurement publish against their number and our two

Phase 5.4 is deliberately second. It costs an hour, needs no new architecture, and if fingerprints do
not survive redesigns better than selectors then phases 1, 2 and 3 are all built on sand - repair,
pinning and the vision cache every assume a stable identity.

---

## What would kill this

- **Fingerprints do not survive redesigns better than CSS selectors.** Then stable identity is not a
  property we have, and with it go repair, pinning, the cache and staleness. Everything reduces to a
  slightly cheaper element picker.
- **Abstention recall is poor on a real benchmark.** If we refuse often when the target is present,
  refusal is a nuisance and the one metric we lead becomes the reason nobody uses it.
- **The AX tree is not enough for real apps.** If too many components are unlabelled, Chrome's
  semantics are as thin as our approximation and vision stops being an edge case.
- **Task success stays far below 97% even after phases 1 and 2.** Determinism does not sell if the
  thing determinstically fails.

## Explicitly out of scope

No crawler, no proxy or anti-bot work, no CAPTCHA handling, no index. No attempt to beat them at
open-ended autonomous browsing, which is their architecture's strength and not ours. We match the
capability surface only as far as is needed to hold the three properties they cannot.
