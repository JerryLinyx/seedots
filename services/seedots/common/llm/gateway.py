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
from pydantic_ai import Agent, AgentRunResultEvent, NativeOutput, PromptedOutput, ToolOutput  # noqa: E402
from pydantic_ai.exceptions import ModelHTTPError, UnexpectedModelBehavior  # noqa: E402
from pydantic_ai.messages import (BinaryContent, FunctionToolCallEvent, ModelMessage, ModelRequest,  # noqa: E402
                                  ModelResponse, PartDeltaEvent, PartStartEvent, TextPart, TextPartDelta,
                                  UserPromptPart)
from pydantic_ai.usage import UsageLimits  # noqa: E402
from pydantic_ai.models import Model  # noqa: E402
from pydantic_ai.toolsets import FunctionToolset  # noqa: E402

from seedots.common.llm.prompts import Prompt, PromptLibrary  # noqa: E402

log = logging.getLogger("seedots.llm")

OutputMode = Literal["prompted", "native", "tool"]
Reasoning = Literal["low", "medium", "high"]

# Reasoning models spend output tokens on thinking before they answer, and `max_tokens`
# caps thinking + answer together. When the cap is hit before any answer, retry once
# with a larger cap instead of failing.
MAX_TOKENS_CEILING = 65_536


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
    reasoning: Reasoning | None = None        # reasoning effort for thinking models; None -> provider default


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
                 cache: CacheStore | None = None, model_names: dict[str, str] | None = None,
                 reasoning: str = "auto", max_tokens: dict[str, int] | None = None):
        """`reasoning`: "auto" sends each task's own effort, "off" never sends the parameter
        (for providers that reject it), or a level forces that effort on every task.
        `max_tokens` overrides the per-task caps (from SEEDOTS_LLM_MAX_TOKENS)."""
        self.prompts = prompts
        self.model_factory = model_factory
        self.model_name = model_name
        self.model_names = model_names or {}      # tasks routed to another model (logged accurately)
        self.tasks = {t.name: t for t in tasks}
        self.usage_sink = usage_sink
        self.cache = cache
        self._budget = _Budget()
        # Agents hold an async HTTP client bound to the event loop that first used it. Workflow
        # threads each run their own loop (run_sync), so agents are cached per thread.
        self._local = threading.local()
        self.reasoning = reasoning
        self.max_tokens = max_tokens or {}
        self._reasoning_rejected = False

    # ----------------------------------------------------------------- internals
    def spec(self, task: str) -> TaskSpec:
        if task not in self.tasks:
            raise LLMError(f"undeclared task {task!r}")
        return self.tasks[task]

    def _agent(self, spec: TaskSpec, prompt: Prompt) -> Agent:
        agents: dict[tuple[str, int], Agent] = self._local.__dict__.setdefault("agents", {})
        key = (spec.name, prompt.version)
        if key not in agents:
            agents[key] = Agent(
                self.model_factory(spec.name),
                output_type=_output_spec(spec),
                retries={"output": spec.output_retries, "tools": 1},
                name=spec.name,
            )
        return agents[key]

    def _settings(self, spec: TaskSpec, max_tokens: int | None = None) -> dict[str, Any]:
        out: dict[str, Any] = {"temperature": spec.temperature, "timeout": spec.timeout,
                               "max_tokens": max_tokens or self.max_tokens.get(spec.name, spec.max_tokens)}
        effort = spec.reasoning if self.reasoning == "auto" else None if self.reasoning == "off" else self.reasoning
        if effort and not self._reasoning_rejected:
            out["openai_reasoning_effort"] = effort
        return out

    def _recover(self, exc: Exception, settings: dict[str, Any], tried: set[str]) -> dict[str, Any] | None:
        """Settings for one more attempt, or None when the error is not one we can fix."""
        if isinstance(exc, UnexpectedModelBehavior) and "token limit" in str(exc) and "tokens" not in tried:
            tried.add("tokens")
            bigger = min(MAX_TOKENS_CEILING, settings["max_tokens"] * 3)
            if bigger > settings["max_tokens"]:
                log.warning("max_tokens %s used up before an answer; retrying with %s", settings["max_tokens"], bigger)
                return {**settings, "max_tokens": bigger}
        if (isinstance(exc, ModelHTTPError) and exc.status_code in (400, 422) and "openai_reasoning_effort" in settings
                and "reasoning" in str(exc).lower() and "reasoning" not in tried):
            tried.add("reasoning")
            log.warning("provider rejected reasoning_effort; not sending it again")
            self._reasoning_rejected = True
            return {k: v for k, v in settings.items() if k != "openai_reasoning_effort"}
        return None

    def _record(self, rec: UsageRecord) -> None:
        self._budget.add(rec.task, rec.input_tokens + rec.output_tokens)
        if self.usage_sink:
            try:
                self.usage_sink(rec)
            except Exception:  # logging must never break a call
                log.exception("usage sink failed")

    def _cache_key(self, spec: TaskSpec, prompt: Prompt, system: str, user: str) -> str:
        raw = json.dumps([spec.name, prompt.tag, self.model_names.get(spec.name, self.model_name), system, user], ensure_ascii=False)
        return hashlib.sha256(raw.encode()).hexdigest()

    # ----------------------------------------------------------------- structured, sync
    def run(self, task: str, variables: dict[str, Any], *, manifest: dict[str, Any] | None = None,
            use_cache: bool | None = None, tools: Sequence[Callable[..., Any]] = (),
            images: Sequence[bytes] = (), max_requests: int | None = None) -> Any:
        """Structured call. `tools` turns it into a bounded agent loop (the model may call the
        whitelisted functions, at most `max_requests` model requests); `images` are PNGs sent
        with the user message (vision tasks)."""
        spec = self.spec(task)
        if spec.output is None:
            raise LLMError(f"task {task!r} is a text task; use stream()")
        prompt = self.prompts.get(task, spec.prompt_version)
        system, user = prompt.render(variables)
        caching = (spec.cache if use_cache is None else use_cache) and not tools and not images
        key = self._cache_key(spec, prompt, system, user) if caching and self.cache else None
        if key and (hit := self.cache.get(key)) is not None:
            return spec.output.model_validate(hit)
        self._budget.check(spec)

        started = time.perf_counter()
        rec = UsageRecord(task=task, model=self.model_names.get(task, self.model_name), prompt_version=prompt.tag, ok=False, latency_ms=0,
                          context_manifest={**(manifest or {}), **({"tools": [f.__name__ for f in tools]} if tools else {}),
                                            **({"images": len(images)} if images else {})})
        user_prompt: Any = user
        if images:
            user_prompt = [user, *(BinaryContent(data=img, media_type="image/png") for img in images)]
        settings, tried = self._settings(spec), set()
        while True:
            try:
                result = self._agent(spec, prompt).run_sync(
                    user_prompt, instructions=system, model_settings=settings,
                    toolsets=[FunctionToolset(list(tools))] if tools else None,
                    usage_limits=UsageLimits(request_limit=max_requests) if max_requests else None)
                break
            except Exception as exc:
                if (retry := self._recover(exc, settings, tried)) is not None:
                    settings = retry
                    continue
                rec.error = f"{type(exc).__name__}: {exc}"[:500]
                rec.latency_ms = int((time.perf_counter() - started) * 1000)
                self._record(rec)
                raise LLMError(rec.error) from exc
        if settings["max_tokens"] != self._settings(spec)["max_tokens"]:
            rec.context_manifest["max_tokens_retry"] = settings["max_tokens"]
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
        rec = UsageRecord(task=task, model=self.model_names.get(task, self.model_name), prompt_version=prompt.tag, ok=False, latency_ms=0,
                          context_manifest={**(manifest or {}), "tools": [t.__name__ for t in tools]})
        toolsets = [FunctionToolset(list(tools))] if tools else None
        settings, tried = self._settings(spec), set()
        try:
            while True:
                try:
                    # run_stream_events, not run_stream: run_stream stops at the first text, so a reply
                    # that says "let me check" and then calls a tool would end there.
                    async with self._agent(spec, prompt).run_stream_events(
                            user, instructions=system, message_history=history_messages(history),
                            toolsets=toolsets, model_settings=settings) as events:
                        wrote, after_tool = False, False
                        async for ev in events:
                            delta = ""
                            if isinstance(ev, PartStartEvent) and isinstance(ev.part, TextPart):
                                delta = ev.part.content
                                if after_tool and wrote and delta:
                                    delta = "\n\n" + delta.lstrip()   # text after a tool call: new paragraph
                                after_tool = after_tool and not delta
                            elif isinstance(ev, PartDeltaEvent) and isinstance(ev.delta, TextPartDelta):
                                delta = ev.delta.content_delta
                            elif isinstance(ev, FunctionToolCallEvent):
                                after_tool = True
                            elif isinstance(ev, AgentRunResultEvent):
                                usage = ev.result.usage
                            if delta:
                                if rec.first_token_ms is None:
                                    rec.first_token_ms = int((time.perf_counter() - started) * 1000)
                                wrote = True
                                yield delta
                    break
                except Exception as exc:
                    # retry only while nothing has reached the caller
                    if rec.first_token_ms is None and (retry := self._recover(exc, settings, tried)) is not None:
                        settings = retry
                        continue
                    raise
            rec.ok = True
            rec.input_tokens, rec.output_tokens, rec.requests = usage.input_tokens, usage.output_tokens, usage.requests
        except Exception as exc:
            rec.error = f"{type(exc).__name__}: {exc}"[:500]
            raise LLMError(rec.error) from exc
        finally:
            rec.latency_ms = int((time.perf_counter() - started) * 1000)
            self._record(rec)
