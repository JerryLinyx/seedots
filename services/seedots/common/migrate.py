"""Alembic, per service. Each service owns its database and its migration history:

    services/migrations/media/versions/*.py
    services/migrations/learning/versions/*.py

CLI (from services/):   alembic -n media upgrade head  |  alembic -n learning revision --autogenerate -m "..."
At startup the services call upgrade() when SEEDOTS_AUTO_MIGRATE=1 (the default in dev).
"""
from __future__ import annotations

from pathlib import Path

from alembic import command
from alembic.config import Config

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations"


def alembic_config(service: str, url: str) -> Config:
    cfg = Config()
    cfg.set_main_option("script_location", str(MIGRATIONS / service))
    cfg.attributes["service"] = service
    cfg.attributes["url"] = url            # attributes: avoids configparser '%' interpolation
    return cfg


def upgrade(service: str, url: str, revision: str = "head") -> None:
    command.upgrade(alembic_config(service, url), revision)
