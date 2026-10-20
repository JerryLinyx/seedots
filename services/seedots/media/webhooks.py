"""Outbox dispatcher: delivers persisted events to subscribers with retries and backoff.
Consumers dedupe by event_id and tolerate out-of-order arrival (they re-fetch state)."""
from __future__ import annotations

import logging
import threading
from typing import Callable

from seedots.common.contracts import SIGNATURE_HEADER, sign
from seedots.media.store import MediaStore

log = logging.getLogger("seedots.media.webhooks")

Poster = Callable[[str, bytes, dict[str, str]], int]


def httpx_post(url: str, body: bytes, headers: dict[str, str]) -> int:
    import httpx

    return httpx.post(url, content=body, headers=headers, timeout=10).status_code


class Dispatcher:
    def __init__(self, store: MediaStore, url: str, secret: str, poster: Poster = httpx_post, interval: float = 1.0):
        self.store, self.url, self.secret, self.poster, self.interval = store, url, secret, poster, interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def deliver_once(self) -> int:
        delivered = 0
        for row in self.store.pending_events():
            body = row["body"].encode()
            headers = {"Content-Type": "application/json", SIGNATURE_HEADER: sign(body, self.secret)}
            try:
                status = self.poster(self.url, body, headers)
                ok = 200 <= status < 300
                err = "" if ok else f"HTTP {status}"
            except Exception as exc:
                ok, err = False, str(exc)
            if ok:
                self.store.mark_delivered(row["event_id"])
                delivered += 1
            else:
                self.store.mark_failed(row["event_id"], err, row["attempts"] + 1)
        return delivered

    def start(self) -> None:
        if not self.url:
            log.warning("No webhook URL configured; events stay in the outbox")
            return

        def loop() -> None:
            while not self._stop.wait(self.interval):
                try:
                    self.deliver_once()
                except Exception:
                    log.exception("dispatch loop error")

        self._thread = threading.Thread(target=loop, daemon=True, name="media-webhooks")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
