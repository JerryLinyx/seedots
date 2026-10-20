"""Shared Alembic environment; each service's folder imports it (see seedots.common.migrate)."""
from __future__ import annotations

import importlib

from alembic import context
from sqlalchemy import engine_from_config, pool

config = context.config
service = config.attributes.get("service") or config.get_main_option("service")
metadata = importlib.import_module(f"seedots.{service}.models").Base.metadata


def _url() -> str:
    url = config.attributes.get("url") or config.get_main_option("sqlalchemy.url")
    if url:
        return url
    from seedots.common.config import load_settings

    s = load_settings()
    return s.media_db_url if service == "media" else s.learning_db_url


def run() -> None:
    url = _url()
    opts = dict(target_metadata=metadata, compare_type=True, render_as_batch=url.startswith("sqlite"))
    if context.is_offline_mode():
        context.configure(url=url, literal_binds=True, **opts)
        with context.begin_transaction():
            context.run_migrations()
        return
    engine = engine_from_config({"sqlalchemy.url": url}, prefix="sqlalchemy.", poolclass=pool.NullPool)
    with engine.connect() as conn:
        context.configure(connection=conn, **opts)
        with context.begin_transaction():
            context.run_migrations()


run()
