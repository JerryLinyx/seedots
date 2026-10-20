from seedots.common.llm.gateway import BudgetExceeded, Gateway, LLMError, TaskSpec, UsageRecord
from seedots.common.llm.models import FakeToolCall, fake_model, openai_compatible
from seedots.common.llm.prompts import PromptLibrary
from seedots.common.llm.store import DbCache, DbUsageSink

__all__ = ["BudgetExceeded", "DbCache", "DbUsageSink", "FakeToolCall", "Gateway", "LLMError", "PromptLibrary",
           "TaskSpec", "UsageRecord", "build_gateway", "fake_model", "openai_compatible"]


def build_gateway(settings, *, prompt_dir, tasks, brain, db=None, usage_model=None, cache_model=None,
                  task_endpoints=None) -> Gateway:
    """Wire a gateway from settings: real endpoint unless SEEDOTS_LLM_FAKE=1 or no key.
    `task_endpoints` routes specific tasks to another model (e.g. a vision model for review)."""
    use_fake = settings.llm_fake or not settings.llm.api_key
    default = fake_model(brain) if use_fake else openai_compatible(settings.llm)
    routed = {task: openai_compatible(ep) for task, ep in (task_endpoints or {}).items()
              if not use_fake and ep.configured}

    def factory(task: str):
        return (routed.get(task) or default)(task)
    return Gateway(
        prompts=PromptLibrary(prompt_dir), model_factory=factory,
        model_name="fake" if use_fake else settings.llm.model, tasks=tasks,
        usage_sink=DbUsageSink(db, usage_model) if db is not None and usage_model else None,
        cache=DbCache(db, cache_model) if db is not None and cache_model else None,
        model_names={task: ep.model for task, ep in (task_endpoints or {}).items() if task in routed},
        reasoning=settings.llm_reasoning, max_tokens=settings.llm_max_tokens,
    )
