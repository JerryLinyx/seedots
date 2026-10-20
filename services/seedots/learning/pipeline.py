"""Content generation for one chapter — a fixed workflow, not an autonomous agent:

    snapshot  copy the chapter's evidence revisions from the foundation
    concepts  extract mentions -> resolve into the global library -> occurrences
    items     generate the base item pool -> validate -> publish (auto_validated)
    gap_fill  ask once more for (concept, level) cells the base pool left empty
    scene     at most one L1 interactive scene, if the chapter has a relationship worth trying

Runs on chapter_ready, in the order the foundation announces chapters (playback priority).
Idempotent per (chapter, PIPELINE_VERSION); each step records its result in the run's stats.
"""
from __future__ import annotations

import logging
from typing import Any

import sqlalchemy as sa
from pydantic import BaseModel, Field

from seedots.common.db import Database, utcnow
from seedots.common.llm import Gateway, LLMError
from seedots.common.timefmt import fmt_ts
from seedots.common.workflow import Engine, PermanentError
from seedots.learning import item_types, items
from seedots.learning.catalog import short, snapshot
from seedots.learning.concepts import ConceptLibrary, Mention, normalize
from seedots.learning.media_client import MediaClient
from seedots.learning.models import (Chapter, ContentRun, EvidenceRole, EvidenceSnapshot, ItemRejection, Misconception,
                                     Occurrence, OccurrenceEvidence, OccurrenceRole, RunStatus, Video)

log = logging.getLogger("seedots.learning.pipeline")

PIPELINE_VERSION = "content@2"
WORKFLOW = "learning.chapter"
STEPS = ["snapshot", "concepts", "items", "gap_fill", "scene"]


class MisconceptionOut(BaseModel):
    id: str
    text: str


class ConceptOut(BaseModel):
    name: str
    aliases: list[str] = Field(default_factory=list)
    definition: str = ""
    role: str = "defined"
    evidence: list[str] = Field(default_factory=list)
    misconceptions: list[MisconceptionOut] = Field(default_factory=list)


class ConceptsOut(BaseModel):
    concepts: list[ConceptOut]


class ItemsOut(BaseModel):
    items: list[dict[str, Any]]      # validated one by one so one bad item does not sink the batch


class ContentRunner:
    def __init__(self, db: Database, media: MediaClient, gateway: Gateway, library: ConceptLibrary, scenes=None):
        self.db, self.media, self.gateway, self.library, self.scenes = db, media, gateway, library, scenes
        self.engine: Engine | None = None

    # ------------------------------------------------------------------ entry
    def chapter_ready(self, media_id: str, chapter_id: str) -> None:
        with self.db.session() as s:
            run = self._run(s, chapter_id)
            if run is None:
                run = ContentRun(chapter_id=chapter_id, pipeline_version=PIPELINE_VERSION, status=RunStatus.PENDING)
                s.add(run)
            elif run.status in (RunStatus.DONE, RunStatus.RUNNING):
                return
            run.status, run.error = RunStatus.PENDING, None
        self.engine.start(WORKFLOW, f"content-{chapter_id}-{PIPELINE_VERSION}",
                          {"media_id": media_id, "chapter_id": chapter_id})

    def resume(self) -> int:
        with self.db.session() as s:
            rows = s.execute(sa.select(Chapter.media_id, ContentRun.chapter_id).join(Chapter)
                             .where(ContentRun.pipeline_version == PIPELINE_VERSION,
                                    ContentRun.status.in_([RunStatus.PENDING, RunStatus.RUNNING]))).all()
        for media_id, chapter_id in rows:
            self.engine.start(WORKFLOW, f"content-{chapter_id}-{PIPELINE_VERSION}",
                              {"media_id": media_id, "chapter_id": chapter_id})
        return len(rows)

    @staticmethod
    def _run(s, chapter_id: str) -> ContentRun | None:
        return s.scalar(sa.select(ContentRun).where(ContentRun.chapter_id == chapter_id,
                                                    ContentRun.pipeline_version == PIPELINE_VERSION))

    # ------------------------------------------------------------------ StepRunner
    def plan(self, workflow: str, arg: dict[str, Any]) -> list[str]:
        with self.db.session() as s:
            run = self._run(s, arg["chapter_id"])
            if run is None or run.status == RunStatus.DONE:
                return []
            run.status = RunStatus.RUNNING
            return [st for st in STEPS if st not in run.stats]

    def run_step(self, workflow: str, arg: dict[str, Any], step: str) -> None:
        with self.db.session() as s:
            run = self._run(s, arg["chapter_id"])
            if step in run.stats:
                return
            run.step, run.attempts = step, run.attempts + 1
            run_id = run.id
        result = getattr(self, f"_{step}")(arg["media_id"], arg["chapter_id"], run_id)
        with self.db.session() as s:
            run = s.get(ContentRun, run_id)
            run.stats = {**run.stats, step: result}
            if step == STEPS[-1]:
                run.status, run.finished_at, run.step = RunStatus.DONE, utcnow(), ""

    def failed(self, workflow: str, arg: dict[str, Any], error: str) -> None:
        with self.db.session() as s:
            run = self._run(s, arg["chapter_id"])
            if run:
                run.status, run.error, run.finished_at = RunStatus.FAILED, error[:500], utcnow()

    # ------------------------------------------------------------------ steps
    def _snapshot(self, media_id: str, chapter_id: str, run_id: int) -> dict:
        with self.db.session() as s:
            ch = s.get(Chapter, chapter_id)
            if ch is None:
                raise PermanentError(f"chapter {chapter_id} is unknown")
            t0, t1 = ch.t0, ch.t1
        units = self.media.evidence(media_id, kinds="sentence,chapter", t0=t0 - 0.01, t1=t1 + 0.01)
        chapter = next((u for u in units if u.id == chapter_id), None)
        if chapter is None:
            raise PermanentError(f"chapter {chapter_id} no longer exists in the outline")
        ids = set(chapter.content.get("sentence_ids") or [])
        sentences = [u for u in units if u.kind == "sentence" and u.id in ids]
        with self.db.session() as s:
            snapshot(s, [chapter, *sentences])
        return {"sentences": len(sentences), "chapter_revision": chapter.revision}

    def _context(self, s, media_id: str, chapter_id: str) -> tuple[Video, EvidenceSnapshot, list[EvidenceSnapshot]]:
        video = s.get(Video, media_id)
        ch = s.scalar(sa.select(EvidenceSnapshot).where(EvidenceSnapshot.id == chapter_id,
                                                        EvidenceSnapshot.is_current.is_(True)))
        ids = ch.content.get("sentence_ids") or []
        rows = {r.id: r for r in s.scalars(sa.select(EvidenceSnapshot).where(EvidenceSnapshot.id.in_(ids),
                                                                             EvidenceSnapshot.is_current.is_(True)))}
        return video, ch, [rows[i] for i in ids if i in rows]

    @staticmethod
    def _lines(sentences: list[EvidenceSnapshot]) -> str:
        return "\n".join(f"{short(x.id)} [{fmt_ts(x.t0)}] {x.content.get('text', '')}" for x in sentences)

    def _concepts(self, media_id: str, chapter_id: str, run_id: int) -> dict:
        with self.db.session() as s:
            video, ch, sentences = self._context(s, media_id, chapter_id)
            variables = {"title": video.title, "chapter_title": ch.content.get("title", ""),
                         "chapter_summary": ch.content.get("summary", ""), "sentences": self._lines(sentences)}
        out: ConceptsOut = self.gateway.run("concepts", variables,
                                            manifest={"chapter": chapter_id, "evidence": [x.id for x in sentences]})
        saved = []
        by_short = {short(x.id): x for x in sentences}
        for c in out.concepts:
            evs = [by_short[e] for e in c.evidence if e in by_short]
            if not evs or not normalize(c.name):
                continue                    # unanchored concepts are dropped, not guessed
            res = self.library.resolve(Mention(
                name=c.name, definition=c.definition, aliases=c.aliases,
                misconceptions=[(m.id, m.text) for m in c.misconceptions],
                context=evs[0].content.get("text", "")), actor=f"content:{run_id}")
            role = c.role if c.role in OccurrenceRole._value2member_map_ else "mentioned"
            with self.db.session() as s:
                occ = s.scalar(sa.select(Occurrence).where(Occurrence.concept_id == res.concept_id,
                                                           Occurrence.chapter_id == chapter_id))
                if occ is None:
                    occ = Occurrence(concept_id=res.concept_id, media_id=media_id, chapter_id=chapter_id, role=role,
                                     t0=min(e.t0 for e in evs), t1=max(e.t1 for e in evs), content_run_id=run_id,
                                     confidence=1.0 if res.how in ("exact", "created") else res.score)
                    s.add(occ)
                have = {e.evidence_id for e in occ.evidence}
                for e in evs:
                    if e.id not in have:
                        occ.evidence.append(OccurrenceEvidence(evidence_id=e.id, evidence_revision=e.revision))
            saved.append({"id": res.concept_id, "name": c.name, "how": res.how,
                          "misconceptions": [m.id for m in c.misconceptions]})
        return {"concepts": saved}

    def _items(self, media_id: str, chapter_id: str, run_id: int, focus: str = "") -> dict:
        with self.db.session() as s:
            concepts = s.get(ContentRun, run_id).stats.get("concepts", {}).get("concepts", [])
            if not concepts:
                return {"published": 0, "rejected": 0}
            video, ch, sentences = self._context(s, media_id, chapter_id)
            misc = {(m.concept_id, m.slug): m for m in s.scalars(sa.select(Misconception).where(
                Misconception.concept_id.in_([c["id"] for c in concepts])))}
            concept_txt = "\n".join(
                f"- {c['name']}: " + ("; ".join(f"{m.slug}: {m.text}" for (cid, _), m in misc.items()
                                                if cid == c["id"]) or "none") for c in concepts)
            variables = {"title": video.title, "chapter_title": ch.content.get("title", ""),
                         "chapter_summary": ch.content.get("summary", ""), "concepts": concept_txt,
                         "sentences": self._lines(sentences),
                         "focus": focus or "Cover every listed concept at the levels the chapter supports."}
            by_short = {short(x.id): x for x in sentences}
            chapter_start = ch.t0
        out: ItemsOut = self.gateway.run("items", variables, use_cache=not focus,
                                         manifest={"chapter": chapter_id, "focus": bool(focus)})
        by_name = {normalize(c["name"]): c for c in concepts}
        prompt_tag = self.gateway.prompts.get("items", self.gateway.spec("items").prompt_version).tag
        published = rejected = 0
        with self.db.session() as s:
            for raw in out.items:
                try:
                    draft = item_types.ItemDraft.model_validate(raw)
                    concept = by_name.get(normalize(draft.concept)) or (concepts[0] if len(concepts) == 1 else None)
                    if concept is None:
                        raise item_types.InvalidItem(f"unknown concept {draft.concept!r}")
                    cited = [by_short.get(e) for e in draft.evidence]
                    if not cited or any(x is None for x in cited):
                        raise item_types.InvalidItem("evidence must cite sentence ids from this chapter")
                    evidence = [(x.id, x.revision, EvidenceRole.SUPPORT) for x in cited]
                    show_before = None
                    if draft.type == "predict":
                        reveal = by_short.get(draft.reveal_after or "")
                        if reveal is None or reveal.id not in {x.id for x in cited}:
                            raise item_types.InvalidItem("predict item needs reveal_after inside its evidence")
                        if reveal.t0 - chapter_start < 10:
                            raise item_types.InvalidItem("predict item reveals too early to be asked beforehand")
                        show_before = reveal.t0
                        evidence = [(i, r, EvidenceRole.REVEAL if i == reveal.id else role) for i, r, role in evidence]
                    t, payload, answer = item_types.build(draft)
                    m = misc.get((concept["id"], draft.misconception or ""))
                    items.publish(s, media_id=media_id, chapter_id=chapter_id, type_=t.name, level=draft.level,
                                  payload=payload.model_dump(), answer_key=answer.model_dump(),
                                  concept_ids=[concept["id"]], evidence=evidence, generator=prompt_tag,
                                  content_run_id=run_id, misconception_id=m.id if m else None,
                                  show_before_s=show_before)
                    published += 1
                except (item_types.InvalidItem, ValueError) as exc:
                    rejected += 1
                    s.add(ItemRejection(content_run_id=run_id, draft=raw, reason=str(exc)[:500]))
        return {"published": published, "rejected": rejected}

    def _gap_fill(self, media_id: str, chapter_id: str, run_id: int) -> dict:
        with self.db.session() as s:
            concepts = s.get(ContentRun, run_id).stats.get("concepts", {}).get("concepts", [])
            have = {(c.concept_id, it.level) for it in items.pool(s, media_id, chapter_id) for c in it.concepts}
        gaps = [(c["name"], lv) for c in concepts for lv in (1, 2) if (c["id"], lv) not in have]
        if not gaps:
            return {"gaps": 0}
        focus = "Only write items for these missing (concept, level) cells, if the chapter supports them: " + \
            "; ".join(f"{n} @ level {lv}" for n, lv in gaps)
        try:
            res = self._items(media_id, chapter_id, run_id, focus=focus)
        except LLMError as exc:          # the base pool is already usable; gap fill is best effort
            return {"gaps": len(gaps), "error": str(exc)[:200]}
        return {"gaps": len(gaps), **res}

    def _scene(self, media_id: str, chapter_id: str, run_id: int) -> dict:
        if self.scenes is None:
            return {"scene": None, "reason": "scenes disabled"}
        try:
            return self.scenes.make_l1(media_id, chapter_id, run_id)
        except LLMError as exc:          # the chapter is useful without a scene
            return {"scene": None, "reason": f"model error: {str(exc)[:160]}"}
