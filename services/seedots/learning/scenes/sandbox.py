"""Sandbox port: run a generated scene somewhere it cannot hurt anyone, script interactions,
and report events + a screenshot.

  NodeSandbox     local headless Chromium via services/scenekit/run.mjs (dev, CI)
  (hosted)        the same JSON contract over HTTP to a hosted sandbox, for production
"""
from __future__ import annotations

import base64
import json
import math
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from seedots.learning.scenes import kit

SCENEKIT = Path(__file__).resolve().parents[3] / "scenekit"
W, H = 640, 400


@dataclass
class RunReport:
    ok: bool
    error: str | None = None
    log: list[dict[str, Any]] = field(default_factory=list)
    marks: dict[str, int] = field(default_factory=dict)
    screenshot: bytes | None = None
    pixels: dict[str, float] | None = None
    page_errors: list[str] = field(default_factory=list)

    def ready(self) -> dict[str, Any] | None:
        return next((m for m in self.log if m.get("type") == "ready"), None)

    def errors(self) -> list[str]:
        return [m.get("message", "") for m in self.log if m.get("type") == "error"] + self.page_errors

    def observed_at(self, label: str) -> dict[str, Any]:
        """Latest value of every observation up to a mark."""
        values: dict[str, Any] = {}
        for m in self.log[: self.marks.get(label, len(self.log))]:
            if m.get("type") == "observe":
                values[m["name"]] = m["value"]
        return values


class Sandbox(Protocol):
    name: str
    available: bool

    def run(self, runner_html: str, steps: list[dict[str, Any]], timeout_ms: int = 20000) -> RunReport: ...


class NodeSandbox:
    name = "local-chromium"

    def __init__(self, script: Path = SCENEKIT / "run.mjs", env: dict[str, str] | None = None):
        self.script, self.env = script, env
        self.available = bool(shutil.which("node")) and script.exists()

    def run(self, runner_html: str, steps: list[dict[str, Any]], timeout_ms: int = 20000) -> RunReport:
        payload = {"host_html": kit.host_html(runner_html, W, H), "width": W, "height": H, "steps": steps,
                   "timeout_ms": timeout_ms}
        import os

        try:
            proc = subprocess.run(["node", str(self.script)], input=json.dumps(payload), capture_output=True,
                                  text=True, timeout=timeout_ms / 1000 + 30, cwd=self.script.parent,
                                  env={**os.environ, **(self.env or {})})
        except subprocess.TimeoutExpired:
            return RunReport(False, "sandbox timed out")
        try:
            raw = json.loads(proc.stdout)
        except ValueError:
            return RunReport(False, f"sandbox crashed: {proc.stderr.strip()[-300:]}")
        shot = base64.b64decode(raw["screenshot_b64"]) if raw.get("screenshot_b64") else None
        return RunReport(raw.get("ok", False), raw.get("error"), raw.get("log", []), raw.get("marks", {}), shot,
                         raw.get("pixels"), raw.get("page_errors", []))


# ------------------------------------------------------------------------------ the protocol gate
@dataclass
class ProtocolResult:
    ok: bool
    problems: list[str]
    params: list[dict[str, Any]]
    answer: str | None
    screenshot: bytes | None
    observed: dict[str, Any]


def protocol_steps(params: list[dict[str, Any]], predict: dict[str, Any]) -> list[dict[str, Any]]:
    """Scripted interaction: every control to both ends and back, then the prediction case."""
    steps: list[dict[str, Any]] = [{"op": "wait_ready"}, {"op": "settle", "ms": 300}, {"op": "screenshot"}]
    for p in params:
        steps += [{"op": "set", "name": p["name"], "value": p["min"]}, {"op": "set", "name": p["name"], "value": p["max"]},
                  {"op": "set", "name": p["name"], "value": p["value"]}]
    steps += [{"op": "settle", "ms": 200}, {"op": "mark", "label": "before"},
              {"op": "set", "name": predict["param"], "value": predict["to"], "settle": 400},
              {"op": "settle", "ms": 300}, {"op": "mark", "label": "after"}]
    return steps


def run_protocol(sandbox: Sandbox, code: str, engine: str, declared: dict[str, Any]) -> ProtocolResult:
    """Gate 2: the scene must start, expose the declared controls, react to every one of them
    with observations, never throw, draw something, and make the predicted change visible."""
    params, predict, observation = declared["params"], declared["predict"], declared["predict"]["observation"]
    rep = sandbox.run(kit.runner_html(code, engine), protocol_steps(params, predict))
    problems: list[str] = []
    if not rep.ok:
        return ProtocolResult(False, [rep.error or "the scene did not run"] + rep.errors()[:3], [], None, None, {})
    ready = rep.ready() or {}
    got = {p["name"]: p for p in ready.get("params", [])}
    for p in params:
        g = got.get(p["name"])
        if g is None:
            problems.append(f"control {p['name']!r} was declared but kit.param() never registered it")
        elif abs(g["min"] - p["min"]) > 1e-9 or abs(g["max"] - p["max"]) > 1e-9:
            problems.append(f"control {p['name']!r} range differs from the declaration")
    if errs := rep.errors():
        problems.append("the scene threw errors: " + "; ".join(e[:120] for e in errs[:3]))
    acks = {m["name"] for m in rep.log if m.get("type") == "ack"}
    for p in params:
        if p["name"] in got and p["name"] not in acks:
            problems.append(f"setting {p['name']!r} was not handled")
    obs = [m for m in rep.log if m.get("type") == "observe"]
    if not any(m["name"] == observation for m in obs):
        problems.append(f"the scene never reported the observation {observation!r} with kit.observe()")
    for m in obs:
        v = m["value"]
        if not isinstance(v, (int, float, str)) or (isinstance(v, float) and not math.isfinite(v)):
            problems.append(f"observation {m['name']!r} has a non-numeric, non-text value")
            break
    px = rep.pixels or {}
    if px.get("colors", 0) < 3 or px.get("stdev", 0) < 2:
        problems.append("the scene looks blank: nothing visible was drawn")

    before, after = rep.observed_at("before").get(observation), rep.observed_at("after").get(observation)
    answer = None
    if before is None or after is None:
        problems.append("the observation did not update when the prediction's control changed")
    elif isinstance(after, str):
        options = predict.get("options") or []
        if after not in options:
            problems.append(f"observation value {after!r} is not one of the prediction options {options}")
        answer = after
    else:
        from seedots.learning.scenes.spec import change

        answer = change(float(before), float(after))
        if answer == "stays about the same":
            problems.append("changing the prediction's control does not visibly change the observation")
    return ProtocolResult(not problems, problems, list(got.values()), answer, rep.screenshot,
                          {"before": before, "after": after})
