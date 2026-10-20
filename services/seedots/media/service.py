"""Application layer of the foundation: register -> analyze (staged, idempotent) -> publish events.

Job execution here is an in-process worker per media. The tech plan puts this on Temporal;
stages are already keyed by (media, stage, processor version) so moving each stage into a
Temporal Activity does not change their contract.
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path

from seedots.common.contracts import EvidenceUnit, MediaEvent
from seedots.common.ids import new_id, now_ms
from seedots.common.llm import Gateway
from seedots.media.processors import CAPTIONS_VERSION, OUTLINE_VERSION, caption_evidence, outline_evidence
from seedots.media.sources import SourceError, adapter_for
from seedots.media.store import MediaStore

log = logging.getLogger("seedots.media")

PUBLISH_VERSION = "publish@1"


class MediaService:
    def __init__(self, store: MediaStore, gateway: Gateway | None, data_dir: Path):
        self.store = store
        self.gateway = gateway
        self.data_dir = data_dir
        self._running: set[str] = set()
        self._lock = threading.Lock()

    # ------------------------------------------------------------ register
    def register(self, *, kind: str, uri: str, visibility: str, owner: str | None, language: str,
                 rights_attestation: str | None) -> dict:
        if kind == "webpage" and not rights_attestation:
            raise SourceError("Confirm you have the right to use this video before adding a web page source")
        adapter = adapter_for(kind, uri)
        reg = adapter.register(uri)
        if kind == "platform":
            visibility, owner = "public", None
        existing = self.store.find_dedupe(reg.dedupe_key, visibility, owner)
        if existing:
            return existing
        media_id = new_id("med")
        self.store.insert_media({
            "id": media_id, "source_kind": kind, "source_uri": uri, "dedupe_key": reg.dedupe_key,
            "visibility": visibility, "owner": owner, "language": language, "title": reg.title,
            "duration": reg.duration, "capabilities": reg.capabilities.model_dump(),
            "platform_meta": reg.platform_meta, "rights_attestation": rights_attestation,
            "status": "registered", "status_detail": "", "priority_from": None,
        })
        self._emit(media_id, "media.registered", {"title": reg.title})
        return self.store.get_media(media_id)

    # ------------------------------------------------------------ analyze
    def analyze(self, media_id: str, priority_from: float | None = None, background: bool = True) -> dict:
        media = self.store.get_media(media_id)
        if not media:
            raise KeyError(media_id)
        self.store.update_media(media_id, priority_from=priority_from)
        with self._lock:
            if media_id in self._running:
                return self.store.get_media(media_id)
            self._running.add(media_id)
        self.store.update_media(media_id, status="analyzing", status_detail="queued")
        if background:
            threading.Thread(target=self._run, args=(media_id,), daemon=True, name=f"analyze-{media_id}").start()
        else:
            self._run(media_id)
        return self.store.get_media(media_id)

    def _run(self, media_id: str) -> None:
        try:
            self._pipeline(media_id)
        except SourceError as exc:
            self._fail(media_id, str(exc))
        except Exception as exc:  # unexpected: keep the message short, log the trace
            log.exception("analysis failed for %s", media_id)
            self._fail(media_id, f"Analysis failed: {exc}")
        finally:
            with self._lock:
                self._running.discard(media_id)

    def _fail(self, media_id: str, message: str) -> None:
        self.store.update_media(media_id, status="failed", status_detail=message)
        self._emit(media_id, "media.failed", {"reason": message})

    def _stage(self, media_id: str, stage: str, version: str, fn) -> None:
        if self.store.stage_status(media_id, stage, version) == "done":
            return
        self.store.update_media(media_id, status_detail=stage)
        self.store.stage_mark(media_id, stage, version, "running")
        try:
            fn()
        except Exception as exc:
            self.store.stage_mark(media_id, stage, version, "failed", str(exc)[:300])
            raise
        self.store.stage_mark(media_id, stage, version, "done")

    def _pipeline(self, media_id: str) -> None:
        media = self.store.get_media(media_id)
        adapter = adapter_for(media["source_kind"], media["source_uri"])
        media_dir = self.data_dir / "media" / media_id
        media_dir.mkdir(parents=True, exist_ok=True)

        def captions() -> None:
            track = adapter.captions(media["source_uri"], media["language"], media_dir)
            units = caption_evidence(media_id, track.text, track.source)
            if not units:
                raise SourceError("The caption track is empty")
            self.store.replace_evidence(media_id, "sentence", units)

        def outline() -> None:
            sentences = self.store.evidence(media_id, kinds=["sentence"])
            hints = (media.get("platform_meta") or {}).get("chapters") or []
            chapters = outline_evidence(media_id, media["title"] or "", sentences, hints, self.gateway)
            self.store.replace_evidence(media_id, "chapter", chapters)

        def publish() -> None:
            chapters = self.store.evidence(media_id, kinds=["chapter"])
            self._emit(media_id, "media.outline_ready",
                       {"chapters": [{"id": c.id, "t0": c.t0, "t1": c.t1, "title": c.content["title"]}
                                     for c in chapters]})
            for c in order_by_priority(chapters, self.store.get_media(media_id).get("priority_from")):
                self._emit(media_id, "media.chapter_ready",
                           {"chapter_id": c.id, "t0": c.t0, "t1": c.t1, "title": c.content["title"]})

        self._stage(media_id, "captions", CAPTIONS_VERSION, captions)
        self._stage(media_id, "outline", OUTLINE_VERSION, outline)
        # Pass 2 (keyframes + region evidence) needs a vision model and frames; not in this build.
        self._stage(media_id, "publish", PUBLISH_VERSION, publish)
        self.store.update_media(media_id, status="ready", status_detail="")

    # ------------------------------------------------------------ corrections
    def correct_sentence(self, evidence_id: str, text: str) -> EvidenceUnit:
        found = self.store.evidence_by_id(evidence_id)
        if not found:
            raise KeyError(evidence_id)
        unit, ord_ = found
        if unit.kind != "sentence":
            raise SourceError("Only sentence text can be corrected")
        new = unit.model_copy(update={"revision": unit.revision + 1, "content": {"text": text.strip()},
                                      "source": "manual", "confidence": 1.0, "needs_review": False})
        self.store.add_revision(new, ord_)
        return new

    # ------------------------------------------------------------ events
    def _emit(self, media_id: str, type_: str, data: dict) -> None:
        seq = self.store.next_seq(media_id)
        ev = MediaEvent(event_id=new_id("evt"), type=type_, media_id=media_id, seq=seq,
                        occurred_at=now_ms(), data=data)
        self.store.enqueue(ev.event_id, media_id, seq, type_, ev.model_dump_json())


def order_by_priority(chapters: list[EvidenceUnit], t: float | None) -> list[EvidenceUnit]:
    """Chapters from the playback position onward first, then the earlier ones."""
    if t is None:
        return chapters
    idx = next((i for i, c in enumerate(chapters) if c.t0 <= t < c.t1), 0)
    return chapters[idx:] + chapters[:idx]
