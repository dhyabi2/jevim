# Vend gateway for the browser agent

The paid, hosted face of Jevim's browser agent: x402 over Nano (XNO). It sits beside a checkout of the MIT-licensed
[dhyabi2/vend](https://github.com/dhyabi2/vend) and reuses its paywall. You do not need it to use Jevim: the Hermes
plugin in the repo root runs the same open-source agent locally. See [VEND.md](../VEND.md) for prices and endpoints.

- `browser_agent.py` runs as `vend-browser-agent.service` on 127.0.0.1:8410, as the same user as vend's API. It
  imports vend's own `require_payment`/`paid_response` from the vend checkout in `VEND_DIR`: one paywall, one
  treasury, one redemption store, so a block cannot be spent here and at vend.
- The agent itself (`server/public.mjs`) runs as its own unprivileged user on 127.0.0.1:8790 with
  `JEVIM_FREE_RUNS=0`, `JEVIM_HOST=127.0.0.1`, `JEVIM_BLOCK_PRIVATE=1` and one owner key that only the gateway
  holds. Pages it opens must not reach the host: either run it in the container in `../deploy/`, or give its user
  a firewall that refuses private ranges and the host's own address.
- `ensure-caddy-route.sh` adds, through Caddy's admin API, one route on the public host for
  `/api/v1/browser-agent*` ahead of vend's catch-all (or add the same route to the Caddyfile).
- Settings (mode 600, see `../.env.example`): `NANO_AGENT_ACCOUNT` (the payout address; the gateway refuses to
  start without a valid one), `JEVIM_AGENT_URL`, `JEVIM_AGENT_KEY`, `VEND_PRICE_BROWSER_AGENT` (0.05 XNO),
  `VEND_DIR`, port and public base.

Endpoints: `GET /api/v1/browser-agent?task=&website=` (paid, returns a job id), `GET .../jobs/{id}` (free status),
`GET .../jobs/{id}/events` (free, server-sent events). Inputs are checked before vend's payment gate sees the
request, so a bad task or a private address costs nothing. A run is never free: vend's daily free calls do not
cover this endpoint, because every run spends model tokens.
