"""Webhook dispatcher: delivers outbox events to subscriptions with exponential backoff.
A delivery that keeps failing becomes `dead` and stays visible for manual replay.
Consumers dedupe by event_id and tolerate out-of-order arrival (they re-read state)."""
from __future__ import annotations

import json
import logging
import threading
from collections.abc import Callable
from datetime import timedelta

import sqlalchemy as sa

from seedots.common.contracts import SIGNATURE_HEADER, sign
from seedots.common.db import Database, utcnow
from seedots.media.models import DeliveryStatus, OutboxEvent, WebhookDelivery, WebhookSubscription

log = logging.getLogger("seedots.media.webhooks")

Poster = Callable[[str, bytes, dict[str, str]], int]
MAX_ATTEMPTS = 12                       # ~ 1s, 2s, 4s ... capped at 10 min: about an hour in total


def httpx_post(url: str, body: bytes, headers: dict[str, str]) -> int:
    import httpx

    return httpx.post(url, content=body, headers=headers, timeout=10).status_code


def backoff(attempts: int) -> timedelta:
    return timedelta(seconds=min(600, 2 ** max(0, attempts - 1)))


class Dispatcher:
    def __init__(self, db: Database, poster: Poster = httpx_post, interval: float = 1.0, batch: int = 50):
        self.db, self.poster, self.interval, self.batch = db, poster, interval, batch
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def deliver_once(self) -> int:
        """Send due deliveries, oldest per media first (seq order keeps most consumers happy;
        correctness never depends on it)."""
        with self.db.session() as s:
            due = s.execute(
                sa.select(WebhookDelivery.event_id, WebhookDelivery.subscription_id, OutboxEvent.payload,
                          WebhookSubscription.url, WebhookSubscription.secret)
                .join(OutboxEvent, OutboxEvent.event_id == WebhookDelivery.event_id)
                .join(WebhookSubscription, WebhookSubscription.id == WebhookDelivery.subscription_id)
                .where(WebhookDelivery.status == DeliveryStatus.PENDING, WebhookDelivery.next_attempt_at <= utcnow(),
                       WebhookSubscription.active.is_(True))
                .order_by(OutboxEvent.media_id, OutboxEvent.seq).limit(self.batch)).all()
        sent = 0
        for event_id, sub_id, payload, url, secret in due:
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
            headers = {"Content-Type": "application/json", SIGNATURE_HEADER: sign(body, secret),
                       "X-SeeDots-Event": event_id}
            try:
                status = self.poster(url, body, headers)
                ok, err = 200 <= status < 300, f"HTTP {status}"
            except Exception as exc:
                ok, err = False, f"{type(exc).__name__}: {exc}"
            with self.db.session() as s:
                d = s.get(WebhookDelivery, (event_id, sub_id))
                d.attempts += 1
                if ok:
                    d.status, d.delivered_at, d.last_error = DeliveryStatus.DELIVERED, utcnow(), None
                    sent += 1
                else:
                    d.last_error = err[:500]
                    if d.attempts >= MAX_ATTEMPTS:
                        d.status = DeliveryStatus.DEAD
                    else:
                        d.next_attempt_at = utcnow() + backoff(d.attempts)
        return sent

    def start(self) -> None:
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
