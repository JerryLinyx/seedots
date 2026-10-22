"""Interactive scenes (labs): making them, checking them, serving them.

L1  made by the content pipeline, one per chapter at most. With the rig service up, the model writes a
    version-2 lab spec for one of the prebuilt rigs (tools: list_rigs, describe_rig, try_rig) and the
    rig service checks it and computes the prediction's answer; without it, the legacy two-component
    SceneSpec path runs.
L2  made on a learner's request by a Pydantic AI agent that chooses its route: "rig" (configure a
    prebuilt rig, checked by the rig service) or "code" (write Scene Kit code; run_checks runs static
    rules + a scripted run in the sandbox). The workflow then re-verifies independently, has a vision
    model review the screenshot (code only), and publishes. Every stage is recorded in `progress`,
    which the page shows as it happens.
"""
from __future__ import annotations

import json
import logging
import math
from pathlib import Path
from typing import Any, Literal

import sqlalchemy as sa
from pydantic import BaseModel, Field, ValidationError, field_validator

from seedots.common.db import Database, utcnow
from seedots.common.ids import new_id
from seedots.common.llm import Gateway, LLMError
from seedots.common.timefmt import fmt_ts
from seedots.common.workflow import Engine, PermanentError
from seedots.learning.catalog import short
from seedots.learning.models import (Chapter, EvidenceSnapshot, Occurrence, SceneEvidence, SceneLevel, SceneSpec,
                                     SceneStatus, Video, Concept)
from seedots.learning.scenes import kit, spec as l1
from seedots.learning.scenes.lab_tools import authoring_tools
from seedots.learning.scenes.live import BuildNarrator, LiveFeed
from seedots.learning.scenes.rigs import RigClient, RigUnavailable, compact_card
from seedots.learning.scenes.sandbox import Sandbox, run_protocol

log = logging.getLogger("seedots.learning.scenes")

WORKFLOW = "learning.scene"
STEPS = ["draft", "verify", "review", "publish"]
AGENT_REQUESTS = 8          # model requests per draft (each check is one sandbox run or one rig check)
LAB_REQUESTS = 6            # model requests per pipeline lab (describe + a few try_rig rounds)


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


class LabSpecOut(BaseModel):
    spec: dict[str, Any] | None = None
    evidence: list[str] = Field(default_factory=list)
    activity: str = "predict"
    reason: str = ""


class BuildOut(BaseModel):
    """The builder's answer: a rig spec (route "rig") or Scene Kit code (route "code").
    Lenient on purpose: a model that writes a long reason, sends the spec as a JSON string or puts a rig-style
    predict at the top level should not fail the whole build; route-specific checks happen after it answers."""
    route: Literal["rig", "code"]
    reason: str = ""
    evidence: list[str] = Field(default_factory=list)
    spec: dict[str, Any] | None = None                 # route rig
    title: str = ""                                    # route code, as CodeOut
    prompt: str = ""
    engine: str | None = None
    code: str = ""
    params: list[dict[str, Any]] = Field(default_factory=list)
    predict: dict[str, Any] | None = None

    @field_validator("spec", mode="before")
    @classmethod
    def _spec_text(cls, v: Any) -> Any:
        if isinstance(v, str):
            try:
                return json.loads(v)
            except ValueError:
                return None
        return v

    @field_validator("reason", "title", "prompt", mode="before")
    @classmethod
    def _clip(cls, v: Any) -> Any:
        return str(v)[:400] if v is not None else ""

    @field_validator("evidence", mode="before")
    @classmethod
    def _ids(cls, v: Any) -> Any:
        return [str(x) for x in v] if isinstance(v, list) else []

    def as_code(self) -> CodeOut:
        """The strict code declaration; raises with a readable message if the agent's answer was incomplete."""
        return CodeOut(title=(self.title or "Scene")[:80], prompt=self.prompt[:240], engine=self.engine or "canvas",
                       code=self.code, params=self.params, predict=self.predict)


def is_lab(spec: dict[str, Any] | None) -> bool:
    """A version-2 lab spec (a configured rig), as opposed to legacy L1 config or L2 code."""
    return bool(spec) and spec.get("version") == 2 and "rig" in spec


class ReviewOut(BaseModel):
    ok: bool
    score: int = Field(ge=1, le=5)
    problems: list[str] = Field(default_factory=list)


# ------------------------------------------------------------------------------ service
class SceneService:
    def __init__(self, db: Database, gateway: Gateway, sandbox: Sandbox | None, *, vision: bool, data_dir: Path,
                 rigs: RigClient | None = None):
        self.db, self.gateway, self.sandbox, self.vision, self.rigs = db, gateway, sandbox, vision, rigs
        self.live = LiveFeed()
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
    def _cards(self, query: str, limit: int = 5) -> str:
        try:
            got = self.rigs.catalog(query, limit=limit) if self.rigs else {}
        except RigUnavailable:
            got = {}
        cards = [compact_card(c) for c in got.get("rigs", [])]
        return json.dumps(cards, ensure_ascii=False, indent=1) if cards else "(the rig service is unavailable: use route code)"

    def make_l1(self, media_id: str, chapter_id: str, run_id: int) -> dict[str, Any]:
        if self.rigs is not None and self.rigs.available:
            return self.make_lab(media_id, chapter_id, run_id)
        return self.make_legacy(media_id, chapter_id, run_id)

    def make_lab(self, media_id: str, chapter_id: str, run_id: int) -> dict[str, Any]:
        """The model writes a lab spec with the rig tools; the rig service re-checks the answer itself."""
        video, ch, sentences, concepts = self._chapter_context(chapter_id)
        if not sentences:
            return {"scene": None, "reason": "no transcript"}
        refs = {short(x.id) for x in sentences}
        query = f"{ch.title}. {', '.join(concepts)}. " + " ".join(x.content.get("text", "") for x in sentences[:12])
        variables = {"title": video.title, "chapter_title": ch.title, "concepts": ", ".join(concepts) or "none",
                     "sentences": self._lines(sentences), "cards": self._cards(query), "feedback": "none"}
        tries: list[dict[str, Any]] = []
        tools = authoring_tools(self.rigs, on_try=lambda spec, rep: tries.append(
            {"rig": spec.get("rig") if isinstance(spec, dict) else None, "ok": rep.get("ok"),
             "problems": rep.get("problems", [])[:3]}))
        tag = self.gateway.prompts.get("lab_spec").tag
        for attempt in range(2):          # one more round if our own check disagrees with the agent
            try:
                out: LabSpecOut = self.gateway.run("lab_spec", variables, tools=tools, max_requests=LAB_REQUESTS,
                                                   use_cache=False, manifest={"chapter": chapter_id, "attempt": attempt})
            except LLMError as exc:
                return {"scene": None, "reason": f"lab agent failed: {exc}"[:200], "tries": len(tries)}
            if out.spec is None:
                return {"scene": None, "reason": out.reason[:200], "tries": len(tries)}
            evidence = [r for r in out.evidence if r in refs]
            rep = self.rigs.check(out.spec)
            problems = list(rep.get("problems", [])) + ([rep["error"]] if "error" in rep else [])
            if not evidence:
                problems.append("evidence must list at least one sentence id from this chapter")
            if rep.get("ok") and not problems:
                with self.db.session() as s:
                    row = SceneSpec(id=new_id("scn"), media_id=media_id, chapter_id=chapter_id, level=SceneLevel.L1,
                                    component=f"rig:{out.spec['rig']}"[:64], title=str(out.spec.get("title", ""))[:120],
                                    spec=out.spec, status=SceneStatus.READY, generator=tag, content_run_id=run_id,
                                    gates={"rig_check": {k: rep.get(k) for k in ("ok", "answer", "options", "rig_version",
                                                                                 "catalog")},
                                           "activity": out.activity, "attempts": attempt + 1, "tries": tries[-8:],
                                           "route": {"route": "rig", "reason": out.reason[:300]}},
                                    progress={"stage": "ready", "log": []})
                    row.evidence = self._evidence_rows(evidence, sentences)
                    s.add(row)
                    return {"scene": row.id, "component": row.component, "attempts": attempt + 1, "tries": len(tries)}
            variables["feedback"] = f"Your previous answer was rejected: {'; '.join(problems)[:600]}. Fix it or return null."
        return {"scene": None, "reason": f"rejected twice: {variables['feedback'][:200]}", "tries": len(tries)}

    def make_legacy(self, media_id: str, chapter_id: str, run_id: int) -> dict[str, Any]:
        """The two-component path, kept for when the rig service is down."""
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
        self.live.publish(scene_id, {"type": "stage", "stage": stage, "text": note})
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
        self.live.close(arg["scene_id"])
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
        self._progress(scene_id, "drafting", "Looking for a prebuilt rig that fits, or writing one")
        attempts: dict[str, Any] = {"n": 0, "passed": None, "tries": []}

        def on_try(spec: dict[str, Any], rep: dict[str, Any]) -> None:
            rig = spec.get("rig") if isinstance(spec, dict) else "?"
            attempts["tries"].append({"rig": rig, "ok": rep.get("ok"), "problems": rep.get("problems", [])[:3]})
            if rep.get("ok"):
                attempts["rig_ok"] = spec
                # a draft the rig service accepts can be tried right away, before the final checks
                self.live.publish(scene_id, {"type": "draft", "text": "A first version you can try", "spec": spec})
            self._progress(scene_id, "checking", f"The {rig} rig fits" if rep.get("ok") else
                           f"Trying the {rig} rig: {'; '.join(rep.get('problems', []))[:160]}")

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
            if rep["passed"]:
                attempts["passed"], attempts["passed_n"] = draft, attempts["n"]
            self._progress(scene_id, "checking", "Draft passed" if rep["passed"] else
                           f"Draft needs fixes: {'; '.join(rep['problems'])[:200]}", attempt=attempts["n"])
            return rep

        request = ask or "Make the key relationship in this chapter something I can experiment with."
        tools: list[Any] = [run_checks]
        if self.rigs is not None:
            tools = [*authoring_tools(self.rigs, on_try=on_try), run_checks]
        try:
            built: BuildOut = self.gateway.run("scene_code", {
                "title": video.title, "chapter_title": ch.title, "concepts": ", ".join(concepts) or "none",
                "sentences": self._lines(sentences), "request": request,
                "cards": self._cards(f"{request} {ch.title} {', '.join(concepts)}")},
                tools=tools, max_requests=AGENT_REQUESTS, manifest={"scene": scene_id},
                on_event=BuildNarrator(self.live, scene_id))
        except LLMError as exc:
            # A draft that passed its checks is kept even if the agent stumbles afterwards (e.g. it keeps
            # re-checking until the request limit): verify re-runs every gate on it anyway.
            if attempts.get("rig_ok") is not None:
                built = BuildOut(route="rig", reason="the agent stopped after a rig spec passed", spec=attempts["rig_ok"])
            elif attempts["passed"] is not None:
                p = attempts["passed"]
                built = BuildOut(route="code", reason="the agent stopped after a draft passed", **p.model_dump())
                self._progress(scene_id, "checking", f"Using draft {attempts['passed_n']}, which passed")
            else:
                raise PermanentError(f"The scene agent could not finish: {exc}") from exc
        # the spec the rig service already accepted stands in for a final answer that leaves it out
        # (models often answer {"route": "rig"} without repeating a long spec they just checked)
        if built.route == "rig" and not built.spec and attempts.get("rig_ok") is not None:
            built.spec = attempts["rig_ok"]
        if built.route == "code" and not built.code and attempts.get("rig_ok") is not None:
            built = BuildOut(route="rig", reason=built.reason or "a rig spec passed; no code was given",
                             spec=attempts["rig_ok"], evidence=built.evidence)
        refs = [short(x.id) for x in sentences]
        cited = [r for r in built.evidence if r in refs] or refs[:3]
        route = {"route": built.route, "reason": built.reason[:400], "tries": attempts["tries"][-8:]}
        if built.route == "rig":
            if not built.spec:
                raise PermanentError("The agent chose a rig but gave no spec")
            self._progress(scene_id, "checking", f"Built from the {built.spec.get('rig')} rig")
            self._done(scene_id, "draft", component=f"rig:{built.spec.get('rig')}"[:64],
                       title=str(built.spec.get("title", ""))[:120], spec=built.spec, gates={"route": route},
                       generator=self.gateway.prompts.get("scene_code").tag)
        else:
            if not built.code or built.predict is None or not built.params:
                raise PermanentError("The agent chose to write code but gave no code, params or prediction")
            try:
                out = built.as_code()
            except ValidationError as exc:
                raise PermanentError(f"The agent's code declaration is incomplete: {exc}"[:500]) from exc
            self._done(scene_id, "draft", component=out.engine, title=out.title, spec=out.model_dump(),
                       gates={"route": route}, generator=self.gateway.prompts.get("scene_code").tag)
        with self.db.session() as s:
            row = s.get(SceneSpec, scene_id)
            row.evidence = self._evidence_rows(cited, sentences)

    def _verify(self, scene_id: str) -> None:
        """Re-run every gate ourselves: the agent's word that it passed is not evidence."""
        with self.db.session() as s:
            row = s.get(SceneSpec, scene_id)
            spec, gates = row.spec, dict(row.gates or {})
        if is_lab(spec):
            self._progress(scene_id, "verifying", "Checking the rig spec with the rig service")
            if self.rigs is None:
                raise PermanentError("The rig service is not configured")
            try:
                rep = self.rigs.check(spec)
            except RigUnavailable as exc:
                raise PermanentError(str(exc)) from exc
            if not rep.get("ok"):
                raise PermanentError("The lab failed its checks: " + "; ".join(rep.get("problems", [rep.get("error", "")]))[:500])
            gates["rig_check"] = {k: rep.get(k) for k in ("ok", "answer", "options", "rig_version", "catalog")}
            self._done(scene_id, "verify", gates=gates)
            return
        self._progress(scene_id, "verifying", "Running the final interaction script")
        with self.db.session() as s:
            out = CodeOut.model_validate(s.get(SceneSpec, scene_id).spec)
        rep = self._check(out)
        shot = rep.pop("_screenshot", None)
        if shot:
            (self.dir / f"{scene_id}.png").write_bytes(shot)
        if not rep["passed"]:
            raise PermanentError("The scene failed its checks: " + "; ".join(rep["problems"])[:500])
        self._done(scene_id, "verify", gates={**gates, "static": "passed",
                                              "protocol": {k: v for k, v in rep.items() if k != "stage"}})

    def _review(self, scene_id: str) -> None:
        shot = self.dir / f"{scene_id}.png"
        with self.db.session() as s:
            row = s.get(SceneSpec, scene_id)
            gates, title, prompt, ask = dict(row.gates), row.title, row.spec.get("prompt", ""), row.request
            lab = is_lab(row.spec)
        if lab:                       # rigs draw themselves: nothing generated to look at
            gates["review"] = {"skipped": "a prebuilt rig: its drawing is not generated"}
            self._done(scene_id, "review", gates=gates)
            return
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
        self.live.close(scene_id)

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
            if row is None or row.level != SceneLevel.L2 or row.status != SceneStatus.READY or is_lab(row.spec):
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
        route = (row.gates or {}).get("route") or {}
        out: dict[str, Any] = {
            "id": row.id, "level": row.level.value, "component": row.component, "chapter_id": row.chapter_id,
            "engine": "rig" if is_lab(row.spec) else ("code" if row.level == SceneLevel.L2 else "component"),
            "route": {"route": route.get("route"), "reason": route.get("reason", "")} if route else None,
            "activity": (row.gates or {}).get("activity"),
            "title": row.title, "status": row.status.value, "request": row.request, "error": row.error,
            "progress": {"stage": (row.progress or {}).get("stage"), "log": (row.progress or {}).get("log", [])},
            "evidence": ev, "checks": _checks(row.gates), "spec": None,
        }
        if row.status != SceneStatus.READY:
            return out
        if is_lab(row.spec):          # the spec carries no answer: the rig service keeps it in gates
            out["spec"] = row.spec
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
    if (gates.get("rig_check") or {}).get("ok"):
        out["rig checks"] = "passed"
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


__all__ = ["BuildOut", "CodeOut", "LabSpecOut", "ReviewOut", "SceneService", "SpecOut", "WORKFLOW", "is_lab", "math"]
