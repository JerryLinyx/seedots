"""Settings read from the environment (and a repo-root .env when python-dotenv is installed)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

try:  # optional: load <repo>/.env for local dev
    from dotenv import load_dotenv

    load_dotenv(REPO_ROOT / ".env")
except ImportError:  # pragma: no cover
    pass


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


@dataclass(frozen=True)
class Settings:
    llm_api_key: str
    llm_base_url: str
    llm_model: str
    llm_fake: bool
    media_url: str
    learning_url: str
    media_webhook_url: str
    webhook_secret: str
    data_dir: Path
    action_selector: str
    web_origins: list[str]


def load_settings() -> Settings:
    data_dir = Path(_env("SEEDOTS_DATA_DIR", "./data"))
    if not data_dir.is_absolute():
        data_dir = REPO_ROOT / data_dir
    data_dir.mkdir(parents=True, exist_ok=True)
    return Settings(
        llm_api_key=_env("SEEDOTS_LLM_API_KEY"),
        llm_base_url=_env("SEEDOTS_LLM_BASE_URL", "https://api.tokenrouter.io/v1").rstrip("/"),
        llm_model=_env("SEEDOTS_LLM_MODEL", "deepseek/deepseek-v4-flash-0731"),
        llm_fake=_env("SEEDOTS_LLM_FAKE", "0") == "1",
        media_url=_env("SEEDOTS_MEDIA_URL", "http://127.0.0.1:8001").rstrip("/"),
        learning_url=_env("SEEDOTS_LEARNING_URL", "http://127.0.0.1:8000").rstrip("/"),
        media_webhook_url=_env("SEEDOTS_MEDIA_WEBHOOK_URL", "http://127.0.0.1:8000/hooks/media"),
        webhook_secret=_env("SEEDOTS_WEBHOOK_SECRET", "change-me"),
        data_dir=data_dir,
        action_selector=_env("SEEDOTS_ACTION_SELECTOR", "llm"),
        web_origins=[o.strip() for o in _env("SEEDOTS_WEB_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",") if o.strip()],
    )
