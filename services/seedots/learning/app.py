"""Composition root of the learning backend."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from seedots.common.config import Settings, load_settings
from seedots.common.db import Database
from seedots.common.llm import Gateway, TaskSpec, build_gateway
from seedots.common.migrate import upgrade
from seedots.common.workflow import Engine, build_engine
from seedots.learning.catalog import Inbox
from seedots.learning.coach import Coach
from seedots.learning.concepts import ConceptLibrary, JudgeOut, build_embedder
from seedots.learning.fake import learning_brain
from seedots.learning.knowledge import CardOut, Knowledge
from seedots.learning.media_client import MediaClient
from seedots.learning.models import Base, LlmCache, UsageLog
from seedots.learning.pipeline import ConceptsOut, ContentRunner, ItemsOut
from seedots.learning.runtime import LLMSelector, Runtime, SelectOut

PROMPTS = Path(__file__).parent / "prompts"
TASKS = [
    TaskSpec("concepts", ConceptsOut, temperature=0.1, max_tokens=3000, cache=True),
    TaskSpec("concept_judge", JudgeOut, temperature=0.0, max_tokens=300, cache=True),
    TaskSpec("items", ItemsOut, temperature=0.3, max_tokens=6000, cache=True),
    TaskSpec("select_action", SelectOut, temperature=0.0, max_tokens=300, timeout=20),
    TaskSpec("coach", None, temperature=0.4, max_tokens=700, timeout=60),
    TaskSpec("card", CardOut, temperature=0.3, max_tokens=900),
]


@dataclass
class LearningContainer:
    settings: Settings
    db: Database
    gateway: Gateway
    media: MediaClient
    runner: ContentRunner
    engine: Engine
    inbox: Inbox
    runtime: Runtime
    coach: Coach
    knowledge: Knowledge
    library: ConceptLibrary


def build_container(settings: Settings | None = None, *, media_http: httpx.Client | None = None,
                    inline: bool = False, migrate: bool | None = None, **_: Any) -> LearningContainer:
    settings = settings or load_settings()
    if settings.auto_migrate if migrate is None else migrate:
        upgrade("learning", settings.learning_db_url)
    db = Database(settings.learning_db_url, Base.metadata)
    gateway = build_gateway(settings, prompt_dir=PROMPTS, tasks=TASKS, brain=learning_brain, db=db,
                            usage_model=UsageLog, cache_model=LlmCache)
    media = MediaClient(media_http) if media_http is not None else MediaClient.at(settings.media_url)
    embedder = build_embedder(settings.embeddings)
    library = ConceptLibrary(db, gateway, embedder)
    runner = ContentRunner(db, media, gateway, library)
    engine = build_engine(settings.workflow_engine, runner, service="learning",
                          temporal_address=settings.temporal_address, inline=inline)
    runner.engine = engine
    return LearningContainer(
        settings=settings, db=db, gateway=gateway, media=media, runner=runner, engine=engine,
        inbox=Inbox(db, media, runner.chapter_ready),
        runtime=Runtime(db, LLMSelector(gateway), use_llm=settings.action_selector == "llm"),
        coach=Coach(db, gateway), knowledge=Knowledge(db, gateway, embedder), library=library)
