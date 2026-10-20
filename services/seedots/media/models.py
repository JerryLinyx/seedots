"""Video analysis foundation — database schema (its own database).

  media_assets ─┬─ media_files            files we hold (original / playback / ASR audio)
                ├─ analysis_jobs ── stage_runs   idempotent stages keyed by processor version
                ├─ evidence_units         time-anchored evidence, revisioned, never edited in place
                └─ outbox_events ── webhook_deliveries ── webhook_subscriptions
  usage_logs                               every model call
"""
from __future__ import annotations

import enum
from datetime import datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy.orm import Mapped, mapped_column, relationship

from seedots.common.db import LlmCacheColumns, Timestamps, UsageLogColumns, enum_type, make_base, utcnow

Base = make_base()


class SourceKind(enum.StrEnum):
    UPLOAD = "upload"
    PLATFORM = "platform"
    WEBPAGE = "webpage"


class Visibility(enum.StrEnum):
    PUBLIC = "public"      # shared across users (platform videos)
    PRIVATE = "private"    # owner only (uploads, web-page grabs)


class MediaStatus(enum.StrEnum):
    REGISTERED = "registered"
    ANALYZING = "analyzing"
    READY = "ready"
    FAILED = "failed"


class FileRole(enum.StrEnum):
    ORIGINAL = "original"
    PLAYBACK = "playback"
    ASR_AUDIO = "asr_audio"
    CAPTIONS = "captions"


class EvidenceKind(enum.StrEnum):
    SENTENCE = "sentence"
    CHAPTER = "chapter"
    KEYFRAME = "keyframe"
    REGION = "region"


class EvidenceSource(enum.StrEnum):
    CAPTION = "caption"
    AUTO_CAPTION = "auto_caption"
    ASR = "asr"
    VLM = "vlm"
    NATIVE_MODEL = "native_model"
    LLM_OUTLINE = "llm_outline"
    PLATFORM_CHAPTERS = "platform_chapters"
    HEURISTIC = "heuristic"
    USER_CORRECTION = "user_correction"


class JobStatus(enum.StrEnum):
    ACCEPTED = "accepted"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class StageStatus(enum.StrEnum):
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class DeliveryStatus(enum.StrEnum):
    PENDING = "pending"
    DELIVERED = "delivered"
    DEAD = "dead"


class MediaAsset(Timestamps, Base):
    __tablename__ = "media_assets"

    id: Mapped[str] = mapped_column(sa.String(40), primary_key=True)
    source_kind: Mapped[SourceKind] = mapped_column(enum_type(SourceKind, "source_kind"), nullable=False)
    source_uri: Mapped[str] = mapped_column(sa.Text, nullable=False)
    platform: Mapped[str | None] = mapped_column(sa.String(32))             # youtube | ...
    external_id: Mapped[str | None] = mapped_column(sa.String(128))         # platform video id
    content_hash: Mapped[str | None] = mapped_column(sa.String(80))         # sha256:... for files we hold
    dedupe_key: Mapped[str] = mapped_column(sa.String(200), nullable=False)
    visibility: Mapped[Visibility] = mapped_column(enum_type(Visibility, "visibility"), nullable=False)
    owner_id: Mapped[str | None] = mapped_column(sa.String(64))
    language: Mapped[str] = mapped_column(sa.String(16), nullable=False)
    title: Mapped[str | None] = mapped_column(sa.Text)
    duration_s: Mapped[float | None] = mapped_column(sa.Float)
    capabilities: Mapped[dict[str, Any]] = mapped_column(nullable=False)
    # Platform API data. YouTube policy: unauthorised API data is kept at most 30 days.
    platform_meta: Mapped[dict[str, Any]] = mapped_column(default=dict, nullable=False)
    platform_meta_expires_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    rights_attestation: Mapped[dict[str, Any] | None] = mapped_column()     # {by, statement, at, source_url}
    status: Mapped[MediaStatus] = mapped_column(enum_type(MediaStatus, "media_status"), nullable=False,
                                                default=MediaStatus.REGISTERED)
    status_detail: Mapped[str] = mapped_column(sa.Text, default="", nullable=False)

    files: Mapped[list[MediaFile]] = relationship(back_populates="media", cascade="all, delete-orphan")
    jobs: Mapped[list[AnalysisJob]] = relationship(back_populates="media", cascade="all, delete-orphan")

    __table_args__ = (
        sa.CheckConstraint("visibility = 'public' OR owner_id IS NOT NULL", name="private_needs_owner"),
        sa.CheckConstraint("source_kind <> 'webpage' OR rights_attestation IS NOT NULL", name="webpage_attested"),
        sa.CheckConstraint("duration_s IS NULL OR duration_s >= 0", name="duration_nonneg"),
        # one shared row per public source; one per owner for private sources
        sa.Index("uq_media_public_dedupe", "dedupe_key", unique=True,
                 postgresql_where=sa.text("visibility = 'public'"), sqlite_where=sa.text("visibility = 'public'")),
        sa.Index("uq_media_private_dedupe", "dedupe_key", "owner_id", unique=True,
                 postgresql_where=sa.text("visibility = 'private'"), sqlite_where=sa.text("visibility = 'private'")),
        sa.Index("ix_media_owner", "owner_id"),
    )


class MediaFile(Base):
    __tablename__ = "media_files"

    id: Mapped[str] = mapped_column(sa.String(40), primary_key=True)
    media_id: Mapped[str] = mapped_column(sa.ForeignKey("media_assets.id", ondelete="CASCADE"), nullable=False)
    role: Mapped[FileRole] = mapped_column(enum_type(FileRole, "file_role"), nullable=False)
    storage_key: Mapped[str] = mapped_column(sa.Text, nullable=False)       # path or object-store key
    mime: Mapped[str | None] = mapped_column(sa.String(100))
    bytes: Mapped[int | None] = mapped_column(sa.BigInteger)
    sha256: Mapped[str | None] = mapped_column(sa.String(64))
    created_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True), default=utcnow, nullable=False)

    media: Mapped[MediaAsset] = relationship(back_populates="files")
    __table_args__ = (sa.UniqueConstraint("media_id", "role"),)


class EvidenceUnitRow(Base):
    """One revision of one evidence unit. A correction inserts a new revision and stamps
    `superseded_at` on the old one; references always carry (id, revision)."""

    __tablename__ = "evidence_units"

    id: Mapped[str] = mapped_column(sa.String(64), primary_key=True)
    revision: Mapped[int] = mapped_column(primary_key=True)
    media_id: Mapped[str] = mapped_column(sa.ForeignKey("media_assets.id", ondelete="CASCADE"), nullable=False)
    kind: Mapped[EvidenceKind] = mapped_column(enum_type(EvidenceKind, "evidence_kind"), nullable=False)
    ord: Mapped[int] = mapped_column(nullable=False)
    t0: Mapped[float] = mapped_column(nullable=False)
    t1: Mapped[float] = mapped_column(nullable=False)
    content: Mapped[dict[str, Any]] = mapped_column(nullable=False)
    bbox: Mapped[list[Any] | None] = mapped_column()
    frame_ref: Mapped[str | None] = mapped_column(sa.Text)
    source: Mapped[EvidenceSource] = mapped_column(enum_type(EvidenceSource, "evidence_source"), nullable=False)
    processor: Mapped[str] = mapped_column(sa.String(64), nullable=False)    # name@version
    confidence: Mapped[float] = mapped_column(nullable=False, default=1.0)
    needs_review: Mapped[bool] = mapped_column(nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True), default=utcnow, nullable=False)
    superseded_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))

    __table_args__ = (
        sa.CheckConstraint("t0 >= 0 AND t1 >= t0", name="time_range"),
        sa.CheckConstraint("confidence >= 0 AND confidence <= 1", name="confidence_range"),
        sa.CheckConstraint("revision >= 1", name="revision_positive"),
        sa.Index("ix_evidence_current", "media_id", "kind", "t0",
                 postgresql_where=sa.text("superseded_at IS NULL"), sqlite_where=sa.text("superseded_at IS NULL")),
        sa.Index("uq_evidence_one_current", "id", unique=True,
                 postgresql_where=sa.text("superseded_at IS NULL"), sqlite_where=sa.text("superseded_at IS NULL")),
    )


class AnalysisJob(Base):
    __tablename__ = "analysis_jobs"

    id: Mapped[str] = mapped_column(sa.String(40), primary_key=True)
    media_id: Mapped[str] = mapped_column(sa.ForeignKey("media_assets.id", ondelete="CASCADE"), nullable=False)
    status: Mapped[JobStatus] = mapped_column(enum_type(JobStatus, "job_status"), nullable=False)
    priority_from: Mapped[float | None]
    engine: Mapped[str] = mapped_column(sa.String(32), nullable=False)     # inprocess | temporal
    workflow_id: Mapped[str | None] = mapped_column(sa.String(128))
    error: Mapped[str | None] = mapped_column(sa.Text)
    created_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True), default=utcnow, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))

    media: Mapped[MediaAsset] = relationship(back_populates="jobs")
    __table_args__ = (
        # at most one live job per media
        sa.Index("uq_job_live", "media_id", unique=True,
                 postgresql_where=sa.text("status IN ('accepted','running')"),
                 sqlite_where=sa.text("status IN ('accepted','running')")),
    )


class StageRun(Base):
    __tablename__ = "stage_runs"

    media_id: Mapped[str] = mapped_column(sa.ForeignKey("media_assets.id", ondelete="CASCADE"), primary_key=True)
    stage: Mapped[str] = mapped_column(sa.String(48), primary_key=True)
    processor_version: Mapped[str] = mapped_column(sa.String(64), primary_key=True)
    job_id: Mapped[str | None] = mapped_column(sa.ForeignKey("analysis_jobs.id", ondelete="SET NULL"))
    status: Mapped[StageStatus] = mapped_column(enum_type(StageStatus, "stage_status"), nullable=False)
    attempts: Mapped[int] = mapped_column(default=0, nullable=False)
    error: Mapped[str | None] = mapped_column(sa.Text)
    stats: Mapped[dict[str, Any]] = mapped_column(default=dict, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))


class OutboxEvent(Base):
    __tablename__ = "outbox_events"

    event_id: Mapped[str] = mapped_column(sa.String(40), primary_key=True)
    media_id: Mapped[str] = mapped_column(sa.ForeignKey("media_assets.id", ondelete="CASCADE"), nullable=False)
    seq: Mapped[int] = mapped_column(nullable=False)
    type: Mapped[str] = mapped_column(sa.String(48), nullable=False)
    payload: Mapped[dict[str, Any]] = mapped_column(nullable=False)       # full MediaEvent JSON
    created_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True), default=utcnow, nullable=False)

    __table_args__ = (sa.UniqueConstraint("media_id", "seq"),)


class WebhookSubscription(Timestamps, Base):
    __tablename__ = "webhook_subscriptions"

    id: Mapped[str] = mapped_column(sa.String(40), primary_key=True)
    url: Mapped[str] = mapped_column(sa.Text, nullable=False, unique=True)
    secret: Mapped[str] = mapped_column(sa.String(200), nullable=False)
    event_types: Mapped[list[Any]] = mapped_column(default=list, nullable=False)   # empty = all
    active: Mapped[bool] = mapped_column(default=True, nullable=False)


class WebhookDelivery(Base):
    __tablename__ = "webhook_deliveries"

    event_id: Mapped[str] = mapped_column(sa.ForeignKey("outbox_events.event_id", ondelete="CASCADE"),
                                          primary_key=True)
    subscription_id: Mapped[str] = mapped_column(sa.ForeignKey("webhook_subscriptions.id", ondelete="CASCADE"),
                                                 primary_key=True)
    status: Mapped[DeliveryStatus] = mapped_column(enum_type(DeliveryStatus, "delivery_status"), nullable=False,
                                                   default=DeliveryStatus.PENDING)
    attempts: Mapped[int] = mapped_column(default=0, nullable=False)
    next_attempt_at: Mapped[datetime] = mapped_column(sa.DateTime(timezone=True), default=utcnow, nullable=False)
    last_error: Mapped[str | None] = mapped_column(sa.Text)
    delivered_at: Mapped[datetime | None] = mapped_column(sa.DateTime(timezone=True))

    __table_args__ = (sa.Index("ix_delivery_due", "status", "next_attempt_at"),)


class UsageLog(UsageLogColumns, Base):
    __tablename__ = "usage_logs"


class LlmCache(LlmCacheColumns, Base):
    __tablename__ = "llm_cache"
