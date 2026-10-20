"""Video analysis foundation — HTTP API (port 8001).

  POST  /v1/media                    register a source
  POST  /v1/media/upload             register an uploaded file (+ caption sidecar)
  POST  /v1/media/{id}/analyze       start / resume analysis (optional priority_from)
  GET   /v1/media/{id}               status, capabilities, stages
  GET   /v1/media/{id}/chapters
  GET   /v1/media/{id}/evidence      ?t0&t1&kinds=sentence,chapter
  GET   /v1/media/{id}/file          the uploaded file (uploads only)
  PATCH /v1/evidence/{id}            correct a sentence -> new revision
  GET   /v1/events                   outbox (debug);  POST /v1/events/{id}/replay
"""
from __future__ import annotations

import logging
import shutil
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from seedots.common.config import load_settings
from seedots.common.contracts import EvidenceUnit
from seedots.common.db import Database
from seedots.common.ids import new_id
from seedots.common.llm import Gateway, build_transport
from seedots.media.fake import media_fake
from seedots.media.service import MediaService
from seedots.media.sources import SourceError
from seedots.media.store import SCHEMA, MediaStore
from seedots.media.webhooks import Dispatcher

logging.basicConfig(level=logging.INFO)
settings = load_settings()
store = MediaStore(Database(settings.data_dir / "media.sqlite3", SCHEMA))
gateway = Gateway(transport=build_transport(settings, media_fake),
                  prompt_dir=Path(__file__).parent / "prompts",
                  default_model=settings.llm_model, usage_sink=store.log_usage)
service = MediaService(store, gateway, settings.data_dir)
dispatcher = Dispatcher(store, settings.media_webhook_url, settings.webhook_secret)


@asynccontextmanager
async def lifespan(_: FastAPI):
    dispatcher.start()
    yield
    dispatcher.stop()


app = FastAPI(title="SeeDots media foundation", version="0.1.0", lifespan=lifespan)


class SourceIn(BaseModel):
    kind: Literal["upload", "platform", "webpage"]
    uri: str
    rights_attestation: str | None = None


class RegisterIn(BaseModel):
    source: SourceIn
    visibility: Literal["public", "private"] = "public"
    owner: str | None = None
    language: str = "en"


class AnalyzeIn(BaseModel):
    priority_from: float | None = None


class CorrectIn(BaseModel):
    text: str


def _out(media: dict) -> dict:
    media = dict(media)
    media["stages"] = store.stages(media["id"])
    media.pop("dedupe_key", None)
    return media


@app.get("/health")
def health() -> dict:
    return {"ok": True, "llm": "fake" if settings.llm_fake else settings.llm_model}


@app.post("/v1/media")
def register(body: RegisterIn) -> dict:
    try:
        media = service.register(kind=body.source.kind, uri=body.source.uri, visibility=body.visibility,
                                 owner=body.owner, language=body.language,
                                 rights_attestation=body.source.rights_attestation)
    except SourceError as exc:
        raise HTTPException(422, str(exc)) from exc
    return _out(media)


@app.post("/v1/media/upload")
def upload(file: UploadFile = File(...), captions: UploadFile = File(...), owner: str = Form("demo"),
           language: str = Form("en")) -> dict:
    up_dir = settings.data_dir / "uploads" / new_id("up")
    up_dir.mkdir(parents=True, exist_ok=True)
    video_path = up_dir / Path(file.filename or "video.mp4").name
    with video_path.open("wb") as f:
        shutil.copyfileobj(file.file, f)
    cap_ext = Path(captions.filename or "c.vtt").suffix.lower()
    if cap_ext not in (".vtt", ".srt"):
        raise HTTPException(422, "Captions must be .vtt or .srt")
    with video_path.with_suffix(cap_ext).open("wb") as f:
        shutil.copyfileobj(captions.file, f)
    try:
        media = service.register(kind="upload", uri=str(video_path), visibility="private", owner=owner,
                                 language=language, rights_attestation="uploader")
    except SourceError as exc:
        raise HTTPException(422, str(exc)) from exc
    return _out(media)


@app.get("/v1/media")
def list_media() -> list[dict]:
    return [_out(m) for m in store.list_media()]


@app.post("/v1/media/{media_id}/analyze")
def analyze(media_id: str, body: AnalyzeIn | None = None) -> dict:
    try:
        return _out(service.analyze(media_id, (body or AnalyzeIn()).priority_from))
    except KeyError as exc:
        raise HTTPException(404, "media not found") from exc


@app.get("/v1/media/{media_id}")
def get_media(media_id: str) -> dict:
    media = store.get_media(media_id)
    if not media:
        raise HTTPException(404, "media not found")
    return _out(media)


@app.get("/v1/media/{media_id}/chapters")
def chapters(media_id: str) -> list[EvidenceUnit]:
    return store.evidence(media_id, kinds=["chapter"])


@app.get("/v1/media/{media_id}/evidence")
def evidence(media_id: str, t0: float | None = None, t1: float | None = None,
             kinds: str = Query("sentence,chapter")) -> list[EvidenceUnit]:
    return store.evidence(media_id, kinds=[k for k in kinds.split(",") if k], t0=t0, t1=t1)


@app.get("/v1/media/{media_id}/file")
def media_file(media_id: str):
    media = store.get_media(media_id)
    if not media or media["source_kind"] != "upload":
        raise HTTPException(404, "no file for this media")
    return FileResponse(media["source_uri"])


@app.patch("/v1/evidence/{evidence_id}")
def correct(evidence_id: str, body: CorrectIn) -> EvidenceUnit:
    try:
        return service.correct_sentence(evidence_id, body.text)
    except KeyError as exc:
        raise HTTPException(404, "evidence not found") from exc
    except SourceError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/v1/events")
def events(media_id: str | None = None) -> list[dict]:
    return store.events(media_id)


@app.post("/v1/events/{event_id}/replay")
def replay(event_id: str) -> dict:
    if not store.replay(event_id):
        raise HTTPException(404, "event not found")
    return {"ok": True}
