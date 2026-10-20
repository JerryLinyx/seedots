"""L1 scenes: a SceneSpec is configuration for a prebuilt component, never code.

Two domain-general components cover most "what happens if I change this?" moments:

  function_plot  y = f(x; params), one or two curves, sliders for the params
  iteration      x_{n+1} = g(x_n; params) for N steps, optionally drawn on an objective f(x)
                 (gradient descent, compound growth, population models, fixed-point methods)

Every scene runs the same loop: predict -> try (set_param) -> observe -> explain.
The prediction's true answer is computed here by code (the same grammar runs in the
browser), and validation enforces invariants before a scene is ever shown.
"""
from __future__ import annotations

import math
import re
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, Field, field_validator, model_validator

from seedots.learning.scenes import expr

IDENT = re.compile(r"^[a-z][a-z0-9_]{0,15}$")
RESERVED = {"x", "n"} | set(expr.FUNCS) | set(expr.CONSTS)

CHANGE_OPTIONS = ["goes up", "goes down", "stays about the same"]
BEHAVIOUR_OPTIONS = ["settles down", "keeps bouncing", "blows up"]


class Param(BaseModel):
    name: str
    label: str = Field(max_length=60)
    min: float
    max: float
    step: float
    value: float

    @field_validator("name")
    @classmethod
    def _name(cls, v: str) -> str:
        if not IDENT.match(v) or v in RESERVED:
            raise ValueError(f"parameter name {v!r} must be a short lowercase identifier, not a reserved word")
        return v

    @model_validator(mode="after")
    def _range(self) -> Param:
        if not (math.isfinite(self.min) and math.isfinite(self.max)) or self.min >= self.max:
            raise ValueError(f"{self.name}: min must be below max")
        if not self.min <= self.value <= self.max:
            raise ValueError(f"{self.name}: default value outside its range")
        if not 0 < self.step <= (self.max - self.min):
            raise ValueError(f"{self.name}: bad step")
        return self


class Axis(BaseModel):
    min: float
    max: float
    label: str = Field("", max_length=40)

    @model_validator(mode="after")
    def _range(self) -> Axis:
        if self.min >= self.max:
            raise ValueError("axis min must be below max")
        return self


class Observe(BaseModel):
    kind: Literal["value_at", "final", "behaviour"]
    x: float | None = None           # value_at: where to read the curve
    curve: int = 0


class Predict(BaseModel):
    question: str = Field(max_length=200)
    param: str
    to: float
    observe: Observe


class Curve(BaseModel):
    expr: str
    label: str = Field("", max_length=40)


class FunctionPlot(BaseModel):
    component: Literal["function_plot"]
    title: str = Field(max_length=80)
    prompt: str = Field(max_length=240)
    x: Axis
    y_label: str = Field("", max_length=40)
    curves: list[Curve] = Field(min_length=1, max_length=2)
    params: list[Param] = Field(min_length=1, max_length=3)
    predict: Predict
    evidence: list[str] = Field(min_length=1, max_length=6)


class Iteration(BaseModel):
    component: Literal["iteration"]
    title: str = Field(max_length=80)
    prompt: str = Field(max_length=240)
    state_label: str = Field("x", max_length=40)
    start: float
    update: str                       # in terms of x (current state) and params
    steps: int = Field(ge=5, le=80)
    objective: str | None = None      # optional f(x) to draw the path on
    x: Axis
    params: list[Param] = Field(min_length=1, max_length=3)
    predict: Predict
    evidence: list[str] = Field(min_length=1, max_length=6)


L1Spec = Annotated[Union[FunctionPlot, Iteration], Field(discriminator="component")]


class SceneInvalid(ValueError):
    pass


# ------------------------------------------------------------------------------ simulation
def env_of(params: list[Param], override: dict[str, float] | None = None) -> dict[str, float]:
    env = {p.name: p.value for p in params}
    env.update(override or {})
    return env


def sample_curve(node: expr.Node, axis: Axis, env: dict[str, float], n: int = 121) -> list[float]:
    return [expr.evaluate(node, {**env, "x": axis.min + (axis.max - axis.min) * i / (n - 1)}) for i in range(n)]


def iterate(update: expr.Node, start: float, steps: int, env: dict[str, float]) -> list[float]:
    xs = [start]
    for k in range(steps):
        nxt = expr.evaluate(update, {**env, "x": xs[-1], "n": k})
        xs.append(nxt)
        if not math.isfinite(nxt) or abs(nxt) > 1e9:
            break
    return xs


def behaviour(xs: list[float]) -> str:
    """settles down | keeps bouncing | blows up (same rule as lib/expr.ts)."""
    if any(not math.isfinite(v) or abs(v) > 1e6 for v in xs):
        return "blows up"
    d = [b - a for a, b in zip(xs, xs[1:])]
    tail = d[-8:]
    scale = 1 + max(abs(v) for v in xs)
    if all(abs(v) < 1e-3 * scale for v in tail[-3:]):
        return "settles down"
    first, last = abs(d[len(d) // 2]) if d else 0, abs(d[-1]) if d else 0
    alternating = sum(1 for a, b in zip(tail, tail[1:]) if a * b < 0) >= len(tail) - 2
    if last > first * 1.5 and last > 1e-2 * scale:
        return "blows up"
    if alternating and last > 0.5 * first:
        return "keeps bouncing"
    return "settles down"


def observe(spec: FunctionPlot | Iteration, env: dict[str, float]) -> float | str:
    o = spec.predict.observe
    if isinstance(spec, FunctionPlot):
        if o.kind != "value_at" or o.x is None:
            raise SceneInvalid("function_plot predictions read a curve value at x")
        node = expr.parse(spec.curves[min(o.curve, len(spec.curves) - 1)].expr)
        return expr.evaluate(node, {**env, "x": o.x})
    xs = iterate(expr.parse(spec.update), spec.start, spec.steps, env)
    if o.kind == "behaviour":
        return behaviour(xs)
    if o.kind == "final":
        return xs[-1]
    raise SceneInvalid("iteration predictions observe the final value or the behaviour")


def change(before: float, after: float) -> str:
    if not (math.isfinite(before) and math.isfinite(after)):
        return "goes up" if (after if math.isfinite(after) else math.inf) > before else "goes down"
    tol = 0.02 * max(1.0, abs(before))
    return "goes up" if after - before > tol else "goes down" if before - after > tol else "stays about the same"


def options(spec: FunctionPlot | Iteration) -> list[str]:
    return BEHAVIOUR_OPTIONS if spec.predict.observe.kind == "behaviour" else CHANGE_OPTIONS


def answer(spec: FunctionPlot | Iteration) -> str:
    before = observe(spec, env_of(spec.params))
    after = observe(spec, env_of(spec.params, {spec.predict.param: spec.predict.to}))
    if spec.predict.observe.kind == "behaviour":
        return str(after)
    return change(float(before), float(after))


# ------------------------------------------------------------------------------ validation
def validate(raw: dict[str, Any], chapter_refs: set[str]) -> tuple[FunctionPlot | Iteration, dict[str, Any]]:
    """Parse + invariants. Returns the spec and a gate report; raises SceneInvalid."""
    from pydantic import TypeAdapter, ValidationError

    try:
        spec = TypeAdapter(L1Spec).validate_python(raw)
    except ValidationError as exc:
        first = exc.errors()[0]
        raise SceneInvalid(f"{'.'.join(map(str, first['loc']))}: {first['msg']}") from exc

    names = [p.name for p in spec.params]
    if len(set(names)) != len(names):
        raise SceneInvalid("parameter names must be unique")
    allowed = set(names) | {"x", "n"}
    try:
        nodes = [expr.check(c.expr, allowed) for c in spec.curves] if isinstance(spec, FunctionPlot) \
            else [expr.check(spec.update, allowed)] + ([expr.check(spec.objective, allowed)] if spec.objective else [])
    except expr.ExprError as exc:
        raise SceneInvalid(f"expression: {exc}") from exc
    unused = set(names) - set().union(*(expr.names(n) for n in nodes))
    if unused:
        raise SceneInvalid(f"parameter(s) never used: {', '.join(sorted(unused))}")

    missing = [e for e in spec.evidence if e not in chapter_refs]
    if missing:
        raise SceneInvalid(f"evidence must cite sentences of this chapter, unknown: {missing}")

    p = next((p for p in spec.params if p.name == spec.predict.param), None)
    if p is None:
        raise SceneInvalid("predict.param must be one of the parameters")
    if not p.min <= spec.predict.to <= p.max or abs(spec.predict.to - p.value) < p.step / 2:
        raise SceneInvalid("predict.to must be inside the slider range and differ from the default")

    # the scene must stay drawable across the whole slider range
    corners = [{}] + [{q.name: q.min} for q in spec.params] + [{q.name: q.max} for q in spec.params]
    if isinstance(spec, FunctionPlot):
        for node in nodes:
            for c in corners:
                ys = sample_curve(node, spec.x, env_of(spec.params, c))
                if sum(math.isfinite(v) for v in ys) < 0.6 * len(ys):
                    raise SceneInvalid("a curve is undefined over most of the x range for some slider value")
    else:
        xs = iterate(nodes[0], spec.start, spec.steps, env_of(spec.params))
        if behaviour(xs) == "blows up":
            raise SceneInvalid("the default settings should not blow up; start from a sensible value")
        if spec.objective:
            ys = sample_curve(nodes[1], spec.x, env_of(spec.params))
            if sum(math.isfinite(v) for v in ys) < 0.8 * len(ys):
                raise SceneInvalid("the objective is undefined over most of the x range")

    truth = answer(spec)
    if truth == "stays about the same":
        raise SceneInvalid("the prediction should be about a change the learner can see")
    return spec, {"invariants": "passed", "answer": truth, "options": options(spec)}


def public(spec: FunctionPlot | Iteration) -> dict[str, Any]:
    """What the browser receives: the config and the options, not the computed answer."""
    out = spec.model_dump()
    out["predict"]["options"] = options(spec)
    return out
