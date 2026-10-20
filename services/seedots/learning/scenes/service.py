"""Interactive scenes: making them, checking them, serving them.

L1  made by the content pipeline, one per chapter at most: the model fills a SceneSpec for a
    prebuilt component; code validates it and computes the prediction's answer.
L2  made on a learner's request: a Pydantic AI coding agent writes Scene Kit code and calls
    run_checks (static rules + a scripted run in the sandbox) until it passes; then the
    workflow re-verifies independently, has a vision model review the screenshot, and
    publishes. Every stage is recorded in `progress`, which the page shows as it happens.
"""
from __future__ import annotations

import logging
import math
from pathlib import Path
from typing import Any, Literal

import sqlalchemy as sa
from pydantic import BaseModel, Field

from seedots.common.db import Database, utcnow
from seedots.common.ids import new_id
from seedots.common.llm import Gateway, LLMError
from seedots.common.timefmt import fmt_ts
from seedots.common.workflow import Engine, PermanentError
from seedots.learning.catalog import short
from seedots.learning.models import (Chapter, EvidenceSnapshot, Occurrence, SceneEvidence, SceneLevel, SceneSpec,
                                     SceneStatus, Video, Concept)
from seedots.learning.scenes import kit, spec as l1
from seedots.learning.scenes.sandbox import Sandbox, run_protocol

log = logging.getLogger("seedots.learning.scenes")

WORKFLOW = "learning.scene"
STEPS = ["draft", "verify", "review", "publish"]
AGENT_REQUESTS = 6          # model requests per draft (each check is one sandbox run)


# ------------------------------------------------------------------------------ model outputs
class SpecOut(BaseModel):
    scene: dict[str, Any] | None = None
    reason: str = ""


class ParamDecl(BaseModel):
    name: str
    label: str = ""
    min: float
    max: float
    step: float = 0.01
    value: float


class PredictDecl(BaseModel):
    question: str = Field(max_length=200)
    param: str
    to: float
    observation: str
    options: list[str] | None = Field(None, description="only for text observations: the possible values")


class CodeOut(BaseModel):
    title: str = Field(max_length=80)
    prompt: str = Field(max_length=240, description="one line telling the learner what to try")
    engine: Literal["canvas", "jsxgraph", "matter", "three"]
    code: str
    params: list[ParamDecl] = Field(min_length=1, max_length=4)
    predict: PredictDecl


class ReviewOut(BaseModel):
    ok: bool
    score: int = Field(ge=1, le=5)
    problems: list[str] = Field(default_factory=list)


# ------------------------------------------------------------------------------ service
class SceneService:
    def __init__(self, db: Database, gateway: Gateway, sandbox: Sandbox | None, *, vision: bool, data_dir: Path):
        self.db, self.gateway, self.sandbox, self.vision = db, gateway, sandbox, vision
        self.dir = data_dir / "scenes"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.engine: Engine | None = None

    # ================================================================== shared context
    def _chapter_context(self, chapter_id: str) -> tuple[Video, Chapter, list[EvidenceSnapshot], list[str]]:
        with self.db.session() as s:
            ch = s.get(Chapter, chapter_id)
            if ch is None:
                raise PermanentError("unknown chapter")
            video = s.get(Video, ch.media_id)
            snap = s.scalar(sa.select(EvidenceSnapshot).where(EvidenceSnapshot.id == chapter_id,
                                                              EvidenceSnapshot.is_current.is_(True)))
            ids = (snap.content.get("sentence_ids") if snap else None) or []
            rows = {r.id: r for r in s.scalars(sa.select(EvidenceSnapshot).where(
                EvidenceSnapshot.id.in_(ids), EvidenceSnapshot.is_current.is_(True)))}
            sentences = [rows[i] for i in ids if i in rows]
            if not sentences:                 # chapter not generated yet: use the time range
                sentences = list(s.scalars(sa.select(EvidenceSnapshot).where(
                    EvidenceSnapshot.media_id == ch.media_id, EvidenceSnapshot.kind == "sentence",
                    EvidenceSnapshot.is_current.is_(True), EvidenceSnapshot.t0 >= ch.t0, EvidenceSnapshot.t0 < ch.t1)
                    .order_by(EvidenceSnapshot.t0)))
            concepts = list(s.scalars(sa.select(Concept.name).join(Occurrence, Occurrence.concept_id == Concept.id)
                                      .where(Occurrence.chapter_id == chapter_id)))
            return video, ch, sentences, concepts

    @staticmethod
    def _lines(sentences: list[EvidenceSnapshot]) -> str:
        return "\n".join(f"{short(x.id)} [{fmt_ts(x.t0)}] {x.content.get('text', '')}" for x in sentences)

    def _evidence_rows(self, refs: list[str], sentences: list[EvidenceSnapshot]) -> list[SceneEvidence]:
        by = {short(x.id): x for x in sentences}
        return [SceneEvidence(evidence_id=by[r].id, evidence_revision=by[r].revision, ord=i)
                for i, r in enumerate(dict.fromkeys(refs)) if r in by]

    # ================================================================== L1 (pipeline step)
    def make_l1(self, media_id: str, chapter_id: str, run_id: int) -> dict[str, Any]:
        video, ch, sentences, concepts = self._chapter_context(chapter_id)
        if not sentences:
            return {"scene": None, "reason": "no transcript"}
        refs = {short(x.id) for x in sentences}
        variables = {"title": video.title, "chapter_title": ch.title, "concepts": ", ".join(concepts) or "none",
                     "sentences": self._lines(sentences), "feedback": "none"}
        tag = self.gateway.prompts.get("scene_spec").tag
        for attempt in range(2):          # one repair round with the validator's message
            out: SpecOut = self.gateway.run("scene_spec", variables, use_cache=attempt == 0,
                                            manifest={"chapter": chapter_id, "attempt": attempt})
            if out.scene is None:
                return {"scene": None, "reason": out.reason[:200]}
            try:
                scene, report = l1.validate(out.scene, refs)
            except l1.SceneInvalid as exc:
                variables["feedback"] = f"Your previous scene was rejected: {exc}. Fix it or return null."
                continue
            with self.db.session() as s:
                row = SceneSpec(id=new_id("scn"), media_id=media_id, chapter_id=chapter_id, level=SceneLevel.L1,
                                component=scene.component, title=scene.title, spec=scene.model_dump(),
                                status=SceneStatus.READY, gates={**report, "attempts": attempt + 1}, generator=tag,
                                content_run_id=run_id, progress={"stage": "ready", "log": []})
                row.evidence = self._evidence_rows(scene.evidence, sentences)
                s.add(row)
                return {"scene": row.id, "component": scene.component, "attempts": attempt + 1}
        return {"scene": None, "reason": f"rejected twice: {variables['feedback'][:200]}"}

    # ================================================================== L2 (requested)
    def request(self, user_id: str, media_id: str, chapter_id: str, ask: str) -> str:
        with self.db.session() as s:
            ch = s.get(Chapter, chapter_id)
            if ch is None or ch.media_id != media_id:
                raise KeyError(chapter_id)
            live = s.scalar(sa.select(SceneSpec.id).where(
                SceneSpec.chapter_id == chapter_id, SceneSpec.level == SceneLevel.L2,
                SceneSpec.status.in_([SceneStatus.QUEUED, SceneStatus.GENERATING]), SceneSpec.request == ask.strip()))
            if live:
                return live
            row = SceneSpec(id=new_id("scn"), media_id=media_id, chapter_id=chapter_id, level=SceneLevel.L2,
                            component="pending", title="", request=ask.strip()[:500], spec={}, status=SceneStatus.QUEUED,
                            requested_by=user_id,
                            progress={"stage": "queued", "done": [], "log": [{"at": utcnow().isoformat(), "stage": "queued",
                                                                              "note": "Waiting to start"}]})
            s.add(row)
            scene_id = row.id
        self.engine.start(WORKFLOW, f"scene-{scene_id}", {"scene_id": scene_id})
        return scene_id

    def resume(self) -> int:
        """After a restart (in-process engine): continue scenes that were mid-generation."""
        with self.db.session() as s:
            ids = list(s.scalars(sa.select(SceneSpec.id).where(
                SceneSpec.status.in_([SceneStatus.QUEUED, SceneStatus.GENERATING]))))
        for sid in ids:
            self.engine.start(WORKFLOW, f"scene-{sid}", {"scene_id": sid})
        return len(ids)

    def _progress(self, scene_id: str, stage: str, note: str, **extra: Any) -> None:
        with self.db.session() as s:
            row = s.get(SceneSpec, scene_id)
            p = dict(row.progress or {})
            p["stage"] = stage
            p["log"] = [*p.get("log", []), {"at": utcnow().isoformat(), "stage": stage, "note": note, **extra}][-40:]
            row.progress = p
            if row.status == SceneStatus.QUEUED:
                row.status = SceneStatus.GENERATING

    def _done(self, scene_id: str, step: str, **fields: Any) -> None:
        with self.db.session() as s:
            row = s.get(SceneSpec, scene_id)
            p = dict(row.progress or {})
            p["done"] = [*p.get("done", []), step]
            row.progress = p
            for k, v in fields.items():
                setattr(row, k, v)

    # ------------------------------------------------------------------ StepRunner
    def plan(self, workflow: str, arg: dict[str, Any]) -> list[str]:
        with self.db.session() as s:
            row = s.get(SceneSpec, arg["scene_id"])
            if row is None or row.status in (SceneStatus.READY, SceneStatus.FAILED):
                return []
            done = set((row.progress or {}).get("done", []))
        return [st for st in STEPS if st not in done]

    def run_step(self, workflow: str, arg: dict[str, Any], step: str) -> None:
        getattr(self, f"_{step}")(arg["scene_id"])

    def failed(self, workflow: str, arg: dict[str, Any], error: str) -> None:
        self._progress(arg["scene_id"], "failed", error[:300])
        with self.db.session() as s:
            row = s.get(SceneSpec, arg["scene_id"])
            row.status, row.error = SceneStatus.FAILED, error[:1000]

    # ------------------------------------------------------------------ steps
    def _check(self, out: CodeOut) -> dict[str, Any]:
        """Gates 1 + 2: static rules, then a scripted run in the sandbox."""
        static = kit.static_check(out.code, out.engine)
        if not static.ok:
            return {"passed": False, "stage": "static", "problems": static.problems}
        names = [p.name for p in out.params]
        problems = []
        if out.predict.param not in names:
            problems.append("predict.param must be one of the declared params")
        p = next((x for x in out.params if x.name == out.predict.param), None)
        if p and not (p.min <= out.predict.to <= p.max and abs(out.predict.to - p.value) >= p.step / 2):
            problems.append("predict.to must be inside the control's range and differ from its default")
        if problems:
            return {"passed": False, "stage": "declaration", "problems": problems}
        if self.sandbox is None or not self.sandbox.available:
            raise PermanentError("No sandbox is available to run generated scenes (install services/scenekit)")
        res = run_protocol(self.sandbox, out.code, out.engine, {
            "params": [x.model_dump() for x in out.params], "predict": out.predict.model_dump()})
        return {"passed": res.ok, "stage": "sandbox", "problems": res.problems, "answer": res.answer,
                "observed": res.observed, "_screenshot": res.screenshot}

    def _draft(self, scene_id: str) -> None:
        with self.db.session() as s:
            row = s.get(SceneSpec, scene_id)
            chapter_id, ask = row.chapter_id, row.request
        video, ch, sentences, concepts = self._chapter_context(chapter_id)
        self._progress(scene_id, "drafting", "Writing the interactive from this chapter")
        attempts = {"n": 0}

        def run_checks(code: str, engine: str, params: list[ParamDecl], predict: PredictDecl,
                       title: str = "", prompt: str = "") -> dict[str, Any]:
            """Run your scene through the safety rules and a scripted test in the sandbox.
            Returns passed + problems to fix. Call it before giving your final answer."""
            attempts["n"] += 1
            self._progress(scene_id, "checking", f"Testing draft {attempts['n']} in the sandbox", attempt=attempts["n"])
            try:
                draft = CodeOut(title=title or "Scene", prompt=prompt or "", engine=engine, code=code, params=params,
                                predict=predict)
            except Exception as exc:     # malformed declaration: tell the agent
                return {"passed": False, "problems": [str(exc)[:300]]}
            rep = self._check(draft)
            rep.pop("_screenshot", None)
            self._progress(scene_id, "checking", "Draft passed" if rep["passed"] else
                           f"Draft needs fixes: {'; '.join(rep['problems'])[:200]}", attempt=attempts["n"])
            return rep

        try:
            out: CodeOut = self.gateway.run("scene_code", {
                "title": video.title, "chapter_title": ch.title, "concepts": ", ".join(concepts) or "none",
                "sentences": self._lines(sentences), "request": ask or "Make the key relationship in this chapter "
                                                                      "something I can experiment with."},
                tools=[run_checks], max_requests=AGENT_REQUESTS, manifest={"scene": scene_id})
        except LLMError as exc:
            raise PermanentError(f"The scene agent could not finish: {exc}") from exc
        refs = [short(x.id) for x in sentences[:3]]
        self._done(scene_id, "draft", component=out.engine, title=out.title, spec=out.model_dump(),
                   generator=self.gateway.prompts.get("scene_code").tag)
        with self.db.session() as s:
            row = s.get(SceneSpec, scene_id)
            row.evidence = self._evidence_rows(refs, sentences)

    def _verify(self, scene_id: str) -> None:
        """Re-run every gate ourselves: the agent's word that it passed is not evidence."""
        self._progress(scene_id, "verifying", "Running the final interaction script")
        with self.db.session() as s:
            out = CodeOut.model_validate(s.get(SceneSpec, scene_id).spec)
        rep = self._check(out)
        shot = rep.pop("_screenshot", None)
        if shot:
            (self.dir / f"{scene_id}.png").write_bytes(shot)
        if not rep["passed"]:
            raise PermanentError("The scene failed its checks: " + "; ".join(rep["problems"])[:500])
        self._done(scene_id, "verify", gates={"static": "passed", "protocol": {k: v for k, v in rep.items()
                                                                               if k != "stage"}})

    def _review(self, scene_id: str) -> None:
        shot = self.dir / f"{scene_id}.png"
        with self.db.session() as s:
            row = s.get(SceneSpec, scene_id)
            gates, title, prompt, ask = dict(row.gates), row.title, row.spec.get("prompt", ""), row.request
        if not self.vision:
            gates["review"] = {"skipped": "no vision model configured (SEEDOTS_VLM_MODEL)"}
            self._progress(scene_id, "reviewing", "Screenshot review skipped: no vision model configured")
            self._done(scene_id, "review", gates=gates)
            return
        self._progress(scene_id, "reviewing", "Checking the screenshot for legibility and correctness")
        try:
            rev: ReviewOut = self.gateway.run("scene_review", {"title": title, "prompt": prompt, "request": ask or "none"},
                                              images=[shot.read_bytes()], manifest={"scene": scene_id})
        except LLMError as exc:
            raise PermanentError(f"Screenshot review failed: {exc}") from exc
        gates["review"] = rev.model_dump()
        if not rev.ok or rev.score < 3:
            self._done(scene_id, "review", gates=gates)
            raise PermanentError("The screenshot review rejected the scene: " + "; ".join(rev.problems)[:400])
        self._done(scene_id, "review", gates=gates)

    def _publish(self, scene_id: str) -> None:
        self._progress(scene_id, "ready", "Ready to try")
        self._done(scene_id, "publish", status=SceneStatus.READY, error=None)

    # ================================================================== reading
    def for_video(self, media_id: str) -> list[dict[str, Any]]:
        with self.db.session() as s:
            rows = s.scalars(sa.select(SceneSpec).where(SceneSpec.media_id == media_id)
                             .order_by(SceneSpec.created_at))
            return [self.public(s, r) for r in rows if r.status != SceneStatus.FAILED or r.level == SceneLevel.L2]

    def get(self, scene_id: str) -> dict[str, Any]:
        with self.db.session() as s:
            row = s.get(SceneSpec, scene_id)
            if row is None:
                raise KeyError(scene_id)
            return self.public(s, row)

    def media_of(self, scene_id: str) -> str:
        with self.db.session() as s:
            row = s.get(SceneSpec, scene_id)
            if row is None:
                raise KeyError(scene_id)
            return row.media_id

    def runner(self, scene_id: str, dark: bool = False) -> str:
        with self.db.session() as s:
            row = s.get(SceneSpec, scene_id)
            if row is None or row.level != SceneLevel.L2 or row.status != SceneStatus.READY:
                raise KeyError(scene_id)
            return kit.runner_html(row.spec["code"], row.spec["engine"], row.title)

    def preview(self, scene_id: str) -> Path:
        p = self.dir / f"{scene_id}.png"
        if not p.exists():
            raise KeyError(scene_id)
        return p

    def public(self, s, row: SceneSpec) -> dict[str, Any]:
        ev = []
        for e in row.evidence:
            snap = s.get(EvidenceSnapshot, (e.evidence_id, e.evidence_revision))
            ev.append({"id": e.evidence_id, "t0": snap.t0 if snap else None})
        out: dict[str, Any] = {
            "id": row.id, "level": row.level.value, "component": row.component, "chapter_id": row.chapter_id,
            "title": row.title, "status": row.status.value, "request": row.request, "error": row.error,
            "progress": {"stage": (row.progress or {}).get("stage"), "log": (row.progress or {}).get("log", [])},
            "evidence": ev, "checks": _checks(row.gates), "spec": None,
        }
        if row.status != SceneStatus.READY:
            return out
        if row.level == SceneLevel.L1:
            from pydantic import TypeAdapter

            out["spec"] = l1.public(TypeAdapter(l1.L1Spec).validate_python(row.spec))
        else:
            sp = row.spec
            options = sp["predict"].get("options") or l1.CHANGE_OPTIONS
            out["spec"] = {"title": sp["title"], "prompt": sp["prompt"], "engine": sp["engine"], "params": sp["params"],
                           "predict": {**{k: v for k, v in sp["predict"].items() if k != "options"}, "options": options},
                           "runner": f"/api/scenes/{row.id}/runner", "preview": f"/api/scenes/{row.id}/preview.png"}
        return out


def _checks(gates: dict[str, Any]) -> dict[str, str]:
    """Human-readable gate summary for the UI (never the answer)."""
    out = {}
    if gates.get("invariants"):
        out["consistency checks"] = "passed"
    if gates.get("static"):
        out["safety rules"] = "passed"
    if gates.get("protocol"):
        out["scripted run"] = "passed"
    rev = gates.get("review")
    if rev:
        out["screenshot review"] = "skipped" if "skipped" in rev else ("passed" if rev.get("ok") else "failed")
    return out


__all__ = ["CodeOut", "ReviewOut", "SceneService", "SpecOut", "WORKFLOW", "math"]
