"""Deploy link: the gateway's allowlisted proxy to the deploy kit's deploy service (`g1 lab --headless`, API v1).

The deploy kit owns every process and every motor gate (its console runs the SONIC runner and the planner node); Studio
owns the experience. Studio relays an operator's press to the kit and never makes one up (docs/DEPLOY.md).

Configuration: `config/local.json` -> `deploy_service: {url, token_file}`; defaults http://127.0.0.1:8769 and
~/.config/g1-deploy/panel_token (G1_PANEL_TOKEN wins when set). The token stays in the gateway: the browser never sees it.

Standard library only.
"""
from __future__ import annotations

import json
import math
import os
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from . import paths

DEFAULT_URL = "http://127.0.0.1:8769"
DEFAULT_TOKEN_FILE = Path.home() / ".config/g1-deploy/panel_token"
GET_TIMEOUT_S = 2.0
POST_TIMEOUT_S = 8.0

# Studio route -> (hub path template, query keys passed through). {name} / {slot} come from the query.
GET_ROUTES = {
    "/api/deploy/state": ("/api/v1/state", ()),
    "/api/deploy/readiness": ("/api/v1/readiness", ("scan", "slot")),
    "/api/deploy/scan/live": ("/api/v1/scan/live", ()),
    "/api/deploy/scan/scene": ("/api/v1/scan/{name}/scene", ()),
    "/api/deploy/live": ("/api/v1/live/{slot}/view", ("cloud_after", "mem_after")),
    "/api/deploy/rehearsal/track": ("/api/v1/rehearsal/{name}/track", ()),
    "/api/deploy/manifest": ("/api/v1/session/{name}/manifest", ()),
    "/api/deploy/panel": ("/api/v1/panel/{slot}/state", ()),
}
# Studio's POST /api/deploy/act {act, ...}: act -> hub path. Console acts go through /api/v1/act.
HUB_ACTS = {
    "start": "/api/v1/start", "stop": "/api/v1/stop", "scan": "/api/v1/scan", "practice_scan": "/api/v1/practice/scan",
    "rehearse": "/api/v1/rehearse", "start_check": "/api/v1/start_check", "send_goal": "/api/v1/send_goal",
    "doctor": "/api/v1/doctor",
}
CONSOLE_ACTS = {"arm", "s", "c", "g", "h", "t", "tag", "note"}
SAFE_NAME = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")


class DeployError(Exception):
    """The deploy service refused or could not be reached; `status` is the HTTP status to answer with."""

    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


def sanitize(value):
    """Strict JSON: non-finite floats become null (the gateway answers with allow_nan=False)."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: sanitize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize(v) for v in value]
    return value


class DeployLink:
    def __init__(self, url=None, token_file=None):
        cfg = paths.local_config().get("deploy_service", {})
        self.url = (url or cfg.get("url") or DEFAULT_URL).rstrip("/")
        parsed = urllib.parse.urlparse(self.url)
        if parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError("deploy_service.url must be a loopback address")
        self.token_file = Path(token_file or cfg.get("token_file") or DEFAULT_TOKEN_FILE).expanduser()

    def token(self):
        env = os.environ.get("G1_PANEL_TOKEN")
        if env:
            return env
        try:
            return self.token_file.read_text().strip()
        except OSError:
            raise DeployError(f"no deploy service token: set G1_PANEL_TOKEN or create {self.token_file}", 503)

    def _request(self, method, path, query=None, body=None, timeout=GET_TIMEOUT_S):
        q = dict(query or {}, t=self.token())
        url = f"{self.url}{path}?{urllib.parse.urlencode(q)}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={"Content-Type": "application/json"} if data is not None else {})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                status, raw = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            raise DeployError(f"the deploy service at {self.url} is not reachable ({getattr(e, 'reason', e)}); "
                              "start it on the deploy PC with ./g1 lab --headless", 503)
        try:
            obj = json.loads(raw or b"{}")
        except ValueError:
            raise DeployError(f"the deploy service answered {status} with non-JSON", 502)
        return status, sanitize(obj)

    def get(self, route, query):
        """A proxied GET: route is a Studio path in GET_ROUTES, query a dict of single values."""
        template, passthrough = GET_ROUTES[route]
        fields = {}
        for key in ("name", "slot"):
            if "{" + key + "}" in template:
                value = str(query.get(key, ""))
                if not value or not set(value) <= SAFE_NAME or value.startswith("."):
                    raise DeployError(f"a valid {key} is required", 400)
                fields[key] = value
        path = template.format(**fields)
        q = {k: str(query[k]) for k in passthrough if k in query}
        return self._request("GET", path, q)

    def act(self, body):
        """A proxied operator act: hub acts by name, console acts through /api/v1/act."""
        act = body.get("act")
        if act in HUB_ACTS:
            return self._request("POST", HUB_ACTS[act], body={k: v for k, v in body.items() if k != "act"},
                                 timeout=POST_TIMEOUT_S)
        if act in CONSOLE_ACTS:
            return self._request("POST", "/api/v1/act", body=body, timeout=POST_TIMEOUT_S)
        raise DeployError(f"act {act!r} is not relayed by Studio", 400)
