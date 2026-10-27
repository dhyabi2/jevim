"""Starts Jevim's own open-source servers on this machine and talks to them over loopback.

Nothing here calls a hosted Jevim or Vend service. Two local processes, started on first use and stopped when
Hermes exits:

* ``server/public.mjs``: the Chrome-driven browser agent (``jevim_browse``). Needs Chrome and a model key.
* ``server/serve.mjs``: the page-index use cases (``jevim_index`` and the rest). The index itself needs no key.

Both bind 127.0.0.1 on a free port; the agent server is protected by a random per-process key.
"""

from __future__ import annotations

import atexit
import json
import os
import secrets
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
_lock = threading.Lock()
_procs: dict[str, dict] = {}


class JevimError(RuntimeError):
    pass


def model_key() -> str:
    return os.environ.get("JEV_API_KEY") or os.environ.get("NANO_API_KEY") or ""


def chrome_path() -> str:
    for cand in (os.environ.get("CHROME_PATH"), shutil.which("google-chrome-stable"), shutil.which("google-chrome"),
                 shutil.which("chromium"), shutil.which("chromium-browser"),
                 "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"):
        if cand and Path(cand).exists():
            return cand
    return ""


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _data_dir() -> str:
    home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    path = Path(home) / "jevim-data"
    path.mkdir(parents=True, exist_ok=True)
    return str(path)


def _ensure_deps() -> None:
    if (ROOT / "node_modules" / "jsdom").exists():
        return
    npm = shutil.which("npm")
    if not npm:
        raise JevimError("npm is required once to install Jevim's single dependency (jsdom).")
    r = subprocess.run([npm, "install", "--omit=dev", "--no-audit", "--no-fund"], cwd=ROOT,
                       capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise JevimError("npm install failed: " + (r.stderr or r.stdout)[-400:])


def _wait_up(port: int, path: str, headers: dict, seconds: float = 20.0) -> None:
    end = time.time() + seconds
    while time.time() < end:
        try:
            urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers=headers), timeout=2)
            return
        except urllib.error.HTTPError:
            return                      # it answered
        except Exception:
            time.sleep(0.25)
    raise JevimError(f"the local Jevim server did not start on port {port}")


def _start(name: str) -> dict:
    with _lock:
        cur = _procs.get(name)
        if cur and cur["proc"].poll() is None:
            return cur
        node = shutil.which("node")
        if not node:
            raise JevimError("Node.js 20+ is required.")
        _ensure_deps()
        port, key = _free_port(), secrets.token_hex(24)
        env = dict(os.environ, PORT=str(port), JEVIM_HOST="127.0.0.1", JEVIM_BLOCK_PRIVATE="1")
        if name == "agent":
            chrome = chrome_path()
            if not chrome:
                raise JevimError("Chrome or Chromium is required for jevim_browse (set CHROME_PATH).")
            env.update(CHROME_PATH=chrome, JEVIM_DATA=_data_dir(), JEVIM_OWNER_KEYS=key,
                       NANO_API_KEY=model_key())
            if hasattr(os, "geteuid") and os.geteuid() == 0:
                env.setdefault("JEVIM_CHROME_ARGS", "--no-sandbox --disable-dev-shm-usage --disable-gpu")
            script, ready = "server/public.mjs", "/health"
        else:
            script, ready = "server/serve.mjs", "/v1"
        proc = subprocess.Popen([node, script], cwd=ROOT, env=env, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, start_new_session=True)
        entry = {"proc": proc, "port": port, "key": key}
        try:
            _wait_up(port, ready, {})
        except JevimError:
            proc.kill()
            raise
        _procs[name] = entry
        return entry


def stop_all() -> None:
    for entry in _procs.values():
        try:
            entry["proc"].terminate()
        except Exception:
            pass


atexit.register(stop_all)


def _call(entry: dict, method: str, path: str, body: dict | None = None, auth: bool = False, timeout: float = 120.0):
    headers = {"content-type": "application/json"}
    if auth:
        headers["authorization"] = "Bearer " + entry["key"]
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:{entry['port']}{path}", data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {"error": f"HTTP {e.code}"}


def usecase(path: str, body: dict, needs_model: bool = True) -> dict:
    """POST one of serve.mjs's /v1/* use cases."""
    if needs_model and not model_key():
        return {"error": "Set NANO_API_KEY (or JEV_API_KEY) to enable the model tier of this tool."}
    return _call(_start("usecases"), "POST", path, body)


def browse(task: str, website: str, max_wait: float = 420.0) -> dict:
    if not model_key():
        return {"error": "Set NANO_API_KEY (an OpenAI-compatible nano-gpt key) so the agent can decide its steps."}
    entry = _start("agent")
    started = _call(entry, "POST", "/api/v1/runs", {"task": task, "website": website}, auth=True)
    run_id = started.get("id")
    if not run_id:
        return started                  # a refusal: bad task, private address
    end = time.time() + max_wait
    while time.time() < end:
        run = _call(entry, "GET", f"/api/v1/runs/{run_id}", auth=True)
        if run.get("finished") or run.get("status") in ("done", "failed", "error", "stopped"):
            return run
        time.sleep(2)
    return {"id": run_id, "status": "timeout", "error": f"still running after {int(max_wait)} s", "partial": run}
