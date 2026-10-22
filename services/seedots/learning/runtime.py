"""Learning runtime: action selection, grading, mastery (tech plan §6).

The front end decides *when* an interruption is acceptable (natural pauses, rate limit,
focus mode, muting after dismissals). Here we decide *what* to do. The rule selector always
runs and is logged; the model selector runs first when enabled and any failure falls back
to the rule choice. Online path = lookups only: items come from the pre-built pool.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

import sqlalchemy as sa
from pydantic import BaseModel
from sqlalchemy.orm import Session

from seedots.common.db import Database, utcnow
from seedots.common.ids import new_id
from seedots.common.llm import Gateway, LLMError
from seedots.common.timefmt import fmt_ts
from seedots.learning import item_types, items
from seedots.learning.catalog import add_to_library, current_sentences, ensure_user, visible_video
from seedots.learning.models import (Action, Attempt, Chapter, ConceptLink, Decision, DecisionOutcome, EvidenceRole,
                                     LearningItem, LibraryEntry, LinkRelation, Mastery, Occurrence, ReviewStatus,
                                     SceneSpec, SceneStatus, UserSettings, Video)

ActionName = Literal["none", "check_in", "quiz", "predict", "rewatch", "explain", "link", "lab"]
SignalName = Literal["rewind_repeat", "long_pause", "chapter_end", "skip_ahead", "confused_mark", "predict_window",
                     "concept_seen_before", "manual"]


# Which actions make sense for each signal; the model only ever chooses among these.
# Explicit learner requests (EXPLICIT) are not second-guessed by the model: the rules answer them.
ALLOWED: dict[str, list[str]] = {
    "chapter_end": ["none", "quiz", "lab", "check_in", "rewatch", "explain"],
    "skip_ahead": ["none", "quiz", "check_in", "rewatch"],
    "manual": ["none", "quiz"],          # the learner pressed "Quiz me": a question, or none if none is left
    "rewind_repeat": ["none", "check_in", "rewatch", "explain", "quiz"],
    "long_pause": ["none", "check_in", "explain", "quiz"],
    "predict_window": ["none", "predict"],
    "concept_seen_before": ["none", "link"],
    "confused_mark": ["explain"],
}


EXPLICIT = {"confused_mark", "manual"}


class Signal(BaseModel):
    kind: SignalName
    t: float
    chapter_id: str | None = None        # chapter that ended / was skipped, if any
    concept_id: str | None = None        # concept_seen_before
    detail: dict[str, Any] = {}


@dataclass
class Context:
    user_id: str
    media_id: str
    signal: Signal
    chapter: Chapter | None
    quiz_items: list[LearningItem]
    predict_items: list[LearningItem]
    rewatch: dict | None
    link: dict | None
    lab: dict | None                     # a ready lab for this chapter: {id, title, engine}
    mastery: dict[str, Mastery]
    purpose: str
    recent: list[Decision]
    candidates: list[str] = field(default_factory=list)


@dataclass
class Choice:
    action: str
    item_id: str | None
    reason: str


class ActionSelector(Protocol):
    name: str

    def select(self, ctx: Context, s: Session) -> Choice: ...


def _target_level(it: LearningItem, mastery: dict[str, Mastery]) -> int:
    return max((mastery[c.concept_id].level for c in it.concepts if c.concept_id in mastery), default=1)


def pick_item(pool: list[LearningItem], mastery: dict[str, Mastery]) -> LearningItem | None:
    """Level closest to the learner's current level; reviewed items first on ties."""
    if not pool:
        return None
    return sorted(pool, key=lambda it: (abs(it.level - _target_level(it, mastery)),
                                        it.review_status != ReviewStatus.HUMAN_REVIEWED, it.level, it.id))[0]


class RuleSelector:
    name = "rule@2"

    def select(self, ctx: Context, s: Session | None = None) -> Choice:
        k = ctx.signal.kind
        quiz = pick_item(ctx.quiz_items, ctx.mastery)
        if k == "confused_mark":
            return Choice("explain", None, "learner marked confusion")
        if k == "predict_window" and ctx.predict_items:
            return Choice("predict", ctx.predict_items[0].id, "the video is about to reveal an answer")
        if k == "concept_seen_before" and ctx.link:
            return Choice("link", None, "this concept appeared in another video you watched")
        if k in ("chapter_end", "skip_ahead", "manual"):
            if quiz:
                return Choice("quiz", quiz.id, "check the part just skipped" if k == "skip_ahead"
                              else "check the chapter just covered")
            if k == "chapter_end" and ctx.lab:
                return Choice("lab", None, "this chapter has a lab to try what it taught")
            return Choice("none", None, "no usable item for this chapter yet")
        if k == "rewind_repeat":
            if ctx.rewatch:
                return Choice("rewatch", None, "an earlier answer on this concept was wrong")
            return Choice("check_in", None, "repeated rewinds over the same span")
        if k == "long_pause":
            return Choice("check_in", None, "long pause")
        return Choice("none", None, "weak signal")


class SelectOut(BaseModel):
    action: ActionName
    item_id: str | None = None
    reason: str = ""
    confidence: float = 0.5


class LLMSelector:
    name = "llm@select_action"

    def __init__(self, gateway: Gateway):
        self.gateway = gateway

    def select(self, ctx: Context, s: Session) -> Choice:
        sents = current_sentences(s, ctx.media_id, ctx.signal.t - 45, ctx.signal.t + 10)
        offered = {"quiz": ctx.quiz_items[:6], "predict": ctx.predict_items[:2]}
        items_txt = [{"item_id": it.id, "for_action": a, "type": it.type.value, "level": it.level,
                      "stem": str(it.payload.get("stem", ""))[:160]} for a, its in offered.items() for it in its]
        now = utcnow()
        out: SelectOut = self.gateway.run("select_action", {
            "signal": ctx.signal.model_dump(exclude={"detail"}), "purpose": ctx.purpose,
            "recent": [{"action": d.action.value, "seconds_ago": _ago(now, d.created_at)} for d in ctx.recent[:5]],
            "mastery": {cid: m.level for cid, m in ctx.mastery.items()},
            "context": "\n".join(f"[{fmt_ts(x.t0)}] {x.content.get('text', '')}" for x in sents) or "(no transcript)",
            "candidates": ctx.candidates, "items": items_txt,
            "lab": {"title": ctx.lab["title"]} if ctx.lab else "none",
        }, use_cache=False, manifest={"signal": ctx.signal.kind, "candidates": ctx.candidates})
        if out.action not in ctx.candidates:
            raise LLMError(f"model chose {out.action!r}, not a candidate")
        if out.action in ("quiz", "predict"):
            if out.item_id not in {it.id for it in offered[out.action]}:
                raise LLMError("model chose an item that was not offered")
        else:
            out.item_id = None
        return Choice(out.action, out.item_id, out.reason[:200])


def _ago(now, then) -> int:
    if then.tzinfo is None:
        now = now.replace(tzinfo=None)
    return int((now - then).total_seconds())


class Runtime:
    def __init__(self, db: Database, llm_selector: ActionSelector | None, *, use_llm: bool = True):
        self.db, self.rule, self.llm, self.use_llm = db, RuleSelector(), llm_selector, use_llm

    # ------------------------------------------------------------------ context
    def _context(self, s: Session, user_id: str, media_id: str, signal: Signal) -> Context:
        chapters = list(s.scalars(sa.select(Chapter).where(Chapter.media_id == media_id, Chapter.retired_at.is_(None))
                                  .order_by(Chapter.ord)))
        chapter = next((c for c in chapters if c.id == signal.chapter_id), None) or \
            next((c for c in chapters if c.t0 <= signal.t < c.t1), None)
        pool = items.pool(s, media_id)
        tried = set(s.scalars(sa.select(Attempt.item_key).where(Attempt.user_id == user_id,
                                                                Attempt.item_key.in_([i.item_key for i in pool]))))
        fresh = [i for i in pool if i.item_key not in tried]
        quiz = [i for i in fresh if chapter and i.chapter_id == chapter.id
                and item_types.REGISTRY[i.type.value].quiz_kind == "quiz"]
        # predict items are offered only when the front end reports the reveal is near
        predict = [i for i in fresh if signal.kind == "predict_window" and i.type.value == "predict"
                   and i.show_before_s and signal.t < i.show_before_s <= signal.t + 45]
        concept_ids = sorted({c.concept_id for i in pool if chapter and i.chapter_id == chapter.id for c in i.concepts})
        mastery = {m.concept_id: m for m in s.scalars(sa.select(Mastery).where(
            Mastery.user_id == user_id, Mastery.concept_id.in_(concept_ids)))}
        settings = s.get(UserSettings, user_id)
        recent = list(s.scalars(sa.select(Decision).where(Decision.user_id == user_id, Decision.media_id == media_id)
                                .order_by(Decision.created_at.desc()).limit(10)))
        ctx = Context(user_id, media_id, signal, chapter, quiz, predict,
                      self._rewatch_target(s, user_id, media_id, concept_ids),
                      self._link_target(s, user_id, media_id, signal.concept_id),
                      self._lab_target(s, chapter),
                      mastery, settings.purpose.value if settings else "interest", recent)
        available = {"none", "check_in", "explain"} | ({"quiz"} if quiz else set()) | \
            ({"predict"} if predict else set()) | ({"rewatch"} if ctx.rewatch else set()) | \
            ({"link"} if ctx.link else set()) | ({"lab"} if ctx.lab else set())
        ctx.candidates = [a for a in ALLOWED[signal.kind] if a in available]
        return ctx

    @staticmethod
    def _rewatch_target(s: Session, user_id: str, media_id: str, concept_ids: list[str]) -> dict | None:
        wrong = s.scalars(sa.select(Attempt).where(Attempt.user_id == user_id, Attempt.correct.is_(False))
                          .order_by(Attempt.created_at.desc()).limit(20))
        for a in wrong:
            item = s.get(LearningItem, a.item_id)
            if item and item.media_id == media_id and {c.concept_id for c in item.concepts} & set(concept_ids):
                ev = items.evidence_times(s, [item])
                spans = [ev[(e.evidence_id, e.evidence_revision)] for e in item.evidence
                         if (e.evidence_id, e.evidence_revision) in ev]
                if spans:
                    first = min(spans, key=lambda u: u.t0)
                    return {"evidence_id": first.id, "t0": first.t0, "t1": max(u.t1 for u in spans), "item_id": item.id}
        return None

    @staticmethod
    def _lab_target(s: Session, chapter: Chapter | None) -> dict | None:
        """A ready lab for this chapter (looked up only: nothing is generated online)."""
        if chapter is None:
            return None
        row = s.scalar(sa.select(SceneSpec).where(SceneSpec.chapter_id == chapter.id, SceneSpec.status == SceneStatus.READY)
                       .order_by(SceneSpec.created_at))
        if row is None:
            return None
        return {"id": row.id, "title": row.title, "engine": "rig" if (row.spec or {}).get("version") == 2 else row.level.value}

    @staticmethod
    def _link_target(s: Session, user_id: str, media_id: str, concept_id: str | None) -> dict | None:
        """Where the learner met this concept before: another video in their library."""
        if not concept_id:
            return None
        occ = s.execute(sa.select(Occurrence, Video.title).join(Video, Video.media_id == Occurrence.media_id)
                        .join(LibraryEntry, sa.and_(LibraryEntry.media_id == Occurrence.media_id,
                                                    LibraryEntry.user_id == user_id))
                        .where(Occurrence.concept_id == concept_id, Occurrence.media_id != media_id)
                        .order_by(LibraryEntry.last_opened_at.desc().nullslast())).first()
        if occ is None:
            return None
        o, title = occ
        seen = s.scalar(sa.select(ConceptLink).where(ConceptLink.user_id == user_id, ConceptLink.concept_id == concept_id,
                                                     ConceptLink.from_media_id == media_id,
                                                     ConceptLink.to_occurrence_id == o.id))
        if seen is not None:
            return None                         # never suggest the same link twice
        return {"concept_id": concept_id, "occurrence_id": o.id, "media_id": o.media_id, "title": title,
                "t0": o.t0, "t1": o.t1}

    # ------------------------------------------------------------------ decide
    def decide(self, user_id: str, media_id: str, signal: Signal) -> dict[str, Any]:
        with self.db.session() as s:                     # 1. read the context, run the rules
            ensure_user(s, user_id)
            visible_video(s, media_id, user_id)
            ctx = self._context(s, user_id, media_id, signal)
        rule = self.rule.select(ctx)
        choice, selector, error = rule, self.rule.name, None
        started = time.perf_counter()
        # 2. the model (no transaction held open). Explicit requests ("confused" mark, "Quiz me") skip it.
        if self.use_llm and self.llm is not None and signal.kind not in EXPLICIT:
            try:
                with self.db.session() as rs:
                    choice, selector = self.llm.select(ctx, rs), self.llm.name
            except Exception as exc:                     # any model failure -> the rule choice
                error = f"{type(exc).__name__}: {exc}"[:500]
        latency = int((time.perf_counter() - started) * 1000)
        with self.db.session() as s:                     # 3. log the decision (rules always recorded)
            dec = Decision(id=new_id("dec"), user_id=user_id, media_id=media_id, media_time=signal.t,
                           signal_kind=signal.kind, signal=signal.model_dump(), rule_action=rule.action,
                           rule_item_id=rule.item_id, action=choice.action, item_id=choice.item_id, selector=selector,
                           reason=choice.reason, fallback=error is not None, error=error, latency_ms=latency)
            s.add(dec)
            out: dict[str, Any] = {"decision_id": dec.id, "action": choice.action, "reason": choice.reason,
                                   "selector": selector, "rule_action": rule.action, "latency_ms": latency,
                                   "fallback": error is not None}
            if choice.item_id:
                out["item"] = items.project(s, [s.get(LearningItem, choice.item_id)])[0]
            if choice.action == "rewatch":
                out["rewatch"] = ctx.rewatch
            if choice.action == "lab" and ctx.lab:
                out["lab"] = ctx.lab
            if choice.action == "link" and ctx.link:
                link = ConceptLink(id=new_id("lnk"), user_id=user_id, concept_id=ctx.link["concept_id"],
                                   relation=LinkRelation.SAME_CONCEPT, from_media_id=media_id,
                                   to_occurrence_id=ctx.link["occurrence_id"])
                s.add(link)
                names = items.concept_names(s, [ctx.link["concept_id"]])
                out["link"] = {**ctx.link, "id": link.id, "concept": names.get(ctx.link["concept_id"], "")}
            return out

    def outcome(self, user_id: str, decision_id: str, outcome: str) -> None:
        with self.db.session() as s:
            d = s.get(Decision, decision_id)
            if d is None or d.user_id != user_id:
                raise KeyError(decision_id)
            d.outcome = DecisionOutcome(outcome)

    # ------------------------------------------------------------------ grade
    def attempt(self, user_id: str, item_id: str, response: dict, *, assisted: bool, confidence: int | None,
                decision_id: str | None) -> dict[str, Any]:
        with self.db.session() as s:
            ensure_user(s, user_id)
            item = s.get(LearningItem, item_id)
            if item is None or item.review_status not in items.USABLE:
                raise KeyError(item_id)
            visible_video(s, item.media_id, user_id)
            prior = s.scalar(sa.select(sa.func.count()).select_from(Attempt).where(
                Attempt.user_id == user_id, Attempt.item_key == item.item_key)) or 0
            correct = item_types.grade(item.type.value, item.payload, item.answer_key, response)
            counted = item.review_status == ReviewStatus.HUMAN_REVIEWED and prior == 0 and not assisted
            s.add(Attempt(id=new_id("att"), user_id=user_id, item_id=item.id, item_key=item.item_key,
                          decision_id=decision_id, response=response, correct=correct, assisted=assisted,
                          first_attempt=prior == 0, counted=counted, confidence=confidence))
            if decision_id and (d := s.get(Decision, decision_id)) is not None and d.user_id == user_id:
                d.outcome = DecisionOutcome.ANSWERED
            add_to_library(s, user_id, item.media_id)
            mastery = {c.concept_id: self._update_mastery(s, user_id, c.concept_id, correct, assisted, counted)
                       for c in item.concepts}
            ev = items.evidence_times(s, [item])
            return {
                "correct": correct,
                "answer": item.answer_key,
                "evidence": [{"id": e.evidence_id, "t0": snap.t0, "t1": snap.t1, "text": snap.content.get("text", "")}
                             for e in item.evidence if (snap := ev.get((e.evidence_id, e.evidence_revision)))],
                "counted_toward_mastery": counted,
                "why_not_counted": None if counted else (
                    "item not yet reviewed by a person" if item.review_status != ReviewStatus.HUMAN_REVIEWED
                    else "hint used" if assisted else "not the first attempt"),
                "mastery": mastery,
            }

    @staticmethod
    def _update_mastery(s: Session, user_id: str, concept_id: str, correct: bool, assisted: bool,
                        counted: bool) -> dict[str, int]:
        """Rule ladder: two counted correct in a row -> up a level; a counted miss -> down one."""
        m = s.get(Mastery, (user_id, concept_id))
        if m is None:
            m = Mastery(user_id=user_id, concept_id=concept_id, level=1, streak=0, independent_correct=0,
                        independent_wrong=0, assisted=0)
            s.add(m)
        m.last_attempt_at = utcnow()
        if assisted:
            m.assisted += 1
        if counted:
            if correct:
                m.independent_correct += 1
                m.streak += 1
                if m.streak >= 2:
                    m.level, m.streak = min(3, m.level + 1), 0
            else:
                m.independent_wrong += 1
                m.level, m.streak = max(1, m.level - 1), 0
        s.flush()
        return {"level": m.level, "streak": m.streak, "independent_correct": m.independent_correct}


__all__ = ["Action", "Context", "LLMSelector", "RuleSelector", "Runtime", "Signal", "EvidenceRole"]
