"""Catalog: users, the video mirror, chapters, evidence snapshots, and the foundation inbox.

Consumption of foundation events is idempotent (event_id) and order-tolerant: handlers never
trust the event body for state, they re-read it from the foundation's pull API.
"""
from __future__ import annotations

import logging
from collections.abc import Callable, Iterable
from typing import Any

import sqlalchemy as sa
from sqlalchemy.orm import Session

from seedots.common.contracts import EvidenceUnit, MediaEvent
from seedots.common.db import Database, utcnow
from seedots.learning.media_client import MediaClient
from seedots.learning.models import (Chapter, EvidenceSnapshot, InboxEvent, LibraryEntry, User, UserSettings, Video,
                                     VideoStatus, Visibility)

log = logging.getLogger("seedots.learning.catalog")

ChapterReady = Callable[[str, str], None]          # (media_id, chapter_id) -> start generation


class AccessDenied(PermissionError):
    pass


# ------------------------------------------------------------------------------ users
def ensure_user(s: Session, user_id: str) -> User:
    user = s.get(User, user_id)
    if user is None:
        user = User(id=user_id, display_name=user_id)
        s.add(user)
        s.add(UserSettings(user_id=user_id))
        s.flush()
    return user


def visible_video(s: Session, media_id: str, user_id: str) -> Video:
    v = s.get(Video, media_id)
    if v is None:
        raise KeyError(media_id)
    if v.visibility == Visibility.PRIVATE and v.owner_id != user_id:
        raise AccessDenied(media_id)
    return v


def visible_media_ids(s: Session, user_id: str) -> sa.Select:
    """Subquery: media the user may read (public + their own private)."""
    return sa.select(Video.media_id).where(sa.or_(Video.visibility == Visibility.PUBLIC, Video.owner_id == user_id))


# ------------------------------------------------------------------------------ mirror
def playback_of(media: dict[str, Any]) -> dict[str, Any]:
    caps = media.get("capabilities") or {}
    if caps.get("playback") == "youtube_embed":
        return {"kind": "youtube_embed", "video_id": (media.get("platform_meta") or {}).get("video_id")
                or media.get("external_id")}
    return {"kind": "file", "path": f"/api/videos/{media['id']}/file"}


STATUS = {"registered": VideoStatus.REGISTERED, "analyzing": VideoStatus.ANALYZING, "ready": VideoStatus.READY,
          "failed": VideoStatus.FAILED}


def upsert_video(s: Session, media: dict[str, Any]) -> Video:
    owner = media.get("owner")
    if owner:
        ensure_user(s, owner)
    v = s.get(Video, media["id"])
    if v is None:
        v = Video(media_id=media["id"], source_kind=media["source_kind"], visibility=Visibility(media["visibility"]),
                  owner_id=owner, capabilities=media.get("capabilities") or {}, playback=playback_of(media))
        s.add(v)
    v.title = media.get("title") or v.title or ""
    v.language = media.get("language") or v.language
    v.duration_s = media.get("duration") or v.duration_s
    v.capabilities, v.playback = media.get("capabilities") or v.capabilities, playback_of(media)
    v.status, v.status_detail = STATUS.get(media.get("status"), v.status), media.get("status_detail") or ""
    s.flush()
    return v


def add_to_library(s: Session, user_id: str, media_id: str) -> None:
    if s.get(LibraryEntry, (user_id, media_id)) is None:
        s.add(LibraryEntry(user_id=user_id, media_id=media_id))


def sync_outline(s: Session, media_id: str, chapters: list[EvidenceUnit]) -> list[Chapter]:
    """Chapters keep their evidence ids; a re-outline updates titles/ranges in place and
    the revision is recorded (content runs are keyed by chapter id + pipeline version)."""
    existing = {c.id: c for c in s.scalars(sa.select(Chapter).where(Chapter.media_id == media_id))}
    for i, c in enumerate(existing.values()):     # park ords so reordering never collides
        c.ord = -(i + 1)
    s.flush()
    out = []
    keep = {u.id for u in chapters}
    for c in existing.values():
        if c.id not in keep and c.retired_at is None:
            c.retired_at = utcnow()
    for ord_, u in enumerate(chapters):
        row = existing.get(u.id) or Chapter(id=u.id, media_id=media_id, ord=ord_, t0=u.t0, t1=u.t1, title="")
        row.ord, row.t0, row.t1, row.retired_at = ord_, u.t0, u.t1, None
        row.title, row.summary = u.content.get("title", ""), u.content.get("summary", "")
        row.evidence_revision = u.revision
        s.add(row)
        out.append(row)
    s.flush()
    return out


def snapshot(s: Session, units: Iterable[EvidenceUnit]) -> None:
    """Store evidence revisions we cite. A newer revision marks older ones not current."""
    for ord_, u in enumerate(units):
        if s.get(EvidenceSnapshot, (u.id, u.revision)) is not None:
            continue
        s.execute(sa.update(EvidenceSnapshot).where(EvidenceSnapshot.id == u.id).values(is_current=False))
        s.add(EvidenceSnapshot(id=u.id, revision=u.revision, media_id=u.media_id, kind=u.kind, ord=ord_, t0=u.t0,
                               t1=u.t1, content=u.content, source=u.source, confidence=u.confidence,
                               needs_review=u.needs_review, is_current=True))
    s.flush()


def current_sentences(s: Session, media_id: str, t0: float | None = None, t1: float | None = None
                      ) -> list[EvidenceSnapshot]:
    q = sa.select(EvidenceSnapshot).where(EvidenceSnapshot.media_id == media_id, EvidenceSnapshot.kind == "sentence",
                                          EvidenceSnapshot.is_current.is_(True))
    if t0 is not None:
        q = q.where(EvidenceSnapshot.t1 > t0)
    if t1 is not None:
        q = q.where(EvidenceSnapshot.t0 < t1)
    return list(s.scalars(q.order_by(EvidenceSnapshot.t0)))


def short(evidence_id: str) -> str:
    return evidence_id.rsplit(".", 1)[-1]


# ------------------------------------------------------------------------------ inbox
class Inbox:
    def __init__(self, db: Database, media: MediaClient, on_chapter_ready: ChapterReady):
        self.db, self.media, self.on_chapter_ready = db, media, on_chapter_ready

    def accept(self, ev: MediaEvent) -> str:
        with self.db.session() as s:
            if s.get(InboxEvent, ev.event_id) is not None:
                return "duplicate"
            s.add(InboxEvent(event_id=ev.event_id, media_id=ev.media_id, seq=ev.seq, type=ev.type,
                             payload=ev.model_dump()))
        try:
            self._apply(ev)
        except Exception as exc:
            with self.db.session() as s:
                s.get(InboxEvent, ev.event_id).error = str(exc)[:500]
            raise
        with self.db.session() as s:
            s.get(InboxEvent, ev.event_id).processed_at = utcnow()
        return "ok"

    def catch_up(self, media_id: str) -> int:
        """Pull API fallback: apply any events we missed (e.g. while this service was down)."""
        with self.db.session() as s:
            v = s.get(Video, media_id)
            after = v.last_event_seq if v else 0
        n = 0
        for ev in self.media.events(media_id, after):
            n += self.accept(ev) == "ok"
        return n

    def refresh_video(self, media_id: str) -> None:
        media = self.media.get(media_id)
        with self.db.session() as s:
            upsert_video(s, media)

    def _apply(self, ev: MediaEvent) -> None:
        self.refresh_video(ev.media_id)
        with self.db.session() as s:
            v = s.get(Video, ev.media_id)
            v.last_event_seq = max(v.last_event_seq, ev.seq)
        if ev.type in ("media.outline_ready", "media.chapter_ready"):
            self._sync_outline(ev.media_id)
        if ev.type == "media.chapter_ready":
            with self.db.session() as s:
                ch = s.get(Chapter, ev.data["chapter_id"])
                if ch is None:
                    return                      # outline revised since; a newer event covers it
                ch.ready = True
            self.on_chapter_ready(ev.media_id, ev.data["chapter_id"])
        elif ev.type == "media.evidence_revised":
            unit = self.media.evidence_one(ev.data["evidence_id"], ev.data.get("revision"))
            with self.db.session() as s:
                snapshot(s, [unit])

    def _sync_outline(self, media_id: str) -> None:
        chapters = self.media.evidence(media_id, kinds="chapter")
        with self.db.session() as s:
            sync_outline(s, media_id, chapters)
