"""Lab tools for agents. Plain functions (the gateway turns them into tools); each binds the rig
client and, where it matters, what the caller may touch. They never let a model compute a lab fact:
facts come back from the rig service.

    authoring  list_rigs, describe_rig, try_rig        lab_spec (pipeline), scene_code (builder)
    coaching   observe_lab, sweep_lab                   coach: answers "what if" with computed facts
"""
from __future__ import annotations

import json
from typing import Any, Callable

from seedots.learning.scenes.rigs import RigClient, RigUnavailable, compact_card

MAX_OUT = 3000           # characters of tool output handed back to the model
MAX_CARD = 9000          # a full card with two example specs


def _short(obj: Any, limit: int = MAX_OUT) -> Any:
    """Keep tool output small: the model needs the gist, not every number."""
    text = json.dumps(obj, ensure_ascii=False)
    if len(text) <= limit:
        return obj
    return {"truncated": True, "text": text[:limit]}


def authoring_tools(rigs: RigClient, *, on_try: Callable[[dict[str, Any], dict[str, Any]], None] | None = None,
                    tags: list[str] | None = None) -> list[Callable[..., Any]]:
    """Tools for writing a lab spec. `on_try(spec, report)` sees every attempt (progress, records)."""

    def list_rigs(query: str) -> dict[str, Any]:
        """Find prebuilt lab rigs that fit what you want the learner to explore. Returns the best few with
        what each is for and not for. Then call describe_rig for the exact config and examples."""
        try:
            got = rigs.catalog(query, tags=tags, limit=5)
        except RigUnavailable as exc:
            return {"error": str(exc)}
        return {"rigs": [compact_card(c) for c in got.get("rigs", [])]}

    def describe_rig(rig: str) -> dict[str, Any]:
        """The full card of one rig: its config fields, observables and example specs that pass the checks.
        Copy an example's shape and change what this chapter needs."""
        try:
            card = rigs.describe(rig)
            card.pop("catalog", None)
            return _short(card, MAX_CARD)
        except RigUnavailable as exc:
            return {"error": str(exc)}

    def try_rig(spec: dict[str, Any]) -> dict[str, Any]:
        """Check a lab spec (version 2) with the rig service. Returns ok, and if not ok the problems to fix.
        Call it before your final answer; only a spec that returned ok may be your answer."""
        try:
            rep = rigs.check(spec)
        except RigUnavailable as exc:
            return {"ok": False, "problems": [str(exc)]}
        if "error" in rep:
            rep = {"ok": False, "problems": [rep["error"]]}
        if on_try:
            on_try(spec, rep)
        # the answer stays on the server: the model must not write it into the question
        return {"ok": rep.get("ok", False), "problems": rep.get("problems", []), "options": rep.get("options", [])}

    return [list_rigs, describe_rig, try_rig]


def coaching_tools(rigs: RigClient, labs: dict[str, dict[str, Any]]) -> list[Callable[..., Any]]:
    """Tools for the coach over the labs of the current video. `labs` maps a short ref (lab1, lab2...)
    to {"id", "title", "spec"}; the model can only name a ref, never send a spec."""

    def _lab(ref: str) -> dict[str, Any] | None:
        return labs.get(ref.strip().lower())

    def observe_lab(lab: str, settings: dict[str, float]) -> dict[str, Any]:
        """Compute what a lab shows at given settings, e.g. observe_lab("lab1", {"tau": 2}). Use the returned
        numbers when you answer a "what if" question; never estimate them yourself."""
        x = _lab(lab)
        if x is None:
            return {"error": f"no lab {lab}; labs here: {', '.join(labs) or 'none'}"}
        try:
            out = rigs.observe(x["spec"], settings)
        except RigUnavailable as exc:
            return {"error": str(exc)}
        if "error" in out:
            return out
        return _short({"lab": lab, "title": x["title"], "settings": out["set"], "observed": out["observed"]})

    def sweep_lab(lab: str, param: str, low: float | None = None, high: float | None = None) -> dict[str, Any]:
        """See how a lab's results change across one setting (up to 11 points), e.g. to find where
        something breaks or peaks."""
        x = _lab(lab)
        if x is None:
            return {"error": f"no lab {lab}; labs here: {', '.join(labs) or 'none'}"}
        try:
            out = rigs.sweep(x["spec"], param, lo=low, hi=high, n=11)
        except RigUnavailable as exc:
            return {"error": str(exc)}
        return _short(out)

    return [observe_lab, sweep_lab]
