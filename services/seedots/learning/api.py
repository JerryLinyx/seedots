"""Learning backend — HTTP API (port 8000). The web app calls only this service.

  POST /hooks/media                          signed foundation webhooks (idempotent, order-tolerant)

  GET  /api/me                               GET|PUT /api/settings
  POST /api/videos                           add by link (YouTube -> platform; other pages -> webpage + rights)
  POST /api/videos/upload                    add a file (+ optional captions)
  GET  /api/videos                           the learner's library
  GET  /api/videos/{id}                      status + content progress;  DELETE removes it from the library
  PUT  /api/videos/{id}/position             resume point
  GET  /api/videos/{id}/progress             SSE: analysis + generation progress
  POST /api/videos/{id}/retry                restart chapters whose content generation failed
  GET  /api/videos/{id}/pack                 everything the player needs, no answers
  GET  /api/videos/{id}/file | /frames/{n}   media we hold (range requests pass through)

  POST /api/events                           batched behaviour events (append-only)
  GET  /api/scenes/{scene_id}/live          lab build events (SSE)
  POST /api/decide                           signal -> action (+ item / rewatch span / link)
  POST /api/decisions/{id}/outcome           shown | dismissed | suppressed
  POST /api/attempts                         grade server-side, update mastery
  POST /api/coach                            SSE: grounded coach answer;  GET /api/coach/{media_id}
  POST /api/marks ; DELETE /api/marks/{id}
  PATCH /api/evidence/{id}                   correct a transcript sentence (new revision in the foundation)

  GET  /api/map ; GET /api/concepts/{id} ; GET /api/search?q=
  POST /api/concepts/{id}/card ; GET /api/cards ; PATCH /api/cards/{id}
  POST /api/links/{id}                       confirm / dismiss a cross-video link

  review (curators): POST /api/items/{id}/review ; GET /api/review/candidates ;
                     POST /api/review/candidates/{id} ; POST /api/review/merges/{id}/rollback
  GET  /api/usage
Run:  uvicorn --factory seedots.learning.api:create_app --port 8000
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from typing import Any, Literal

import sqlalchemy as sa
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from seedots.common.contracts import SIGNATURE_HEADER, MediaEvent, verify
from seedots.common.db import utcnow
from seedots.common.ids import new_id
from seedots.common.llm import LLMError
from seedots.learning import items as item_store
from seedots.learning.app import LearningContainer, build_container
from seedots.learning.catalog import (AccessDenied, add_to_library, ensure_user, short, upsert_video, visible_video)
from seedots.learning.media_client import MediaAPIError
from seedots.learning.models import (Attempt, Chapter, ConceptCandidate, ContentRun, EvidenceSnapshot, LearningItem, LibraryEntry, Mark,
                                     Occurrence, Purpose, ReviewStatus, RunStatus, UsageLog, UserSettings, Video)
from seedots.learning.pipeline import PIPELINE_VERSION
from seedots.learning.runtime import Signal
from seedots.common.platforms import youtube_id

log = logging.getLogger("seedots.learning.api")


def sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


def current_user(x_seedots_user: str | None = Header(None), u: str | None = Query(None)) -> str:
    """Placeholder for the hosted auth provider: the subject arrives in a header in dev
    (or `?u=` for media tags, which cannot send headers)."""
    uid = (x_seedots_user or u or "demo").strip()[:64]
    return uid or "demo"


# ------------------------------------------------------------------------------ bodies
class AddVideoIn(BaseModel):
    url: str = Field(min_length=3, max_length=4000)
    rights_statement: str | None = Field(None, max_length=1000)
    priority_from: float | None = None
    language: str = "en"


class PositionIn(BaseModel):
    t: float = Field(ge=0)


class EventsIn(BaseModel):
    events: list[dict[str, Any]] = Field(max_length=500)


class DecideIn(BaseModel):
    media_id: str
    signal: Signal


class OutcomeIn(BaseModel):
    outcome: Literal["shown", "dismissed", "suppressed"]


class AttemptIn(BaseModel):
    item_id: str
    response: dict[str, Any]
    assisted: bool = False
    confidence: int | None = Field(None, ge=1, le=5)
    decision_id: str | None = None


class CoachIn(BaseModel):
    media_id: str
    t: float = Field(ge=0)
    question: str = Field("", max_length=2000)


class MarkIn(BaseModel):
    media_id: str
    t: float = Field(ge=0)
    type: Literal["useful", "resonate", "confused"]
    note: str = Field("", max_length=500)


class CorrectIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


class SettingsIn(BaseModel):
    focus_mode: bool | None = None
    max_cards_per_5min: int | None = Field(None, ge=0, le=10)
    purpose: Literal["interest", "exam", "work", "research"] | None = None
    language: str | None = None


class CardIn(BaseModel):
    title: str | None = None
    body: str | None = None
    status: Literal["draft", "confirmed", "archived"] | None = None


class LinkIn(BaseModel):
    status: Literal["confirmed", "dismissed"]


class ReviewIn(BaseModel):
    status: Literal["human_reviewed", "rejected", "auto_validated", "retired"]
    note: str = ""


class CandidateIn(BaseModel):
    merge: bool


class SceneIn(BaseModel):
    media_id: str
    chapter_id: str
    request: str = Field("", max_length=500)


# ------------------------------------------------------------------------------ app
def create_app(container: LearningContainer | None = None) -> FastAPI:
    logging.basicConfig(level=logging.INFO)
    c = container or build_container()
    db = c.db

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        c.runner.resume()
        c.scenes.resume()
        yield

    app = FastAPI(title="SeeDots learning backend", version="0.2.0", lifespan=lifespan)
    app.state.container = c
    app.add_middleware(CORSMiddleware, allow_origins=c.settings.web_origins, allow_methods=["*"],
                       allow_headers=["*"], expose_headers=["Content-Range", "Accept-Ranges"])

    @app.exception_handler(AccessDenied)
    async def _denied(_: Request, __: AccessDenied):
        from fastapi.responses import JSONResponse
        return JSONResponse({"detail": "not found"}, status_code=404)

    @app.exception_handler(MediaAPIError)
    async def _media_err(_: Request, exc: MediaAPIError):
        from fastapi.responses import JSONResponse
        status = exc.status if 400 <= exc.status < 500 else 502
        return JSONResponse({"detail": str(exc)}, status_code=status)

    def _404(fn, *a, **kw):
        try:
            return fn(*a, **kw)
        except KeyError as exc:
            raise HTTPException(404, "not found") from exc

    # ================================================================== webhooks
    @app.post("/hooks/media")
    async def media_hook(request: Request) -> dict:
        body = await request.body()
        if not verify(body, c.settings.webhook_secret, request.headers.get(SIGNATURE_HEADER)):
            raise HTTPException(401, "bad signature")
        ev = MediaEvent.model_validate_json(body)
        return {"status": await asyncio.to_thread(c.inbox.accept, ev)}

    # ================================================================== user
    @app.get("/health")
    def health() -> dict:
        return {"ok": True, "model": c.gateway.model_name, "engine": type(c.engine).__name__,
                "selector": "llm" if c.runtime.use_llm else "rule", "embedder": c.library.embedder.name}

    @app.get("/api/me")
    def me(user: str = Depends(current_user)) -> dict:
        with db.session() as s:
            u = ensure_user(s, user)
            return {"id": u.id, "name": u.display_name}

    def _settings_out(st: UserSettings) -> dict:
        return {"focus_mode": st.focus_mode, "max_cards_per_5min": st.max_cards_per_5min,
                "purpose": st.purpose.value, "language": st.language}

    @app.get("/api/settings")
    def get_settings(user: str = Depends(current_user)) -> dict:
        with db.session() as s:
            ensure_user(s, user)
            return _settings_out(s.get(UserSettings, user))

    @app.put("/api/settings")
    def put_settings(body: SettingsIn, user: str = Depends(current_user)) -> dict:
        with db.session() as s:
            ensure_user(s, user)
            st = s.get(UserSettings, user)
            for k, v in body.model_dump(exclude_none=True).items():
                setattr(st, k, Purpose(v) if k == "purpose" else v)
            s.flush()
            return _settings_out(st)

    # ================================================================== videos
    def video_out(s, v: Video, user: str) -> dict:
        runs = dict(s.execute(sa.select(ContentRun.chapter_id, ContentRun.status).join(Chapter)
                              .where(Chapter.media_id == v.media_id, ContentRun.pipeline_version == PIPELINE_VERSION))
                    .all())
        n_ch = s.scalar(sa.select(sa.func.count()).select_from(Chapter).where(
            Chapter.media_id == v.media_id, Chapter.retired_at.is_(None))) or 0
        n_items = s.scalar(sa.select(sa.func.count()).select_from(LearningItem).where(
            LearningItem.media_id == v.media_id, LearningItem.superseded_at.is_(None),
            LearningItem.review_status.in_(item_store.USABLE))) or 0
        entry = s.get(LibraryEntry, (user, v.media_id))
        return {"media_id": v.media_id, "title": v.title, "source_kind": v.source_kind, "visibility": v.visibility.value,
                "duration": v.duration_s, "playback": v.playback, "capabilities": v.capabilities,
                "status": v.status.value, "status_detail": v.status_detail,
                "content": {"chapters_total": n_ch,
                            "chapters_done": sum(st == RunStatus.DONE for st in runs.values()),
                            "chapters_failed": sum(st == RunStatus.FAILED for st in runs.values()),
                            "items": n_items},
                "position": entry.last_position_s if entry else 0.0,
                "added_at": entry.added_at if entry else None}

    def register_and_track(user: str, media: dict) -> dict:
        with db.session() as s:
            ensure_user(s, user)
            v = upsert_video(s, media)
            add_to_library(s, user, v.media_id)
            s.flush()
            return video_out(s, v, user)

    @app.post("/api/videos", status_code=201)
    def add_video(body: AddVideoIn, user: str = Depends(current_user)) -> dict:
        url = body.url.strip()
        if youtube_id(url):
            source: dict[str, Any] = {"kind": "platform", "uri": url}
            visibility = "public"
        else:
            if not body.rights_statement:
                raise HTTPException(422, "For videos from other web pages, confirm you have the right to use them")
            source = {"kind": "webpage", "uri": url,
                      "rights_attestation": {"statement": body.rights_statement, "by": user}}
            visibility = "private"
        media = c.media.register({"source": source, "visibility": visibility, "owner": user,
                                  "language": body.language, "priority_from": body.priority_from})
        return register_and_track(user, media)

    @app.post("/api/videos/upload", status_code=201)
    def upload(file: UploadFile = File(...), captions: UploadFile | None = File(None), language: str = Form("en"),
               user: str = Depends(current_user)) -> dict:
        cap = (captions.filename, captions.file) if captions is not None and captions.filename else None
        media = c.media.upload(filename=file.filename or "video.mp4", fileobj=file.file, captions=cap, owner=user,
                               language=language)
        return register_and_track(user, media)

    @app.get("/api/videos")
    def list_videos(user: str = Depends(current_user)) -> list[dict]:
        with db.session() as s:
            ensure_user(s, user)
            rows = s.scalars(sa.select(Video).join(LibraryEntry, LibraryEntry.media_id == Video.media_id)
                             .where(LibraryEntry.user_id == user)
                             .order_by(sa.func.coalesce(LibraryEntry.last_opened_at, LibraryEntry.added_at).desc()))
            return [video_out(s, v, user) for v in rows]

    def refresh(media_id: str) -> None:
        try:
            c.inbox.refresh_video(media_id)
        except MediaAPIError:
            pass                                    # foundation down: serve what we have

    @app.get("/api/videos/{media_id}")
    def get_video(media_id: str, user: str = Depends(current_user)) -> dict:
        refresh(media_id)
        with db.session() as s:
            return video_out(s, _404(visible_video, s, media_id, user), user)

    @app.delete("/api/videos/{media_id}")
    def remove_video(media_id: str, user: str = Depends(current_user)) -> dict:
        with db.session() as s:
            entry = s.get(LibraryEntry, (user, media_id))
            if entry:
                s.delete(entry)
        return {"ok": True}

    @app.put("/api/videos/{media_id}/position")
    def position(media_id: str, body: PositionIn, user: str = Depends(current_user)) -> dict:
        with db.session() as s:
            _404(visible_video, s, media_id, user)
            add_to_library(s, user, media_id)
            s.flush()
            entry = s.get(LibraryEntry, (user, media_id))
            entry.last_position_s, entry.last_opened_at = body.t, utcnow()
        return {"ok": True}

    @app.get("/api/videos/{media_id}/progress")
    async def progress(media_id: str, user: str = Depends(current_user)) -> StreamingResponse:
        def snap() -> dict:
            refresh(media_id)
            with db.session() as s:
                v = video_out(s, _404(visible_video, s, media_id, user), user)
            return {"status": v["status"], "detail": v["status_detail"], **v["content"]}

        first = await asyncio.to_thread(snap)          # 404 before the stream starts

        async def gen():
            last, cur = None, first
            for _ in range(2400):
                if cur != last:
                    yield sse("progress", cur)
                    last = cur
                total, settled = cur["chapters_total"], cur["chapters_done"] + cur["chapters_failed"]
                if cur["status"] == "failed" or (cur["status"] == "ready" and total and settled >= total):
                    yield sse("end", cur)
                    return
                await asyncio.sleep(1.5)
                cur = await asyncio.to_thread(snap)
        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.post("/api/videos/{media_id}/retry")
    def retry(media_id: str, user: str = Depends(current_user)) -> dict:
        with db.session() as s:
            _404(visible_video, s, media_id, user)
        return {"restarted": c.runner.retry_failed(media_id)}

    @app.get("/api/videos/{media_id}/pack")
    def pack(media_id: str, user: str = Depends(current_user)) -> dict:
        with db.session() as s:
            ensure_user(s, user)
            v = _404(visible_video, s, media_id, user)
            video = video_out(s, v, user)
            snaps = list(s.scalars(sa.select(EvidenceSnapshot).where(EvidenceSnapshot.media_id == media_id,
                                                                     EvidenceSnapshot.kind == "sentence",
                                                                     EvidenceSnapshot.is_current.is_(True))
                                   .order_by(EvidenceSnapshot.t0)))
        if not snaps:                               # content not generated yet: read straight from the foundation
            try:
                units = c.media.evidence(media_id, kinds="sentence")
            except MediaAPIError:
                units = []
            sentences = [{"id": u.id, "ref": u.short, "t0": u.t0, "t1": u.t1, "text": u.content["text"],
                          "confidence": u.confidence, "needs_review": u.needs_review} for u in units]
        else:
            sentences = [{"id": x.id, "ref": short(x.id), "t0": x.t0, "t1": x.t1, "text": x.content.get("text", ""),
                          "confidence": x.confidence, "needs_review": x.needs_review} for x in snaps]
        frames: list[dict] = []
        if v.capabilities.get("frames"):
            try:
                frames = [{"id": u.id, "t": u.t0, "src": f"/api/videos/{media_id}/frames/{u.frame_ref.split('/')[-1]}"}
                          for u in c.media.evidence(media_id, kinds="keyframe") if u.frame_ref]
            except MediaAPIError:
                frames = []
        with db.session() as s:
            runs = dict(s.execute(sa.select(ContentRun.chapter_id, ContentRun.status)
                                  .where(ContentRun.pipeline_version == PIPELINE_VERSION)).all())
            chapters = [{"id": ch.id, "t0": ch.t0, "t1": ch.t1, "title": ch.title, "summary": ch.summary,
                         "content_status": runs[ch.id].value if ch.id in runs else "pending"}
                        for ch in s.scalars(sa.select(Chapter).where(Chapter.media_id == media_id,
                                                                     Chapter.retired_at.is_(None)).order_by(Chapter.ord))]
            occ = list(s.scalars(sa.select(Occurrence).where(Occurrence.media_id == media_id).order_by(Occurrence.t0)))
            names = item_store.concept_names(s, (o.concept_id for o in occ))
            mine = sa.select(LibraryEntry.media_id).where(LibraryEntry.user_id == user)
            elsewhere: dict[str, list[dict]] = {}
            for o, title in s.execute(sa.select(Occurrence, Video.title).join(Video, Video.media_id == Occurrence.media_id)
                                      .where(Occurrence.concept_id.in_(list(names)), Occurrence.media_id != media_id,
                                             Occurrence.media_id.in_(mine))).all():
                elsewhere.setdefault(o.concept_id, []).append({"media_id": o.media_id, "title": title, "t0": o.t0})
            concepts: dict[str, dict] = {}
            for o in occ:
                cc = concepts.setdefault(o.concept_id, {"id": o.concept_id, "name": names.get(o.concept_id, ""),
                                                        "occurrences": [], "elsewhere": elsewhere.get(o.concept_id, [])})
                cc["occurrences"].append({"chapter_id": o.chapter_id, "t0": o.t0, "t1": o.t1, "role": o.role.value})
            pool = item_store.pool(s, media_id)
            tried = dict(s.execute(sa.select(Attempt.item_key, sa.func.max(sa.cast(Attempt.correct,
                                                                                              sa.Integer)))
                                   .where(Attempt.user_id == user,
                                          Attempt.item_key.in_([i.item_key for i in pool]))
                                   .group_by(Attempt.item_key)).all())
            projected = [{**p, "attempted": p["key"] in tried, "solved": bool(tried.get(p["key"]))}
                         for p in item_store.project(s, pool)]
            marks = [{"id": m.id, "t": m.t, "type": m.type.value, "note": m.note} for m in s.scalars(
                sa.select(Mark).where(Mark.user_id == user, Mark.media_id == media_id, Mark.deleted_at.is_(None))
                .order_by(Mark.t))]
            st = s.get(UserSettings, user)
            pack_out = {"video": video, "chapters": chapters, "sentences": sentences, "frames": frames,
                        "concepts": list(concepts.values()), "items": projected, "marks": marks,
                        "settings": _settings_out(st)}
        pack_out["scenes"] = c.scenes.for_video(media_id)
        return pack_out

    def _proxy(path_media: str, request: Request, frame: str | None = None) -> StreamingResponse:
        headers = {k: v for k, v in request.headers.items() if k.lower() in ("range", "if-range")}
        http = c.media.http
        url = f"/v1/media/{path_media}/frames/{frame}" if frame else f"/v1/media/{path_media}/file"
        r = http.send(http.build_request("GET", url, headers=headers), stream=True)
        if r.status_code >= 400:
            r.close()
            raise HTTPException(r.status_code if r.status_code < 500 else 502, "file not available")
        keep = {k: v for k, v in r.headers.items()
                if k.lower() in ("content-type", "content-length", "content-range", "accept-ranges", "last-modified")}

        def body():
            try:
                yield from r.iter_bytes()
            finally:
                r.close()
        return StreamingResponse(body(), status_code=r.status_code, headers=keep)

    @app.get("/api/videos/{media_id}/file")
    def video_file(media_id: str, request: Request, user: str = Depends(current_user)):
        with db.session() as s:
            _404(visible_video, s, media_id, user)
        return _proxy(media_id, request)

    @app.get("/api/videos/{media_id}/frames/{name}")
    def video_frame(media_id: str, name: str, request: Request, user: str = Depends(current_user)):
        with db.session() as s:
            _404(visible_video, s, media_id, user)
        return _proxy(media_id, request, frame=name)

    # ================================================================== runtime
    @app.post("/api/events")
    def events(body: EventsIn, user: str = Depends(current_user)) -> dict:
        from datetime import datetime, timezone

        from seedots.learning.models import LearningEvent

        accepted = 0
        with db.session() as s:
            ensure_user(s, user)
            known = {m for (m,) in s.execute(sa.select(Video.media_id))}
            ids = [e.get("event_id") for e in body.events]
            dup = set(s.scalars(sa.select(LearningEvent.event_id).where(LearningEvent.event_id.in_(ids))))
            for e in body.events:
                if not e.get("event_id") or not e.get("type"):
                    raise HTTPException(422, "each event needs event_id and type")
                if e["event_id"] in dup:
                    continue
                dup.add(e["event_id"])
                at = e.get("occurred_at")
                s.add(LearningEvent(
                    event_id=str(e["event_id"])[:64], user_id=user, session_id=e.get("session_id"),
                    media_id=e.get("media_id") if e.get("media_id") in known else None, type=str(e["type"])[:48],
                    media_time=e.get("media_time"), client_seq=e.get("client_seq"), payload=e.get("payload") or {},
                    occurred_at=datetime.fromtimestamp(at / 1000, timezone.utc) if isinstance(at, (int, float)) else None))
                accepted += 1
        return {"accepted": accepted}

    @app.post("/api/decide")
    def decide(body: DecideIn, user: str = Depends(current_user)) -> dict:
        return _404(c.runtime.decide, user, body.media_id, body.signal)

    @app.post("/api/decisions/{decision_id}/outcome")
    def outcome(decision_id: str, body: OutcomeIn, user: str = Depends(current_user)) -> dict:
        _404(c.runtime.outcome, user, decision_id, body.outcome)
        return {"ok": True}

    @app.post("/api/attempts")
    def attempt(body: AttemptIn, user: str = Depends(current_user)) -> dict:
        return _404(c.runtime.attempt, user, body.item_id, body.response, assisted=body.assisted,
                    confidence=body.confidence, decision_id=body.decision_id)

    @app.post("/api/coach")
    async def ask(body: CoachIn, user: str = Depends(current_user)) -> StreamingResponse:
        def check():
            with db.session() as s:
                _404(visible_video, s, body.media_id, user)
        await asyncio.to_thread(check)

        async def gen():
            try:
                async for part in c.coach.ask(user, body.media_id, body.t, body.question):
                    yield sse(part["type"], part)
            except LLMError as exc:
                yield sse("error", {"message": "The coach is unavailable right now.", "detail": str(exc)[:300]})
        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/api/coach/{media_id}")
    def coach_thread(media_id: str, user: str = Depends(current_user)) -> list[dict]:
        return c.coach.thread(user, media_id)

    @app.post("/api/marks", status_code=201)
    def add_mark(body: MarkIn, user: str = Depends(current_user)) -> dict:
        with db.session() as s:
            ensure_user(s, user)
            _404(visible_video, s, body.media_id, user)
            t = max(0.0, body.t - 5)                 # PRD R15: people react a beat after the moment
            under = s.scalar(sa.select(EvidenceSnapshot.id).where(
                EvidenceSnapshot.media_id == body.media_id, EvidenceSnapshot.kind == "sentence",
                EvidenceSnapshot.is_current.is_(True), EvidenceSnapshot.t0 <= t, EvidenceSnapshot.t1 > t))
            m = Mark(id=new_id("mrk"), user_id=user, media_id=body.media_id, t=t, type=body.type, note=body.note,
                     evidence_id=under)
            s.add(m)
            add_to_library(s, user, body.media_id)
            return {"id": m.id, "t": t, "type": body.type, "note": body.note}

    @app.delete("/api/marks/{mark_id}")
    def delete_mark(mark_id: str, user: str = Depends(current_user)) -> dict:
        with db.session() as s:
            m = s.get(Mark, mark_id)
            if m is None or m.user_id != user:
                raise HTTPException(404, "not found")
            m.deleted_at = utcnow()
        return {"ok": True}

    @app.patch("/api/evidence/{evidence_id}")
    def correct(evidence_id: str, body: CorrectIn, user: str = Depends(current_user)) -> dict:
        with db.session() as s:
            snap = s.scalar(sa.select(EvidenceSnapshot).where(EvidenceSnapshot.id == evidence_id))
            media_id = snap.media_id if snap else evidence_id.rsplit(".", 1)[0]
            _404(visible_video, s, media_id, user)
        unit = c.media.correct(evidence_id, body.text, user)
        with db.session() as s:
            from seedots.learning.catalog import snapshot
            snapshot(s, [unit])
        return {"id": unit.id, "revision": unit.revision, "text": unit.content["text"]}

    # ================================================================== scenes
    def _scene_visible(scene_id: str, user: str) -> None:
        media_id = _404(c.scenes.media_of, scene_id)
        with db.session() as s:
            _404(visible_video, s, media_id, user)

    @app.post("/api/scenes", status_code=202)
    def request_scene(body: SceneIn, user: str = Depends(current_user)) -> dict:
        """Ask the scene agent for an interactive (L2). Progress is readable at GET /api/scenes/{id}."""
        with db.session() as s:
            ensure_user(s, user)
            _404(visible_video, s, body.media_id, user)
        scene_id = _404(c.scenes.request, user, body.media_id, body.chapter_id, body.request)
        return c.scenes.get(scene_id)

    @app.get("/api/scenes/{scene_id}")
    def get_scene(scene_id: str, user: str = Depends(current_user)) -> dict:
        _scene_visible(scene_id, user)
        return c.scenes.get(scene_id)

    @app.get("/api/scenes/{scene_id}/runner")
    def scene_runner(scene_id: str, user: str = Depends(current_user)):
        """The generated scene page. Served with a CSP sandbox so it runs in an opaque origin
        even if opened directly; the app also embeds it in <iframe sandbox="allow-scripts">."""
        from fastapi.responses import HTMLResponse

        from seedots.learning.scenes.kit import CSP

        _scene_visible(scene_id, user)
        html = _404(c.scenes.runner, scene_id)
        return HTMLResponse(html, headers={
            "Content-Security-Policy": f"sandbox allow-scripts; {CSP}", "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer", "Cache-Control": "no-store"})

    @app.get("/api/scenes/{scene_id}/live")
    async def scene_live(scene_id: str, after: int = 0, user: str = Depends(current_user)) -> StreamingResponse:
        """What the builder is doing right now (server-sent events): stage changes, the agent searching rigs,
        reading cards, writing and checking drafts, a first draft to try. Ends with `done` and the scene."""
        await asyncio.to_thread(_scene_visible, scene_id, user)

        async def gen():
            seq, started, checked = after, time.monotonic(), 0.0
            while time.monotonic() - started < 900:
                events, closed = c.scenes.live.since(scene_id, seq)
                for e in events:
                    seq = e["seq"]
                    yield sse(e["type"], e)
                # the feed closes when the build ends; without a feed (another process) watch the row
                if not events and (closed or time.monotonic() - checked > 2):
                    checked = time.monotonic()
                    scene = await asyncio.to_thread(c.scenes.get, scene_id)
                    if closed or scene["status"] in ("ready", "failed"):
                        yield sse("done", scene)
                        return
                await asyncio.sleep(0.3)
            yield sse("done", await asyncio.to_thread(c.scenes.get, scene_id))
        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.get("/api/scenes/{scene_id}/preview.png")
    def scene_preview(scene_id: str, user: str = Depends(current_user)):
        from fastapi.responses import FileResponse

        _scene_visible(scene_id, user)
        return FileResponse(_404(c.scenes.preview, scene_id), media_type="image/png")

    # ================================================================== knowledge
    @app.get("/api/map")
    def knowledge_map(user: str = Depends(current_user)) -> dict:
        return c.knowledge.map(user)

    @app.get("/api/concepts/{concept_id}")
    def concept(concept_id: str, user: str = Depends(current_user)) -> dict:
        return _404(c.knowledge.concept, user, concept_id)

    @app.get("/api/search")
    def search(q: str = Query(..., min_length=1, max_length=200), user: str = Depends(current_user)) -> dict:
        return c.knowledge.search(user, q)

    @app.post("/api/concepts/{concept_id}/card")
    def draft_card(concept_id: str, user: str = Depends(current_user)) -> dict:
        try:
            return _404(c.knowledge.draft_card, user, concept_id)
        except PermissionError as exc:
            raise HTTPException(409, str(exc)) from exc
        except LLMError as exc:
            raise HTTPException(503, "Could not draft the card right now") from exc

    @app.get("/api/cards")
    def cards(user: str = Depends(current_user)) -> list[dict]:
        return c.knowledge.cards(user)

    @app.patch("/api/cards/{card_id}")
    def update_card(card_id: str, body: CardIn, user: str = Depends(current_user)) -> dict:
        return _404(c.knowledge.update_card, user, card_id, title=body.title, body=body.body, status=body.status)

    @app.post("/api/links/{link_id}")
    def resolve_link(link_id: str, body: LinkIn, user: str = Depends(current_user)) -> dict:
        _404(c.knowledge.resolve_link, user, link_id, body.status)
        return {"ok": True}

    # ================================================================== review
    @app.post("/api/items/{item_id}/review")
    def review(item_id: str, body: ReviewIn, user: str = Depends(current_user)) -> dict:
        with db.session() as s:
            item = _404(item_store.review, s, item_id, ReviewStatus(body.status), user, body.note)
            return {"id": item.id, "review_status": item.review_status.value}

    @app.get("/api/review/candidates")
    def candidates() -> list[dict]:
        with db.session() as s:
            rows = s.scalars(sa.select(ConceptCandidate).where(ConceptCandidate.status == "pending")
                             .order_by(ConceptCandidate.created_at))
            names = {}
            out = []
            for r in rows:
                names.update(item_store.concept_names(s, [r.concept_id, r.suggested_concept_id]))
                out.append({"id": r.id, "concept": {"id": r.concept_id, "name": names.get(r.concept_id)},
                            "suggested": {"id": r.suggested_concept_id, "name": names.get(r.suggested_concept_id)},
                            "score": r.score, "judge": r.judge})
            return out

    @app.post("/api/review/candidates/{candidate_id}")
    def resolve_candidate(candidate_id: int, body: CandidateIn, user: str = Depends(current_user)) -> dict:
        with db.session() as s:
            try:
                log_id = c.library.resolve_candidate(s, candidate_id, merge=body.merge, actor=user)
            except ValueError as exc:
                raise HTTPException(409, str(exc)) from exc
        return {"merge_log_id": log_id}

    @app.post("/api/review/merges/{log_id}/rollback")
    def rollback(log_id: int, user: str = Depends(current_user)) -> dict:
        with db.session() as s:
            try:
                return {"rollback_log_id": c.library.rollback(s, log_id, actor=user)}
            except ValueError as exc:
                raise HTTPException(409, str(exc)) from exc

    @app.get("/api/usage")
    def usage(limit: int = Query(200, le=1000)) -> list[dict]:
        with db.session() as s:
            rows = s.scalars(sa.select(UsageLog).order_by(UsageLog.id.desc()).limit(limit))
            return [{col.name: getattr(r, col.name) for col in UsageLog.__table__.columns} for r in rows]

    return app
