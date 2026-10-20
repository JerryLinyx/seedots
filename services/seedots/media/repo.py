"""Persistence operations of the foundation. Every function takes the caller's Session, so a
state change and the event announcing it commit together (transactional outbox)."""
from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any

import sqlalchemy as sa
from sqlalchemy.orm import Session

from seedots.common.contracts import EvidenceUnit, MediaEvent
from seedots.common.db import utcnow
from seedots.common.ids import new_id, now_ms
from seedots.media.models import (DeliveryStatus, EvidenceUnitRow, MediaAsset, OutboxEvent, StageRun,
                                  WebhookDelivery, WebhookSubscription)


# ------------------------------------------------------------------------------ evidence
def to_unit(row: EvidenceUnitRow) -> EvidenceUnit:
    return EvidenceUnit(id=row.id, media_id=row.media_id, revision=row.revision, t0=row.t0, t1=row.t1,
                        kind=row.kind.value, content=row.content, bbox=row.bbox, frame_ref=row.frame_ref,
                        source=row.source.value, processor=row.processor, confidence=row.confidence,
                        needs_review=row.needs_review)


def _same(row: EvidenceUnitRow, u: EvidenceUnit) -> bool:
    return (row.t0, row.t1, row.content, row.bbox, row.frame_ref, row.source.value, row.processor) == \
        (u.t0, u.t1, u.content, u.bbox, u.frame_ref, u.source, u.processor)


def write_evidence(s: Session, media_id: str, kind: str, units: Sequence[EvidenceUnit]) -> dict[str, int]:
    """Make `units` the current evidence of this kind. Unchanged units are kept; changed ones
    get revision+1; units no longer produced are superseded. Nothing is deleted."""
    current = {r.id: r for r in s.scalars(sa.select(EvidenceUnitRow).where(
        EvidenceUnitRow.media_id == media_id, EvidenceUnitRow.kind == kind,
        EvidenceUnitRow.superseded_at.is_(None)))}
    stats = {"kept": 0, "revised": 0, "added": 0, "retired": 0}
    now = utcnow()
    seen: set[str] = set()
    for ord_, u in enumerate(units):
        seen.add(u.id)
        old = current.get(u.id)
        if old is not None and _same(old, u):
            old.ord = ord_
            stats["kept"] += 1
            continue
        revision = 1
        if old is not None:
            old.superseded_at = now
            s.flush()                         # free the "one current revision" slot first
            revision = old.revision + 1
            stats["revised"] += 1
        else:
            prev = s.scalar(sa.select(sa.func.max(EvidenceUnitRow.revision)).where(EvidenceUnitRow.id == u.id))
            revision = (prev or 0) + 1
            stats["added"] += 1
        s.add(EvidenceUnitRow(id=u.id, revision=revision, media_id=media_id, kind=kind, ord=ord_, t0=u.t0, t1=u.t1,
                              content=u.content, bbox=u.bbox, frame_ref=u.frame_ref, source=u.source,
                              processor=u.processor, confidence=u.confidence, needs_review=u.needs_review))
    for eid, row in current.items():
        if eid not in seen:
            row.superseded_at = now
            stats["retired"] += 1
    s.flush()
    return stats


def current_evidence(s: Session, media_id: str, kinds: Iterable[str] | None = None, t0: float | None = None,
                     t1: float | None = None) -> list[EvidenceUnit]:
    q = sa.select(EvidenceUnitRow).where(EvidenceUnitRow.media_id == media_id,
                                         EvidenceUnitRow.superseded_at.is_(None))
    if kinds:
        q = q.where(EvidenceUnitRow.kind.in_(list(kinds)))
    if t0 is not None:
        q = q.where(EvidenceUnitRow.t1 > t0)
    if t1 is not None:
        q = q.where(EvidenceUnitRow.t0 < t1)
    q = q.order_by(EvidenceUnitRow.kind, EvidenceUnitRow.ord)
    return [to_unit(r) for r in s.scalars(q)]


def evidence_row(s: Session, evidence_id: str, revision: int | None = None) -> EvidenceUnitRow | None:
    q = sa.select(EvidenceUnitRow).where(EvidenceUnitRow.id == evidence_id)
    q = q.where(EvidenceUnitRow.revision == revision) if revision else q.where(EvidenceUnitRow.superseded_at.is_(None))
    return s.scalar(q)


# ------------------------------------------------------------------------------ stages
def stage_run(s: Session, media_id: str, stage: str, version: str) -> StageRun | None:
    return s.get(StageRun, (media_id, stage, version))


def stage_stats(s: Session, media_id: str, stage: str) -> dict[str, Any]:
    row = s.scalar(sa.select(StageRun).where(StageRun.media_id == media_id, StageRun.stage == stage,
                                             StageRun.status == "done").order_by(StageRun.finished_at.desc()))
    return dict(row.stats) if row else {}


# ------------------------------------------------------------------------------ outbox
def emit(s: Session, media_id: str, type_: str, data: dict[str, Any]) -> MediaEvent:
    """Append an event and one delivery per matching active subscription, in the caller's
    transaction. seq is per media and strictly increasing (consumers use it for ordering)."""
    seq = (s.scalar(sa.select(sa.func.max(OutboxEvent.seq)).where(OutboxEvent.media_id == media_id)) or 0) + 1
    ev = MediaEvent(event_id=new_id("evt"), type=type_, media_id=media_id, seq=seq, occurred_at=now_ms(), data=data)
    s.add(OutboxEvent(event_id=ev.event_id, media_id=media_id, seq=seq, type=type_, payload=ev.model_dump()))
    s.flush()
    for sub in s.scalars(sa.select(WebhookSubscription).where(WebhookSubscription.active.is_(True))):
        if not sub.event_types or type_ in sub.event_types:
            s.add(WebhookDelivery(event_id=ev.event_id, subscription_id=sub.id))
    return ev


def replay(s: Session, event_id: str, subscription_id: str | None = None) -> int:
    q = sa.select(WebhookDelivery).where(WebhookDelivery.event_id == event_id)
    if subscription_id:
        q = q.where(WebhookDelivery.subscription_id == subscription_id)
    rows = list(s.scalars(q))
    if not rows and s.get(OutboxEvent, event_id) is not None:
        # event predates the subscription: create deliveries now
        for sub in s.scalars(sa.select(WebhookSubscription).where(WebhookSubscription.active.is_(True))):
            if subscription_id in (None, sub.id):
                rows.append(WebhookDelivery(event_id=event_id, subscription_id=sub.id))
                s.add(rows[-1])
    for d in rows:
        d.status, d.next_attempt_at, d.last_error = DeliveryStatus.PENDING, utcnow(), None
    return len(rows)


def asset(s: Session, media_id: str) -> MediaAsset | None:
    return s.get(MediaAsset, media_id)
