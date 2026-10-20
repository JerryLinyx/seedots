"""Video analysis foundation — HTTP API (port 8001). Domain-agnostic: media, time, evidence.

  POST   /v1/media                       register a source (platform | webpage + attestation)
  POST   /v1/media/upload                register an uploaded file (+ optional caption sidecar)
  GET    /v1/media?owner=                list
  GET    /v1/media/{id}                  status, capabilities, stages, current job
  POST   /v1/media/{id}/analyze          start / join analysis (priority_from = playback position)
  GET    /v1/media/{id}/chapters
  GET    /v1/media/{id}/evidence         ?kinds=sentence,chapter&t0&t1   (current revisions)
  GET    /v1/evidence/{id}               ?revision=N
  PATCH  /v1/evidence/{id}               correct a sentence -> new revision + media.evidence_revised
  GET    /v1/media/{id}/file             the media file we hold (uploads, web pages)
  GET    /v1/media/{id}/frames/{name}    keyframe image
  GET    /v1/events                      pull API: ?media_id&after_seq  (fallback to webhooks)
  POST   /v1/webhooks | GET /v1/webhooks | DELETE /v1/webhooks/{id}
  GET    /v1/deliveries?status=dead      POST /v1/events/{id}/replay
  GET    /v1/usage                       model calls
Run:  uvicorn --factory seedots.media.api:create_app --port 8001
"""
from __future__ import annotations

import logging
import re
import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Literal

import sqlalchemy as sa
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from seedots.common.contracts import EvidenceUnit, MediaEvent
from seedots.common.ids import new_id
from seedots.common.workflow import PermanentError
from seedots.media import repo
from seedots.media.app import MediaContainer, build_container
from seedots.media.models import (AnalysisJob, DeliveryStatus, FileRole, MediaAsset, MediaFile, OutboxEvent, StageRun,
                                  UsageLog, WebhookDelivery, WebhookSubscription)
from seedots.media.sources import SourceError


class Attestation(BaseModel):
    statement: str = Field(min_length=10, max_length=1000)
    by: str | None = None


class SourceIn(BaseModel):
    kind: Literal["upload", "platform", "webpage"]
    uri: str = Field(min_length=1, max_length=4000)
    rights_attestation: Attestation | None = None


class RegisterIn(BaseModel):
    source: SourceIn
    visibility: Literal["public", "private"] = "public"
    owner: str | None = None
    language: str = "en"
    analyze: bool = True
    priority_from: float | None = None


class AnalyzeIn(BaseModel):
    priority_from: float | None = None


class CorrectIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    by: str = "user"


class SubscribeIn(BaseModel):
    url: str
    secret: str = Field(min_length=8)
    event_types: list[str] = []


def media_out(s, a: MediaAsset) -> dict[str, Any]:
    stages = s.scalars(sa.select(StageRun).where(StageRun.media_id == a.id).order_by(StageRun.started_at)).all()
    job = s.scalar(sa.select(AnalysisJob).where(AnalysisJob.media_id == a.id).order_by(AnalysisJob.created_at.desc()))
    return {
        "id": a.id, "source_kind": a.source_kind.value, "source_uri": a.source_uri, "platform": a.platform,
        "external_id": a.external_id, "visibility": a.visibility.value, "owner": a.owner_id, "language": a.language,
        "title": a.title, "duration": a.duration_s, "capabilities": a.capabilities,
        "status": a.status.value, "status_detail": a.status_detail,
        "platform_meta": {k: v for k, v in (a.platform_meta or {}).items() if k in ("video_id", "channel", "chapters")},
        "stages": [{"stage": r.stage, "version": r.processor_version, "status": r.status.value, "error": r.error,
                    "attempts": r.attempts, "stats": r.stats} for r in stages],
        "job": {"id": job.id, "status": job.status.value, "priority_from": job.priority_from,
                "error": job.error} if job else None,
    }


def create_app(container: MediaContainer | None = None) -> FastAPI:
    logging.basicConfig(level=logging.INFO)
    c = container or build_container()
    svc, db = c.service, c.db

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        c.dispatcher.start()
        svc.resume()
        yield
        c.dispatcher.stop()

    app = FastAPI(title="SeeDots media foundation", version="0.2.0", lifespan=lifespan)
    app.state.container = c

    def get(media_id: str) -> dict[str, Any]:
        with db.session() as s:
            a = s.get(MediaAsset, media_id)
            if a is None:
                raise HTTPException(404, "media not found")
            return media_out(s, a)

    def handle(fn, *args, **kw):
        try:
            return fn(*args, **kw)
        except SourceError as exc:
            raise HTTPException(422, str(exc)) from exc
        except PermanentError as exc:
            raise HTTPException(422, str(exc)) from exc
        except KeyError as exc:
            raise HTTPException(404, "not found") from exc

    @app.get("/health")
    def health() -> dict:
        return {"ok": True, "model": c.gateway.model_name, "engine": type(c.engine).__name__,
                "asr": svc.transcriber.name if svc.transcriber else None}

    # ------------------------------------------------------------------ media
    @app.post("/v1/media", status_code=201)
    def register(body: RegisterIn) -> dict:
        att = body.source.rights_attestation.model_dump() if body.source.rights_attestation else None
        media_id = handle(svc.register, kind=body.source.kind, uri=body.source.uri.strip(),
                          visibility=body.visibility, owner=body.owner, language=body.language,
                          rights_attestation=att)
        if body.analyze:
            handle(svc.analyze, media_id, body.priority_from)
        return get(media_id)

    @app.post("/v1/media/upload", status_code=201)
    def upload(file: UploadFile = File(...), captions: UploadFile | None = File(None), owner: str = Form(...),
               language: str = Form("en"), analyze: str = Form("true")) -> dict:
        # (a missing bool form field parses as False, so take the text and read it ourselves)
        up_dir = c.settings.data_dir / "uploads" / new_id("up")
        up_dir.mkdir(parents=True, exist_ok=True)
        name = re.sub(r"[^\w.\- ]+", "_", Path(file.filename or "video.mp4").name)[:120] or "video.mp4"
        video_path = up_dir / name
        with video_path.open("wb") as f:
            shutil.copyfileobj(file.file, f)
        if captions is not None and captions.filename:
            ext = Path(captions.filename).suffix.lower()
            if ext not in (".vtt", ".srt"):
                raise HTTPException(422, "Captions must be .vtt or .srt")
            with video_path.with_suffix(ext).open("wb") as f:
                shutil.copyfileobj(captions.file, f)
        media_id = handle(svc.register, kind="upload", uri=str(video_path), visibility="private", owner=owner,
                          language=language, rights_attestation={"statement": "uploaded by the owner", "by": owner})
        if analyze.strip().lower() not in ("0", "false", "no", "off"):
            handle(svc.analyze, media_id)
        return get(media_id)

    @app.get("/v1/media")
    def list_media(owner: str | None = None, limit: int = Query(50, le=200)) -> list[dict]:
        with db.session() as s:
            q = sa.select(MediaAsset).order_by(MediaAsset.created_at.desc()).limit(limit)
            if owner:
                q = q.where(sa.or_(MediaAsset.visibility == "public", MediaAsset.owner_id == owner))
            return [media_out(s, a) for a in s.scalars(q)]

    @app.get("/v1/media/{media_id}")
    def get_media(media_id: str) -> dict:
        return get(media_id)

    @app.post("/v1/media/{media_id}/analyze")
    def analyze(media_id: str, body: AnalyzeIn | None = None) -> dict:
        handle(svc.analyze, media_id, (body or AnalyzeIn()).priority_from)
        return get(media_id)

    @app.get("/v1/media/{media_id}/chapters")
    def chapters(media_id: str) -> list[EvidenceUnit]:
        with db.session() as s:
            return repo.current_evidence(s, media_id, ["chapter"])

    @app.get("/v1/media/{media_id}/evidence")
    def evidence(media_id: str, kinds: str = "sentence,chapter", t0: float | None = None,
                 t1: float | None = None) -> list[EvidenceUnit]:
        with db.session() as s:
            return repo.current_evidence(s, media_id, [k for k in kinds.split(",") if k], t0, t1)

    @app.get("/v1/evidence/{evidence_id}")
    def evidence_one(evidence_id: str, revision: int | None = None) -> EvidenceUnit:
        with db.session() as s:
            row = repo.evidence_row(s, evidence_id, revision)
            if row is None:
                raise HTTPException(404, "evidence not found")
            return repo.to_unit(row)

    @app.patch("/v1/evidence/{evidence_id}")
    def correct(evidence_id: str, body: CorrectIn) -> EvidenceUnit:
        return handle(svc.correct_sentence, evidence_id, body.text, body.by)

    def _held_file(media_id: str) -> Path:
        with db.session() as s:
            row = s.scalar(sa.select(MediaFile).where(MediaFile.media_id == media_id,
                                                      MediaFile.role == FileRole.ORIGINAL))
            if row is None:
                a = s.get(MediaAsset, media_id)
                if a is None or a.source_kind.value != "upload":
                    raise HTTPException(404, "no file for this media")
                return Path(a.source_uri)
            return Path(row.storage_key)

    @app.get("/v1/media/{media_id}/file")
    def media_file(media_id: str):
        path = _held_file(media_id)
        if not path.exists():
            raise HTTPException(404, "file missing")
        return FileResponse(path)

    @app.get("/v1/media/{media_id}/frames/{name}")
    def frame(media_id: str, name: str):
        if not re.fullmatch(r"k\d{4}\.jpg", name):
            raise HTTPException(404, "no such frame")
        path = svc.workdir(media_id) / "frames" / name
        if not path.exists():
            raise HTTPException(404, "no such frame")
        return FileResponse(path, media_type="image/jpeg")

    # ------------------------------------------------------------------ events
    @app.get("/v1/events")
    def events(media_id: str | None = None, after_seq: int = 0, limit: int = Query(200, le=1000)) -> list[MediaEvent]:
        with db.session() as s:
            q = sa.select(OutboxEvent.payload)
            if media_id:
                q = q.where(OutboxEvent.media_id == media_id, OutboxEvent.seq > after_seq).order_by(OutboxEvent.seq)
            else:
                q = q.order_by(OutboxEvent.created_at.desc())
            return [MediaEvent.model_validate(p) for p in s.scalars(q.limit(limit))]

    @app.post("/v1/events/{event_id}/replay")
    def replay(event_id: str, subscription_id: str | None = None) -> dict:
        with db.session() as s:
            n = repo.replay(s, event_id, subscription_id)
        if not n:
            raise HTTPException(404, "event not found")
        return {"queued": n}

    @app.get("/v1/deliveries")
    def deliveries(status: Literal["pending", "delivered", "dead"] | None = None,
                   limit: int = Query(100, le=500)) -> list[dict]:
        with db.session() as s:
            q = sa.select(WebhookDelivery, OutboxEvent.type, OutboxEvent.media_id).join(
                OutboxEvent, OutboxEvent.event_id == WebhookDelivery.event_id)
            if status:
                q = q.where(WebhookDelivery.status == DeliveryStatus(status))
            rows = s.execute(q.order_by(WebhookDelivery.next_attempt_at.desc()).limit(limit)).all()
            return [{"event_id": d.event_id, "subscription_id": d.subscription_id, "type": t, "media_id": m,
                     "status": d.status.value, "attempts": d.attempts, "last_error": d.last_error} for d, t, m in rows]

    @app.post("/v1/webhooks", status_code=201)
    def subscribe(body: SubscribeIn) -> dict:
        return {"id": svc.subscribe(body.url, body.secret, body.event_types)}

    @app.get("/v1/webhooks")
    def subscriptions() -> list[dict]:
        with db.session() as s:
            return [{"id": w.id, "url": w.url, "event_types": w.event_types, "active": w.active}
                    for w in s.scalars(sa.select(WebhookSubscription))]

    @app.delete("/v1/webhooks/{sub_id}")
    def unsubscribe(sub_id: str) -> dict:
        with db.session() as s:
            w = s.get(WebhookSubscription, sub_id)
            if w is None:
                raise HTTPException(404, "subscription not found")
            w.active = False
        return {"ok": True}

    @app.get("/v1/usage")
    def usage(limit: int = Query(200, le=1000)) -> list[dict]:
        with db.session() as s:
            rows = s.scalars(sa.select(UsageLog).order_by(UsageLog.id.desc()).limit(limit))
            return [{c.name: getattr(r, c.name) for c in UsageLog.__table__.columns} for r in rows]

    return app
