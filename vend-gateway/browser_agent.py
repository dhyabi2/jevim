"""Vend gateway for the Jevim browser agent.

Runs on the Vend box beside vend-api, as its own process, from a private directory: this code is not part
of the public vend repository. It reuses Vend's own paywall - ``server.require_payment`` and
``server.paid_response`` imported from the vend checkout, read-only - so there is one payment
implementation, one treasury and one redemption store, and a block cannot be spent here and at vend.

The agent itself runs on a separate machine (browsers need memory the paywall does not). A paid call
starts a job there and returns at once with a job id, because a browser run takes 30-300 s and Vend's
calls and MCP clients time out at 60 s:

    GET /api/v1/browser-agent?task=...&website=...     paid (x402, XNO)   -> {job_id, status, links}
    GET /api/v1/browser-agent/jobs/{job_id}             free               -> the run: status, steps, answer
    GET /api/v1/browser-agent/jobs/{job_id}/events      free               -> text/event-stream, live

Job ids are random UUIDs, so only the payer can find their job.

Every input check runs BEFORE the payment is redeemed (Vend's ``validate_input`` hook): a buyer who sends
a bad task or a private address keeps their block and can retry with it.
"""

import ipaddress
import os
import socket
import sys
from urllib.parse import urlparse

VEND_DIR = os.environ.get("VEND_DIR", "/root/vend")
sys.path.insert(0, VEND_DIR)
os.chdir(VEND_DIR)          # vend resolves its store and static paths relative to its checkout

import httpx  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import FastAPI, Query, Request  # noqa: E402
from fastapi.responses import JSONResponse, StreamingResponse  # noqa: E402

import server as vend  # noqa: E402  (payment only; vend's own app is not started)
import store  # noqa: E402
from nano_verify import _price_to_raw  # noqa: E402

import re  # noqa: E402

# The payout address is configuration, never code: Vend pays every settled call to NANO_AGENT_ACCOUNT.
PAYOUT = os.environ.get("NANO_AGENT_ACCOUNT", "")
if not re.fullmatch(r"nano_[13][13-9a-km-uw-z]{59}", PAYOUT):
    sys.exit("Set NANO_AGENT_ACCOUNT to the nano_... address that should receive payments (see .env.example).")

AGENT_URL = os.environ["JEVIM_AGENT_URL"].rstrip("/")
AGENT_KEY = os.environ["JEVIM_AGENT_KEY"]
PUBLIC_BASE = os.environ.get("BROWSER_AGENT_PUBLIC_BASE", "https://extract.paypercall.dev").rstrip("/")
PATH = "/api/v1/browser-agent"
PRICE_XNO = float(os.environ.get("VEND_PRICE_BROWSER_AGENT", "0.05"))
PRICE_RAW = str(_price_to_raw(PRICE_XNO))
PORT = int(os.environ.get("BROWSER_AGENT_PORT", "8410"))
JOB_ID = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"

app = FastAPI(title="Vend browser agent", docs_url=None, redoc_url=None, openapi_url=None)
store.init()


def _bad(message: str) -> JSONResponse:
    return JSONResponse(status_code=400, content={"error": "bad_input", "message": message})


def public_website(raw: str):
    """(url, None) for a public http(s) site, or (None, reason). Every DNS answer must be public."""
    if not raw:
        return None, "website is required, e.g. website=arxiv.org"
    has_scheme = "://" in raw
    if has_scheme and not raw.lower().startswith(("http://", "https://")):
        return None, "only http and https websites can be used"
    url = raw if has_scheme else f"https://{raw}"
    host = urlparse(url).hostname or ""
    if not host or host == "localhost" or host.endswith((".local", ".internal")):
        return None, "only public websites can be used"
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(host, None)}
    except OSError:
        return None, f"could not find {host}"
    for address in addresses:
        ip = ipaddress.ip_address(address.split("%")[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return None, "only public websites can be used"
    return url, None


def input_problem(request: Request):
    """Vend calls this after verifying payment and before redeeming it."""
    task = (request.query_params.get("task") or "").strip()
    if not 8 <= len(task) <= 500:
        return _bad("task must describe what to do in 8 to 500 characters")
    _, problem = public_website((request.query_params.get("website") or "").strip())
    return _bad(problem) if problem else None


@app.get(PATH)
async def start_run(
    request: Request,
    task: str = Query(None, description="What the agent should do, in plain language (8-500 characters)."),
    website: str = Query(None, description="The website to do it on, e.g. arxiv.org or https://www.allrecipes.com"),
):
    """Start a browser-agent run: a real browser that searches, clicks, filters and reads, then answers.
    Paid per run in XNO. Returns a job id at once; follow it at the links returned."""
    paid, response = await vend.require_payment(
        PATH, price_xno=PRICE_XNO, price_raw=PRICE_RAW, validate_input=input_problem,
    )(request)
    if not paid:
        return response
    # Vend's free-trial branch approves a call before validate_input runs (a paid block is checked
    # before it is redeemed), so the same check runs here, and a trial call with bad input gets the same 400.
    problem = input_problem(request)
    if problem is not None:
        return problem

    url, _ = public_website(website.strip())
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(f"{AGENT_URL}/api/v1/runs", json={"task": task.strip(), "website": url},
                                  headers={"authorization": f"Bearer {AGENT_KEY}"})
        body = r.json()
        ok = r.status_code < 400
    except Exception:
        body, ok = {}, False
    if not ok:
        result = {"error": body.get("error", "agent_unavailable"),
                  "message": "The browser agent could not start this run."}
    else:
        job = body["id"]
        result = {
            "job_id": job,
            "status": body.get("status", "queued"),
            "task": task.strip(),
            "website": url,
            "links": {
                "status": f"{PUBLIC_BASE}{PATH}/jobs/{job}",
                "events": f"{PUBLIC_BASE}{PATH}/jobs/{job}/events",
            },
            "note": "Poll links.status (free) until status is done, stopped or failed; "
                    "links.events streams steps and live frames as server-sent events.",
        }
    return vend.paid_response(result, request)


@app.get(PATH + "/jobs/{job_id}")
async def job_status(job_id: str):
    """The run so far: status, steps, answer, cost. Free."""
    import re
    if not re.match(JOB_ID, job_id):
        return JSONResponse(status_code=404, content={"error": "not_found"})
    async with httpx.AsyncClient(timeout=20) as client:
        r = await client.get(f"{AGENT_URL}/api/v1/runs/{job_id}")
    return JSONResponse(status_code=r.status_code, content=r.json())


@app.get(PATH + "/jobs/{job_id}/events")
async def job_events(job_id: str):
    """Live server-sent events for a run: status, step, frame (JPEG), done. Free."""
    import re
    if not re.match(JOB_ID, job_id):
        return JSONResponse(status_code=404, content={"error": "not_found"})

    async def relay():
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("GET", f"{AGENT_URL}/api/v1/runs/{job_id}/events") as upstream:
                async for chunk in upstream.aiter_raw():
                    yield chunk

    return StreamingResponse(relay(), media_type="text/event-stream",
                             headers={"cache-control": "no-store", "x-accel-buffering": "no"})


if __name__ == "__main__":
    # uvicorn.Server, not uvicorn.run: vend's notes record run() deadlocking on this box.
    uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=PORT, proxy_headers=True,
                                  forwarded_allow_ips="*", log_level="info")).run()
