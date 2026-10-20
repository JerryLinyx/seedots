"""Client for the foundation's API. The learning backend only talks to it through this."""
from __future__ import annotations

from typing import Any, Protocol

from seedots.common.contracts import EvidenceUnit


class MediaAPIError(RuntimeError):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status


class MediaClient(Protocol):
    def register(self, body: dict[str, Any]) -> dict: ...
    def analyze(self, media_id: str, priority_from: float | None = None) -> dict: ...
    def get(self, media_id: str) -> dict: ...
    def evidence(self, media_id: str, kinds: str = "sentence,chapter", t0: float | None = None,
                 t1: float | None = None) -> list[EvidenceUnit]: ...


class HttpMediaClient:
    def __init__(self, base_url: str):
        self.base = base_url.rstrip("/")

    def _req(self, method: str, path: str, **kw) -> Any:
        import httpx

        r = httpx.request(method, f"{self.base}{path}", timeout=60, **kw)
        if r.status_code >= 400:
            try:
                detail = r.json().get("detail", r.text)
            except ValueError:
                detail = r.text
            raise MediaAPIError(r.status_code, str(detail))
        return r.json()

    def register(self, body):
        return self._req("POST", "/v1/media", json=body)

    def analyze(self, media_id, priority_from=None):
        return self._req("POST", f"/v1/media/{media_id}/analyze", json={"priority_from": priority_from})

    def get(self, media_id):
        return self._req("GET", f"/v1/media/{media_id}")

    def evidence(self, media_id, kinds="sentence,chapter", t0=None, t1=None):
        params: dict[str, Any] = {"kinds": kinds}
        if t0 is not None:
            params["t0"] = t0
        if t1 is not None:
            params["t1"] = t1
        return [EvidenceUnit.model_validate(u) for u in self._req("GET", f"/v1/media/{media_id}/evidence",
                                                                  params=params)]
