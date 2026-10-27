# Vend gateway for the browser agent

The paid, hosted face of Jevim's browser agent: x402 over Nano (XNO). It sits beside a checkout of the MIT-licensed
[dhyabi2/vend](https://github.com/dhyabi2/vend) and reuses its paywall. You do not need it to use Jevim: the Hermes
plugin in the repo root runs the same open-source agent locally. See [VEND.md](../VEND.md) for prices and endpoints.

- `browser_agent.py` runs as `vend-browser-agent.service` on 127.0.0.1:8410. It imports vend's own
  `require_payment`/`paid_response` read-only from `/root/vend`: one paywall, one treasury, one redemption store.
- `ensure-caddy-route.sh` adds, through Caddy's admin API, one route on extract.paypercall.dev for
  `/api/v1/browser-agent*` ahead of vend's catch-all. The config from before is in `/root/vend-private/caddy-config-before.json`.
- `browser-agent.env` (mode 600, see `../.env.example`): `NANO_AGENT_ACCOUNT` (the payout address; the gateway refuses to start
  without a valid one), `JEVIM_AGENT_URL`, `JEVIM_AGENT_KEY` (a key of its own on the agent server, revocable apart from
  the owner key), `VEND_PRICE_BROWSER_AGENT` (0.05 XNO), port and public base.

Endpoints: `GET /api/v1/browser-agent?task=&website=` (paid, returns a job id), `GET .../jobs/{id}` (free status),
`GET .../jobs/{id}/events` (free, server-sent events). Inputs are checked before a payment is redeemed, and on
the free-trial path too.
