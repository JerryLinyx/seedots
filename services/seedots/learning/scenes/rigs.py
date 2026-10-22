"""Client for the rig service (services/rigs). Every lab fact (gates, the prediction's answer,
observables) comes from there, so the backend, the agents and the browser share one implementation.

`client` is any httpx.Client; tests may pass one with a mock transport."""
from __future__ import annotations

from typing import Any

import httpx

TIMEOUT = 5.0


class RigUnavailable(RuntimeError):
    """The service did not answer: callers fall back (no lab, or the legacy L1 path)."""


class RigClient:
    def __init__(self, client: httpx.Client):
        self.http = client

    @classmethod
    def at(cls, base_url: str) -> "RigClient":
        return cls(httpx.Client(base_url=base_url, timeout=TIMEOUT))

    def _call(self, method: str, path: str, **kw: Any) -> dict[str, Any]:
        try:
            r = self.http.request(method, path, **kw)
        except httpx.HTTPError as exc:
            raise RigUnavailable(f"rig service unreachable: {exc}") from exc
        data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        if r.status_code in (400, 404):          # the caller's mistake: tell them (and the model) what to fix
            return {"error": data.get("error", f"HTTP {r.status_code}")}
        if r.status_code >= 500:
            raise RigUnavailable(f"rig service error {r.status_code}: {data.get('error', r.text[:200])}")
        return data

    @property
    def available(self) -> bool:
        try:
            return bool(self._call("GET", "/healthz").get("ok"))
        except RigUnavailable:
            return False

    def catalog(self, q: str = "", tags: list[str] | None = None, limit: int = 5) -> dict[str, Any]:
        return self._call("GET", "/v1/rigs", params={"q": q, "tags": ",".join(tags or []), "limit": limit})

    def describe(self, rig: str) -> dict[str, Any]:
        return self._call("GET", f"/v1/rigs/{rig}")

    def check(self, spec: dict[str, Any]) -> dict[str, Any]:
        return self._call("POST", "/v1/check", json={"spec": spec})

    def observe(self, spec: dict[str, Any], set_: dict[str, float] | None = None) -> dict[str, Any]:
        return self._call("POST", "/v1/observe", json={"spec": spec, "set": set_ or {}})

    def sweep(self, spec: dict[str, Any], param: str, *, lo: float | None = None, hi: float | None = None, n: int = 11,
              observe: list[str] | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"spec": spec, "param": param, "n": n}
        if lo is not None:
            body["from"] = lo
        if hi is not None:
            body["to"] = hi
        if observe:
            body["observe"] = observe
        return self._call("POST", "/v1/sweep", json=body)


def compact_card(card: dict[str, Any]) -> dict[str, Any]:
    """What goes into a prompt: enough to choose a rig, not its whole manual."""
    return {k: card[k] for k in ("id", "summary", "use_when", "not_for", "observables") if k in card}
