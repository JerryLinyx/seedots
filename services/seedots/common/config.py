"""Settings read from the environment (and a repo-root .env when python-dotenv is installed).

One Settings object serves both services; each reads only the fields it needs.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

try:  # optional: load <repo>/.env for local dev
    from dotenv import load_dotenv

    load_dotenv(REPO_ROOT / ".env")
except ImportError:  # pragma: no cover
    pass


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _flag(name: str, default: bool = False) -> bool:
    return _env(name, "1" if default else "0").lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class ModelEndpoint:
    """An OpenAI-compatible endpoint. Empty `model` means the capability is not configured."""
    base_url: str = ""
    api_key: str = ""
    model: str = ""

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.model)


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    # model gateway
    llm: ModelEndpoint
    llm_fake: bool
    embeddings: ModelEndpoint            # concept recall; falls back to a local lexical embedder
    asr: ModelEndpoint                   # /audio/transcriptions; required only for sources without captions
    # databases (each service owns one)
    media_db_url: str
    learning_db_url: str
    auto_migrate: bool
    # workflow engine: "inprocess" (default) or "temporal"
    workflow_engine: str
    temporal_address: str
    # service wiring
    media_url: str
    learning_url: str
    media_webhook_url: str
    webhook_secret: str
    grabber_dir: Path
    action_selector: str                 # "llm" | "rule"
    web_origins: list[str] = field(default_factory=list)


def _sqlite_url(data_dir: Path, name: str) -> str:
    return f"sqlite:///{data_dir / name}"


def load_settings() -> Settings:
    data_dir = Path(_env("SEEDOTS_DATA_DIR", "./data"))
    if not data_dir.is_absolute():
        data_dir = REPO_ROOT / data_dir
    data_dir.mkdir(parents=True, exist_ok=True)
    llm_base = _env("SEEDOTS_LLM_BASE_URL", "https://api.tokenrouter.io/v1").rstrip("/")
    llm_key = _env("SEEDOTS_LLM_API_KEY")
    return Settings(
        data_dir=data_dir,
        llm=ModelEndpoint(llm_base, llm_key, _env("SEEDOTS_LLM_MODEL", "deepseek/deepseek-v4-flash-0731")),
        llm_fake=_flag("SEEDOTS_LLM_FAKE"),
        embeddings=ModelEndpoint(_env("SEEDOTS_EMBED_BASE_URL", llm_base).rstrip("/"),
                                 _env("SEEDOTS_EMBED_API_KEY", llm_key), _env("SEEDOTS_EMBED_MODEL")),
        asr=ModelEndpoint(_env("SEEDOTS_ASR_BASE_URL", llm_base).rstrip("/"),
                          _env("SEEDOTS_ASR_API_KEY", llm_key), _env("SEEDOTS_ASR_MODEL")),
        media_db_url=_env("SEEDOTS_MEDIA_DB_URL") or _sqlite_url(data_dir, "media.sqlite3"),
        learning_db_url=_env("SEEDOTS_LEARNING_DB_URL") or _sqlite_url(data_dir, "learning.sqlite3"),
        auto_migrate=_flag("SEEDOTS_AUTO_MIGRATE", True),
        workflow_engine=_env("SEEDOTS_WORKFLOW_ENGINE", "inprocess"),
        temporal_address=_env("SEEDOTS_TEMPORAL_ADDRESS", "127.0.0.1:7233"),
        media_url=_env("SEEDOTS_MEDIA_URL", "http://127.0.0.1:8001").rstrip("/"),
        learning_url=_env("SEEDOTS_LEARNING_URL", "http://127.0.0.1:8000").rstrip("/"),
        media_webhook_url=_env("SEEDOTS_MEDIA_WEBHOOK_URL", "http://127.0.0.1:8000/hooks/media"),
        webhook_secret=_env("SEEDOTS_WEBHOOK_SECRET", "change-me"),
        grabber_dir=Path(_env("SEEDOTS_GRABBER_DIR") or REPO_ROOT / "services" / "grabber"),
        action_selector=_env("SEEDOTS_ACTION_SELECTOR", "llm"),
        web_origins=[o.strip() for o in _env("SEEDOTS_WEB_ORIGINS",
                                              "http://localhost:3000,http://127.0.0.1:3000").split(",")
                     if o.strip()],
    )
