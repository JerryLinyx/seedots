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
from seedots.common.workflow import Engine, Router, build_engine
from seedots.learning.catalog import Inbox
from seedots.learning.coach import Coach
from seedots.learning.concepts import ConceptLibrary, JudgeOut, build_embedder
from seedots.learning.fake import learning_brain
from seedots.learning.knowledge import CardOut, Knowledge
from seedots.learning.media_client import MediaClient
from seedots.learning.models import Base, LlmCache, UsageLog
from seedots.learning.pipeline import ConceptsOut, ContentRunner, ItemsOut
from seedots.learning.pipeline import WORKFLOW as CHAPTER_WORKFLOW
from seedots.learning.runtime import LLMSelector, Runtime, SelectOut
from seedots.learning.scenes.sandbox import NodeSandbox
from seedots.learning.scenes.rigs import RigClient
from seedots.learning.scenes.service import WORKFLOW as SCENE_WORKFLOW, BuildOut, LabSpecOut, ReviewOut, SceneService, SpecOut

PROMPTS = Path(__file__).parent / "prompts"
# max_tokens caps thinking + answer for reasoning models, so it is generous; the gateway retries
# once with a larger cap if a model still runs out before answering. Latency-bound tasks ask for
# low reasoning effort (only sent when SEEDOTS_LLM_REASONING=auto).
TASKS = [
    TaskSpec("concepts", ConceptsOut, temperature=0.1, max_tokens=12000, timeout=180, cache=True),
    TaskSpec("concept_judge", JudgeOut, temperature=0.0, max_tokens=4000, reasoning="low", cache=True),
    TaskSpec("items", ItemsOut, temperature=0.3, max_tokens=16000, timeout=240, cache=True),
    TaskSpec("select_action", SelectOut, temperature=0.0, max_tokens=4000, timeout=20, reasoning="low"),
    TaskSpec("coach", None, temperature=0.4, max_tokens=6000, timeout=90, reasoning="low"),
    TaskSpec("card", CardOut, temperature=0.3, max_tokens=6000, reasoning="low"),
    TaskSpec("scene_spec", SpecOut, temperature=0.2, max_tokens=12000, timeout=180, cache=True),
    TaskSpec("lab_spec", LabSpecOut, temperature=0.2, max_tokens=16000, timeout=300),
    # prompted output: this model often answers in text instead of calling an output tool (all retries then
    # fail); a JSON answer in text is what lab_spec uses too. A draft that passed its checks is kept anyway.
    TaskSpec("scene_code", BuildOut, temperature=0.3, max_tokens=32000, timeout=420, output_retries=2),
    TaskSpec("scene_review", ReviewOut, temperature=0.0, max_tokens=4000, timeout=90, reasoning="low"),
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
    scenes: SceneService
    workflows: Router


def build_container(settings: Settings | None = None, *, media_http: httpx.Client | None = None,
                    rigs_http: httpx.Client | None = None, inline: bool = False, migrate: bool | None = None,
                    **_: Any) -> LearningContainer:
    settings = settings or load_settings()
    if settings.auto_migrate if migrate is None else migrate:
        upgrade("learning", settings.learning_db_url)
    db = Database(settings.learning_db_url, Base.metadata)
    gateway = build_gateway(settings, prompt_dir=PROMPTS, tasks=TASKS, brain=learning_brain, db=db,
                            usage_model=UsageLog, cache_model=LlmCache, task_endpoints={"scene_review": settings.vlm})
    media = MediaClient(media_http) if media_http is not None else MediaClient.at(settings.media_url)
    embedder = build_embedder(settings.embeddings)
    library = ConceptLibrary(db, gateway, embedder)
    sandbox = NodeSandbox() if settings.sandbox == "local" else None
    rigs = RigClient(rigs_http) if rigs_http is not None else RigClient.at(settings.rigs_url)
    scenes = SceneService(db, gateway, sandbox, vision=settings.llm_fake or settings.vlm.configured,
                          data_dir=settings.data_dir, rigs=rigs)
    runner = ContentRunner(db, media, gateway, library, scenes)
    workflows = Router({CHAPTER_WORKFLOW: runner, SCENE_WORKFLOW: scenes})
    engine = build_engine(settings.workflow_engine, workflows, service="learning",
                          temporal_address=settings.temporal_address, inline=inline)
    runner.engine = scenes.engine = engine
    return LearningContainer(
        settings=settings, db=db, gateway=gateway, media=media, runner=runner, engine=engine,
        inbox=Inbox(db, media, runner.chapter_ready),
        runtime=Runtime(db, LLMSelector(gateway), use_llm=settings.action_selector == "llm"),
        coach=Coach(db, gateway, rigs), knowledge=Knowledge(db, gateway, embedder), library=library,
        scenes=scenes, workflows=workflows)
