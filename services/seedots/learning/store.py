"""Learning backend persistence: content layer (shared, versioned), log layer (per user,
append-only) and derived layer (projections). Tech plan §3."""
from __future__ import annotations

from typing import Any

from seedots.common.contracts import EvidenceUnit
from seedots.common.db import Database, dumps, loads
from seedots.common.ids import now_ms

SCHEMA = """
-- ---------------- content layer
CREATE TABLE IF NOT EXISTS videos (
  media_id TEXT PRIMARY KEY,
  title TEXT, source_kind TEXT, source_uri TEXT,
  capabilities TEXT, platform_meta TEXT,
  status TEXT NOT NULL, status_detail TEXT,
  chapters TEXT,                       -- outline from media.outline_ready
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY, revision INTEGER NOT NULL, media_id TEXT NOT NULL,
  kind TEXT NOT NULL, t0 REAL NOT NULL, t1 REAL NOT NULL, body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_media ON evidence(media_id, kind, t0);
CREATE TABLE IF NOT EXISTS concepts (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, norm TEXT NOT NULL, aliases TEXT NOT NULL,
  definition TEXT, misconceptions TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS concepts_norm ON concepts(norm);
CREATE TABLE IF NOT EXISTS occurrences (
  id TEXT PRIMARY KEY, concept_id TEXT NOT NULL REFERENCES concepts(id), media_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL, evidence_ids TEXT NOT NULL, role TEXT, t0 REAL, t1 REAL
);
CREATE INDEX IF NOT EXISTS occ_media ON occurrences(media_id);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, media_id TEXT NOT NULL, chapter_id TEXT NOT NULL,
  type TEXT NOT NULL, schema_version INTEGER NOT NULL, version INTEGER NOT NULL,
  concept_ids TEXT NOT NULL, evidence_ids TEXT NOT NULL, level INTEGER NOT NULL,
  purpose_tags TEXT NOT NULL, review_status TEXT NOT NULL,   -- auto_validated | human_reviewed | rejected
  show_at REAL,                                               -- predict items: shown before this time
  payload TEXT NOT NULL, answer_key TEXT NOT NULL, reject_reason TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS items_media ON items(media_id, review_status);
CREATE TABLE IF NOT EXISTS chapter_runs (
  chapter_id TEXT NOT NULL, version TEXT NOT NULL, media_id TEXT NOT NULL,
  status TEXT NOT NULL, error TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY (chapter_id, version)
);
CREATE TABLE IF NOT EXISTS inbox (event_id TEXT PRIMARY KEY, type TEXT, received_at INTEGER NOT NULL);

-- ---------------- log layer (append-only)
CREATE TABLE IF NOT EXISTS events (
  event_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT, media_id TEXT,
  media_time REAL, client_seq INTEGER, occurred_at INTEGER, received_at INTEGER NOT NULL,
  type TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, item_id TEXT NOT NULL, item_version INTEGER NOT NULL,
  response TEXT NOT NULL, correct INTEGER NOT NULL, assisted INTEGER NOT NULL, first_attempt INTEGER NOT NULL,
  counted INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS marks (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, media_id TEXT NOT NULL, t REAL NOT NULL,
  type TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, media_id TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL, media_time REAL, evidence_ids TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, media_id TEXT NOT NULL, media_time REAL,
  signal TEXT NOT NULL, rule_action TEXT NOT NULL, chosen TEXT NOT NULL, selector TEXT NOT NULL,
  item_id TEXT, reason TEXT, latency_ms INTEGER, error TEXT, created_at INTEGER NOT NULL
);

-- ---------------- derived layer
CREATE TABLE IF NOT EXISTS mastery (
  user_id TEXT NOT NULL, concept_id TEXT NOT NULL, level INTEGER NOT NULL, streak INTEGER NOT NULL,
  independent_correct INTEGER NOT NULL, independent_wrong INTEGER NOT NULL, assisted INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, concept_id)
);
CREATE TABLE IF NOT EXISTS settings (user_id TEXT PRIMARY KEY, body TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS usage_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, row TEXT NOT NULL);
"""

JSON_COLS = {"capabilities", "platform_meta", "chapters", "aliases", "misconceptions", "evidence_ids",
             "concept_ids", "purpose_tags", "payload", "answer_key", "response", "signal", "body"}


def _decode(row: dict | None) -> dict | None:
    if row is None:
        return None
    for k in list(row):
        if k in JSON_COLS and isinstance(row[k], str):
            row[k] = loads(row[k])
    return row


class LearningStore:
    def __init__(self, db: Database):
        self.db = db

    # ---------------------------------------------------- generic helpers
    def _insert(self, table: str, row: dict[str, Any], or_ignore: bool = False) -> int:
        row = {k: (dumps(v) if k in JSON_COLS and not isinstance(v, str) else v) for k, v in row.items()}
        verb = "INSERT OR IGNORE" if or_ignore else "INSERT"
        cur = self.db.execute(f"{verb} INTO {table} ({','.join(row)}) VALUES ({','.join('?' * len(row))})",
                              tuple(row.values()))
        return cur.rowcount

    # ---------------------------------------------------- videos
    def upsert_video(self, media: dict) -> None:
        now = now_ms()
        existing = self.db.one("SELECT media_id FROM videos WHERE media_id=?", (media["id"],))
        fields = {"title": media.get("title"), "source_kind": media.get("source_kind"),
                  "source_uri": media.get("source_uri"), "capabilities": dumps(media.get("capabilities") or {}),
                  "platform_meta": dumps(media.get("platform_meta") or {}),
                  "status": media.get("status", "registered"), "status_detail": media.get("status_detail") or ""}
        if existing:
            sets = ",".join(f"{k}=?" for k in fields)
            self.db.execute(f"UPDATE videos SET {sets}, updated_at=? WHERE media_id=?",
                            (*fields.values(), now, media["id"]))
        else:
            self.db.execute(
                f"INSERT INTO videos (media_id, {','.join(fields)}, chapters, created_at, updated_at) "
                f"VALUES (?{',?' * len(fields)}, '[]', ?, ?)", (media["id"], *fields.values(), now, now))

    def set_video_status(self, media_id: str, status: str, detail: str = "") -> None:
        self.db.execute("UPDATE videos SET status=?, status_detail=?, updated_at=? WHERE media_id=?",
                        (status, detail, now_ms(), media_id))

    def set_video_chapters(self, media_id: str, chapters: list[dict]) -> None:
        self.db.execute("UPDATE videos SET chapters=?, updated_at=? WHERE media_id=?",
                        (dumps(chapters), now_ms(), media_id))

    def video(self, media_id: str) -> dict | None:
        return _decode(self.db.one("SELECT * FROM videos WHERE media_id=?", (media_id,)))

    def videos(self) -> list[dict]:
        return [_decode(r) for r in self.db.all("SELECT * FROM videos ORDER BY created_at DESC")]

    # ---------------------------------------------------- inbox
    def inbox_accept(self, event_id: str, type_: str) -> bool:
        return self._insert("inbox", {"event_id": event_id, "type": type_, "received_at": now_ms()},
                            or_ignore=True) == 1

    # ---------------------------------------------------- evidence snapshot
    def save_evidence(self, units: list[EvidenceUnit]) -> None:
        with self.db.tx() as c:
            for u in units:
                c.execute("INSERT INTO evidence (id, revision, media_id, kind, t0, t1, body) VALUES (?,?,?,?,?,?,?) "
                          "ON CONFLICT(id) DO UPDATE SET revision=excluded.revision, t0=excluded.t0, "
                          "t1=excluded.t1, body=excluded.body",
                          (u.id, u.revision, u.media_id, u.kind, u.t0, u.t1, u.model_dump_json()))

    def evidence(self, media_id: str, kind: str | None = None, t0: float | None = None,
                 t1: float | None = None) -> list[EvidenceUnit]:
        sql, p = "SELECT body FROM evidence WHERE media_id=?", [media_id]
        if kind:
            sql += " AND kind=?"
            p.append(kind)
        if t0 is not None:
            sql += " AND t1>?"
            p.append(t0)
        if t1 is not None:
            sql += " AND t0<?"
            p.append(t1)
        sql += " ORDER BY t0, id"
        return [EvidenceUnit.model_validate_json(r["body"]) for r in self.db.all(sql, tuple(p))]

    def evidence_by_ids(self, ids: list[str]) -> dict[str, EvidenceUnit]:
        if not ids:
            return {}
        rows = self.db.all(f"SELECT body FROM evidence WHERE id IN ({','.join('?' * len(ids))})", tuple(ids))
        units = [EvidenceUnit.model_validate_json(r["body"]) for r in rows]
        return {u.id: u for u in units}

    # ---------------------------------------------------- concepts
    def concept_by_norm(self, norms: list[str]) -> dict | None:
        for n in norms:
            row = self.db.one("SELECT * FROM concepts WHERE norm=?", (n,))
            if row:
                return _decode(row)
        for row in self.db.all("SELECT * FROM concepts"):
            row = _decode(row)
            alias_norms = {normalize(a) for a in row["aliases"]}
            if alias_norms & set(norms):
                return row
        return None

    def insert_concept(self, row: dict) -> None:
        self._insert("concepts", {**row, "created_at": now_ms()})

    def update_concept(self, concept_id: str, aliases: list[str], misconceptions: list[dict],
                       definition: str | None) -> None:
        self.db.execute("UPDATE concepts SET aliases=?, misconceptions=?, definition=COALESCE(definition, ?) "
                        "WHERE id=?", (dumps(aliases), dumps(misconceptions), definition, concept_id))

    def concepts(self, ids: list[str]) -> list[dict]:
        if not ids:
            return []
        return [_decode(r) for r in self.db.all(
            f"SELECT * FROM concepts WHERE id IN ({','.join('?' * len(ids))})", tuple(ids))]

    def all_concepts(self) -> list[dict]:
        return [_decode(r) for r in self.db.all("SELECT * FROM concepts ORDER BY name")]

    def insert_occurrence(self, row: dict) -> None:
        self._insert("occurrences", row, or_ignore=True)

    def occurrences(self, media_id: str | None = None) -> list[dict]:
        if media_id:
            return [_decode(r) for r in self.db.all("SELECT * FROM occurrences WHERE media_id=? ORDER BY t0",
                                                    (media_id,))]
        return [_decode(r) for r in self.db.all("SELECT * FROM occurrences ORDER BY media_id, t0")]

    # ---------------------------------------------------- items
    def insert_item(self, row: dict) -> None:
        self._insert("items", {**row, "created_at": now_ms()})

    def items(self, media_id: str, statuses: tuple[str, ...] = ("auto_validated", "human_reviewed")) -> list[dict]:
        return [_decode(r) for r in self.db.all(
            f"SELECT * FROM items WHERE media_id=? AND review_status IN ({','.join('?' * len(statuses))}) "
            f"ORDER BY chapter_id, level", (media_id, *statuses))]

    def item(self, item_id: str) -> dict | None:
        return _decode(self.db.one("SELECT * FROM items WHERE id=?", (item_id,)))

    def set_review(self, item_id: str, status: str) -> None:
        self.db.execute("UPDATE items SET review_status=? WHERE id=?", (status, item_id))

    # ---------------------------------------------------- chapter runs
    def chapter_status(self, chapter_id: str, version: str) -> str | None:
        row = self.db.one("SELECT status FROM chapter_runs WHERE chapter_id=? AND version=?", (chapter_id, version))
        return row["status"] if row else None

    def chapter_mark(self, chapter_id: str, version: str, media_id: str, status: str, error: str = "") -> None:
        self.db.execute("INSERT INTO chapter_runs (chapter_id, version, media_id, status, error, updated_at) "
                        "VALUES (?,?,?,?,?,?) ON CONFLICT(chapter_id, version) DO UPDATE SET status=excluded.status,"
                        " error=excluded.error, updated_at=excluded.updated_at",
                        (chapter_id, version, media_id, status, error[:300], now_ms()))

    def chapter_runs(self, media_id: str) -> list[dict]:
        return self.db.all("SELECT chapter_id, version, status, error FROM chapter_runs WHERE media_id=?", (media_id,))

    # ---------------------------------------------------- logs
    def insert_events(self, user_id: str, events: list[dict]) -> int:
        n = 0
        now = now_ms()
        for e in events:
            n += self._insert("events", {
                "event_id": e["event_id"], "user_id": user_id, "session_id": e.get("session_id"),
                "media_id": e.get("media_id"), "media_time": e.get("media_time"), "client_seq": e.get("client_seq"),
                "occurred_at": e.get("occurred_at"), "received_at": now, "type": e["type"],
                "payload": e.get("payload") or {}}, or_ignore=True)
        return n

    def insert(self, table: str, row: dict) -> None:
        self._insert(table, row)

    def attempts(self, user_id: str, item_ids: list[str] | None = None) -> list[dict]:
        if item_ids is None:
            return [_decode(r) for r in self.db.all("SELECT * FROM attempts WHERE user_id=? ORDER BY created_at",
                                                    (user_id,))]
        if not item_ids:
            return []
        return [_decode(r) for r in self.db.all(
            f"SELECT * FROM attempts WHERE user_id=? AND item_id IN ({','.join('?' * len(item_ids))}) "
            f"ORDER BY created_at", (user_id, *item_ids))]

    def marks(self, user_id: str, media_id: str) -> list[dict]:
        return self.db.all("SELECT * FROM marks WHERE user_id=? AND media_id=? ORDER BY t", (user_id, media_id))

    def messages(self, user_id: str, media_id: str, limit: int = 20) -> list[dict]:
        rows = self.db.all("SELECT * FROM messages WHERE user_id=? AND media_id=? ORDER BY created_at DESC LIMIT ?",
                           (user_id, media_id, limit))
        return [_decode(r) for r in reversed(rows)]

    def recent_decisions(self, user_id: str, media_id: str, limit: int = 10) -> list[dict]:
        return [_decode(r) for r in self.db.all(
            "SELECT * FROM decisions WHERE user_id=? AND media_id=? ORDER BY created_at DESC LIMIT ?",
            (user_id, media_id, limit))]

    # ---------------------------------------------------- derived
    def mastery(self, user_id: str, concept_ids: list[str] | None = None) -> dict[str, dict]:
        rows = self.db.all("SELECT * FROM mastery WHERE user_id=?", (user_id,))
        out = {r["concept_id"]: r for r in rows}
        if concept_ids is not None:
            out = {k: v for k, v in out.items() if k in concept_ids}
        return out

    def put_mastery(self, row: dict) -> None:
        self.db.execute(
            "INSERT INTO mastery (user_id, concept_id, level, streak, independent_correct, independent_wrong, assisted,"
            " updated_at) VALUES (:user_id,:concept_id,:level,:streak,:independent_correct,:independent_wrong,"
            ":assisted,:updated_at) ON CONFLICT(user_id, concept_id) DO UPDATE SET level=excluded.level,"
            " streak=excluded.streak, independent_correct=excluded.independent_correct,"
            " independent_wrong=excluded.independent_wrong, assisted=excluded.assisted, updated_at=excluded.updated_at",
            {**row, "updated_at": now_ms()})

    def settings(self, user_id: str) -> dict:
        row = self.db.one("SELECT body FROM settings WHERE user_id=?", (user_id,))
        return loads(row["body"], {}) if row else {}

    def put_settings(self, user_id: str, body: dict) -> None:
        self.db.execute("INSERT INTO settings (user_id, body) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET "
                        "body=excluded.body", (user_id, dumps(body)))

    def log_usage(self, row: dict) -> None:
        self.db.execute("INSERT INTO usage_logs (at, row) VALUES (?, ?)", (now_ms(), dumps(row)))

    def usage(self, limit: int = 200) -> list[dict]:
        return [{"at": r["at"], **loads(r["row"], {})}
                for r in self.db.all("SELECT * FROM usage_logs ORDER BY id DESC LIMIT ?", (limit,))]


def normalize(name: str) -> str:
    import re

    s = re.sub(r"[^a-z0-9一-鿿]+", " ", name.lower()).strip()
    words = [w[:-1] if len(w) > 3 and w.endswith("s") and not w.endswith("ss") else w for w in s.split()]
    return " ".join(words)
