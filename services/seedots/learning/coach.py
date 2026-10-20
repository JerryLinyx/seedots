"""AI Coach: a grounded, streaming tutor for the current moment (tech plan §7).

  * prebuilt context pack: transcript around now, chapter, concepts + misconceptions, the
    learner's marks and recent misses - assembled from the DB, no video goes to the model
  * whitelisted tools, bound to this request: transcript_around(sentence id) and
    concept_elsewhere(name) for cross-video retrieval within what the learner may see
  * answers cite evidence ids ([s0042], [o1]); code maps them to times. Knowledge not from
    the video must be flagged "(not from the video)" and is stored as an external citation
  * one thread per (user, video)
"""
from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncIterator
from typing import Any

import sqlalchemy as sa
from sqlalchemy.orm import Session

from seedots.common.db import Database
from seedots.common.ids import new_id
from seedots.common.llm import Gateway
from seedots.common.timefmt import fmt_ts
from seedots.learning.catalog import current_sentences, ensure_user, short, visible_media_ids, visible_video
from seedots.learning.models import (Attempt, Chapter, ChatRole, CitationKind, CoachMessage, CoachThread, Concept,
                                     ConceptAlias, EvidenceSnapshot, ItemConcept, LearningItem, Mark, MessageCitation,
                                     Occurrence, OccurrenceEvidence, Video)

CITE = re.compile(r"\[(s\d{4}|o\d{1,2})\]")
EXTERNAL = "(not from the video)"


class CoachSession:
    """State for one answer: the refs the model may cite, filled by the pack and by tools."""

    def __init__(self, db: Database, user_id: str, media_id: str):
        self.db, self.user_id, self.media_id = db, user_id, media_id
        self.refs: dict[str, tuple[str, int, float, float, str | None]] = {}   # ref -> (evidence id, rev, t0, t1, media)

    def add(self, ref: str, snap: EvidenceSnapshot, media_id: str | None = None) -> None:
        self.refs.setdefault(ref, (snap.id, snap.revision, snap.t0, snap.t1, media_id))

    # ------------------------------------------------------------------ tools (whitelist)
    def tools(self) -> list:
        def transcript_around(sentence_id: str, before: int = 4, after: int = 4) -> list[dict[str, str]]:
            """Read the transcript of the current video around a sentence id such as s0042."""
            before, after = max(0, min(before, 12)), max(0, min(after, 12))
            with self.db.session() as s:
                rows = current_sentences(s, self.media_id)
                idx = next((i for i, r in enumerate(rows) if short(r.id) == sentence_id), None)
                if idx is None:
                    return [{"error": f"unknown sentence id {sentence_id}"}]
                window = rows[max(0, idx - before): idx + after + 1]
                for r in window:
                    self.add(short(r.id), r)
                return [{"id": short(r.id), "text": r.content.get("text", "")} for r in window]

        def concept_elsewhere(name: str) -> list[dict[str, str]]:
            """Find where a concept is taught in the learner's other videos. Cite results by their id (o1, o2...)."""
            from seedots.learning.concepts import normalize

            n = normalize(name)
            with self.db.session() as s:
                cid = s.scalar(sa.select(Concept.id).where(Concept.norm_name == n, Concept.status == "active")) or \
                    s.scalar(sa.select(ConceptAlias.concept_id).where(ConceptAlias.norm == n))
                if not cid:
                    return [{"error": f"no concept named {name!r} in the library"}]
                rows = s.execute(
                    sa.select(Occurrence, Video.title).join(Video, Video.media_id == Occurrence.media_id)
                    .where(Occurrence.concept_id == cid, Occurrence.media_id != self.media_id,
                           Occurrence.media_id.in_(visible_media_ids(s, self.user_id))).limit(3)).all()
                out = []
                for occ, title in rows:
                    ev = s.scalar(sa.select(OccurrenceEvidence).where(OccurrenceEvidence.occurrence_id == occ.id))
                    snap = s.get(EvidenceSnapshot, (ev.evidence_id, ev.evidence_revision)) if ev else None
                    if snap is None:
                        continue
                    ref = f"o{len([r for r in self.refs if r.startswith('o')]) + 1}"
                    self.add(ref, snap, occ.media_id)
                    out.append({"id": ref, "video": title, "text": snap.content.get("text", "")})
                return out or [{"note": "not taught in the learner's other videos"}]

        return [transcript_around, concept_elsewhere]


class Coach:
    def __init__(self, db: Database, gateway: Gateway):
        self.db, self.gateway = db, gateway

    # ------------------------------------------------------------------ context pack
    def pack(self, s: Session, cs: CoachSession, t: float) -> tuple[dict[str, Any], list[tuple[str, str]], str]:
        user_id, media_id = cs.user_id, cs.media_id
        video = visible_video(s, media_id, user_id)
        sents = current_sentences(s, media_id, t - 90, t + 30)
        for x in sents:
            cs.add(short(x.id), x)
        chapter = s.scalar(sa.select(Chapter).where(Chapter.media_id == media_id, Chapter.retired_at.is_(None),
                                                    Chapter.t0 <= t, Chapter.t1 > t))
        concepts: list[Concept] = []
        if chapter:
            concepts = list(s.scalars(sa.select(Concept).join(Occurrence, Occurrence.concept_id == Concept.id)
                                      .where(Occurrence.chapter_id == chapter.id)))
        marks = list(s.scalars(sa.select(Mark).where(Mark.user_id == user_id, Mark.media_id == media_id,
                                                     Mark.deleted_at.is_(None), Mark.t.between(t - 180, t + 30))
                               .order_by(Mark.t).limit(5)))
        misses = s.execute(sa.select(LearningItem.payload).join(Attempt, Attempt.item_id == LearningItem.id)
                           .where(Attempt.user_id == user_id, Attempt.correct.is_(False),
                                  LearningItem.media_id == media_id)
                           .order_by(Attempt.created_at.desc()).limit(3)).scalars().all()
        thread = s.scalar(sa.select(CoachThread).where(CoachThread.user_id == user_id, CoachThread.media_id == media_id))
        if thread is None:
            thread = CoachThread(id=new_id("thr"), user_id=user_id, media_id=media_id)
            s.add(thread)
            s.flush()
        history = [(m.role.value, m.content) for m in reversed(list(s.scalars(
            sa.select(CoachMessage).where(CoachMessage.thread_id == thread.id)
            .order_by(CoachMessage.created_at.desc()).limit(8))))]
        variables = {
            "title": video.title,
            "chapter": chapter.title if chapter else "unknown",
            "concepts": "; ".join(f"{c.name} (common mistakes: " + (", ".join(m.text for m in c.misconceptions[:2])
                                                                     or "none") + ")" for c in concepts) or "none",
            "marks": "; ".join(f"{m.type.value} at {fmt_ts(m.t)}" + (f" — {m.note}" if m.note else "") for m in marks)
            or "none",
            "misses": "; ".join(str(p.get("stem", ""))[:120] for p in misses) or "none",
            "now": fmt_ts(t),
            "context": "\n".join(f"{short(x.id)} [{fmt_ts(x.t0)}]{' <- now' if x.t0 <= t < x.t1 else ''} "
                                 f"{x.content.get('text', '')}" for x in sents) or "(no transcript near this moment)",
        }
        return variables, history, thread.id

    # ------------------------------------------------------------------ ask
    async def ask(self, user_id: str, media_id: str, t: float, question: str) -> AsyncIterator[dict[str, Any]]:
        question = question.strip() or "I'm confused about this part. Can you explain it?"
        cs = CoachSession(self.db, user_id, media_id)

        def prepare():
            with self.db.session() as s:
                ensure_user(s, user_id)
                variables, history, thread_id = self.pack(s, cs, t)
                s.add(CoachMessage(id=new_id("msg"), thread_id=thread_id, role=ChatRole.USER, content=question,
                                   media_time=t))
                return variables, history, thread_id

        variables, history, thread_id = await asyncio.to_thread(prepare)
        variables["question"] = question
        text = ""
        async for delta in self.gateway.stream("coach", variables, history=history, tools=cs.tools(),
                                               manifest={"media_id": media_id, "t": t, "refs": len(cs.refs)}):
            text += delta
            yield {"type": "delta", "text": delta}
        citations = self._citations(cs, text)
        prompt_tag = self.gateway.prompts.get("coach", self.gateway.spec("coach").prompt_version).tag

        def save() -> str:
            with self.db.session() as s:
                msg = CoachMessage(id=new_id("msg"), thread_id=thread_id, role=ChatRole.ASSISTANT, content=text,
                                   media_time=t, prompt_version=prompt_tag)
                msg.citations = [MessageCitation(ord=i, kind=c["kind"], ref=c["ref"], evidence_id=c.get("id"),
                                                 evidence_revision=c.get("revision")) for i, c in enumerate(citations)]
                s.add(msg)
                return msg.id

        message_id = await asyncio.to_thread(save)
        yield {"type": "done", "message_id": message_id, "citations": citations}

    @staticmethod
    def _citations(cs: CoachSession, text: str) -> list[dict[str, Any]]:
        out = []
        for ref in dict.fromkeys(CITE.findall(text)):
            hit = cs.refs.get(ref)
            if hit:
                eid, rev, t0, t1, other_media = hit
                out.append({"kind": CitationKind.EVIDENCE.value, "ref": ref, "id": eid, "revision": rev, "t0": t0,
                            "t1": t1, "media_id": other_media or cs.media_id})
        if EXTERNAL in text:
            out.append({"kind": CitationKind.EXTERNAL.value, "ref": "external"})
        return out

    def thread(self, user_id: str, media_id: str) -> list[dict[str, Any]]:
        with self.db.session() as s:
            thread = s.scalar(sa.select(CoachThread).where(CoachThread.user_id == user_id,
                                                           CoachThread.media_id == media_id))
            if thread is None:
                return []
            msgs = s.scalars(sa.select(CoachMessage).where(CoachMessage.thread_id == thread.id)
                             .order_by(CoachMessage.created_at))
            out = []
            for m in msgs:
                cites = []
                for c in m.citations:
                    snap = s.get(EvidenceSnapshot, (c.evidence_id, c.evidence_revision)) if c.evidence_id else None
                    cites.append({"kind": c.kind.value, "ref": c.ref, "id": c.evidence_id,
                                  "t0": snap.t0 if snap else None, "t1": snap.t1 if snap else None,
                                  "media_id": snap.media_id if snap else None})
                out.append({"id": m.id, "role": m.role.value, "content": m.content, "t": m.media_time,
                            "citations": cites})
            return out


__all__ = ["Coach", "ItemConcept"]
