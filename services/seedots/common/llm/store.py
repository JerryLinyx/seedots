"""DB adapters for the gateway: usage sink and result cache. Each service passes its own
usage_logs / llm_cache models (same columns, different databases)."""
from __future__ import annotations

from dataclasses import asdict

from seedots.common.db import Database
from seedots.common.llm.gateway import UsageRecord


class DbUsageSink:
    def __init__(self, db: Database, model: type):
        self.db, self.model = db, model

    def __call__(self, rec: UsageRecord) -> None:
        with self.db.session() as s:
            s.add(self.model(**asdict(rec)))


class DbCache:
    def __init__(self, db: Database, model: type):
        self.db, self.model = db, model

    def get(self, key: str) -> dict | None:
        with self.db.session() as s:
            row = s.get(self.model, key)
            return dict(row.output) if row else None

    def put(self, key: str, task: str, prompt_version: str, model: str, output: dict) -> None:
        with self.db.session() as s:
            s.merge(self.model(key=key, task=task, prompt_version=prompt_version, model=model, output=output))
