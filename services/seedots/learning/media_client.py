"""The learning backend's only way to reach the foundation: its public HTTP API.

`client` is any httpx.Client; tests pass FastAPI's TestClient for an in-process foundation."""
from __future__ import annotations

from typing import Any

import httpx

from seedots.common.contracts import EvidenceUnit, MediaEvent


class MediaAPIError(RuntimeError):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status


class MediaClient:
    def __init__(self, client: httpx.Client):
        self.http = client

    @classmethod
    def at(cls, base_url: str) -> MediaClient:
        return cls(httpx.Client(base_url=base_url.rstrip("/"), timeout=60))

    def _req(self, method: str, path: str, **kw: Any) -> Any:
        try:
            r = self.http.request(method, path, **kw)
        except httpx.HTTPError as exc:
            raise MediaAPIError(503, f"foundation unreachable: {exc}") from exc
        if r.status_code >= 400:
            try:
                detail = r.json().get("detail", r.text)
            except ValueError:
                detail = r.text
            raise MediaAPIError(r.status_code, str(detail))
        return r.json()

    def register(self, body: dict[str, Any]) -> dict:
        return self._req("POST", "/v1/media", json=body)

    def upload(self, *, filename: str, fileobj, captions: tuple[str, Any] | None, owner: str, language: str) -> dict:
        files = {"file": (filename, fileobj)}
        if captions:
            files["captions"] = captions
        return self._req("POST", "/v1/media/upload", files=files, data={"owner": owner, "language": language},
                         timeout=600)

    def analyze(self, media_id: str, priority_from: float | None = None) -> dict:
        return self._req("POST", f"/v1/media/{media_id}/analyze", json={"priority_from": priority_from})

    def get(self, media_id: str) -> dict:
        return self._req("GET", f"/v1/media/{media_id}")

    def evidence(self, media_id: str, kinds: str = "sentence,chapter", t0: float | None = None,
                 t1: float | None = None) -> list[EvidenceUnit]:
        params: dict[str, Any] = {"kinds": kinds}
        if t0 is not None:
            params["t0"] = t0
        if t1 is not None:
            params["t1"] = t1
        return [EvidenceUnit.model_validate(u) for u in self._req("GET", f"/v1/media/{media_id}/evidence",
                                                                  params=params)]

    def evidence_one(self, evidence_id: str, revision: int | None = None) -> EvidenceUnit:
        params = {"revision": revision} if revision else {}
        return EvidenceUnit.model_validate(self._req("GET", f"/v1/evidence/{evidence_id}", params=params))

    def correct(self, evidence_id: str, text: str, by: str) -> EvidenceUnit:
        return EvidenceUnit.model_validate(self._req("PATCH", f"/v1/evidence/{evidence_id}",
                                                     json={"text": text, "by": by}))

    def events(self, media_id: str, after_seq: int = 0) -> list[MediaEvent]:
        return [MediaEvent.model_validate(e) for e in self._req("GET", "/v1/events",
                                                                params={"media_id": media_id, "after_seq": after_seq})]

    def file_url(self, media_id: str, name: str | None = None) -> str:
        base = str(self.http.base_url).rstrip("/")
        return f"{base}/v1/media/{media_id}/frames/{name}" if name else f"{base}/v1/media/{media_id}/file"

    def stream_file(self, media_id: str, headers: dict[str, str]):
        req = self.http.build_request("GET", f"/v1/media/{media_id}/file", headers=headers)
        return self.http.send(req, stream=True)
