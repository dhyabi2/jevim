"""Laws of the Vend gateway. Needs a checkout of dhyabi2/vend:

    VEND_DIR=/path/to/vend  /path/to/vend/.venv/bin/python -m pytest -q --import-mode=importlib \
        --rootdir=vend-gateway vend-gateway/test_gateway.py

(importlib mode and the rootdir keep pytest from importing the Hermes plugin package at the repo root.)

No network, no agent, no money: Vend's gate and the agent are replaced by fakes; the gateway's own rules run.
"""
import importlib.util
import os
import sys
import tempfile
import uuid

import pytest

TMP = tempfile.mkdtemp()
os.environ.setdefault("VEND_DIR", "/opt/vend")
os.environ["VEND_DB"] = os.path.join(TMP, "vend.sqlite3")
os.environ["BROWSER_AGENT_JOBS_DB"] = os.path.join(TMP, "jobs.sqlite3")
os.environ["NANO_AGENT_ACCOUNT"] = "nano_3z335ug5oz6sxfgcfz3kdqdrgn5otx7ht3epuc3kuimka6hc59xqem1jrzqy"
os.environ["JEVIM_AGENT_URL"] = "http://127.0.0.1:9"
os.environ["JEVIM_AGENT_KEY"] = "test"

spec = importlib.util.spec_from_file_location("gw", os.path.join(os.path.dirname(__file__), "browser_agent.py"))
gw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gw)

from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(gw.app)
GOOD = {"task": "find the main heading of the page", "website": "example.com"}
BLOCK = "A" * 64


class Agent:
    """What the agent would answer."""
    def __init__(self):
        self.up, self.starts, self.runs = True, True, {}

    async def start(self, task, url):
        if not self.starts:
            return None, "agent_unavailable"
        job = str(uuid.uuid4())
        self.runs[job] = "running"
        return job, "queued"

    async def state(self, job_id):
        if not self.up:
            return 0, {}
        if job_id not in self.runs:
            return 404, {"error": "not_found"}
        return 200, {"id": job_id, "status": self.runs[job_id]}


@pytest.fixture()
def agent(monkeypatch):
    a = Agent()
    monkeypatch.setattr(gw, "start_at_agent", a.start)
    monkeypatch.setattr(gw, "agent_run_state", a.state)

    def gate(path, price_xno=None, price_raw=None, required=()):
        async def checker(request):
            if not request.headers.get("x-payment"):
                from fastapi.responses import JSONResponse
                return False, JSONResponse(status_code=402, content={"error": "payment_required"})
            request.state.payment = {"block_hash": request.headers["x-payment"], "amount_raw": price_raw, "source": "nano_payer"}
            return True, None
        return checker
    monkeypatch.setattr(gw.vend, "require_payment", gate)
    monkeypatch.setattr(gw.vend, "extract_payment_block", lambda request: None)   # skip the live health probe
    return a


def paid(params=GOOD, block=BLOCK):
    return client.get(gw.PATH, params=params, headers={"x-payment": block})


def test_unpaid_is_402_and_bad_input_costs_nothing(agent):
    assert client.get(gw.PATH).status_code == 402
    assert client.get(gw.PATH, params=GOOD).status_code == 402
    r = paid({"task": "x", "website": "example.com"})
    assert r.status_code == 400 and r.json()["payment_taken"] is False
    r = paid({"task": GOOD["task"], "website": "127.0.0.1"})
    assert r.status_code == 400 and r.json()["payment_taken"] is False


def test_no_free_trial():
    t = gw.vend.get_tracker()
    assert t.remaining("anyone") == 0 and t.consume("anyone") is False


def test_a_finished_run_cannot_be_retried(agent):
    job = paid().json()["job_id"]
    agent.runs[job] = "done"
    r = client.get(gw.PATH, params={**GOOD, "retry_of": job})
    assert r.status_code == 409 and r.json()["error"] == "not_failed"
    agent.runs.clear()            # even after the agent forgets it
    assert client.get(gw.PATH, params={**GOOD, "retry_of": job}).status_code == 409


def test_a_running_run_cannot_be_retried(agent):
    job = paid().json()["job_id"]
    r = client.get(gw.PATH, params={**GOOD, "retry_of": job})
    assert r.status_code == 409 and r.json()["error"] == "still_running"


def test_a_failed_run_is_retried_once_without_payment(agent):
    job = paid().json()["job_id"]
    agent.runs[job] = "failed"
    status = client.get(f"{gw.PATH}/jobs/{job}").json()
    assert status["retry"]["retry_of"] == job
    r = client.get(gw.PATH, params={**GOOD, "retry_of": job})          # no payment header at all
    assert r.status_code == 200 and r.json()["attempt"] == 2 and r.json()["job_id"] != job
    again = client.get(gw.PATH, params={**GOOD, "retry_of": job})
    assert again.status_code == 409 and again.json()["error"] == "already_retried"
    assert "retry" not in client.get(f"{gw.PATH}/jobs/{job}").json()


def test_one_payment_buys_at_most_max_attempts(agent):
    job = paid().json()["job_id"]
    for attempt in range(2, gw.MAX_ATTEMPTS + 1):
        agent.runs[job] = "failed"
        r = client.get(gw.PATH, params={**GOOD, "retry_of": job})
        assert r.status_code == 200 and r.json()["attempt"] == attempt
        job = r.json()["job_id"]
    agent.runs[job] = "failed"
    r = client.get(gw.PATH, params={**GOOD, "retry_of": job})
    assert r.status_code == 409 and r.json()["error"] == "attempts_used"
    assert "retry" not in client.get(f"{gw.PATH}/jobs/{job}").json()


def test_a_run_lost_to_an_agent_restart_is_retried(agent):
    job = paid().json()["job_id"]
    agent.runs.clear()
    status = client.get(f"{gw.PATH}/jobs/{job}")
    assert status.status_code == 200 and status.json()["status"] == "failed" and status.json()["retry"]
    assert client.get(gw.PATH, params={**GOOD, "retry_of": job}).status_code == 200


def test_a_paid_run_that_cannot_start_hands_back_a_retry(agent):
    agent.starts = False
    body = paid().json()
    job = body["retry"]["retry_of"]
    assert body["error"] and client.get(f"{gw.PATH}/jobs/{job}").json()["status"] == "failed"
    r = client.get(gw.PATH, params={**GOOD, "retry_of": job})          # still down: the retry is not spent
    assert r.status_code == 503 and r.json()["retry"]["retry_of"] == job
    agent.starts = True
    assert client.get(gw.PATH, params={**GOOD, "retry_of": job}).status_code == 200


def test_an_unknown_or_malformed_job_unlocks_nothing(agent):
    assert client.get(gw.PATH, params={**GOOD, "retry_of": str(uuid.uuid4())}).status_code == 404
    assert client.get(gw.PATH, params={**GOOD, "retry_of": "../../etc"}).status_code == 404
    assert len(agent.runs) == 0


def test_an_agent_that_does_not_answer_spends_no_retry(agent):
    job = paid().json()["job_id"]
    agent.up = False
    assert client.get(gw.PATH, params={**GOOD, "retry_of": job}).status_code == 503
    agent.up = True
    agent.runs[job] = "failed"
    assert client.get(gw.PATH, params={**GOOD, "retry_of": job}).status_code == 200
