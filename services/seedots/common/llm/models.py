"""Model factories for the gateway: a real OpenAI-compatible endpoint, or an offline fake.

The fake is a `Brain`: a plain function (task, system, user) -> reply. It drives Pydantic
AI's FunctionModel, so the fake goes through exactly the same agent, output validation and
streaming code paths as the real model. A brain may also ask for a tool call by returning
FakeToolCall; the tool result is then handed back to it in `user` on the next turn.
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from typing import Any

from pydantic_ai.messages import (ModelMessage, ModelRequest, ModelResponse, SystemPromptPart, TextPart,
                                  ToolCallPart, ToolReturnPart, UserPromptPart)
from pydantic_ai.models import Model
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, FunctionModel

from seedots.common.config import ModelEndpoint


@dataclass
class FakeToolCall:
    name: str
    args: dict[str, Any]


Brain = Callable[[str, str, str], "str | FakeToolCall"]


def openai_compatible(endpoint: ModelEndpoint) -> Callable[[str], Model]:
    """TokenRouter and most hosted gateways speak the OpenAI chat API."""

    def factory(_task: str) -> Model:
        from pydantic_ai.models.openai import OpenAIChatModel
        from pydantic_ai.providers.openai import OpenAIProvider

        return OpenAIChatModel(endpoint.model,
                               provider=OpenAIProvider(base_url=endpoint.base_url, api_key=endpoint.api_key))
    return factory


def _flatten(messages: list[ModelMessage], info: AgentInfo) -> tuple[str, str]:
    """System text = agent instructions; user text = the latest request, with tool results."""
    system = info.instructions or ""
    last = messages[-1]
    user_bits: list[str] = []
    for part in last.parts:
        if isinstance(part, SystemPromptPart):
            system = f"{part.content}\n{system}"
        elif isinstance(part, UserPromptPart):
            user_bits.append(part.content if isinstance(part.content, str) else str(part.content))
        elif isinstance(part, ToolReturnPart):
            user_bits.append(f"<tool {part.tool_name}>{json.dumps(part.content, ensure_ascii=False, default=str)}")
    if not any(isinstance(p, UserPromptPart) for p in last.parts):
        # a tool round: keep the original question visible to the brain
        first_user = next((p.content for m in messages if isinstance(m, ModelRequest) for p in m.parts
                           if isinstance(p, UserPromptPart)), "")
        user_bits.insert(0, str(first_user))
    return system, "\n".join(user_bits)


def fake_model(brain: Callable[[str, str, str], Any]) -> Callable[[str], Model]:
    def factory(task: str) -> Model:
        def call(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
            system, user = _flatten(messages, info)
            out = brain(task, system, user)
            if isinstance(out, FakeToolCall):
                return ModelResponse(parts=[ToolCallPart(out.name, out.args)])
            return ModelResponse(parts=[TextPart(out)])

        async def stream(messages: list[ModelMessage], info: AgentInfo) -> AsyncIterator[Any]:
            system, user = _flatten(messages, info)
            out = brain(task, system, user)
            if isinstance(out, FakeToolCall):
                yield {0: DeltaToolCall(name=out.name, json_args=json.dumps(out.args), tool_call_id="fake-1")}
                return
            words = out.split(" ")
            for i, w in enumerate(words):
                yield w + (" " if i < len(words) - 1 else "")

        return FunctionModel(call, stream_function=stream, model_name=f"fake:{task}")
    return factory
