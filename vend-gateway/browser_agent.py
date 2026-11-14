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

Every input check runs BEFORE Vend's payment gate: a buyer who sends a bad task or a private address keeps
their block and can retry with it. A run is never free: Vend's daily free calls do not cover this endpoint.

A payment is not lost to a failure on our side. The server holds no key and cannot send money back, so the
remedy is another run: when a paid run fails (the agent crashed, the model was unavailable, the run could
not start), calling again with ``retry_of=<job_id>`` starts a new run with no new payment. Each payment
buys at most MAX_ATTEMPTS runs, a job can be retried once, and only a job id (a random UUID that only the
payer was given) unlocks it. A run that finished (``done``) or used its step or time budget (``stopped``)
did its work and is not retried. An agent that is down is noticed before the gate: 503, nothing taken.
"""

import ipaddress
import os
import socket
import sqlite3
import sys
import threading
import time
import uuid
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
MAX_ATTEMPTS = int(os.environ.get("BROWSER_AGENT_MAX_ATTEMPTS", "3"))   # runs one payment can buy, failures included
JOBS_DB = os.environ.get("BROWSER_AGENT_JOBS_DB") or os.path.join(
    os.path.dirname(os.environ.get("VEND_DB", "")) or VEND_DIR, "browser-agent-jobs.sqlite3")

# ---- which payment bought which job ---------------------------------------------------------------------
_jobs_lock = threading.Lock()


def _jobs():
    db = sqlite3.connect(JOBS_DB, timeout=10)
    db.execute("""CREATE TABLE IF NOT EXISTS jobs (
        job_id   TEXT PRIMARY KEY,
        payment  TEXT NOT NULL,              -- the block hash (or balance account) that paid for the chain
        attempt  INTEGER NOT NULL,           -- 1 for the paid run, 2.. for retries
        state    TEXT NOT NULL,              -- started | start_failed | done | stopped
        retried  INTEGER NOT NULL DEFAULT 0, -- 1 once a retry of this job has been started
        created  REAL NOT NULL)""")
    return db


def job_record(job_id: str, payment: str, attempt: int, state: str) -> None:
    with _jobs_lock, _jobs() as db:
        db.execute("INSERT OR REPLACE INTO jobs (job_id, payment, attempt, state, retried, created) VALUES (?,?,?,?,0,?)",
                   (job_id, payment, attempt, state, time.time()))


def job_get(job_id: str):
    with _jobs_lock, _jobs() as db:
        row = db.execute("SELECT job_id, payment, attempt, state, retried FROM jobs WHERE job_id=?", (job_id,)).fetchone()
    return dict(zip(("job_id", "payment", "attempt", "state", "retried"), row)) if row else None


def job_set_state(job_id: str, state: str) -> None:
    with _jobs_lock, _jobs() as db:
        db.execute("UPDATE jobs SET state=? WHERE job_id=?", (state, job_id))


def job_claim_retry(job_id: str) -> bool:
    """True for exactly one caller: the retry of this job is now taken."""
    with _jobs_lock, _jobs() as db:
        return db.execute("UPDATE jobs SET retried=1 WHERE job_id=? AND retried=0", (job_id,)).rowcount == 1


def job_release_retry(job_id: str) -> None:
    with _jobs_lock, _jobs() as db:
        db.execute("UPDATE jobs SET retried=0 WHERE job_id=?", (job_id,))


def retry_link(job_id: str) -> dict:
    return {"retry_of": job_id,
            "how": f"GET {PUBLIC_BASE}{PATH}?task=...&website=...&retry_of={job_id} starts a new run with no new payment."}


async def agent_run_state(job_id: str):
    """(http status, body) of the run at the agent; (0, {}) when the agent does not answer."""
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(f"{AGENT_URL}/api/v1/runs/{job_id}")
        return r.status_code, (r.json() if r.content else {})
    except Exception:
        return 0, {}


async def start_at_agent(task: str, url: str):
    """(job id, status) from the agent, or (None, error)."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(f"{AGENT_URL}/api/v1/runs", json={"task": task, "website": url},
                                  headers={"authorization": f"Bearer {AGENT_KEY}"})
        body = r.json()
        if r.status_code < 400 and body.get("id"):
            return body["id"], body.get("status", "queued")
        return None, body.get("error", "agent_unavailable")
    except Exception:
        return None, "agent_unavailable"


def started(job: str, status: str, task: str, url: str) -> dict:
    return {
        "job_id": job,
        "status": status,
        "task": task,
        "website": url,
        "links": {
            "status": f"{PUBLIC_BASE}{PATH}/jobs/{job}",
            "events": f"{PUBLIC_BASE}{PATH}/jobs/{job}/events",
        },
        "note": "Poll links.status (free) until status is done, stopped or failed; "
                "links.events streams steps and live frames as server-sent events. "
                "If the run fails on our side, call again with retry_of=<job_id>: no new payment.",
    }

app = FastAPI(title="Vend browser agent", docs_url=None, redoc_url=None, openapi_url=None)
store.init()


class _NoTrial:
    """A browser run spends model tokens, so it is never free: Vend's daily free calls do not cover it."""
    max_free = 0

    def remaining(self, key):
        return 0

    def consume(self, key):
        return False


# Vend's gate asks this module-level name for the tracker; in this process it always answers "none left".
vend.get_tracker = lambda: _NoTrial()


def _bad(message: str) -> JSONResponse:
    return JSONResponse(status_code=400, content={"error": "bad_input", "message": message, "payment_taken": False})


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
    retry_of: str = Query(None, description="Job id of a paid run that failed on our side: starts a new run, no new payment."),
):
    """Start a browser-agent run: a real browser that searches, clicks, filters and reads, then answers.
    Paid per run in XNO. Returns a job id at once; follow it at the links returned."""
    # Inputs are checked before Vend's gate sees the request, so nothing the buyer owns (a block, a prepaid
    # balance, a signed send) is consumed for a run that cannot start. A bare probe with no parameters and
    # no payment still falls through to the 402 challenge, which is what x402 discovery needs.
    if request.query_params:
        problem = input_problem(request)
        if problem is not None:
            return problem

    if retry_of:
        return await retry_run(retry_of.strip().lower(), task.strip(), public_website(website.strip())[0])

    # An agent that is down is noticed before anything is taken.
    if vend.extract_payment_block(request) or request.headers.get("x-balance") or vend.has_signed_block(request):
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                up = (await client.get(f"{AGENT_URL}/health")).status_code == 200
        except Exception:
            up = False
        if not up:
            return JSONResponse(status_code=503, content={
                "error": "agent_unavailable", "payment_taken": False,
                "message": "The browser agent is not answering. Nothing was taken; retry later with the same payment."})

    paid, response = await vend.require_payment(
        PATH, price_xno=PRICE_XNO, price_raw=PRICE_RAW, required=("task", "website"),
    )(request)
    if not paid:
        return response

    payment = request.state.payment
    paid_with = payment.get("block_hash") or f"balance:{payment.get('source', '')}"
    url, _ = public_website(website.strip())
    job, status = await start_at_agent(task.strip(), url)
    if job is None:
        # Paid, and the run could not start: hand back a job id that unlocks one free retry.
        job = str(uuid.uuid4())
        job_record(job, paid_with, 1, "start_failed")
        result = {"error": status, "message": "The browser agent could not start this run. "
                  "Your payment still buys a run: call again with retry_of.", "job_id": job, "retry": retry_link(job)}
    else:
        job_record(job, paid_with, 1, "started")
        result = started(job, status, task.strip(), url)
    return vend.paid_response(result, request)


async def retry_run(job_id: str, task: str, url: str):
    """A new run for a payment whose run failed on our side. No payment is read or taken here."""
    import re
    if not re.match(JOB_ID, job_id):
        return JSONResponse(status_code=404, content={"error": "not_found", "message": "No such job."})
    job = job_get(job_id)
    if job is None:
        return JSONResponse(status_code=404, content={"error": "not_found", "message": "No such job."})
    if job["retried"]:
        return JSONResponse(status_code=409, content={"error": "already_retried",
                            "message": "A retry of this job was already started; follow that job instead."})
    if job["attempt"] >= MAX_ATTEMPTS:
        return JSONResponse(status_code=409, content={"error": "attempts_used",
                            "message": f"This payment has used its {MAX_ATTEMPTS} runs."})
    if job["state"] in ("done", "stopped"):
        return JSONResponse(status_code=409, content={"error": "not_failed",
                            "message": "That run finished; only a run that failed on our side can be retried."})
    if job["state"] == "started":
        code, body = await agent_run_state(job_id)
        if code == 0:
            return JSONResponse(status_code=503, content={"error": "agent_unavailable",
                                "message": "The browser agent is not answering; try the retry again shortly."})
        state = body.get("status")
        if code == 200 and state in ("done", "stopped"):
            job_set_state(job_id, state)
            return JSONResponse(status_code=409, content={"error": "not_failed",
                                "message": "That run finished; only a run that failed on our side can be retried."})
        if code == 200 and state != "failed":
            return JSONResponse(status_code=409, content={"error": "still_running",
                                "message": "That run has not failed; follow it at its status link."})
        # failed, or the agent no longer knows the run (it restarted while the run was in flight)
    if not job_claim_retry(job_id):
        return JSONResponse(status_code=409, content={"error": "already_retried",
                            "message": "A retry of this job was already started; follow that job instead."})
    new_job, status = await start_at_agent(task, url)
    if new_job is None:
        job_release_retry(job_id)
        return JSONResponse(status_code=503, content={"error": status, "retry": retry_link(job_id),
                            "message": "The browser agent could not start the retry; the retry is still yours."})
    job_record(new_job, job["payment"], job["attempt"] + 1, "started")
    result = started(new_job, status, task, url)
    result["retry_of"] = job_id
    result["attempt"] = job["attempt"] + 1
    return JSONResponse(status_code=200, content=result)


@app.get(PATH + "/jobs/{job_id}")
async def job_status(job_id: str):
    """The run so far: status, steps, answer, cost. Free."""
    import re
    if not re.match(JOB_ID, job_id):
        return JSONResponse(status_code=404, content={"error": "not_found"})
    job = job_get(job_id)
    if job is not None and job["state"] == "start_failed":
        body = {"id": job_id, "status": "failed", "error": "The run could not start."}
        if not job["retried"]:
            body["retry"] = retry_link(job_id)
        return JSONResponse(status_code=200, content=body)
    code, body = await agent_run_state(job_id)
    if code == 0:
        return JSONResponse(status_code=503, content={"error": "agent_unavailable"})
    if job is not None:
        state = body.get("status") if code == 200 else None
        if state in ("done", "stopped") and job["state"] != state:
            job_set_state(job_id, state)
        failed = state == "failed" or (code == 404 and job["state"] == "started")
        if failed and not job["retried"] and job["attempt"] < MAX_ATTEMPTS:
            if code == 404:
                code, body = 200, {"id": job_id, "status": "failed", "error": "The run was lost when the agent restarted."}
            body["retry"] = retry_link(job_id)
    return JSONResponse(status_code=code, content=body)


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
