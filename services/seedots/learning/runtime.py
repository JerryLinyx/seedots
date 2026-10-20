"""Learning runtime: action selection, item selection, grading, mastery (tech plan §6).

The front end decides *when* an interruption is acceptable (hard constraints live there).
Here we decide *what* to do. Rules always run and are logged; the model selector is tried
first when enabled and falls back to the rules on any error.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

from pydantic import BaseModel

from seedots.common.ids import new_id, now_ms
from seedots.common.llm import Gateway, LLMError
from seedots.common.timefmt import fmt_ts
from seedots.learning import item_types
from seedots.learning.store import LearningStore

Action = Literal["none", "check_in", "quiz", "predict", "rewatch", "explain"]
SignalKind = Literal["rewind_repeat", "long_pause", "chapter_end", "skip_ahead", "confused_mark",
                     "predict_window", "manual"]


class Signal(BaseModel):
    kind: SignalKind
    t: float
    chapter_id: str | None = None        # chapter that ended / was skipped, if any
    detail: dict[str, Any] = {}


@dataclass
class Context:
    user_id: str
    media_id: str
    signal: Signal
    chapter: dict | None
    quiz_items: list[dict]
    predict_items: list[dict]
    rewatch: dict | None
    mastery: dict[str, dict]
    purpose: str
    recent: list[dict]
    candidates: list[Action] = field(default_factory=list)


@dataclass
class Choice:
    action: Action
    item_id: str | None
    reason: str


def public_item(item: dict, evidence: dict[str, Any] | None = None, concepts: dict[str, str] | None = None) -> dict:
    ev = []
    for eid in item["evidence_ids"]:
        u = (evidence or {}).get(eid)
        ev.append({"id": eid, "t0": u.t0 if u else None, "t1": u.t1 if u else None})
    return {
        "id": item["id"], "type": item["type"], "schema_version": item["schema_version"], "version": item["version"],
        "chapter_id": item["chapter_id"], "level": item["level"], "concept_ids": item["concept_ids"],
        "concepts": [(concepts or {}).get(c, "") for c in item["concept_ids"]],
        "evidence": ev, "review_status": item["review_status"], "show_at": item.get("show_at"),
        "payload": item["payload"],
    }


class ActionSelector(Protocol):
    name: str

    def select(self, ctx: Context) -> Choice: ...


def _pick_level(items: list[dict], mastery: dict[str, dict]) -> dict | None:
    if not items:
        return None

    def target(it: dict) -> int:
        lv = max((mastery.get(c, {}).get("level", 1) for c in it["concept_ids"]), default=1)
        return lv

    return sorted(items, key=lambda it: (abs(it["level"] - target(it)), it["level"], it["id"]))[0]


class RuleSelector:
    name = "rule@1"

    def select(self, ctx: Context) -> Choice:
        k = ctx.signal.kind
        quiz = _pick_level(ctx.quiz_items, ctx.mastery)
        if k == "confused_mark":
            return Choice("explain", None, "learner marked confusion")
        if k == "predict_window" and ctx.predict_items:
            return Choice("predict", ctx.predict_items[0]["id"], "the video is about to reveal an answer")
        if k in ("chapter_end", "skip_ahead", "manual"):
            if quiz:
                return Choice("quiz", quiz["id"], "check the chapter just covered" if k != "skip_ahead"
                              else "check the skipped part")
            return Choice("none", None, "no reviewed-ready item for this chapter")
        if k == "rewind_repeat":
            if ctx.rewatch:
                return Choice("rewatch", None, "earlier answer on this concept was wrong")
            return Choice("check_in", None, "repeated rewinds over the same span")
        if k == "long_pause":
            return Choice("check_in", None, "long pause")
        return Choice("none", None, "weak signal")


class SelectOut(BaseModel):
    action: str
    item_id: str | None = None
    reason: str = ""
    confidence: float = 0.5


class LLMSelector:
    name = "llm@select_action.v1"

    def __init__(self, gateway: Gateway, store: LearningStore):
        self.gateway, self.store = gateway, store

    def select(self, ctx: Context) -> Choice:
        sents = self.store.evidence(ctx.media_id, "sentence", ctx.signal.t - 45, ctx.signal.t + 10)
        context = "\n".join(f"[{fmt_ts(s.t0)}] {s.content['text']}" for s in sents) or "(no transcript)"
        offered = {"quiz": ctx.quiz_items[:6], "predict": ctx.predict_items[:2]}
        items_txt = [{"item_id": it["id"], "for_action": a, "type": it["type"], "level": it["level"],
                      "stem": it["payload"].get("stem", "")[:160]} for a, its in offered.items() for it in its]
        out = self.gateway.run("select_action", {
            "signal": ctx.signal.model_dump(), "purpose": ctx.purpose or "unspecified",
            "recent": [{"action": d["chosen"], "seconds_ago": int((now_ms() - d["created_at"]) / 1000)}
                       for d in ctx.recent[:5]],
            "mastery": {c: {"level": m["level"]} for c, m in ctx.mastery.items()},
            "context": context, "candidates": ctx.candidates, "items": items_txt,
        }, SelectOut, use_cache=False)
        if out.action not in ctx.candidates:
            raise LLMError(f"model chose {out.action!r}, not a candidate")
        if out.action in ("quiz", "predict"):
            ids = {it["id"] for it in offered[out.action]}
            if out.item_id not in ids:
                raise LLMError("model chose an item that was not offered")
        else:
            out.item_id = None
        return Choice(out.action, out.item_id, out.reason[:200])


class Runtime:
    def __init__(self, store: LearningStore, llm_selector: ActionSelector | None):
        self.store = store
        self.rule = RuleSelector()
        self.llm = llm_selector

    # ------------------------------------------------------------ context
    def _context(self, user_id: str, media_id: str, signal: Signal) -> Context:
        video = self.store.video(media_id) or {}
        chapters = video.get("chapters") or []
        chapter = None
        if signal.chapter_id:
            chapter = next((c for c in chapters if c["id"] == signal.chapter_id), None)
        if chapter is None:
            chapter = next((c for c in chapters if c["t0"] <= signal.t < c["t1"]), None)
        items = self.store.items(media_id)
        tried = {a["item_id"] for a in self.store.attempts(user_id, [i["id"] for i in items])}
        quiz = [i for i in items if chapter and i["chapter_id"] == chapter["id"] and i["id"] not in tried
                and item_types.REGISTRY[i["type"]].quiz_kind == "quiz"]
        predict = [i for i in items if i["type"] == "predict" and i["id"] not in tried and i.get("show_at")
                   and signal.t < i["show_at"] <= signal.t + 45]
        concept_ids = sorted({c for i in items if chapter and i["chapter_id"] == chapter["id"]
                              for c in i["concept_ids"]})
        mastery = self.store.mastery(user_id, concept_ids)
        rewatch = self._rewatch_target(user_id, media_id, concept_ids)
        settings = self.store.settings(user_id)
        ctx = Context(user_id, media_id, signal, chapter, quiz, predict, rewatch, mastery,
                      settings.get("purpose", ""), self.store.recent_decisions(user_id, media_id))
        ctx.candidates = ["none", "check_in", "explain"] + (["quiz"] if quiz else []) + \
                         (["predict"] if predict else []) + (["rewatch"] if rewatch else [])
        return ctx

    def _rewatch_target(self, user_id: str, media_id: str, concept_ids: list[str]) -> dict | None:
        wrong = [a for a in self.store.attempts(user_id) if not a["correct"]]
        for a in reversed(wrong):
            item = self.store.item(a["item_id"])
            if item and item["media_id"] == media_id and set(item["concept_ids"]) & set(concept_ids):
                ev = self.store.evidence_by_ids(item["evidence_ids"])
                if ev:
                    first = min(ev.values(), key=lambda u: u.t0)
                    return {"evidence_id": first.id, "t0": first.t0, "t1": max(u.t1 for u in ev.values()),
                            "item_id": item["id"]}
        return None

    # ------------------------------------------------------------ decide
    def decide(self, user_id: str, media_id: str, signal: Signal, use_llm: bool) -> dict:
        ctx = self._context(user_id, media_id, signal)
        rule_choice = self.rule.select(ctx)
        choice, selector, error = rule_choice, self.rule.name, ""
        t0 = time.perf_counter()
        # an explicit "confused" mark always opens the coach; everything else may go to the model
        if use_llm and self.llm is not None and signal.kind != "confused_mark":
            try:
                choice, selector = self.llm.select(ctx), self.llm.name
            except Exception as exc:  # any model failure -> rules
                error = str(exc)[:300]
        latency = int((time.perf_counter() - t0) * 1000)
        self.store.insert("decisions", {
            "id": new_id("dec"), "user_id": user_id, "media_id": media_id, "media_time": signal.t,
            "signal": signal.model_dump(), "rule_action": rule_choice.action, "chosen": choice.action,
            "selector": selector, "item_id": choice.item_id, "reason": choice.reason, "latency_ms": latency,
            "error": error, "created_at": now_ms()})
        out: dict[str, Any] = {"action": choice.action, "reason": choice.reason, "selector": selector,
                               "rule_action": rule_choice.action, "latency_ms": latency,
                               "fallback": bool(error)}
        if choice.item_id:
            item = self.store.item(choice.item_id)
            ev = self.store.evidence_by_ids(item["evidence_ids"])
            names = {c["id"]: c["name"] for c in self.store.concepts(item["concept_ids"])}
            out["item"] = public_item(item, ev, names)
        if choice.action == "rewatch":
            out["rewatch"] = ctx.rewatch
        return out

    # ------------------------------------------------------------ grade
    def attempt(self, user_id: str, item_id: str, response: dict, assisted: bool) -> dict:
        item = self.store.item(item_id)
        if not item or item["review_status"] == "rejected":
            raise KeyError(item_id)
        prior = self.store.attempts(user_id, [item_id])
        correct = item_types.grade(item["type"], item["payload"], item["answer_key"], response)
        counted = item["review_status"] == "human_reviewed" and not prior and not assisted
        self.store.insert("attempts", {
            "id": new_id("att"), "user_id": user_id, "item_id": item_id, "item_version": item["version"],
            "response": response, "correct": int(correct), "assisted": int(assisted),
            "first_attempt": int(not prior), "counted": int(counted), "created_at": now_ms()})
        mastery = {}
        for cid in item["concept_ids"]:
            mastery[cid] = self._update_mastery(user_id, cid, correct, assisted, counted)
        ev = self.store.evidence_by_ids(item["evidence_ids"])
        return {
            "correct": correct,
            "answer": {k: v for k, v in item["answer_key"].items() if k != "misconception"},
            "evidence": [{"id": e, "t0": ev[e].t0, "t1": ev[e].t1, "text": ev[e].content.get("text", "")}
                         for e in item["evidence_ids"] if e in ev],
            "counted_toward_mastery": counted,
            "why_not_counted": None if counted else (
                "item not yet reviewed by a person" if item["review_status"] != "human_reviewed"
                else "hint used" if assisted else "not the first attempt"),
            "mastery": mastery,
        }

    def _update_mastery(self, user_id: str, concept_id: str, correct: bool, assisted: bool, counted: bool) -> dict:
        m = self.store.mastery(user_id).get(concept_id) or {
            "user_id": user_id, "concept_id": concept_id, "level": 1, "streak": 0,
            "independent_correct": 0, "independent_wrong": 0, "assisted": 0}
        m = dict(m)
        if assisted:
            m["assisted"] += 1
        if counted:
            if correct:
                m["independent_correct"] += 1
                m["streak"] += 1
                if m["streak"] >= 2:
                    m["level"], m["streak"] = min(3, m["level"] + 1), 0
            else:
                m["independent_wrong"] += 1
                m["level"], m["streak"] = max(1, m["level"] - 1), 0
        self.store.put_mastery(m)
        return {"level": m["level"], "streak": m["streak"]}
