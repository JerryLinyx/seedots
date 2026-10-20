"""Database kernel shared by both services.

PostgreSQL is the target (JSONB, partial indexes, timestamptz). SQLite is supported for
local development and tests through type variants, so the same models and Alembic
migrations run on both. Each service owns its own database and metadata.
"""
from __future__ import annotations

import enum
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any

import sqlalchemy as sa
from sqlalchemy import JSON, MetaData, event
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker

# Stable constraint names so Alembic diffs and migrations are deterministic.
NAMING = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}

JSONType = JSON().with_variant(JSONB(), "postgresql")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def make_base() -> type[DeclarativeBase]:
    """A fresh declarative base (one per service, so their metadata never mix)."""

    class Base(DeclarativeBase):
        metadata = MetaData(naming_convention=NAMING)
        type_annotation_map = {dict[str, Any]: JSONType, list[Any]: JSONType}

    return Base


def enum_type(enum_cls: type[enum.Enum], name: str) -> sa.Enum:
    """Portable enum: VARCHAR + CHECK constraint (no native PG enum, so adding a value is a
    plain migration, not an ALTER TYPE)."""
    return sa.Enum(enum_cls, name=name, native_enum=False, create_constraint=True, length=32,
                   values_callable=lambda e: [m.value for m in e], validate_strings=True)


def ts_column(**kw: Any) -> Mapped[datetime]:
    return mapped_column(sa.DateTime(timezone=True), default=utcnow, **kw)


class Timestamps:
    created_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True), default=utcnow, onupdate=utcnow,
                                                 nullable=False)


class UsageLogColumns:
    """Model-call log (tech plan §8): one row per gateway call. Mixed into each service."""

    id: Mapped[int] = mapped_column(sa.BigInteger().with_variant(sa.Integer, "sqlite"), primary_key=True,
                                    autoincrement=True)
    at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    task: Mapped[str] = mapped_column(sa.String(64), nullable=False, index=True)
    model: Mapped[str] = mapped_column(sa.String(128), nullable=False)
    prompt_version: Mapped[str] = mapped_column(sa.String(32), nullable=False)
    ok: Mapped[bool] = mapped_column(nullable=False)
    error: Mapped[str | None] = mapped_column(sa.Text)
    latency_ms: Mapped[int] = mapped_column(nullable=False)
    first_token_ms: Mapped[int | None]
    input_tokens: Mapped[int] = mapped_column(default=0, nullable=False)
    output_tokens: Mapped[int] = mapped_column(default=0, nullable=False)
    requests: Mapped[int] = mapped_column(default=1, nullable=False)
    context_manifest: Mapped[dict[str, Any]] = mapped_column(default=dict, nullable=False)


class LlmCacheColumns:
    """Gateway result cache: key = hash(task, prompt version, model, rendered prompt)."""

    key: Mapped[str] = mapped_column(sa.String(64), primary_key=True)
    task: Mapped[str] = mapped_column(sa.String(64), nullable=False)
    prompt_version: Mapped[str] = mapped_column(sa.String(32), nullable=False)
    model: Mapped[str] = mapped_column(sa.String(128), nullable=False)
    output: Mapped[dict[str, Any]] = mapped_column(nullable=False)
    created_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True), default=utcnow, nullable=False)


@event.listens_for(Engine, "connect")
def _sqlite_pragmas(dbapi_conn, _record) -> None:  # pragma: no cover - driver hook
    if dbapi_conn.__class__.__module__.startswith("sqlite3"):
        cur = dbapi_conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA busy_timeout=10000")
        cur.close()


class Database:
    """Engine + session factory. `session()` is the unit of work: commit on success,
    rollback on error."""

    def __init__(self, url: str, metadata: MetaData, *, echo: bool = False):
        kw: dict[str, Any] = {"echo": echo, "future": True}
        if url.startswith("sqlite"):
            kw["connect_args"] = {"check_same_thread": False}
        else:
            kw.update(pool_pre_ping=True, pool_size=5, max_overflow=10)
        self.url = url
        self.metadata = metadata
        self.engine = sa.create_engine(url, **kw)
        self._factory = sessionmaker(self.engine, expire_on_commit=False)

    @contextmanager
    def session(self) -> Iterator[Session]:
        s = self._factory()
        try:
            yield s
            s.commit()
        except BaseException:
            s.rollback()
            raise
        finally:
            s.close()

    def create_all(self) -> None:
        """Dev/test only. Production schema comes from Alembic migrations."""
        self.metadata.create_all(self.engine)
