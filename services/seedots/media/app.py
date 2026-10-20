"""Composition root of the foundation: one place that wires settings -> db -> gateway ->
service -> workflow engine -> dispatcher. Used by the HTTP app, the Temporal worker and tests."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from seedots.common.config import Settings, load_settings
from seedots.common.db import Database
from seedots.common.llm import Gateway, TaskSpec, build_gateway
from seedots.common.migrate import upgrade
from seedots.common.workflow import Engine, build_engine
from seedots.media.asr import build_transcriber
from seedots.media.fake import media_brain
from seedots.media.models import Base, LlmCache, UsageLog
from seedots.media.processors import OutlineOut
from seedots.media.service import MediaService
from seedots.media.webhooks import Dispatcher, Poster, httpx_post

PROMPTS = Path(__file__).parent / "prompts"
TASKS = [TaskSpec("outline", OutlineOut, temperature=0.1, max_tokens=4000, cache=True)]


@dataclass
class MediaContainer:
    settings: Settings
    db: Database
    gateway: Gateway
    service: MediaService
    engine: Engine
    dispatcher: Dispatcher

    @property
    def runner(self) -> MediaService:
        return self.service


def build_container(settings: Settings | None = None, *, inline: bool = False, poster: Poster = httpx_post,
                    migrate: bool | None = None) -> MediaContainer:
    settings = settings or load_settings()
    if settings.auto_migrate if migrate is None else migrate:
        upgrade("media", settings.media_db_url)
    db = Database(settings.media_db_url, Base.metadata)
    gateway = build_gateway(settings, prompt_dir=PROMPTS, tasks=TASKS, brain=media_brain, db=db,
                            usage_model=UsageLog, cache_model=LlmCache)
    service = MediaService(db, data_dir=settings.data_dir, gateway=gateway,
                           transcriber=build_transcriber(settings.asr), grabber_dir=settings.grabber_dir)
    engine = build_engine(settings.workflow_engine, service, service="media",
                          temporal_address=settings.temporal_address, inline=inline)
    service.engine = engine
    if settings.media_webhook_url:
        service.subscribe(settings.media_webhook_url, settings.webhook_secret)
    return MediaContainer(settings, db, gateway, service, engine, Dispatcher(db, poster))
