"""Learning backend — HTTP API (port 8000). The Next.js app calls this (proxied under /api).

  POST /hooks/media                     events from the foundation (signed)
  POST /api/videos                      add a video by URL;  GET /api/videos;  GET /api/videos/{id}
  GET  /api/videos/{id}/pack            course pack: chapters, sentences, concepts, items (no answers)
  GET  /api/videos/{id}/progress        SSE: analysis / generation progress
  POST /api/events                      batched learning events
  POST /api/decide                      signal -> teaching action (+ item)
  POST /api/attempts                    grade an answer, update mastery
  POST /api/coach                       SSE: grounded coach answer
  POST /api/marks ; GET /api/map ; GET/PUT /api/settings ; POST /api/items/{id}/review ; GET /api/usage
"""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from seedots.common.config import load_settings
from seedots.common.contracts import SIGNATURE_HEADER, MediaEvent, verify
from seedots.common.db import Database
from seedots.common.ids import new_id, now_ms
from seedots.common.llm import Gateway, LLMError, TaskConfig, build_transport
from seedots.learning.coach import Coach
from seedots.learning.fake import learning_fake
from seedots.learning.media_client import HttpMediaClient, MediaAPIError
from seedots.learning.pipeline import ChapterPipeline
from seedots.learning.runtime import LLMSelector, Runtime, Signal, public_item
from seedots.learning.service import ContentWorker, handle_media_event
from seedots.learning.store import SCHEMA, LearningStore

logging.basicConfig(level=logging.INFO)
settings = load_settings()
store = LearningStore(Database(settings.data_dir / "learning.sqlite3", SCHEMA))
gateway = Gateway(
    transport=build_transport(settings, learning_fake),
    prompt_dir=Path(__file__).parent / "prompts",
    default_model=settings.llm_model,
    tasks={
        "concepts": TaskConfig(temperature=0.1, max_tokens=3000),
        "items": TaskConfig(temperature=0.3, max_tokens=6000),
        "select_action": TaskConfig(temperature=0.0, max_tokens=300, timeout=20),
        "coach": TaskConfig(temperature=0.4, max_tokens=700, timeout=60),
    },
    usage_sink=store.log_usage,
)
media = HttpMediaClient(settings.media_url)
pipeline = ChapterPipeline(store, media, gateway)
worker = ContentWorker(pipeline)
runtime = Runtime(store, LLMSelector(gateway, store))
coach = Coach(store, gateway)

app = FastAPI(title="SeeDots learning backend", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=settings.web_origins, allow_methods=["*"], allow_headers=["*"])
DEFAULT_SETTINGS = {"focus_mode": False, "max_cards_per_5min": 1, "purpose": "interest"}


def uid(x_seedots_user: str | None) -> str:
    return (x_seedots_user or "demo").strip()[:64] or "demo"


def sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.get("/health")
def health() -> dict:
    return {"ok": True, "llm": "fake" if settings.llm_fake else settings.llm_model,
            "selector": settings.action_selector}


# ------------------------------------------------------------------ webhooks
@app.post("/hooks/media")
async def media_hook(request: Request) -> dict:
    body = await request.body()
    if not verify(body, settings.webhook_secret, request.headers.get(SIGNATURE_HEADER)):
        raise HTTPException(401, "bad signature")
    ev = MediaEvent.model_validate_json(body)
    try:
        status = handle_media_event(ev, store, media, worker.submit)
    except MediaAPIError as exc:
        raise HTTPException(502, f"foundation unavailable: {exc}") from exc
    return {"status": status}


# ------------------------------------------------------------------ videos
class AddVideoIn(BaseModel):
    url: str
    priority_from: float | None = None


@app.post("/api/videos")
def add_video(body: AddVideoIn) -> dict:
    try:
        m = media.register({"source": {"kind": "platform", "uri": body.url}, "visibility": "public",
                            "language": "en"})
        store.upsert_video(m)
        m = media.analyze(m["id"], body.priority_from)
        store.upsert_video(m)
    except MediaAPIError as exc:
        raise HTTPException(exc.status if exc.status < 500 else 502, str(exc)) from exc
    return _video_out(store.video(m["id"]))


def _video_out(v: dict | None) -> dict:
    if not v:
        raise HTTPException(404, "video not found")
    runs = store.chapter_runs(v["media_id"])
    return {**v, "content": {
        "chapters_total": len(v.get("chapters") or []),
        "chapters_done": sum(r["status"] == "done" for r in runs),
        "chapters_failed": sum(r["status"] == "failed" for r in runs),
    }}


def _refresh(media_id: str) -> dict:
    try:
        store.upsert_video(media.get(media_id))
    except MediaAPIError:
        pass  # foundation down: serve what we have
    return _video_out(store.video(media_id))


@app.get("/api/videos")
def list_videos() -> list[dict]:
    return [_video_out(v) for v in store.videos()]


@app.get("/api/videos/{media_id}")
def get_video(media_id: str) -> dict:
    return _refresh(media_id)


@app.get("/api/videos/{media_id}/progress")
async def progress(media_id: str) -> StreamingResponse:
    async def gen():
        last = None
        for _ in range(1800):
            v = await asyncio.to_thread(_refresh, media_id)
            snap = {"status": v["status"], "detail": v.get("status_detail"), **v["content"]}
            if snap != last:
                yield sse("progress", snap)
                last = snap
            if v["status"] == "failed" or (v["status"] == "ready" and snap["chapters_total"] and
                                           snap["chapters_done"] + snap["chapters_failed"] >= snap["chapters_total"]):
                yield sse("end", snap)
                return
            await asyncio.sleep(1.5)
    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/api/videos/{media_id}/pack")
def pack(media_id: str, x_seedots_user: str | None = Header(None)) -> dict:
    user = uid(x_seedots_user)
    video = _video_out(store.video(media_id))
    sentences = store.evidence(media_id, "sentence")
    if not sentences:
        try:
            units = media.evidence(media_id, kinds="sentence,chapter")
            store.save_evidence(units)
            sentences = [u for u in units if u.kind == "sentence"]
        except MediaAPIError:
            sentences = []
    occ = store.occurrences(media_id)
    concepts = {c["id"]: c for c in store.concepts(sorted({o["concept_id"] for o in occ}))}
    names = {k: v["name"] for k, v in concepts.items()}
    items = store.items(media_id)
    ev = store.evidence_by_ids(sorted({e for i in items for e in i["evidence_ids"]}))
    tried = {a["item_id"]: bool(a["correct"]) for a in store.attempts(user, [i["id"] for i in items])}
    runs = {r["chapter_id"]: r["status"] for r in store.chapter_runs(media_id)}
    chapters = video.get("chapters") or [
        {"id": c.id, "t0": c.t0, "t1": c.t1, "title": c.content.get("title", "")}
        for c in store.evidence(media_id, "chapter")]
    return {
        "video": video,
        "chapters": [{**c, "content_status": runs.get(c["id"], "pending")} for c in chapters],
        "sentences": [{"id": s.id, "t0": s.t0, "t1": s.t1, "text": s.content["text"], "confidence": s.confidence,
                       "source": s.source} for s in sentences],
        "concepts": [{"id": c["id"], "name": c["name"], "definition": c.get("definition"),
                      "occurrences": [{"chapter_id": o["chapter_id"], "t0": o["t0"], "t1": o["t1"], "role": o["role"]}
                                      for o in occ if o["concept_id"] == c["id"]]} for c in concepts.values()],
        "items": [{**public_item(i, ev, names), "attempted": i["id"] in tried} for i in items],
        "marks": store.marks(user, media_id),
        "settings": {**DEFAULT_SETTINGS, **store.settings(user)},
    }


# ------------------------------------------------------------------ runtime
class EventsIn(BaseModel):
    events: list[dict] = Field(max_length=500)


@app.post("/api/events")
def events(body: EventsIn, x_seedots_user: str | None = Header(None)) -> dict:
    for e in body.events:
        if not e.get("event_id") or not e.get("type"):
            raise HTTPException(422, "each event needs event_id and type")
    return {"accepted": store.insert_events(uid(x_seedots_user), body.events)}


class DecideIn(BaseModel):
    media_id: str
    signal: Signal


@app.post("/api/decide")
def decide(body: DecideIn, x_seedots_user: str | None = Header(None)) -> dict:
    return runtime.decide(uid(x_seedots_user), body.media_id, body.signal,
                          use_llm=settings.action_selector == "llm")


class AttemptIn(BaseModel):
    item_id: str
    response: dict
    assisted: bool = False
    confidence: int | None = None


@app.post("/api/attempts")
def attempt(body: AttemptIn, x_seedots_user: str | None = Header(None)) -> dict:
    try:
        return runtime.attempt(uid(x_seedots_user), body.item_id, {**body.response, "confidence": body.confidence},
                               body.assisted)
    except KeyError as exc:
        raise HTTPException(404, "item not found") from exc


class ReviewIn(BaseModel):
    status: Literal["human_reviewed", "rejected", "auto_validated"]


@app.post("/api/items/{item_id}/review")
def review(item_id: str, body: ReviewIn) -> dict:
    if not store.item(item_id):
        raise HTTPException(404, "item not found")
    store.set_review(item_id, body.status)
    return {"ok": True}


# ------------------------------------------------------------------ coach
class CoachIn(BaseModel):
    media_id: str
    t: float
    question: str = ""


@app.post("/api/coach")
def ask(body: CoachIn, x_seedots_user: str | None = Header(None)) -> StreamingResponse:
    user = uid(x_seedots_user)

    def gen():
        try:
            for part in coach.ask(user, body.media_id, body.t, body.question):
                yield sse(part["type"], part)
        except LLMError as exc:
            yield sse("error", {"message": str(exc)[:300]})
    return StreamingResponse(gen(), media_type="text/event-stream")


# ------------------------------------------------------------------ marks, map, settings
class MarkIn(BaseModel):
    media_id: str
    t: float
    type: Literal["useful", "resonate", "confused"]
    note: str = ""


@app.post("/api/marks")
def add_mark(body: MarkIn, x_seedots_user: str | None = Header(None)) -> dict:
    row = {"id": new_id("mrk"), "user_id": uid(x_seedots_user), "media_id": body.media_id,
           "t": max(0.0, body.t - 5), "type": body.type, "note": body.note[:500], "created_at": now_ms()}
    store.insert("marks", row)
    return row


@app.get("/api/map")
def knowledge_map() -> dict:
    """Read-only map: global concepts as nodes; an edge when two videos share a concept."""
    occ = store.occurrences()
    videos = {v["media_id"]: v["title"] for v in store.videos()}
    nodes = []
    for c in store.all_concepts():
        mine = [o for o in occ if o["concept_id"] == c["id"]]
        if mine:
            nodes.append({"id": c["id"], "name": c["name"], "definition": c.get("definition"),
                          "sources": [{"media_id": o["media_id"], "title": videos.get(o["media_id"]), "t0": o["t0"]}
                                      for o in mine]})
    edges = [{"concept_id": n["id"], "type": "same_concept", "videos": sorted({s["media_id"] for s in n["sources"]})}
             for n in nodes if len({s["media_id"] for s in n["sources"]}) > 1]
    return {"nodes": nodes, "edges": edges}


@app.get("/api/settings")
def get_settings(x_seedots_user: str | None = Header(None)) -> dict:
    return {**DEFAULT_SETTINGS, **store.settings(uid(x_seedots_user))}


@app.put("/api/settings")
def put_settings(body: dict, x_seedots_user: str | None = Header(None)) -> dict:
    allowed = {k: body[k] for k in DEFAULT_SETTINGS if k in body}
    merged = {**DEFAULT_SETTINGS, **store.settings(uid(x_seedots_user)), **allowed}
    store.put_settings(uid(x_seedots_user), merged)
    return merged


@app.get("/api/usage")
def usage() -> list[dict]:
    return store.usage()
