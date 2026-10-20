"""Learning backend — database schema (its own database). Three layers (tech plan §3):

CONTENT (shared across users, versioned, never edited in place)
  videos ── chapters ── content_runs                    mirror of the foundation + generation runs
  evidence_snapshots (id, revision)                     the evidence our content cites
  concepts ─┬ concept_aliases / misconceptions / concept_embeddings
            ├ occurrences ── occurrence_evidence        where a concept appears in a video
            ├ concept_candidates                        low-confidence normalisation, pending review
            └ concept_merge_log                         audit trail; every merge can be rolled back
  learning_items (immutable versions) ─┬ item_concepts / item_evidence
                                       └ item_reviews   append-only review log (status projected on item)
  scene_specs                                           L1 / L2 interactive scenes (follow video sharing)

LOG (per user, append-only)
  learning_events, attempts, decisions, marks, coach_threads ── coach_messages ── message_citations

DERIVED (rebuildable from LOG + CONTENT)
  mastery, concept_links (suggested), knowledge_cards (drafted, user-confirmed)

USERS
  users, user_settings, library_entries, collections ── collection_items

Rules: every time-bearing reference goes through evidence (id + revision); model output never
carries seconds. Enums are VARCHAR + CHECK so adding a value is an ordinary migration.
"""
from __future__ import annotations

import enum
from datetime import datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy.orm import Mapped, mapped_column, relationship

from seedots.common.db import (LlmCacheColumns, Timestamps, UsageLogColumns, enum_type, make_base, utcnow)

Base = make_base()

TS = sa.DateTime(timezone=True)
BIGID = sa.BigInteger().with_variant(sa.Integer, "sqlite")


def _now() -> Mapped[datetime]:
    return mapped_column(TS, default=utcnow, nullable=False)


def _fk(target: str, *, ondelete: str = "CASCADE", nullable: bool = False, index: bool = False, **kw: Any):
    return mapped_column(sa.ForeignKey(target, ondelete=ondelete), nullable=nullable, index=index, **kw)


def _where(clause: str) -> dict[str, Any]:
    """Partial-index predicate for both dialects."""
    return {"postgresql_where": sa.text(clause), "sqlite_where": sa.text(clause)}


# =============================================================================== enums
class VideoStatus(enum.StrEnum):
    REGISTERED = "registered"
    ANALYZING = "analyzing"
    READY = "ready"
    FAILED = "failed"


class RunStatus(enum.StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class ConceptStatus(enum.StrEnum):
    ACTIVE = "active"
    MERGED = "merged"        # merged_into_id points at the survivor


class OccurrenceRole(enum.StrEnum):
    DEFINED = "defined"
    EXAMPLE = "example"
    APPLIED = "applied"
    MENTIONED = "mentioned"


class CandidateStatus(enum.StrEnum):
    PENDING = "pending"
    MERGED = "merged"
    KEPT_SEPARATE = "kept_separate"


class MergeAction(enum.StrEnum):
    CREATE = "create"
    ATTACH = "attach"        # a new mention resolved to an existing concept
    MERGE = "merge"
    ROLLBACK = "rollback"


class ItemType(enum.StrEnum):
    SINGLE_CHOICE = "single_choice"
    MULTI_CHOICE = "multi_choice"
    FIND_ERROR = "find_error"
    PREDICT = "predict"
    ORDERING = "ordering"
    MATCHING = "matching"
    PARAM_EXPERIMENT = "param_experiment"


class ReviewStatus(enum.StrEnum):
    AUTO_VALIDATED = "auto_validated"     # usable; not counted toward mastery
    HUMAN_REVIEWED = "human_reviewed"     # usable; counted toward mastery
    REJECTED = "rejected"
    RETIRED = "retired"


class EvidenceRole(enum.StrEnum):
    SUPPORT = "support"
    REVEAL = "reveal"                     # predict items: the sentence that gives the answer away


class SceneLevel(enum.StrEnum):
    L1 = "l1"                             # SceneSpec -> prebuilt component
    L2 = "l2"                             # generated code in a sandbox, behind gates


class SceneStatus(enum.StrEnum):
    GENERATING = "generating"
    READY = "ready"
    FAILED = "failed"


class Purpose(enum.StrEnum):
    INTEREST = "interest"
    EXAM = "exam"
    WORK = "work"
    RESEARCH = "research"


class Action(enum.StrEnum):
    NONE = "none"
    CHECK_IN = "check_in"
    QUIZ = "quiz"
    PREDICT = "predict"
    REWATCH = "rewatch"
    EXPLAIN = "explain"
    LINK = "link"                         # "you met this concept in another video"


class SignalKind(enum.StrEnum):
    REWIND_REPEAT = "rewind_repeat"
    LONG_PAUSE = "long_pause"
    CHAPTER_END = "chapter_end"
    SKIP_AHEAD = "skip_ahead"
    CONFUSED_MARK = "confused_mark"
    PREDICT_WINDOW = "predict_window"
    CONCEPT_SEEN_BEFORE = "concept_seen_before"
    MANUAL = "manual"


class DecisionOutcome(enum.StrEnum):
    SHOWN = "shown"
    ANSWERED = "answered"
    DISMISSED = "dismissed"
    SUPPRESSED = "suppressed"             # front end decided not to show after all


class MarkType(enum.StrEnum):
    USEFUL = "useful"
    RESONATE = "resonate"
    CONFUSED = "confused"


class ChatRole(enum.StrEnum):
    USER = "user"
    ASSISTANT = "assistant"


class CitationKind(enum.StrEnum):
    EVIDENCE = "evidence"
    CONCEPT = "concept"
    EXTERNAL = "external"                 # knowledge not from the video, flagged as such


class LinkRelation(enum.StrEnum):
    SAME_CONCEPT = "same_concept"
    PREREQUISITE = "prerequisite"
    CONTRAST = "contrast"


class LinkStatus(enum.StrEnum):
    SUGGESTED = "suggested"
    CONFIRMED = "confirmed"
    DISMISSED = "dismissed"


class CardStatus(enum.StrEnum):
    DRAFT = "draft"
    CONFIRMED = "confirmed"
    ARCHIVED = "archived"


class Visibility(enum.StrEnum):
    PUBLIC = "public"
    PRIVATE = "private"


# =============================================================================== users
class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(sa.String(64), primary_key=True)
    auth_subject: Mapped[str | None] = mapped_column(sa.String(200), unique=True)   # hosted auth "sub"
    display_name: Mapped[str] = mapped_column(sa.String(120), default="", nullable=False)
    created_at: Mapped[datetime] = _now()


class UserSettings(Base):
    __tablename__ = "user_settings"

    user_id: Mapped[str] = mapped_column(sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    focus_mode: Mapped[bool] = mapped_column(default=False, nullable=False)
    max_cards_per_5min: Mapped[int] = mapped_column(default=1, nullable=False)
    purpose: Mapped[Purpose] = mapped_column(enum_type(Purpose, "purpose"), default=Purpose.INTEREST, nullable=False)
    language: Mapped[str] = mapped_column(sa.String(16), default="en", nullable=False)
    extra: Mapped[dict[str, Any]] = mapped_column(default=dict, nullable=False)   # forward-compatible prefs
    updated_at: Mapped[datetime] = mapped_column(TS, default=utcnow, onupdate=utcnow, nullable=False)

    __table_args__ = (sa.CheckConstraint("max_cards_per_5min BETWEEN 0 AND 10", name="cards_rate"),)


# =============================================================================== content: videos
class Video(Timestamps, Base):
    """Mirror of a foundation media item, plus what the learning side needs to serve it."""

    __tablename__ = "videos"

    media_id: Mapped[str] = mapped_column(sa.String(40), primary_key=True)
    source_kind: Mapped[str] = mapped_column(sa.String(16), nullable=False)
    visibility: Mapped[Visibility] = mapped_column(enum_type(Visibility, "visibility"), nullable=False)
    owner_id: Mapped[str | None] = _fk("users.id", nullable=True, index=True)   # private copies go with the user
    title: Mapped[str] = mapped_column(sa.Text, default="", nullable=False)
    language: Mapped[str] = mapped_column(sa.String(16), default="en", nullable=False)
    duration_s: Mapped[float | None]
    capabilities: Mapped[dict[str, Any]] = mapped_column(nullable=False)
    playback: Mapped[dict[str, Any]] = mapped_column(nullable=False)       # {"kind":"youtube_embed","video_id"} | file
    status: Mapped[VideoStatus] = mapped_column(enum_type(VideoStatus, "video_status"), nullable=False,
                                                default=VideoStatus.REGISTERED)
    status_detail: Mapped[str] = mapped_column(sa.Text, default="", nullable=False)
    last_event_seq: Mapped[int] = mapped_column(default=0, nullable=False)  # highest foundation seq applied

    __table_args__ = (sa.CheckConstraint("visibility = 'public' OR owner_id IS NOT NULL", name="private_needs_owner"),)


class LibraryEntry(Base):
    """A user's shelf: which videos they added, where they stopped."""

    __tablename__ = "library_entries"

    user_id: Mapped[str] = mapped_column(sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    media_id: Mapped[str] = mapped_column(sa.ForeignKey("videos.media_id", ondelete="CASCADE"), primary_key=True)
    added_at: Mapped[datetime] = _now()
    last_position_s: Mapped[float] = mapped_column(default=0.0, nullable=False)
    last_opened_at: Mapped[datetime | None] = mapped_column(TS)


class Collection(Timestamps, Base):
    __tablename__ = "collections"

    id: Mapped[str] = mapped_column(sa.String(40), primary_key=True)
    user_id: Mapped[str] = _fk("users.id", index=True)
    title: Mapped[str] = mapped_column(sa.String(200), nullable=False)
    description: Mapped[str] = mapped_column(sa.Text, default="", nullable=False)


class CollectionItem(Base):
    __tablename__ = "collection_items"

    collection_id: Mapped[str] = mapped_column(sa.ForeignKey("collections.id", ondelete="CASCADE"), primary_key=True)
    media_id: Mapped[str] = mapped_column(sa.ForeignKey("videos.media_id", ondelete="CASCADE"), primary_key=True)
    ord: Mapped[int] = mapped_column(nullable=False)


class Chapter(Base):
    __tablename__ = "chapters"

    id: Mapped[str] = mapped_column(sa.String(64), primary_key=True)          # = chapter evidence id
    media_id: Mapped[str] = _fk("videos.media_id")
    evidence_revision: Mapped[int] = mapped_column(default=1, nullable=False)
    ord: Mapped[int] = mapped_column(nullable=False)
    t0: Mapped[float] = mapped_column(nullable=False)
    t1: Mapped[float] = mapped_column(nullable=False)
    title: Mapped[str] = mapped_column(sa.Text, nullable=False)
    summary: Mapped[str] = mapped_column(sa.Text, default="", nullable=False)
    ready: Mapped[bool] = mapped_column(default=False, nullable=False)        # foundation sent chapter_ready
    retired_at: Mapped[datetime | None] = mapped_column(TS)                   # dropped by a re-outline

    __table_args__ = (sa.Index("uq_chapter_live_ord", "media_id", "ord", unique=True, **_where("retired_at IS NULL")),
                      sa.CheckConstraint("t1 >= t0", name="time_range"))


class ContentRun(Base):
    """One generation run for one chapter at one pipeline version (idempotency key)."""

    __tablename__ = "content_runs"

    id: Mapped[int] = mapped_column(BIGID, primary_key=True, autoincrement=True)
    chapter_id: Mapped[str] = _fk("chapters.id")
    pipeline_version: Mapped[str] = mapped_column(sa.String(32), nullable=False)
    status: Mapped[RunStatus] = mapped_column(enum_type(RunStatus, "run_status"), nullable=False,
                                              default=RunStatus.PENDING)
    step: Mapped[str] = mapped_column(sa.String(32), default="", nullable=False)
    attempts: Mapped[int] = mapped_column(default=0, nullable=False)
    stats: Mapped[dict[str, Any]] = mapped_column(default=dict, nullable=False)
    error: Mapped[str | None] = mapped_column(sa.Text)
    created_at: Mapped[datetime] = _now()
    finished_at: Mapped[datetime | None] = mapped_column(TS)

    __table_args__ = (sa.UniqueConstraint("chapter_id", "pipeline_version"),)


class EvidenceSnapshot(Base):
    """Local copy of foundation evidence revisions that content cites. Read-only here."""

    __tablename__ = "evidence_snapshots"

    id: Mapped[str] = mapped_column(sa.String(64), primary_key=True)
    revision: Mapped[int] = mapped_column(primary_key=True)
    media_id: Mapped[str] = _fk("videos.media_id")
    kind: Mapped[str] = mapped_column(sa.String(16), nullable=False)
    ord: Mapped[int] = mapped_column(nullable=False)
    t0: Mapped[float] = mapped_column(nullable=False)
    t1: Mapped[float] = mapped_column(nullable=False)
    content: Mapped[dict[str, Any]] = mapped_column(nullable=False)
    source: Mapped[str] = mapped_column(sa.String(32), nullable=False)
    confidence: Mapped[float] = mapped_column(default=1.0, nullable=False)
    needs_review: Mapped[bool] = mapped_column(default=False, nullable=False)
    is_current: Mapped[bool] = mapped_column(default=True, nullable=False)

    __table_args__ = (sa.Index("ix_evsnap_current", "media_id", "kind", "t0", **_where("is_current")),)


# =============================================================================== content: concepts
class Concept(Timestamps, Base):
    """Global canonical concept library, shared by all videos and users."""

    __tablename__ = "concepts"

    id: Mapped[str] = mapped_column(sa.String(40), primary_key=True)
    name: Mapped[str] = mapped_column(sa.String(200), nullable=False)
    norm_name: Mapped[str] = mapped_column(sa.String(200), nullable=False)
    definition: Mapped[str] = mapped_column(sa.Text, default="", nullable=False)
    status: Mapped[ConceptStatus] = mapped_column(enum_type(ConceptStatus, "concept_status"), nullable=False,
                                                  default=ConceptStatus.ACTIVE)
    merged_into_id: Mapped[str | None] = _fk("concepts.id", ondelete="RESTRICT", nullable=True)

    aliases: Mapped[list[ConceptAlias]] = relationship(cascade="all, delete-orphan")
    misconceptions: Mapped[list[Misconception]] = relationship(cascade="all, delete-orphan")

    __table_args__ = (
        sa.Index("uq_concept_active_norm", "norm_name", unique=True, **_where("status = 'active'")),
        sa.CheckConstraint("(status = 'merged') = (merged_into_id IS NOT NULL)", name="merge_target"),
    )


class ConceptAlias(Base):
    __tablename__ = "concept_aliases"

    concept_id: Mapped[str] = mapped_column(sa.ForeignKey("concepts.id", ondelete="CASCADE"), primary_key=True)
    norm: Mapped[str] = mapped_column(sa.String(200), primary_key=True)
    alias: Mapped[str] = mapped_column(sa.String(200), nullable=False)

    __table_args__ = (sa.Index("ix_alias_norm", "norm"),)


class Misconception(Base):
    __tablename__ = "misconceptions"

    id: Mapped[int] = mapped_column(BIGID, primary_key=True, autoincrement=True)
    concept_id: Mapped[str] = _fk("concepts.id")
    slug: Mapped[str] = mapped_column(sa.String(80), nullable=False)
    text: Mapped[str] = mapped_column(sa.Text, nullable=False)

    __table_args__ = (sa.UniqueConstraint("concept_id", "slug"),)


class ConceptEmbedding(Base):
    """Vector for recall. JSON for portability; swap to pgvector's `vector` column (same
    shape) when running on PostgreSQL with the extension (tech plan §4)."""

    __tablename__ = "concept_embeddings"

    concept_id: Mapped[str] = mapped_column(sa.ForeignKey("concepts.id", ondelete="CASCADE"), primary_key=True)
    model: Mapped[str] = mapped_column(sa.String(128), primary_key=True)
    vector: Mapped[list[Any]] = mapped_column(nullable=False)
    text: Mapped[str] = mapped_column(sa.Text, nullable=False)        # what was embedded
    updated_at: Mapped[datetime] = mapped_column(TS, default=utcnow, onupdate=utcnow, nullable=False)


class Occurrence(Base):
    __tablename__ = "occurrences"

    id: Mapped[int] = mapped_column(BIGID, primary_key=True, autoincrement=True)
    concept_id: Mapped[str] = _fk("concepts.id", index=True)
    media_id: Mapped[str] = _fk("videos.media_id", index=True)
    chapter_id: Mapped[str] = _fk("chapters.id")
    role: Mapped[OccurrenceRole] = mapped_column(enum_type(OccurrenceRole, "occurrence_role"), nullable=False)
    t0: Mapped[float] = mapped_column(nullable=False)                 # derived from cited evidence
    t1: Mapped[float] = mapped_column(nullable=False)
    confidence: Mapped[float] = mapped_column(default=1.0, nullable=False)
    content_run_id: Mapped[int | None] = _fk("content_runs.id", ondelete="SET NULL", nullable=True)

    evidence: Mapped[list[OccurrenceEvidence]] = relationship(cascade="all, delete-orphan")
    __table_args__ = (sa.UniqueConstraint("concept_id", "chapter_id"),)


class OccurrenceEvidence(Base):
    __tablename__ = "occurrence_evidence"

    occurrence_id: Mapped[int] = mapped_column(sa.ForeignKey("occurrences.id", ondelete="CASCADE"), primary_key=True)
    evidence_id: Mapped[str] = mapped_column(sa.String(64), primary_key=True)
    evidence_revision: Mapped[int] = mapped_column(nullable=False)


class ConceptCandidate(Base):
    """A normalisation the judge was unsure about: the mention was given its own concept and
    this row proposes merging it into `suggested_concept_id`. Resolved by a person."""

    __tablename__ = "concept_candidates"

    id: Mapped[int] = mapped_column(BIGID, primary_key=True, autoincrement=True)
    concept_id: Mapped[str] = _fk("concepts.id")
    suggested_concept_id: Mapped[str] = _fk("concepts.id")
    score: Mapped[float] = mapped_column(nullable=False)               # recall similarity
    judge: Mapped[dict[str, Any]] = mapped_column(default=dict, nullable=False)   # {same, confidence, reason}
    status: Mapped[CandidateStatus] = mapped_column(enum_type(CandidateStatus, "candidate_status"),
                                                    nullable=False, default=CandidateStatus.PENDING)
    created_at: Mapped[datetime] = _now()
    resolved_at: Mapped[datetime | None] = mapped_column(TS)
    resolved_by: Mapped[str | None] = mapped_column(sa.String(64))

    __table_args__ = (sa.UniqueConstraint("concept_id", "suggested_concept_id"),
                      sa.Index("ix_candidate_pending", "status", **_where("status = 'pending'")))


class ConceptMergeLog(Base):
    """Append-only. `detail` records exactly which rows moved so a merge can be undone."""

    __tablename__ = "concept_merge_log"

    id: Mapped[int] = mapped_column(BIGID, primary_key=True, autoincrement=True)
    action: Mapped[MergeAction] = mapped_column(enum_type(MergeAction, "merge_action"), nullable=False)
    concept_id: Mapped[str] = _fk("concepts.id", index=True)
    other_concept_id: Mapped[str | None] = _fk("concepts.id", nullable=True)
    actor: Mapped[str] = mapped_column(sa.String(64), nullable=False)    # system | judge | user id
    detail: Mapped[dict[str, Any]] = mapped_column(default=dict, nullable=False)
    reverts_id: Mapped[int | None] = _fk("concept_merge_log.id", ondelete="SET NULL", nullable=True)
    at: Mapped[datetime] = _now()


# =============================================================================== content: items
class LearningItem(Base):
    """One immutable version of a learning item. Edits create version N+1 with the same
    item_key and stamp superseded_at on N. Attempts point at the exact version answered."""

    __tablename__ = "learning_items"

    id: Mapped[str] = mapped_column(sa.String(40), primary_key=True)
    item_key: Mapped[str] = mapped_column(sa.String(40), nullable=False)
    version: Mapped[int] = mapped_column(nullable=False)
    media_id: Mapped[str] = _fk("videos.media_id")
    chapter_id: Mapped[str] = _fk("chapters.id")
    type: Mapped[ItemType] = mapped_column(enum_type(ItemType, "item_type"), nullable=False)
    schema_version: Mapped[int] = mapped_column(default=1, nullable=False)
    level: Mapped[int] = mapped_column(nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(nullable=False)        # sent to the browser
    answer_key: Mapped[dict[str, Any]] = mapped_column(nullable=False)     # never leaves the server
    misconception_id: Mapped[int | None] = _fk("misconceptions.id", ondelete="SET NULL", nullable=True)
    show_before_s: Mapped[float | None]                                    # predict: derived from reveal evidence
    review_status: Mapped[ReviewStatus] = mapped_column(enum_type(ReviewStatus, "review_status"), nullable=False)
    content_run_id: Mapped[int | None] = _fk("content_runs.id", ondelete="SET NULL", nullable=True)
    generator: Mapped[str] = mapped_column(sa.String(64), nullable=False)  # prompt tag / "human"
    created_at: Mapped[datetime] = _now()
    superseded_at: Mapped[datetime | None] = mapped_column(TS)

    concepts: Mapped[list[ItemConcept]] = relationship(cascade="all, delete-orphan")
    evidence: Mapped[list[ItemEvidence]] = relationship(cascade="all, delete-orphan", order_by="ItemEvidence.ord")

    __table_args__ = (
        sa.UniqueConstraint("item_key", "version"),
        sa.Index("uq_item_current", "item_key", unique=True, **_where("superseded_at IS NULL")),
        sa.Index("ix_item_pool", "media_id", "chapter_id", "review_status", **_where("superseded_at IS NULL")),
        sa.CheckConstraint("level BETWEEN 1 AND 3", name="level_range"),
        sa.CheckConstraint("version >= 1", name="version_positive"),
    )


class ItemConcept(Base):
    __tablename__ = "item_concepts"

    item_id: Mapped[str] = mapped_column(sa.ForeignKey("learning_items.id", ondelete="CASCADE"), primary_key=True)
    concept_id: Mapped[str] = mapped_column(sa.ForeignKey("concepts.id", ondelete="CASCADE"), primary_key=True,
                                            index=True)


class ItemEvidence(Base):
    __tablename__ = "item_evidence"

    item_id: Mapped[str] = mapped_column(sa.ForeignKey("learning_items.id", ondelete="CASCADE"), primary_key=True)
    evidence_id: Mapped[str] = mapped_column(sa.String(64), primary_key=True)
    evidence_revision: Mapped[int] = mapped_column(nullable=False)
    role: Mapped[EvidenceRole] = mapped_column(enum_type(EvidenceRole, "evidence_role"), nullable=False,
                                               default=EvidenceRole.SUPPORT)
    ord: Mapped[int] = mapped_column(nullable=False)


class ItemReview(Base):
    __tablename__ = "item_reviews"

    id: Mapped[int] = mapped_column(BIGID, primary_key=True, autoincrement=True)
    item_id: Mapped[str] = _fk("learning_items.id", index=True)
    reviewer: Mapped[str] = mapped_column(sa.String(64), nullable=False)    # validator@v | user id
    status: Mapped[ReviewStatus] = mapped_column(enum_type(ReviewStatus, "review_status"), nullable=False)
    note: Mapped[str] = mapped_column(sa.Text, default="", nullable=False)
    at: Mapped[datetime] = _now()


class ItemRejection(Base):
    """Drafts that failed automatic validation. Kept for evaluation, never served."""

    __tablename__ = "item_rejections"

    id: Mapped[int] = mapped_column(BIGID, primary_key=True, autoincrement=True)
    content_run_id: Mapped[int] = _fk("content_runs.id", index=True)
    draft: Mapped[dict[str, Any]] = mapped_column(nullable=False)
    reason: Mapped[str] = mapped_column(sa.Text, nullable=False)
    at: Mapped[datetime] = _now()


class SceneSpec(Base):
    __tablename__ = "scene_specs"

    id: Mapped[str] = mapped_column(sa.String(40), primary_key=True)
    media_id: Mapped[str] = _fk("videos.media_id", index=True)
    chapter_id: Mapped[str] = _fk("chapters.id")
    concept_id: Mapped[str | None] = _fk("concepts.id", ondelete="SET NULL", nullable=True)
    level: Mapped[SceneLevel] = mapped_column(enum_type(SceneLevel, "scene_level"), nullable=False)
    component: Mapped[str] = mapped_column(sa.String(64), nullable=False)    # L1 component | L2 engine
    spec: Mapped[dict[str, Any]] = mapped_column(nullable=False)             # L1 config | L2 bundle ref
    status: Mapped[SceneStatus] = mapped_column(enum_type(SceneStatus, "scene_status"), nullable=False)
    gates: Mapped[dict[str, Any]] = mapped_column(default=dict, nullable=False)  # invariants/protocol/vlm results
    requested_by: Mapped[str | None] = _fk("users.id", ondelete="SET NULL", nullable=True)
    created_at: Mapped[datetime] = _now()


# =============================================================================== inbox
class InboxEvent(Base):
    """Foundation webhooks, deduplicated by event_id (consumers are idempotent)."""

    __tablename__ = "inbox_events"

    event_id: Mapped[str] = mapped_column(sa.String(40), primary_key=True)
    media_id: Mapped[str] = mapped_column(sa.String(40), nullable=False, index=True)
    seq: Mapped[int] = mapped_column(nullable=False)
    type: Mapped[str] = mapped_column(sa.String(48), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(nullable=False)
    received_at: Mapped[datetime] = _now()
    processed_at: Mapped[datetime | None] = mapped_column(TS)
    error: Mapped[str | None] = mapped_column(sa.Text)


# =============================================================================== log layer
class LearningEvent(Base):
    __tablename__ = "learning_events"

    event_id: Mapped[str] = mapped_column(sa.String(64), primary_key=True)    # client generated (idempotent)
    user_id: Mapped[str] = _fk("users.id")
    session_id: Mapped[str | None] = mapped_column(sa.String(64))
    media_id: Mapped[str | None] = _fk("videos.media_id", nullable=True)
    type: Mapped[str] = mapped_column(sa.String(48), nullable=False)
    media_time: Mapped[float | None]
    client_seq: Mapped[int | None]
    payload: Mapped[dict[str, Any]] = mapped_column(default=dict, nullable=False)
    occurred_at: Mapped[datetime | None] = mapped_column(TS)
    received_at: Mapped[datetime] = _now()

    __table_args__ = (sa.Index("ix_events_user_media", "user_id", "media_id", "received_at"),)


class Decision(Base):
    __tablename__ = "decisions"

    id: Mapped[str] = mapped_column(sa.String(40), primary_key=True)
    user_id: Mapped[str] = _fk("users.id")
    media_id: Mapped[str] = _fk("videos.media_id")
    media_time: Mapped[float] = mapped_column(nullable=False)
    signal_kind: Mapped[SignalKind] = mapped_column(enum_type(SignalKind, "signal_kind"), nullable=False)
    signal: Mapped[dict[str, Any]] = mapped_column(nullable=False)
    rule_action: Mapped[Action] = mapped_column(enum_type(Action, "rule_action"), nullable=False)
    rule_item_id: Mapped[str | None] = _fk("learning_items.id", ondelete="SET NULL", nullable=True)
    action: Mapped[Action] = mapped_column(enum_type(Action, "action"), nullable=False)
    item_id: Mapped[str | None] = _fk("learning_items.id", ondelete="SET NULL", nullable=True)
    selector: Mapped[str] = mapped_column(sa.String(64), nullable=False)
    reason: Mapped[str] = mapped_column(sa.Text, default="", nullable=False)
    fallback: Mapped[bool] = mapped_column(default=False, nullable=False)
    error: Mapped[str | None] = mapped_column(sa.Text)
    latency_ms: Mapped[int] = mapped_column(default=0, nullable=False)
    outcome: Mapped[DecisionOutcome | None] = mapped_column(enum_type(DecisionOutcome, "decision_outcome"))
    created_at: Mapped[datetime] = _now()

    __table_args__ = (sa.Index("ix_decisions_user_media", "user_id", "media_id", "created_at"),)


class Attempt(Base):
    __tablename__ = "attempts"

    id: Mapped[str] = mapped_column(sa.String(40), primary_key=True)
    user_id: Mapped[str] = _fk("users.id")
    item_id: Mapped[str] = _fk("learning_items.id")                 # the exact version answered
    item_key: Mapped[str] = mapped_column(sa.String(40), nullable=False)
    decision_id: Mapped[str | None] = _fk("decisions.id", ondelete="SET NULL", nullable=True)
    response: Mapped[dict[str, Any]] = mapped_column(nullable=False)
    correct: Mapped[bool] = mapped_column(nullable=False)
    assisted: Mapped[bool] = mapped_column(default=False, nullable=False)
    first_attempt: Mapped[bool] = mapped_column(nullable=False)
    counted: Mapped[bool] = mapped_column(nullable=False)             # toward mastery
    confidence: Mapped[int | None]
    created_at: Mapped[datetime] = _now()

    __table_args__ = (sa.Index("ix_attempts_user_key", "user_id", "item_key"),
                      sa.CheckConstraint("confidence IS NULL OR confidence BETWEEN 1 AND 5", name="confidence_range"))


class Mark(Base):
    __tablename__ = "marks"

    id: Mapped[str] = mapped_column(sa.String(40), primary_key=True)
    user_id: Mapped[str] = _fk("users.id")
    media_id: Mapped[str] = _fk("videos.media_id")
    t: Mapped[float] = mapped_column(nullable=False)
    type: Mapped[MarkType] = mapped_column(enum_type(MarkType, "mark_type"), nullable=False)
    note: Mapped[str] = mapped_column(sa.Text, default="", nullable=False)
    evidence_id: Mapped[str | None] = mapped_column(sa.String(64))    # sentence under the mark
    created_at: Mapped[datetime] = _now()
    deleted_at: Mapped[datetime | None] = mapped_column(TS)

    __table_args__ = (sa.Index("ix_marks_user_media", "user_id", "media_id", "t"),)


class CoachThread(Base):
    """One thread per (user, video); cross-video context comes from concept retrieval."""

    __tablename__ = "coach_threads"

    id: Mapped[str] = mapped_column(sa.String(40), primary_key=True)
    user_id: Mapped[str] = _fk("users.id")
    media_id: Mapped[str] = _fk("videos.media_id")
    created_at: Mapped[datetime] = _now()

    __table_args__ = (sa.UniqueConstraint("user_id", "media_id"),)


class CoachMessage(Base):
    __tablename__ = "coach_messages"

    id: Mapped[str] = mapped_column(sa.String(40), primary_key=True)
    thread_id: Mapped[str] = _fk("coach_threads.id", index=True)
    role: Mapped[ChatRole] = mapped_column(enum_type(ChatRole, "chat_role"), nullable=False)
    content: Mapped[str] = mapped_column(sa.Text, nullable=False)
    media_time: Mapped[float | None]
    prompt_version: Mapped[str | None] = mapped_column(sa.String(32))
    created_at: Mapped[datetime] = _now()

    citations: Mapped[list[MessageCitation]] = relationship(cascade="all, delete-orphan",
                                                            order_by="MessageCitation.ord")


class MessageCitation(Base):
    __tablename__ = "message_citations"

    message_id: Mapped[str] = mapped_column(sa.ForeignKey("coach_messages.id", ondelete="CASCADE"), primary_key=True)
    ord: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[CitationKind] = mapped_column(enum_type(CitationKind, "citation_kind"), nullable=False)
    ref: Mapped[str] = mapped_column(sa.String(32), nullable=False)          # what the model wrote, e.g. s0042
    evidence_id: Mapped[str | None] = mapped_column(sa.String(64))
    evidence_revision: Mapped[int | None]
    concept_id: Mapped[str | None] = _fk("concepts.id", ondelete="SET NULL", nullable=True)

    __table_args__ = (sa.CheckConstraint("kind <> 'evidence' OR evidence_id IS NOT NULL", name="evidence_ref"),)


# =============================================================================== derived layer
class Mastery(Base):
    """Projection of attempts (rule ladder + evidence counts). Rebuildable."""

    __tablename__ = "mastery"

    user_id: Mapped[str] = mapped_column(sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    concept_id: Mapped[str] = mapped_column(sa.ForeignKey("concepts.id", ondelete="CASCADE"), primary_key=True)
    level: Mapped[int] = mapped_column(default=1, nullable=False)
    streak: Mapped[int] = mapped_column(default=0, nullable=False)
    independent_correct: Mapped[int] = mapped_column(default=0, nullable=False)
    independent_wrong: Mapped[int] = mapped_column(default=0, nullable=False)
    assisted: Mapped[int] = mapped_column(default=0, nullable=False)
    last_attempt_at: Mapped[datetime | None] = mapped_column(TS)

    __table_args__ = (sa.CheckConstraint("level BETWEEN 1 AND 3", name="level_range"),)


class ConceptLink(Base):
    """Cross-video connection shown to one user ("you met this in another video")."""

    __tablename__ = "concept_links"

    id: Mapped[str] = mapped_column(sa.String(40), primary_key=True)
    user_id: Mapped[str] = _fk("users.id")
    concept_id: Mapped[str] = _fk("concepts.id")
    relation: Mapped[LinkRelation] = mapped_column(enum_type(LinkRelation, "link_relation"), nullable=False)
    from_media_id: Mapped[str] = _fk("videos.media_id")                 # where the learner is now
    to_occurrence_id: Mapped[int] = _fk("occurrences.id")               # where they met it before
    status: Mapped[LinkStatus] = mapped_column(enum_type(LinkStatus, "link_status"), nullable=False,
                                               default=LinkStatus.SUGGESTED)
    created_at: Mapped[datetime] = _now()
    resolved_at: Mapped[datetime | None] = mapped_column(TS)

    __table_args__ = (sa.UniqueConstraint("user_id", "concept_id", "from_media_id", "to_occurrence_id"),)


class KnowledgeCard(Timestamps, Base):
    __tablename__ = "knowledge_cards"

    id: Mapped[str] = mapped_column(sa.String(40), primary_key=True)
    user_id: Mapped[str] = _fk("users.id")
    concept_id: Mapped[str] = _fk("concepts.id")
    title: Mapped[str] = mapped_column(sa.String(200), nullable=False)
    body: Mapped[str] = mapped_column(sa.Text, nullable=False)           # markdown; citations as [s0042]
    status: Mapped[CardStatus] = mapped_column(enum_type(CardStatus, "card_status"), nullable=False,
                                               default=CardStatus.DRAFT)
    generator: Mapped[str] = mapped_column(sa.String(64), nullable=False)

    sources: Mapped[list[CardSource]] = relationship(cascade="all, delete-orphan")
    __table_args__ = (sa.Index("uq_card_live", "user_id", "concept_id", unique=True,
                               **_where("status <> 'archived'")),)


class CardSource(Base):
    __tablename__ = "card_sources"

    card_id: Mapped[str] = mapped_column(sa.ForeignKey("knowledge_cards.id", ondelete="CASCADE"), primary_key=True)
    evidence_id: Mapped[str] = mapped_column(sa.String(64), primary_key=True)
    evidence_revision: Mapped[int] = mapped_column(nullable=False)


# =============================================================================== ops
class UsageLog(UsageLogColumns, Base):
    __tablename__ = "usage_logs"


class LlmCache(LlmCacheColumns, Base):
    __tablename__ = "llm_cache"
