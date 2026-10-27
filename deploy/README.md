# Deploying the public API and demo

Live: https://agent.172.86.85.83.sslip.io (Caddy on the host terminates HTTPS; sslip.io needs no DNS).

The service runs in Docker so that pages the agent opens cannot reach anything listening on the host's
loopback. Chrome additionally fails every request to a private address (`JEVIM_BLOCK_PRIVATE=1`).

    # on the server, from a copy of package.json, src/, server/, demo/ and deploy/Dockerfile in /opt/jevim-demo
    docker build -t jevim-demo:latest /opt/jevim-demo
    cp deploy/jevim-demo.service /etc/systemd/system/ && systemctl enable --now jevim-demo
    cat deploy/Caddyfile.snippet >> /etc/caddy/Caddyfile && caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy

`/etc/jevim-demo.env` (mode 600) holds `NANO_API_KEY`, `JEVIM_OWNER_KEYS` (comma-separated keys with no
run limit, sent as `Authorization: Bearer <key>`), `JEVIM_CONCURRENCY` and `JEVIM_FREE_RUNS`.

Each visitor gets `JEVIM_FREE_RUNS` runs, counted by a salted hash of their IP (stored in the
`jevim-demo-data` volume). A run that fails on our side (out of model credit, a crash) is refunded.
