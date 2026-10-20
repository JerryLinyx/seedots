"""Content generation for one chapter (fixed workflow, not an autonomous agent):
evidence snapshot -> concepts (+ normalisation into the global library) -> learning items
-> validation -> publish. Idempotent per (chapter, PIPELINE_VERSION)."""
from __future__ import annotations

import logging

from pydantic import BaseModel, Field

from seedots.common.contracts import EvidenceUnit
from seedots.common.ids import new_id, stable_id
from seedots.common.llm import Gateway, LLMError
from seedots.learning import item_types
from seedots.learning.media_client import MediaClient
from seedots.learning.store import LearningStore, normalize
from seedots.common.timefmt import fmt_ts

log = logging.getLogger("seedots.learning.pipeline")

PIPELINE_VERSION = "content@1"


def short(eid: str) -> str:
    return eid.rsplit(".", 1)[-1]


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
    items: list[dict]          # validated one by one so a bad item does not sink the batch


class ChapterPipeline:
    def __init__(self, store: LearningStore, media: MediaClient, gateway: Gateway):
        self.store, self.media, self.gateway = store, media, gateway

    def run(self, media_id: str, chapter_id: str) -> dict:
        if self.store.chapter_status(chapter_id, PIPELINE_VERSION) == "done":
            return {"skipped": True}
        self.store.chapter_mark(chapter_id, PIPELINE_VERSION, media_id, "running")
        try:
            result = self._run(media_id, chapter_id)
        except Exception as exc:
            log.exception("chapter %s failed", chapter_id)
            self.store.chapter_mark(chapter_id, PIPELINE_VERSION, media_id, "failed", str(exc))
            raise
        self.store.chapter_mark(chapter_id, PIPELINE_VERSION, media_id, "done")
        return result

    # ------------------------------------------------------------------
    def _run(self, media_id: str, chapter_id: str) -> dict:
        units = self.media.evidence(media_id, kinds="sentence,chapter")
        self.store.save_evidence(units)
        chapter = next((u for u in units if u.id == chapter_id), None)
        if chapter is None:
            raise LLMError(f"chapter {chapter_id} not found in media evidence")
        ids = set(chapter.content.get("sentence_ids") or [])
        sentences = [u for u in units if u.kind == "sentence" and u.id in ids]
        video = self.store.video(media_id) or {}
        title = video.get("title") or ""
        lines = "\n".join(f"{short(s.id)} [{fmt_ts(s.t0)}] {s.content['text']}" for s in sentences)
        by_short = {short(s.id): s for s in sentences}

        concepts = self._concepts(media_id, chapter, title, lines, by_short)
        items = self._items(media_id, chapter, title, lines, by_short, concepts) if concepts else (0, 0)
        return {"concepts": len(concepts), "published": items[0], "rejected": items[1]}

    def _concepts(self, media_id: str, chapter: EvidenceUnit, title: str, lines: str,
                  by_short: dict[str, EvidenceUnit]) -> list[dict]:
        out = self.gateway.run("concepts", {
            "title": title, "chapter_title": chapter.content.get("title", ""),
            "chapter_summary": chapter.content.get("summary", ""), "sentences": lines,
        }, ConceptsOut, evidence_ids=[u.id for u in by_short.values()])

        saved: list[dict] = []
        for c in out.concepts:
            ev = [by_short[s].id for s in c.evidence if s in by_short]
            if not ev or not c.name.strip():
                continue  # unsupported concept: drop rather than keep an unanchored node
            norms = [normalize(c.name)] + [normalize(a) for a in c.aliases]
            existing = self.store.concept_by_norm(norms)
            mis = [m.model_dump() for m in c.misconceptions]
            if existing:
                aliases = sorted({*existing["aliases"], *c.aliases, c.name} - {existing["name"]})
                known = {m["id"] for m in existing["misconceptions"]}
                merged = existing["misconceptions"] + [m for m in mis if m["id"] not in known]
                self.store.update_concept(existing["id"], aliases, merged, c.definition or None)
                concept_id, name, misc = existing["id"], existing["name"], merged
            else:
                concept_id = stable_id("con", normalize(c.name))
                self.store.insert_concept({"id": concept_id, "name": c.name.strip(), "norm": normalize(c.name),
                                           "aliases": sorted(set(c.aliases)), "definition": c.definition,
                                           "misconceptions": mis})
                name, misc = c.name.strip(), mis
            evs = [by_short[s] for s in c.evidence if s in by_short]
            self.store.insert_occurrence({
                "id": stable_id("occ", concept_id, chapter.id), "concept_id": concept_id, "media_id": media_id,
                "chapter_id": chapter.id, "evidence_ids": ev, "role": c.role,
                "t0": min(e.t0 for e in evs), "t1": max(e.t1 for e in evs)})
            saved.append({"id": concept_id, "name": name, "misconceptions": misc})
        return saved

    def _items(self, media_id: str, chapter: EvidenceUnit, title: str, lines: str,
               by_short: dict[str, EvidenceUnit], concepts: list[dict]) -> tuple[int, int]:
        concept_txt = "\n".join(
            f"- {c['name']}: " + ("; ".join(f"{m['id']}: {m['text']}" for m in c["misconceptions"]) or "none")
            for c in concepts)
        out = self.gateway.run("items", {
            "title": title, "chapter_title": chapter.content.get("title", ""),
            "chapter_summary": chapter.content.get("summary", ""), "concepts": concept_txt, "sentences": lines,
        }, ItemsOut, evidence_ids=[u.id for u in by_short.values()])

        by_name = {normalize(c["name"]): c for c in concepts}
        published = rejected = 0
        for raw in out.items:
            item_id = new_id("itm")
            try:
                draft = item_types.ItemDraft.model_validate(raw)
                concept = by_name.get(normalize(draft.concept)) or (concepts[0] if len(concepts) == 1 else None)
                if concept is None:
                    raise item_types.InvalidItem(f"unknown concept {draft.concept!r}")
                evidence = [by_short[s].id for s in draft.evidence if s in by_short]
                if not evidence or len(evidence) != len(draft.evidence):
                    raise item_types.InvalidItem("evidence must cite sentence ids from this chapter")
                show_at = None
                if draft.type == "predict":
                    reveal = by_short.get(draft.reveal_after or "")
                    if reveal is None or reveal.id not in evidence:
                        raise item_types.InvalidItem("predict item needs reveal_after inside its evidence")
                    if reveal.t0 - chapter.t0 < 10:
                        raise item_types.InvalidItem("predict item reveals too early to be asked beforehand")
                    show_at = reveal.t0
                t, payload, answer = item_types.build(draft)
                self.store.insert_item({
                    "id": item_id, "media_id": media_id, "chapter_id": chapter.id, "type": t.name,
                    "schema_version": 1, "version": 1, "concept_ids": [concept["id"]], "evidence_ids": evidence,
                    "level": draft.level, "purpose_tags": [], "review_status": "auto_validated", "show_at": show_at,
                    "payload": payload.model_dump(), "answer_key": {**answer.model_dump(),
                                                                    "misconception": draft.misconception},
                })
                published += 1
            except (item_types.InvalidItem, ValueError) as exc:
                rejected += 1
                self.store.insert_item({
                    "id": item_id, "media_id": media_id, "chapter_id": chapter.id, "type": str(raw.get("type")),
                    "schema_version": 1, "version": 1, "concept_ids": [], "evidence_ids": [], "level": 1,
                    "purpose_tags": [], "review_status": "rejected", "show_at": None, "payload": raw,
                    "answer_key": {}, "reject_reason": str(exc)[:300]})
        return published, rejected
