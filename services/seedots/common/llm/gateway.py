"""Model gateway on top of Pydantic AI (tech plan §8). Every model call in both services
goes through here, so prompt versions, typed outputs, retries, caching, budgets and the
usage log are handled once.

    gateway.run("outline", {...})              -> validated Pydantic object (sync)
    gateway.stream("coach", {...}, tools=...)  -> async iterator of text deltas

Tasks are declared up front (TaskSpec). The model is built by a ModelFactory, so the same
code runs against TokenRouter (OpenAI-compatible), any other provider Pydantic AI supports,
or the offline fake used in tests and in keyless development.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Literal, Protocol

os.environ.setdefault("PYDANTIC_AI_NO_BANNER", "1")

from pydantic import BaseModel  # noqa: E402
from pydantic_ai import Agent, NativeOutput, PromptedOutput, ToolOutput  # noqa: E402
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, UserPromptPart  # noqa: E402
from pydantic_ai.models import Model  # noqa: E402
from pydantic_ai.toolsets import FunctionToolset  # noqa: E402

from seedots.common.llm.prompts import Prompt, PromptLibrary  # noqa: E402

log = logging.getLogger("seedots.llm")

OutputMode = Literal["prompted", "native", "tool"]


class LLMError(RuntimeError):
    """Any model failure after retries. Callers fall back (rules, windows) or surface it."""


class BudgetExceeded(LLMError):
    pass


@dataclass(frozen=True)
class TaskSpec:
    name: str
    output: type[BaseModel] | None = None     # None -> free text (streaming tasks)
    prompt_version: int | None = None         # pin a version; None -> latest file
    temperature: float = 0.2
    max_tokens: int = 2000
    timeout: float = 90.0
    output_retries: int = 1                   # one repair round on invalid output
    cache: bool = False                       # cache by rendered prompt (deterministic tasks only)
    output_mode: OutputMode = "prompted"      # prompted works with any JSON-capable model
    daily_token_budget: int | None = None


@dataclass
class UsageRecord:
    task: str
    model: str
    prompt_version: str
    ok: bool
    latency_ms: int
    input_tokens: int = 0
    output_tokens: int = 0
    requests: int = 0
    first_token_ms: int | None = None
    error: str | None = None
    context_manifest: dict[str, Any] = field(default_factory=dict)


class CacheStore(Protocol):
    def get(self, key: str) -> dict | None: ...
    def put(self, key: str, task: str, prompt_version: str, model: str, output: dict) -> None: ...


ModelFactory = Callable[[str], Model]          # task name -> model
UsageSink = Callable[[UsageRecord], None]


class _Budget:
    """In-process daily token counter per task. Coarse on purpose: it stops runaway loops."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._day = date.today()
        self._used: dict[str, int] = {}

    def check(self, spec: TaskSpec) -> None:
        if spec.daily_token_budget is None:
            return
        with self._lock:
            self._roll()
            if self._used.get(spec.name, 0) >= spec.daily_token_budget:
                raise BudgetExceeded(f"daily token budget for {spec.name!r} is used up")

    def add(self, task: str, tokens: int) -> None:
        with self._lock:
            self._roll()
            self._used[task] = self._used.get(task, 0) + tokens

    def _roll(self) -> None:
        if date.today() != self._day:
            self._day, self._used = date.today(), {}


def _output_spec(spec: TaskSpec) -> Any:
    if spec.output is None:
        return str
    return {"prompted": PromptedOutput, "native": NativeOutput, "tool": ToolOutput}[spec.output_mode](spec.output)


def history_messages(turns: Sequence[tuple[str, str]]) -> list[ModelMessage]:
    """[(role, text)] -> Pydantic AI message history (user / assistant turns)."""
    out: list[ModelMessage] = []
    for role, text in turns:
        if role == "user":
            out.append(ModelRequest(parts=[UserPromptPart(content=text)]))
        else:
            out.append(ModelResponse(parts=[TextPart(content=text)]))
    return out


class Gateway:
    def __init__(self, *, prompts: PromptLibrary, model_factory: ModelFactory, model_name: str,
                 tasks: Sequence[TaskSpec], usage_sink: UsageSink | None = None,
                 cache: CacheStore | None = None):
        self.prompts = prompts
        self.model_factory = model_factory
        self.model_name = model_name
        self.tasks = {t.name: t for t in tasks}
        self.usage_sink = usage_sink
        self.cache = cache
        self._budget = _Budget()
        self._agents: dict[tuple[str, int], Agent] = {}
        self._lock = threading.Lock()

    # ----------------------------------------------------------------- internals
    def spec(self, task: str) -> TaskSpec:
        if task not in self.tasks:
            raise LLMError(f"undeclared task {task!r}")
        return self.tasks[task]

    def _agent(self, spec: TaskSpec, prompt: Prompt) -> Agent:
        key = (spec.name, prompt.version)
        with self._lock:
            if key not in self._agents:
                self._agents[key] = Agent(
                    self.model_factory(spec.name),
                    output_type=_output_spec(spec),
                    retries={"output": spec.output_retries, "tools": 1},
                    model_settings={"temperature": spec.temperature, "max_tokens": spec.max_tokens,
                                    "timeout": spec.timeout},
                    name=spec.name,
                )
            return self._agents[key]

    def _record(self, rec: UsageRecord) -> None:
        self._budget.add(rec.task, rec.input_tokens + rec.output_tokens)
        if self.usage_sink:
            try:
                self.usage_sink(rec)
            except Exception:  # logging must never break a call
                log.exception("usage sink failed")

    def _cache_key(self, spec: TaskSpec, prompt: Prompt, system: str, user: str) -> str:
        raw = json.dumps([spec.name, prompt.tag, self.model_name, system, user], ensure_ascii=False)
        return hashlib.sha256(raw.encode()).hexdigest()

    # ----------------------------------------------------------------- structured, sync
    def run(self, task: str, variables: dict[str, Any], *, manifest: dict[str, Any] | None = None,
            use_cache: bool | None = None) -> Any:
        spec = self.spec(task)
        if spec.output is None:
            raise LLMError(f"task {task!r} is a text task; use stream()")
        prompt = self.prompts.get(task, spec.prompt_version)
        system, user = prompt.render(variables)
        caching = spec.cache if use_cache is None else use_cache
        key = self._cache_key(spec, prompt, system, user) if caching and self.cache else None
        if key and (hit := self.cache.get(key)) is not None:
            return spec.output.model_validate(hit)
        self._budget.check(spec)

        started = time.perf_counter()
        rec = UsageRecord(task=task, model=self.model_name, prompt_version=prompt.tag, ok=False, latency_ms=0,
                          context_manifest=manifest or {})
        try:
            result = self._agent(spec, prompt).run_sync(user, instructions=system)
        except Exception as exc:
            rec.error = f"{type(exc).__name__}: {exc}"[:500]
            rec.latency_ms = int((time.perf_counter() - started) * 1000)
            self._record(rec)
            raise LLMError(rec.error) from exc
        usage = result.usage
        rec.ok, rec.latency_ms = True, int((time.perf_counter() - started) * 1000)
        rec.input_tokens, rec.output_tokens, rec.requests = usage.input_tokens, usage.output_tokens, usage.requests
        self._record(rec)
        output = result.output
        if key:
            self.cache.put(key, task, prompt.tag, self.model_name, output.model_dump(mode="json"))
        return output

    # ----------------------------------------------------------------- text, streaming
    async def stream(self, task: str, variables: dict[str, Any], *,
                     history: Sequence[tuple[str, str]] = (), tools: Sequence[Callable[..., Any]] = (),
                     manifest: dict[str, Any] | None = None) -> AsyncIterator[str]:
        """Yield text deltas. `tools` are plain functions the model may call (whitelisted per
        request; closures carry the request context, so no global state is reachable)."""
        spec = self.spec(task)
        prompt = self.prompts.get(task, spec.prompt_version)
        system, user = prompt.render(variables)
        self._budget.check(spec)
        started = time.perf_counter()
        rec = UsageRecord(task=task, model=self.model_name, prompt_version=prompt.tag, ok=False, latency_ms=0,
                          context_manifest={**(manifest or {}), "tools": [t.__name__ for t in tools]})
        toolsets = [FunctionToolset(list(tools))] if tools else None
        try:
            async with self._agent(spec, prompt).run_stream(
                    user, instructions=system, message_history=history_messages(history),
                    toolsets=toolsets) as res:
                async for delta in res.stream_text(delta=True):
                    if rec.first_token_ms is None:
                        rec.first_token_ms = int((time.perf_counter() - started) * 1000)
                    yield delta
                usage = res.usage
            rec.ok = True
            rec.input_tokens, rec.output_tokens, rec.requests = usage.input_tokens, usage.output_tokens, usage.requests
        except Exception as exc:
            rec.error = f"{type(exc).__name__}: {exc}"[:500]
            raise LLMError(rec.error) from exc
        finally:
            rec.latency_ms = int((time.perf_counter() - started) * 1000)
            self._record(rec)
