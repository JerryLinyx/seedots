"""Learning items: immutable versions, the item pool, reviews, and the public projection.

The pool is "current versions that are usable": auto_validated (served, not counted toward
mastery) and human_reviewed (served and counted). Answer keys never leave this module
except through grading.
"""
from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any

import sqlalchemy as sa
from sqlalchemy.orm import Session, selectinload

from seedots.common.db import utcnow
from seedots.common.ids import new_id
from seedots.learning.models import (Concept, EvidenceRole, EvidenceSnapshot, ItemConcept, ItemEvidence, ItemReview,
                                     LearningItem, ReviewStatus)

USABLE = (ReviewStatus.AUTO_VALIDATED, ReviewStatus.HUMAN_REVIEWED)


def publish(s: Session, *, media_id: str, chapter_id: str, type_: str, level: int, payload: dict, answer_key: dict,
            concept_ids: Sequence[str], evidence: Sequence[tuple[str, int, EvidenceRole]], generator: str,
            content_run_id: int | None = None, misconception_id: int | None = None,
            show_before_s: float | None = None, item_key: str | None = None,
            review: tuple[ReviewStatus, str] = (ReviewStatus.AUTO_VALIDATED, "validator@1")) -> LearningItem:
    """Insert a new version. With `item_key`, supersedes that item's current version."""
    version = 1
    if item_key:
        cur = current_by_key(s, item_key)
        if cur is not None:
            cur.superseded_at = utcnow()
            s.flush()
            version = cur.version + 1
    key = item_key or new_id("itk")
    item = LearningItem(id=new_id("itm"), item_key=key, version=version, media_id=media_id, chapter_id=chapter_id,
                        type=type_, level=level, payload=payload, answer_key=answer_key,
                        misconception_id=misconception_id, show_before_s=show_before_s,
                        review_status=review[0], content_run_id=content_run_id, generator=generator)
    item.concepts = [ItemConcept(concept_id=c) for c in dict.fromkeys(concept_ids)]
    item.evidence = [ItemEvidence(evidence_id=e, evidence_revision=r, role=role, ord=i)
                     for i, (e, r, role) in enumerate(evidence)]
    s.add(item)
    s.flush()
    s.add(ItemReview(item_id=item.id, reviewer=review[1], status=review[0]))
    return item


def current_by_key(s: Session, item_key: str) -> LearningItem | None:
    return s.scalar(sa.select(LearningItem).where(LearningItem.item_key == item_key,
                                                  LearningItem.superseded_at.is_(None)))


def pool(s: Session, media_id: str, chapter_id: str | None = None) -> list[LearningItem]:
    q = (sa.select(LearningItem).options(selectinload(LearningItem.concepts), selectinload(LearningItem.evidence))
         .where(LearningItem.media_id == media_id, LearningItem.superseded_at.is_(None),
                LearningItem.review_status.in_(USABLE)))
    if chapter_id:
        q = q.where(LearningItem.chapter_id == chapter_id)
    return list(s.scalars(q.order_by(LearningItem.chapter_id, LearningItem.level, LearningItem.id)))


def review(s: Session, item_id: str, status: ReviewStatus, reviewer: str, note: str = "") -> LearningItem:
    item = s.get(LearningItem, item_id)
    if item is None:
        raise KeyError(item_id)
    item.review_status = status
    s.add(ItemReview(item_id=item_id, reviewer=reviewer, status=status, note=note))
    return item


def evidence_times(s: Session, items: Iterable[LearningItem]) -> dict[tuple[str, int], EvidenceSnapshot]:
    keys = {(e.evidence_id, e.evidence_revision) for it in items for e in it.evidence}
    if not keys:
        return {}
    rows = s.scalars(sa.select(EvidenceSnapshot).where(sa.tuple_(EvidenceSnapshot.id, EvidenceSnapshot.revision)
                                                       .in_(list(keys))))
    return {(r.id, r.revision): r for r in rows}


def concept_names(s: Session, ids: Iterable[str]) -> dict[str, str]:
    ids = list(set(ids))
    if not ids:
        return {}
    return dict(s.execute(sa.select(Concept.id, Concept.name).where(Concept.id.in_(ids))).all())


def public(item: LearningItem, ev: dict[tuple[str, int], EvidenceSnapshot], names: dict[str, str]) -> dict[str, Any]:
    """What the browser may see: no answer key, evidence as id + time."""
    evidence = []
    for e in item.evidence:
        snap = ev.get((e.evidence_id, e.evidence_revision))
        if e.role == EvidenceRole.REVEAL:
            continue                      # would point at the answer before it is asked
        evidence.append({"id": e.evidence_id, "revision": e.evidence_revision,
                         "t0": snap.t0 if snap else None, "t1": snap.t1 if snap else None})
    return {
        "id": item.id, "key": item.item_key, "version": item.version, "type": item.type.value,
        "schema_version": item.schema_version, "chapter_id": item.chapter_id, "level": item.level,
        "concept_ids": [c.concept_id for c in item.concepts],
        "concepts": [names.get(c.concept_id, "") for c in item.concepts],
        "evidence": evidence, "review_status": item.review_status.value, "show_before": item.show_before_s,
        "payload": item.payload,
    }


def project(s: Session, items: list[LearningItem]) -> list[dict[str, Any]]:
    ev = evidence_times(s, items)
    names = concept_names(s, (c.concept_id for it in items for c in it.concepts))
    return [public(it, ev, names) for it in items]
