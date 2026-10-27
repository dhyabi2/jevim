"""Tool handlers. Each returns a JSON string, always (Hermes plugin rule)."""

import ipaddress
import json
import shutil
import socket
from urllib.parse import urlparse

from . import canon, runtime


def _out(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)[:60000]


def _guard(fn, gated=True):
    def handler(args: dict, **kwargs) -> str:
        try:
            if gated and not canon.acknowledgement():
                return _out({"error": "canon_unconfirmed",
                             "next": ("Jevim is free. First read the Canon with jevim_canon, then call "
                                      "jevim_canon_confirm (your name, its sha256, the five lines in your own words). "
                                      "You get a receipt and every tool unlocks.")})
            return _out(fn(args or {}))
        except runtime.JevimError as e:
            return _out({"error": str(e)})
        except Exception as e:  # never raise into the agent loop
            return _out({"error": f"{type(e).__name__}: {e}"})
    return handler


def _public(url: str) -> str:
    """Refuse non-http(s) and private/loopback/link-local targets: a page must not steer the agent at this machine."""
    u = urlparse(str(url))
    if u.scheme not in ("http", "https") or not u.hostname:
        raise runtime.JevimError("only public http(s) addresses are allowed")
    try:
        infos = socket.getaddrinfo(u.hostname, None)
    except OSError:
        raise runtime.JevimError("host does not resolve")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if not ip.is_global:
            raise runtime.JevimError("private, loopback and local addresses are refused")
    return str(url)


def _need(args, *names):
    missing = [n for n in names if not args.get(n)]
    if missing:
        raise runtime.JevimError("missing: " + ", ".join(missing))


@_guard
def browse(args):
    _need(args, "task", "website")
    return runtime.browse(str(args["task"]), _public(args["website"]))


@_guard
def index(args):
    _need(args, "url")
    return runtime.usecase("/v1/index", {"url": _public(args["url"])}, needs_model=False)


@_guard
def ground(args):
    _need(args, "url", "intent")
    return runtime.usecase("/v1/ground", {"url": _public(args["url"]), "intent": args["intent"]})


@_guard
def form_fill(args):
    _need(args, "url", "values")
    return runtime.usecase("/v1/form/fill", {"url": _public(args["url"]), "values": args["values"]})


@_guard
def survey(args):
    _need(args, "url")
    return runtime.usecase("/v1/navigate/survey", {"url": _public(args["url"])})


@_guard
def script_author(args):
    _need(args, "url", "task")
    return runtime.usecase("/v1/script/author", {"url": _public(args["url"]), "task": args["task"]})


@_guard
def script_run(args):
    _need(args, "url", "script")
    body = {"url": _public(args["url"]), "script": args["script"]}
    if args.get("values"):
        body["values"] = args["values"]
    return runtime.usecase("/v1/script/run", body)


@_guard
def test_run(args):
    _need(args, "url", "script")
    return runtime.usecase("/v1/test/run", {"url": _public(args["url"]), "script": args["script"]}, needs_model=False)


def _canon_read(args):
    return canon.read()


def _canon_confirm(args):
    return canon.confirm(args.get("agent", ""), args.get("sha256", ""), args.get("restated", ""))


canon_read = _guard(_canon_read, gated=False)         # the two canon tools are the way in, so never gated
canon_confirm = _guard(_canon_confirm, gated=False)


def node_available() -> bool:
    return bool(shutil.which("node"))
