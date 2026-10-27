#!/usr/bin/env bash
# Route /api/v1/browser-agent* on extract.paypercall.dev to the private gateway (127.0.0.1:8410), through
# Caddy's admin API, the way vend's bin/ensure-caddy-mcp.sh routes /mcp. Idempotent: inserts the route only
# when it is missing, right after the leading encode handler and before vend's catch-all proxy to 8402.
set -euo pipefail
ADMIN="http://localhost:2019"
DIAL="127.0.0.1:8410"
ROUTES=$(curl -sf "$ADMIN/config/apps/http/servers/srv0/routes")
SUB=$(echo "$ROUTES" | python3 -c '
import json, sys
for i, r in enumerate(json.load(sys.stdin)):
    hosts = (r.get("match") or [{}])[0].get("host") or []
    if any("extract.paypercall.dev" in h for h in hosts):
        for j, h in enumerate(r.get("handle") or []):
            if h.get("handler") == "subroute":
                print(f"/config/apps/http/servers/srv0/routes/{i}/handle/{j}/routes"); sys.exit(0)
sys.exit(1)')
CURRENT=$(curl -sf "$ADMIN$SUB")
if echo "$CURRENT" | grep -q "$DIAL"; then echo "route already present"; exit 0; fi
POS=$(echo "$CURRENT" | python3 -c '
import json, sys
routes = json.load(sys.stdin)
first = routes[0] if routes else {}
print(1 if any(h.get("handler") == "encode" for h in first.get("handle") or []) else 0)')
ROUTE='{"match":[{"path":["/api/v1/browser-agent","/api/v1/browser-agent/*"]}],"handle":[{"handler":"reverse_proxy","flush_interval":-1,"upstreams":[{"dial":"'"$DIAL"'"}]}]}'
curl -sf -X PUT -H "content-type: application/json" -d "$ROUTE" "$ADMIN$SUB/$POS" > /dev/null
echo "route inserted at position $POS"
