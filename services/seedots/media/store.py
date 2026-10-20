"""Persistence for the video analysis foundation."""
from __future__ import annotations

from typing import Any

from seedots.common.contracts import EvidenceUnit
from seedots.common.db import Database, dumps, loads
from seedots.common.ids import now_ms

SCHEMA = """
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  visibility TEXT NOT NULL,
  owner TEXT,
  language TEXT NOT NULL,
  title TEXT,
  duration REAL,
  capabilities TEXT NOT NULL,
  platform_meta TEXT,
  rights_attestation TEXT,
  status TEXT NOT NULL,          -- registered | analyzing | ready | failed
  status_detail TEXT,
  priority_from REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS media_dedupe ON media(dedupe_key, visibility, IFNULL(owner, ''));

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  media_id TEXT NOT NULL REFERENCES media(id),
  kind TEXT NOT NULL,
  t0 REAL NOT NULL,
  t1 REAL NOT NULL,
  ord INTEGER NOT NULL,
  body TEXT NOT NULL,            -- full EvidenceUnit JSON
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id, revision)
);
CREATE INDEX IF NOT EXISTS evidence_media ON evidence(media_id, kind, t0);

CREATE TABLE IF NOT EXISTS stage_runs (
  media_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL,          -- running | done | failed
  error TEXT,
  started_at INTEGER,
  finished_at INTEGER,
  PRIMARY KEY (media_id, stage, version)
);

CREATE TABLE IF NOT EXISTS outbox (
  event_id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  body TEXT NOT NULL,
  delivered_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(delivered_at, next_attempt_at);

CREATE TABLE IF NOT EXISTS usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  row TEXT NOT NULL
);
"""


class MediaStore:
    def __init__(self, db: Database):
        self.db = db

    # ---- media
    def find_dedupe(self, key: str, visibility: str, owner: str | None) -> dict | None:
        return self._media(self.db.one(
            "SELECT * FROM media WHERE dedupe_key=? AND visibility=? AND IFNULL(owner,'')=IFNULL(?, '')",
            (key, visibility, owner)))

    def insert_media(self, row: dict[str, Any]) -> None:
        now = now_ms()
        row = {**row, "created_at": now, "updated_at": now}
        for k in ("capabilities", "platform_meta"):
            row[k] = dumps(row.get(k))
        cols = ",".join(row)
        self.db.execute(f"INSERT INTO media ({cols}) VALUES ({','.join('?' * len(row))})", tuple(row.values()))

    def update_media(self, media_id: str, **fields: Any) -> None:
        for k in ("capabilities", "platform_meta"):
            if k in fields:
                fields[k] = dumps(fields[k])
        fields["updated_at"] = now_ms()
        sets = ",".join(f"{k}=?" for k in fields)
        self.db.execute(f"UPDATE media SET {sets} WHERE id=?", (*fields.values(), media_id))

    def get_media(self, media_id: str) -> dict | None:
        return self._media(self.db.one("SELECT * FROM media WHERE id=?", (media_id,)))

    def list_media(self) -> list[dict]:
        return [self._media(r) for r in self.db.all("SELECT * FROM media ORDER BY created_at DESC")]

    @staticmethod
    def _media(row: dict | None) -> dict | None:
        if not row:
            return None
        row["capabilities"] = loads(row["capabilities"], {})
        row["platform_meta"] = loads(row["platform_meta"], {})
        return row

    # ---- evidence
    def replace_evidence(self, media_id: str, kind: str, units: list[EvidenceUnit]) -> None:
        with self.db.tx() as c:
            c.execute("DELETE FROM evidence WHERE media_id=? AND kind=?", (media_id, kind))
            now = now_ms()
            for i, u in enumerate(units):
                c.execute("INSERT INTO evidence (id, revision, media_id, kind, t0, t1, ord, body, created_at)"
                          " VALUES (?,?,?,?,?,?,?,?,?)",
                          (u.id, u.revision, media_id, kind, u.t0, u.t1, i, u.model_dump_json(), now))

    def add_revision(self, unit: EvidenceUnit, ord_: int) -> None:
        self.db.execute("INSERT INTO evidence (id, revision, media_id, kind, t0, t1, ord, body, created_at)"
                        " VALUES (?,?,?,?,?,?,?,?,?)",
                        (unit.id, unit.revision, unit.media_id, unit.kind, unit.t0, unit.t1, ord_,
                         unit.model_dump_json(), now_ms()))

    def evidence(self, media_id: str, *, kinds: list[str] | None = None, t0: float | None = None,
                 t1: float | None = None) -> list[EvidenceUnit]:
        sql = ("SELECT e.body FROM evidence e JOIN (SELECT id, MAX(revision) r FROM evidence WHERE media_id=? "
               "GROUP BY id) last ON e.id=last.id AND e.revision=last.r WHERE e.media_id=?")
        params: list[Any] = [media_id, media_id]
        if kinds:
            sql += f" AND e.kind IN ({','.join('?' * len(kinds))})"
            params += kinds
        if t0 is not None:
            sql += " AND e.t1 > ?"
            params.append(t0)
        if t1 is not None:
            sql += " AND e.t0 < ?"
            params.append(t1)
        sql += " ORDER BY e.kind, e.ord"
        return [EvidenceUnit.model_validate_json(r["body"]) for r in self.db.all(sql, tuple(params))]

    def evidence_by_id(self, evidence_id: str) -> tuple[EvidenceUnit, int] | None:
        row = self.db.one("SELECT body, ord FROM evidence WHERE id=? ORDER BY revision DESC LIMIT 1", (evidence_id,))
        return (EvidenceUnit.model_validate_json(row["body"]), row["ord"]) if row else None

    # ---- stages
    def stage_status(self, media_id: str, stage: str, version: str) -> str | None:
        row = self.db.one("SELECT status FROM stage_runs WHERE media_id=? AND stage=? AND version=?",
                          (media_id, stage, version))
        return row["status"] if row else None

    def stage_mark(self, media_id: str, stage: str, version: str, status: str, error: str = "") -> None:
        now = now_ms()
        self.db.execute(
            "INSERT INTO stage_runs (media_id, stage, version, status, error, started_at, finished_at)"
            " VALUES (?,?,?,?,?,?,?) ON CONFLICT(media_id, stage, version) DO UPDATE SET status=excluded.status,"
            " error=excluded.error, finished_at=excluded.finished_at",
            (media_id, stage, version, status, error, now, now if status != "running" else None))

    def stages(self, media_id: str) -> list[dict]:
        return self.db.all("SELECT stage, version, status, error FROM stage_runs WHERE media_id=? ORDER BY started_at",
                           (media_id,))

    # ---- outbox
    def next_seq(self, media_id: str) -> int:
        row = self.db.one("SELECT MAX(seq) m FROM outbox WHERE media_id=?", (media_id,))
        return (row["m"] or 0) + 1

    def enqueue(self, event_id: str, media_id: str, seq: int, type_: str, body: str) -> None:
        self.db.execute("INSERT INTO outbox (event_id, media_id, seq, type, body, next_attempt_at) VALUES (?,?,?,?,?,?)",
                        (event_id, media_id, seq, type_, body, now_ms()))

    def pending_events(self, limit: int = 20) -> list[dict]:
        return self.db.all("SELECT * FROM outbox WHERE delivered_at IS NULL AND next_attempt_at<=? "
                           "ORDER BY media_id, seq LIMIT ?", (now_ms(), limit))

    def mark_delivered(self, event_id: str) -> None:
        self.db.execute("UPDATE outbox SET delivered_at=?, last_error=NULL WHERE event_id=?", (now_ms(), event_id))

    def mark_failed(self, event_id: str, error: str, attempts: int) -> None:
        backoff = min(60_000, 1000 * 2 ** attempts)
        self.db.execute("UPDATE outbox SET attempts=?, last_error=?, next_attempt_at=? WHERE event_id=?",
                        (attempts, error[:300], now_ms() + backoff, event_id))

    def replay(self, event_id: str) -> bool:
        cur = self.db.execute("UPDATE outbox SET delivered_at=NULL, next_attempt_at=? WHERE event_id=?",
                              (now_ms(), event_id))
        return cur.rowcount > 0

    def events(self, media_id: str | None) -> list[dict]:
        if media_id:
            return self.db.all("SELECT event_id, media_id, seq, type, delivered_at, attempts, last_error FROM outbox"
                               " WHERE media_id=? ORDER BY seq", (media_id,))
        return self.db.all("SELECT event_id, media_id, seq, type, delivered_at, attempts, last_error FROM outbox"
                           " ORDER BY rowid DESC LIMIT 200")

    # ---- usage
    def log_usage(self, row: dict) -> None:
        self.db.execute("INSERT INTO usage_logs (at, row) VALUES (?, ?)", (now_ms(), dumps(row)))
