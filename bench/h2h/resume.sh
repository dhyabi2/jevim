#!/bin/bash
# Finish every model-dependent step of Phase 5, unattended, once the model account has funds.
#
#   nohup bench/h2h/resume.sh > .ledger/tmp/resume.log 2>&1 &
#
# Each stage waits for the account to hold enough to finish it, re-queues any run that billing
# refusals, a suspend or a dead process spoiled (same rule for both agents), and commits its results.
# Every stage is resumable: re-running this script skips what is already done.
#
#   1. finish the second held-out Online-Mind2Web run (test2) with the agent as pre-registered
#   2. (merged already)
#   3. the delayed replay of the dev recordings, both agents
#   4. the pre-registered WebVoyager run (split wv)
#   5. mint the new laws and verify the ledger

set -u
cd "$(dirname "$0")/../.."
set -a; . "$HOME/.config/idea-machine/env"; set +a

MIN_USD="${MIN_USD:-5}"
log() { echo "[$(date '+%F %T')] $*"; }

balance() {
  curl -s -m 20 -X POST https://nano-gpt.com/api/check-balance -H "x-api-key: $NANO_API_KEY" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("usd_balance") or 0)' 2>/dev/null || echo 0
}

wait_funds() {
  while :; do
    b=$(balance)
    if python3 -c "import sys; sys.exit(0 if float('$b') >= float('$MIN_USD') else 1)"; then
      log "balance \$$b - proceeding"; return
    fi
    log "balance \$$b below \$$MIN_USD - waiting 10 min"; sleep 600
  done
}

# Run a split until no run is spoiled and every run is judged (at most 5 rounds).
finish_split() {
  local split=$1 agents=$2 dir="bench/out/h2h-$1"
  for round in 1 2 3 4 5; do
    wait_funds
    node bench/h2h/requeue.mjs "$dir" --apply 2>/dev/null
    log "$split round $round"
    node bench/h2h/run.mjs --split "$split" --agents "$agents" --parallel 5
    spoiled=$(node bench/h2h/requeue.mjs "$dir" | awk '/runs to re-run/ {print $1}')
    partial=$(node bench/h2h/requeue.mjs "$dir" | awk '/judgements with fewer/ {print $1}')
    unjudged=$(node bench/h2h/report.mjs "$dir" --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(sum(a["unjudged"] for a in d["agents"].values()))')
    log "$split after round $round: spoiled=$spoiled partial=$partial unjudged=$unjudged"
    if [ "${spoiled:-1}" = 0 ] && [ "${partial:-1}" = 0 ] && [ "${unjudged:-1}" = 0 ]; then return 0; fi
  done
  log "$split still incomplete after 5 rounds"; return 1
}

commit() { git add -f "$@" && git commit -q -m "$COMMIT_MSG" && log "committed: $(git log --oneline -1)"; }
ATTR=$'\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'

# 1. test2, with the agent exactly as pre-registered: the run executes in a checkout pinned to
#    4fd5257 (agent code unchanged since d580ea9), while its outputs stay in this repo's bench/out.
REGISTERED=4fd5257
PINNED="$HOME/work/jevim-registered"
if [ ! -f bench/results/h2h-test2.json ]; then
  if [ ! -d "$PINNED" ]; then git worktree add -q --detach "$PINNED" "$REGISTERED" && ln -s "$PWD/node_modules" "$PINNED/node_modules"; fi
  mkdir -p "$PINNED/bench/out" && ln -sfn "$PWD/bench/out/h2h-test2" "$PINNED/bench/out/h2h-test2"
  ln -sfn "$PWD/bench/data/mind2web" "$PINNED/bench/data/mind2web" 2>/dev/null
  ( cd "$PINNED" && finish_split test2 oursv,bu ) || exit 1
  node bench/h2h/export.mjs bench/out/h2h-test2 bench/results/h2h-test2.json
  node bench/h2h/report.mjs bench/out/h2h-test2 > bench/results/h2h-test2.txt
  COMMIT_MSG="Second held-out result: 220 Online-Mind2Web tasks, as pre-registered in d580ea9$ATTR"
  commit bench/results/h2h-test2.json bench/results/h2h-test2.txt
fi

# 2. (the branch was merged into main on 2026-09-28; test2 uses the pinned checkout above)

# 3. delayed replay
if [ ! -f bench/results/replay.txt ]; then
  wait_funds
  node bench/h2h/replay_run.mjs replay later --parallel 4
  node bench/h2h/replay_run.mjs report > bench/results/replay.txt
  COMMIT_MSG="Replay results: immediately after recording and after a delay, both agents$ATTR"
  commit bench/results/replay.txt
fi

# 4. WebVoyager
if [ ! -f bench/results/h2h-wv.json ]; then
  finish_split wv oursv,bu || exit 1
  node bench/h2h/export.mjs bench/out/h2h-wv bench/results/h2h-wv.json
  node bench/h2h/report.mjs bench/out/h2h-wv > bench/results/h2h-wv.txt
  COMMIT_MSG="WebVoyager held-out result: 60 tasks on 15 sites, as pre-registered in e0afcbf$ATTR"
  commit bench/results/h2h-wv.json bench/results/h2h-wv.txt
fi

# 5. ledger
L="$HOME/invent-stack/bin/ledger"
if ! grep -q '"id": "L28"' .ledger/ledger.json; then
  $L mint --repo . --block 17 --statement "The gate lets a renamed control through only when its name differs by numbers or at most two words." \
    --test "test/samename.test.js accepts counts and short extensions and refuses Buy to Delete account and long extensions." \
    --scope src/index/samename.js test/samename.test.js --oracle "npm test" --expect "# fail 0"
  $L mint --repo . --block 17 --statement "A page that freezes its renderer cannot keep a run past its deadline without an answer." \
    --test "bench/hang-smoke.mjs freezes the renderer on a 40-second deadline; the run ends on time with its memory's answer." \
    --scope server/agent.mjs bench/hang-smoke.mjs --oracle "node bench/hang-smoke.mjs" --expect "ended the run on time, with an answer: YES"
  $L mint --repo . --block 17 --statement "The agent can sort by a table column, move a slider by keyboard and click a filter whose count changed." \
    --test "bench/controls-smoke.mjs clicks a columnheader, presses ArrowRight on a slider and clicks a filter relabelled mid-step." \
    --scope src/agent/policy.js server/ax-index.mjs bench/controls-smoke.mjs --oracle "node bench/controls-smoke.mjs" --expect "count changed meanwhile: YES"
fi
wait_funds
$L verify --repo . --block 17 > .ledger/tmp/verify-17.txt 2>&1
$L summary --repo . >> .ledger/tmp/verify-17.txt 2>&1
COMMIT_MSG="Ledger: laws for the agent fixes, and a full verify$ATTR"
commit .ledger/ledger.json
log "all stages done"
