"""Learning-item type registry (tech plan §5).

Each type registers: payload schema (sent to the browser), answer schema (server only),
a validator (structure + leakage) and a grader. Adding a type = adding one ItemType.
The front end mirrors this with one renderer per `type`.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable

from pydantic import BaseModel, Field, ValidationError, field_validator


class ItemDraft(BaseModel):
    """What the generator model returns for one item (loose; converted per type)."""
    type: str
    concept: str
    level: int = Field(ge=1, le=3)
    stem: str
    options: list[str] | None = None
    items: list[str] | None = None            # ordering: shown shuffled
    left: list[str] | None = None             # matching
    right: list[str] | None = None
    answer: Any = None                         # index | [indices] | order | pairs
    explanation: str = ""
    hints: list[str] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)   # short sentence ids, e.g. s0012
    reveal_after: str | None = None            # predict: the sentence that reveals the answer
    misconception: str | None = None


class InvalidItem(ValueError):
    pass


# ---------------------------------------------------------------- payload / answer models

class ChoicePayload(BaseModel):
    stem: str
    options: list[str]
    hints: list[str] = []

    @field_validator("options")
    @classmethod
    def _opts(cls, v: list[str]) -> list[str]:
        v = [o.strip() for o in v]
        if not 2 <= len(v) <= 6 or any(not o for o in v) or len({o.lower() for o in v}) != len(v):
            raise ValueError("2-6 distinct non-empty options required")
        return v


class SingleAnswer(BaseModel):
    index: int
    explanation: str = ""


class MultiAnswer(BaseModel):
    indices: list[int]
    explanation: str = ""


class OrderingPayload(BaseModel):
    stem: str
    items: list[str]                    # in display order (shuffled)
    hints: list[str] = []


class OrderingAnswer(BaseModel):
    order: list[int]                    # indices into payload.items, correct sequence
    explanation: str = ""


class MatchingPayload(BaseModel):
    stem: str
    left: list[str]
    right: list[str]
    hints: list[str] = []


class MatchingAnswer(BaseModel):
    pairs: list[int]                    # pairs[i] = index into right for left[i]
    explanation: str = ""


@dataclass(frozen=True)
class ItemType:
    name: str
    payload_model: type[BaseModel]
    answer_model: type[BaseModel]
    from_draft: Callable[[ItemDraft], tuple[BaseModel, BaseModel]]
    grade: Callable[[BaseModel, BaseModel, dict], bool]
    quiz_kind: str                      # "quiz" | "predict" — which action can show it


def _leaks(hints: list[str], answer_text: str) -> bool:
    a = answer_text.strip().lower()
    return bool(a) and len(a) > 3 and any(a in h.lower() for h in hints)


_REFERS_TO_OPTIONS = re.compile(r"\b(all|none|both|neither) of (the )?(above|these|them)\b|\b[a-d] and [a-d]\b",
                                re.IGNORECASE)


def _shuffled(stem: str, options: list[str], correct: list[int]) -> tuple[list[str], list[int]]:
    """Models put the right answer in the same slot far too often, so options are shuffled
    deterministically (seeded by the stem). Options that refer to other options keep their order."""
    if any(_REFERS_TO_OPTIONS.search(o) for o in options):
        return options, correct
    import random

    perm = list(range(len(options)))
    random.Random(stem).shuffle(perm)
    return [options[i] for i in perm], sorted(perm.index(i) for i in correct)


def _single_from(d: ItemDraft) -> tuple[BaseModel, BaseModel]:
    p = ChoicePayload(stem=d.stem, options=d.options or [], hints=d.hints)
    if not isinstance(d.answer, int) or not 0 <= d.answer < len(p.options):
        raise InvalidItem("answer must be an option index")
    if _leaks(p.hints, p.options[d.answer]):
        raise InvalidItem("a hint gives the answer away")
    p.options, (index,) = _shuffled(p.stem, p.options, [d.answer])
    return p, SingleAnswer(index=index, explanation=d.explanation)


def _multi_from(d: ItemDraft) -> tuple[BaseModel, BaseModel]:
    p = ChoicePayload(stem=d.stem, options=d.options or [], hints=d.hints)
    ans = d.answer if isinstance(d.answer, list) else []
    if not ans or len(set(ans)) != len(ans) or any(not isinstance(i, int) or not 0 <= i < len(p.options)
                                                   for i in ans):
        raise InvalidItem("answer must be a list of distinct option indices")
    p.options, indices = _shuffled(p.stem, p.options, ans)
    return p, MultiAnswer(indices=indices, explanation=d.explanation)


def _ordering_from(d: ItemDraft) -> tuple[BaseModel, BaseModel]:
    items = [s.strip() for s in (d.items or [])]
    if not 3 <= len(items) <= 7 or len(set(items)) != len(items):
        raise InvalidItem("ordering needs 3-7 distinct steps")
    # the model lists items in the correct order; we shuffle deterministically for display
    import random

    rng = random.Random(d.stem)
    shown = items[:]
    while shown == items:
        rng.shuffle(shown)
    order = [shown.index(s) for s in items]
    return OrderingPayload(stem=d.stem, items=shown, hints=d.hints), OrderingAnswer(order=order,
                                                                                    explanation=d.explanation)


def _matching_from(d: ItemDraft) -> tuple[BaseModel, BaseModel]:
    left, right = d.left or [], d.right or []
    if not 2 <= len(left) <= 6 or len(left) != len(right):
        raise InvalidItem("matching needs 2-6 pairs")
    import random

    rng = random.Random(d.stem)
    shown = right[:]
    rng.shuffle(shown)
    pairs = [shown.index(r) for r in right]
    return MatchingPayload(stem=d.stem, left=left, right=shown, hints=d.hints), MatchingAnswer(
        pairs=pairs, explanation=d.explanation)


def _g_single(_: BaseModel, a: SingleAnswer, r: dict) -> bool:
    return r.get("index") == a.index


def _g_multi(_: BaseModel, a: MultiAnswer, r: dict) -> bool:
    return sorted(r.get("indices") or []) == a.indices


def _g_order(_: BaseModel, a: OrderingAnswer, r: dict) -> bool:
    return list(r.get("order") or []) == a.order


def _g_match(_: BaseModel, a: MatchingAnswer, r: dict) -> bool:
    return list(r.get("pairs") or []) == a.pairs


REGISTRY: dict[str, ItemType] = {t.name: t for t in [
    ItemType("single_choice", ChoicePayload, SingleAnswer, _single_from, _g_single, "quiz"),
    ItemType("multi_choice", ChoicePayload, MultiAnswer, _multi_from, _g_multi, "quiz"),
    ItemType("find_error", ChoicePayload, SingleAnswer, _single_from, _g_single, "quiz"),
    ItemType("predict", ChoicePayload, SingleAnswer, _single_from, _g_single, "predict"),
    ItemType("ordering", OrderingPayload, OrderingAnswer, _ordering_from, _g_order, "quiz"),
    ItemType("matching", MatchingPayload, MatchingAnswer, _matching_from, _g_match, "quiz"),
]}


def build(draft: ItemDraft) -> tuple[ItemType, BaseModel, BaseModel]:
    t = REGISTRY.get(draft.type)
    if not t:
        raise InvalidItem(f"unknown item type {draft.type!r}")
    try:
        payload, answer = t.from_draft(draft)
    except ValidationError as exc:
        raise InvalidItem(exc.errors()[0]["msg"]) from exc
    return t, payload, answer


def grade(item_type: str, payload: dict, answer: dict, response: dict) -> bool:
    t = REGISTRY[item_type]
    return t.grade(t.payload_model.model_validate(payload), t.answer_model.model_validate(answer), response)
