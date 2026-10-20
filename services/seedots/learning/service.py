"""Glue between events from the foundation and content generation."""
from __future__ import annotations

import logging
import queue
import threading

from seedots.common.contracts import MediaEvent
from seedots.learning.media_client import MediaClient
from seedots.learning.pipeline import ChapterPipeline
from seedots.learning.store import LearningStore

log = logging.getLogger("seedots.learning")


class ContentWorker:
    """Single background worker: chapters are generated one at a time, in arrival order
    (the foundation already orders chapter_ready by playback priority)."""

    def __init__(self, pipeline: ChapterPipeline):
        self.pipeline = pipeline
        self.q: queue.Queue[tuple[str, str]] = queue.Queue()
        threading.Thread(target=self._loop, daemon=True, name="content-worker").start()

    def submit(self, media_id: str, chapter_id: str) -> None:
        self.q.put((media_id, chapter_id))

    def _loop(self) -> None:
        while True:
            media_id, chapter_id = self.q.get()
            try:
                log.info("generating %s %s -> %s", media_id, chapter_id, self.pipeline.run(media_id, chapter_id))
            except Exception:
                log.exception("content generation failed for %s", chapter_id)


def handle_media_event(ev: MediaEvent, store: LearningStore, media: MediaClient, submit) -> str:
    """Idempotent by event_id; tolerant of order (state is re-read from the foundation)."""
    if not store.inbox_accept(ev.event_id, ev.type):
        return "duplicate"
    if ev.type == "media.registered":
        store.upsert_video(media.get(ev.media_id))
    elif ev.type == "media.outline_ready":
        if not store.video(ev.media_id):
            store.upsert_video(media.get(ev.media_id))
        store.set_video_chapters(ev.media_id, ev.data.get("chapters", []))
    elif ev.type == "media.chapter_ready":
        if not store.video(ev.media_id):
            store.upsert_video(media.get(ev.media_id))
        submit(ev.media_id, ev.data["chapter_id"])
    elif ev.type == "media.failed":
        store.set_video_status(ev.media_id, "failed", ev.data.get("reason", ""))
    return "ok"
