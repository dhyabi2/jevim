#!/usr/bin/env bash
# The daily run, end to end. Safe to run unattended and safe to run twice in a day.
#
#   tools/invent2/daily.sh [ideas-per-shard] [shards]
#
# generate -> verify (novelty + four rules, by a second model) -> publish -> commit -> deploy
#
# Every stage is skippable by failure: if generation yields nothing, verify finds nothing, publish
# adds nothing, and the deploy is skipped rather than shipping an unchanged site.
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1

# Disabled by default, on request. Nothing runs unless it is turned on explicitly, so a cron entry
# that still exists cannot start a run. To enable: IDEA_MACHINE_ENABLED=1 tools/invent2/daily.sh
if [ "${IDEA_MACHINE_ENABLED:-0}" != "1" ]; then
  echo "idea-machine is disabled. Set IDEA_MACHINE_ENABLED=1 to run it."
  exit 0
fi
PER=${1:-30}
SHARDS=${2:-4}
LOG=".ledger/invent2/daily-$(date +%F).log"
mkdir -p .ledger/invent2

# The key lives outside the repo so it is never committed.
ENV_FILE="$HOME/.config/idea-machine/env"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
if [ -z "${NANO_API_KEY:-}" ]; then
  echo "NANO_API_KEY is not set and $ENV_FILE has none" | tee -a "$LOG"
  exit 2
fi
export NANO_API_KEY

say() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

say "=== daily run start"

# generate -> verify -> publish -> score -> commit -> deploy

# Old shards are consumed by verify; clear them so a crashed run cannot be re-judged tomorrow.
rm -f .ledger/invent2/raw-*.json

say "generating: $SHARDS shards x $PER"
for _ in $(seq "$SHARDS"); do
  node tools/invent2/generate.mjs "$PER" >>"$LOG" 2>&1 &
done
wait

RAW=$(node -e "const fs=require('fs');const d=fs.readdirSync('.ledger/invent2').filter(f=>/^raw-.*json$/.test(f));console.log(d.reduce((n,f)=>n+JSON.parse(fs.readFileSync('.ledger/invent2/'+f,'utf8')).length,0))" 2>/dev/null || echo 0)
say "generated $RAW candidates"
[ "$RAW" -eq 0 ] && { say "nothing generated; stopping"; exit 0; }

say "verifying"
node tools/invent2/verify.mjs >>"$LOG" 2>&1
ACC=$(node -e "console.log(JSON.parse(require('fs').readFileSync('.ledger/invent2/accepted.json','utf8')).length)" 2>/dev/null || echo 0)
say "accepted $ACC of $RAW"
[ "$ACC" -eq 0 ] && { say "nothing passed the four rules today; site unchanged"; exit 0; }

say "publishing"
BEFORE=$(node -e "console.log(JSON.parse(require('fs').readFileSync('web/data/inventions.json','utf8')).total||0)" 2>/dev/null || echo 0)
node tools/invent2/publish.mjs >>"$LOG" 2>&1
AFTER=$(node -e "console.log(JSON.parse(require('fs').readFileSync('web/data/inventions.json','utf8')).total||0)")
say "published: $BEFORE -> $AFTER"

# Score the new arrivals so they sort into the list by how widely the job is needed rather than
# landing at the top merely for being new. Runs twice: a batch that fails leaves entries unrated,
# and unrated entries are retried rather than defaulted.
say "scoring demand"
node tools/invent2/rate.mjs >>"$LOG" 2>&1
node tools/invent2/rate.mjs >>"$LOG" 2>&1
UNSCORED=$(node -e "console.log(JSON.parse(require('fs').readFileSync('web/data/inventions.json','utf8')).inventions.filter(i=>typeof i.rating!=='number').length)")
say "unscored remaining: $UNSCORED"
[ "$AFTER" -le "$BEFORE" ] && { say "no net new ideas; skipping deploy"; exit 0; }

# Accepted is consumed; clear it so a rerun cannot publish the same ideas twice.
rm -f .ledger/invent2/accepted.json .ledger/invent2/raw-*.json

say "committing"
git add -A web/data/inventions.json .ledger/invent2 >>"$LOG" 2>&1
git -c user.email=dhyabi@gmail.com -c user.name="idea-machine" \
  commit -qm "Daily run: +$((AFTER - BEFORE)) ideas (total $AFTER)" >>"$LOG" 2>&1
git push -q origin main >>"$LOG" 2>&1 && say "pushed" || say "push failed (see log)"

say "deploying"
if (cd web && vercel deploy --prod --yes >>"../$LOG" 2>&1); then
  say "deployed https://idea-machine-five.vercel.app"
else
  say "deploy failed (see log)"
  exit 1
fi

say "=== done: +$((AFTER - BEFORE)) new, $AFTER total"
