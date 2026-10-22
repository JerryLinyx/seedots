"""Live feed of a lab being built: fine-grained, short-lived events (the agent searching rigs, reading a
card, writing a spec, a draft passing) that the page streams while `progress` (persisted, coarse) records
the stages. In-process only: with the in-process workflow engine the builder and the API share it; a
remote worker would publish nothing and the page falls back to polling `progress`."""
from __future__ import annotations

import threading
import time
from typing import Any

KEEP_S = 600            # forget a feed this long after it closed


class LiveFeed:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._events: dict[str, list[dict[str, Any]]] = {}
        self._closed: dict[str, float] = {}

    def publish(self, scene_id: str, event: dict[str, Any]) -> None:
        with self._lock:
            log = self._events.setdefault(scene_id, [])
            log.append({"seq": len(log) + 1, "at": time.time(), **event})
            if len(log) > 400:                         # a runaway run cannot grow without bound
                del log[: len(log) - 400]

    def close(self, scene_id: str) -> None:
        with self._lock:
            self._closed[scene_id] = time.time()
            for sid, at in list(self._closed.items()):
                if time.time() - at > KEEP_S:
                    self._events.pop(sid, None)
                    self._closed.pop(sid, None)

    def since(self, scene_id: str, seq: int) -> tuple[list[dict[str, Any]], bool]:
        """Events after `seq`, and whether the feed has closed."""
        with self._lock:
            return [e for e in self._events.get(scene_id, []) if e["seq"] > seq], scene_id in self._closed


class BuildNarrator:
    """Turns the agent's raw run events into steps a learner can follow, throttling the chatty ones."""

    def __init__(self, feed: LiveFeed, scene_id: str):
        self.feed, self.scene_id = feed, scene_id
        self.started = time.time()
        self.thinking = 0
        self.writing: dict[str, int] = {}
        self._last: dict[str, float] = {}

    def _throttled(self, key: str, every: float = 1.0) -> bool:
        now = time.time()
        if now - self._last.get(key, 0) < every:
            return True
        self._last[key] = now
        return False

    def say(self, type_: str, text: str, **extra: Any) -> None:
        self.feed.publish(self.scene_id, {"type": type_, "text": text, **extra})

    def __call__(self, ev: dict[str, Any]) -> None:
        kind = ev.get("kind")
        if kind == "thinking":
            self.thinking += ev.get("chars", 0)
            if not self._throttled("thinking", 1.5):
                self.say("thinking", "Thinking it through", seconds=round(time.time() - self.started), chars=self.thinking)
        elif kind == "text":
            self.say("text", ev.get("delta", "")[:400])
        elif kind == "tool_args":
            tool = ev.get("tool") or "answer"
            self.writing[tool] = self.writing.get(tool, 0) + ev.get("chars", 0)
            if not self._throttled(f"args:{tool}", 0.8):
                what = {"try_rig": "Writing the lab spec", "run_checks": "Writing the code",
                        "final_result": "Writing up the result", "list_rigs": "Deciding what to look for",
                        "describe_rig": "Picking rigs to read about"}.get(tool, "Preparing the next step")
                self.say("writing", what, tool=tool, chars=self.writing[tool])
        elif kind == "tool_call":
            self._tool_call(ev.get("tool", ""), ev.get("args") or {})
        elif kind == "tool_result":
            self._tool_result(ev.get("tool", ""), ev.get("content"))

    def _tool_call(self, tool: str, args: dict[str, Any]) -> None:
        self.writing.pop(tool, None)
        if tool == "list_rigs":
            self.say("tool", f"Looking through the rigs for “{str(args.get('query', ''))[:80]}”")
        elif tool == "describe_rig":
            self.say("tool", f"Reading the {args.get('rig', '?')} rig's card")
        elif tool == "try_rig":
            spec = args.get("spec") if isinstance(args.get("spec"), dict) else {}
            params = ", ".join(p.get("label") or p.get("name", "") for p in spec.get("params", [])[:4] if isinstance(p, dict))
            q = (spec.get("predict") or {}).get("question", "")
            self.say("draft_try", f"Checking a draft on the {spec.get('rig', '?')} rig: “{spec.get('title', '')}”",
                     params=params, question=q[:160])
        elif tool == "run_checks":
            lines = str(args.get("code", "")).count("\n") + 1
            self.say("tool", f"Testing {lines} lines of code in the sandbox ({args.get('engine', 'canvas')})")

    def _tool_result(self, tool: str, content: Any) -> None:
        if tool == "list_rigs" and isinstance(content, dict):
            ids = [r.get("id") for r in content.get("rigs", []) if isinstance(r, dict)]
            if ids:
                self.say("tool_done", "Candidates: " + ", ".join(ids))
        elif tool == "try_rig" and isinstance(content, dict):
            if content.get("ok"):
                self.say("tool_done", "The draft passed the rig's checks")
            else:
                self.say("problem", "To fix: " + "; ".join(content.get("problems", []))[:240])
        elif tool == "run_checks" and isinstance(content, dict):
            self.say("tool_done" if content.get("passed") else "problem",
                     "The code passed the sandbox run" if content.get("passed") else
                     "To fix: " + "; ".join(content.get("problems", []))[:240])
