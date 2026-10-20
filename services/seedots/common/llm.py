"""LLM Gateway — the single exit for every model call (tech plan §8).

Responsibilities the provider SDK does not cover:
  * task name -> model + versioned prompt file
  * structured output: JSON mode + Pydantic validation + one repair retry
  * budget (max tokens / timeout), result cache, usage log, context manifest

The transport speaks the OpenAI-compatible Chat Completions protocol, which is what
TokenRouter exposes for deepseek/deepseek-v4-flash-0731. The plan names Pydantic AI as
the agent framework; this gateway keeps the same boundary (typed input -> typed output)
so the transport can be swapped for a Pydantic AI agent without touching callers.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterator, Protocol, TypeVar

from pydantic import BaseModel, ValidationError

T = TypeVar("T", bound=BaseModel)

Message = dict[str, str]


class LLMError(RuntimeError):
    pass


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0


class Transport(Protocol):
    def complete(self, *, model: str, messages: list[Message], json_mode: bool,
                 temperature: float, max_tokens: int, timeout: float) -> tuple[str, Usage]: ...

    def stream(self, *, model: str, messages: list[Message], temperature: float,
               max_tokens: int, timeout: float) -> Iterator[str]: ...


class HttpTransport:
    """OpenAI-compatible /chat/completions over httpx."""

    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def _headers(self) -> dict[str, str]:
        if not self.api_key:
            raise LLMError("SEEDOTS_LLM_API_KEY is empty. Set it in .env, or set SEEDOTS_LLM_FAKE=1 for offline dev.")
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    def complete(self, *, model, messages, json_mode, temperature, max_tokens, timeout):
        import httpx

        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        resp = httpx.post(f"{self.base_url}/chat/completions", headers=self._headers(), json=body, timeout=timeout)
        if resp.status_code >= 400:
            raise LLMError(f"LLM HTTP {resp.status_code}: {resp.text[:500]}")
        data = resp.json()
        try:
            text = data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError) as exc:
            raise LLMError(f"Unexpected LLM response: {str(data)[:500]}") from exc
        u = data.get("usage") or {}
        return text, Usage(u.get("prompt_tokens", 0), u.get("completion_tokens", 0))

    def stream(self, *, model, messages, temperature, max_tokens, timeout):
        import httpx

        body = {"model": model, "messages": messages, "temperature": temperature,
                "max_tokens": max_tokens, "stream": True}
        with httpx.stream("POST", f"{self.base_url}/chat/completions", headers=self._headers(),
                          json=body, timeout=timeout) as resp:
            if resp.status_code >= 400:
                raise LLMError(f"LLM HTTP {resp.status_code}: {resp.read()[:500]!r}")
            for line in resp.iter_lines():
                if not line or not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload)
                    delta = chunk["choices"][0].get("delta", {}).get("content")
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue
                if delta:
                    yield delta


FakeHandler = Callable[[str, list[Message]], str]


class FakeTransport:
    """Offline transport for tests and key-less dev. `handler(task, messages) -> text`."""

    def __init__(self, handler: FakeHandler):
        self.handler = handler
        self.calls: list[tuple[str, list[Message]]] = []

    def _task(self, messages: list[Message]) -> str:
        m = re.search(r"\[task:([\w.\-]+)\]", messages[0]["content"])
        return m.group(1) if m else "unknown"

    def complete(self, *, model, messages, json_mode, temperature, max_tokens, timeout):
        task = self._task(messages)
        self.calls.append((task, messages))
        return self.handler(task, messages), Usage()

    def stream(self, *, model, messages, temperature, max_tokens, timeout):
        task = self._task(messages)
        self.calls.append((task, messages))
        text = self.handler(task, messages)
        for i in range(0, len(text), 12):
            yield text[i:i + 12]


# ---------------------------------------------------------------- prompts


@dataclass
class Prompt:
    task: str
    version: str
    system: str
    user: str

    def render(self, variables: dict[str, Any]) -> list[Message]:
        def fill(template: str) -> str:
            def rep(m: re.Match) -> str:
                key = m.group(1)
                if key not in variables:
                    raise LLMError(f"prompt {self.task}.{self.version}: missing variable {key!r}")
                v = variables[key]
                return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
            return re.sub(r"\{\{(\w+)\}\}", rep, template)

        system = f"[task:{self.task}] [prompt:{self.version}]\n" + fill(self.system)
        return [{"role": "system", "content": system}, {"role": "user", "content": fill(self.user)}]


def load_prompt(prompt_dir: Path, task: str, version: str) -> Prompt:
    path = prompt_dir / f"{task}.{version}.md"
    text = path.read_text(encoding="utf-8")
    parts = re.split(r"^## (system|user)\s*$", text, flags=re.M)
    sections: dict[str, str] = {}
    for i in range(1, len(parts), 2):
        sections[parts[i]] = parts[i + 1].strip()
    if "system" not in sections or "user" not in sections:
        raise LLMError(f"{path} needs '## system' and '## user' sections")
    return Prompt(task, version, sections["system"], sections["user"])


# ---------------------------------------------------------------- gateway


@dataclass
class TaskConfig:
    prompt_version: str = "v1"
    temperature: float = 0.2
    max_tokens: int = 4000
    timeout: float = 120.0
    model: str | None = None  # None -> gateway default


UsageSink = Callable[[dict[str, Any]], None]


def _extract_json(text: str) -> Any:
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, flags=re.S)
    if fence:
        text = fence.group(1).strip()
    if not text.startswith(("{", "[")):
        start = min([i for i in (text.find("{"), text.find("[")) if i >= 0] or [-1])
        if start >= 0:
            text = text[start:]
    return json.loads(text)


@dataclass
class Gateway:
    transport: Transport
    prompt_dir: Path
    default_model: str
    tasks: dict[str, TaskConfig] = field(default_factory=dict)
    usage_sink: UsageSink | None = None
    cache: dict[str, str] = field(default_factory=dict)

    def _cfg(self, task: str) -> TaskConfig:
        return self.tasks.get(task, TaskConfig())

    def _log(self, **row: Any) -> None:
        if self.usage_sink:
            try:
                self.usage_sink(row)
            except Exception:  # logging must never break a request
                pass

    def run(self, task: str, variables: dict[str, Any], output: type[T], *,
            evidence_ids: list[str] | None = None, use_cache: bool = True) -> T:
        cfg = self._cfg(task)
        model = cfg.model or self.default_model
        prompt = load_prompt(self.prompt_dir, task, cfg.prompt_version)
        messages = prompt.render(variables)
        key = hashlib.sha256(json.dumps([task, cfg.prompt_version, model, messages]).encode()).hexdigest()
        if use_cache and key in self.cache:
            return output.model_validate_json(self.cache[key])

        last_error = ""
        for attempt in range(2):
            msgs = messages if attempt == 0 else messages + [
                {"role": "user", "content": f"Your previous output was invalid: {last_error}\n"
                                            f"Return ONLY a JSON object that matches the schema."}]
            t0 = time.perf_counter()
            try:
                text, usage = self.transport.complete(model=model, messages=msgs, json_mode=True,
                                                      temperature=cfg.temperature, max_tokens=cfg.max_tokens,
                                                      timeout=cfg.timeout)
            except Exception as exc:
                self._log(task=task, model=model, prompt_version=cfg.prompt_version, ok=False,
                          error=str(exc)[:300], latency_ms=int((time.perf_counter() - t0) * 1000),
                          evidence_ids=evidence_ids or [])
                raise LLMError(str(exc)) from exc
            latency = int((time.perf_counter() - t0) * 1000)
            try:
                parsed = output.model_validate(_extract_json(text))
            except (json.JSONDecodeError, ValidationError, ValueError) as exc:
                last_error = str(exc)[:800]
                self._log(task=task, model=model, prompt_version=cfg.prompt_version, ok=False,
                          error="invalid_output: " + last_error[:200], latency_ms=latency,
                          prompt_tokens=usage.prompt_tokens, completion_tokens=usage.completion_tokens,
                          evidence_ids=evidence_ids or [])
                continue
            self._log(task=task, model=model, prompt_version=cfg.prompt_version, ok=True, error="",
                      latency_ms=latency, prompt_tokens=usage.prompt_tokens,
                      completion_tokens=usage.completion_tokens, evidence_ids=evidence_ids or [])
            self.cache[key] = parsed.model_dump_json()
            return parsed
        raise LLMError(f"{task}: output failed validation twice: {last_error}")

    def stream(self, task: str, variables: dict[str, Any], *, history: list[Message] | None = None,
               evidence_ids: list[str] | None = None) -> Iterator[str]:
        cfg = self._cfg(task)
        model = cfg.model or self.default_model
        prompt = load_prompt(self.prompt_dir, task, cfg.prompt_version)
        rendered = prompt.render(variables)
        messages = [rendered[0], *(history or []), rendered[1]]
        t0 = time.perf_counter()
        first = None
        n = 0
        try:
            for delta in self.transport.stream(model=model, messages=messages, temperature=cfg.temperature,
                                               max_tokens=cfg.max_tokens, timeout=cfg.timeout):
                if first is None:
                    first = int((time.perf_counter() - t0) * 1000)
                n += len(delta)
                yield delta
        except Exception as exc:
            self._log(task=task, model=model, prompt_version=cfg.prompt_version, ok=False, error=str(exc)[:300],
                      latency_ms=int((time.perf_counter() - t0) * 1000), evidence_ids=evidence_ids or [])
            raise LLMError(str(exc)) from exc
        self._log(task=task, model=model, prompt_version=cfg.prompt_version, ok=True, error="",
                  latency_ms=int((time.perf_counter() - t0) * 1000), first_token_ms=first or 0,
                  completion_chars=n, evidence_ids=evidence_ids or [])


def build_transport(settings, fake_handler: FakeHandler) -> Transport:
    if settings.llm_fake:
        return FakeTransport(fake_handler)
    return HttpTransport(settings.llm_base_url, settings.llm_api_key)
