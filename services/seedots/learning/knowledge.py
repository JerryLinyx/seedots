"""Knowledge layer for one learner: the map, concept pages, knowledge cards, links, search.

  map     nodes = global concepts the learner has met (in videos they may see);
          edges = concepts taught in the same chapter (co-occurrence) + confirmed links
  cards   drafted by the model from cited evidence across videos, confirmed by the user
  search  keyword (names, aliases, cards, transcript) + semantic (concept embeddings)
"""
from __future__ import annotations

import re
from collections import defaultdict
from itertools import combinations
from typing import Any

import sqlalchemy as sa
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from seedots.common.db import Database
from seedots.common.ids import new_id
from seedots.common.llm import Gateway
from seedots.common.timefmt import fmt_ts
from seedots.learning.catalog import ensure_user, short, visible_media_ids
from seedots.learning.concepts import Embedder, cosine
from seedots.learning.models import (CardSource, CardStatus, Concept, ConceptAlias, ConceptEmbedding, ConceptLink,
                                     ConceptStatus, EvidenceSnapshot, KnowledgeCard, LibraryEntry, LinkStatus, Mastery,
                                     Occurrence, OccurrenceEvidence, Video)


class CardOut(BaseModel):
    title: str = Field(max_length=120)
    body: str = Field(max_length=2400)


class Knowledge:
    def __init__(self, db: Database, gateway: Gateway, embedder: Embedder):
        self.db, self.gateway, self.embedder = db, gateway, embedder

    # ------------------------------------------------------------------ map
    def map(self, user_id: str) -> dict[str, Any]:
        with self.db.session() as s:
            mine = sa.select(LibraryEntry.media_id).where(LibraryEntry.user_id == user_id)
            rows = s.execute(sa.select(Occurrence, Concept.name, Concept.definition, Video.title)
                             .join(Concept, Concept.id == Occurrence.concept_id)
                             .join(Video, Video.media_id == Occurrence.media_id)
                             .where(Occurrence.media_id.in_(mine), Concept.status == ConceptStatus.ACTIVE)).all()
            mastery = {m.concept_id: m.level for m in s.scalars(sa.select(Mastery).where(Mastery.user_id == user_id))}
            nodes: dict[str, dict[str, Any]] = {}
            by_chapter: dict[str, set[str]] = defaultdict(set)
            for occ, name, definition, title in rows:
                n = nodes.setdefault(occ.concept_id, {"id": occ.concept_id, "name": name, "definition": definition,
                                                      "mastery": mastery.get(occ.concept_id), "sources": []})
                n["sources"].append({"media_id": occ.media_id, "title": title, "chapter_id": occ.chapter_id,
                                     "t0": occ.t0, "role": occ.role.value})
                by_chapter[occ.chapter_id].add(occ.concept_id)
            weights: dict[tuple[str, str], int] = defaultdict(int)
            for ids in by_chapter.values():
                for a, b in combinations(sorted(ids), 2):
                    weights[(a, b)] += 1
            edges = [{"source": a, "target": b, "kind": "co_taught", "weight": w} for (a, b), w in weights.items()]
            for link in s.scalars(sa.select(ConceptLink).where(ConceptLink.user_id == user_id,
                                                               ConceptLink.status == LinkStatus.CONFIRMED)):
                if link.concept_id in nodes:
                    nodes[link.concept_id]["linked"] = True
            for n in nodes.values():
                n["videos"] = len({x["media_id"] for x in n["sources"]})
            return {"nodes": sorted(nodes.values(), key=lambda n: (-n["videos"], n["name"])), "edges": edges}

    # ------------------------------------------------------------------ concept page
    def concept(self, user_id: str, concept_id: str) -> dict[str, Any]:
        with self.db.session() as s:
            c = s.get(Concept, concept_id)
            if c is None:
                raise KeyError(concept_id)
            if c.status == ConceptStatus.MERGED:
                return self.concept(user_id, c.merged_into_id)
            occ = self._occurrences(s, user_id, concept_id)
            m = s.get(Mastery, (user_id, concept_id))
            card = s.scalar(sa.select(KnowledgeCard).where(KnowledgeCard.user_id == user_id,
                                                           KnowledgeCard.concept_id == concept_id,
                                                           KnowledgeCard.status != CardStatus.ARCHIVED))
            return {"id": c.id, "name": c.name, "definition": c.definition,
                    "aliases": [a.alias for a in c.aliases], "misconceptions": [m_.text for m_ in c.misconceptions],
                    "occurrences": occ,
                    "mastery": {"level": m.level, "independent_correct": m.independent_correct,
                                "independent_wrong": m.independent_wrong} if m else None,
                    "card": self._card_out(card) if card else None}

    @staticmethod
    def _occurrences(s: Session, user_id: str, concept_id: str) -> list[dict[str, Any]]:
        rows = s.execute(sa.select(Occurrence, Video.title).join(Video, Video.media_id == Occurrence.media_id)
                         .where(Occurrence.concept_id == concept_id,
                                Occurrence.media_id.in_(visible_media_ids(s, user_id)))
                         .order_by(Occurrence.media_id, Occurrence.t0)).all()
        out = []
        for occ, title in rows:
            quotes = []
            for e in occ.evidence[:3]:
                snap = s.get(EvidenceSnapshot, (e.evidence_id, e.evidence_revision))
                if snap:
                    quotes.append({"id": snap.id, "t0": snap.t0, "text": snap.content.get("text", "")})
            out.append({"media_id": occ.media_id, "title": title, "chapter_id": occ.chapter_id, "role": occ.role.value,
                        "t0": occ.t0, "t1": occ.t1, "quotes": quotes})
        return out

    # ------------------------------------------------------------------ cards
    def draft_card(self, user_id: str, concept_id: str) -> dict[str, Any]:
        """Draft (or redraft) the learner's card from cited evidence. Never auto-confirmed."""
        with self.db.session() as s:
            ensure_user(s, user_id)
            c = s.get(Concept, concept_id)
            if c is None or c.status != ConceptStatus.ACTIVE:
                raise KeyError(concept_id)
            evidence: list[EvidenceSnapshot] = []
            lines = []
            for occ in s.scalars(sa.select(Occurrence).where(Occurrence.concept_id == concept_id,
                                                             Occurrence.media_id.in_(visible_media_ids(s, user_id)))):
                title = s.get(Video, occ.media_id).title
                for e in occ.evidence[:4]:
                    snap = s.get(EvidenceSnapshot, (e.evidence_id, e.evidence_revision))
                    if snap and len(evidence) < 16:
                        evidence.append(snap)
                        lines.append(f"{short(snap.id)} ({title} {fmt_ts(snap.t0)}) {snap.content.get('text', '')}")
            if not evidence:
                raise KeyError(concept_id)
            variables = {"name": c.name, "definition": c.definition or "none",
                         "misconceptions": "; ".join(m.text for m in c.misconceptions) or "none",
                         "evidence": "\n".join(lines)}
        out: CardOut = self.gateway.run("card", variables, manifest={"concept": concept_id,
                                                                     "evidence": [e.id for e in evidence]})
        cited = set(re.findall(r"\[(s\d{4})\]", out.body))
        prompt_tag = self.gateway.prompts.get("card").tag
        with self.db.session() as s:
            card = s.scalar(sa.select(KnowledgeCard).where(KnowledgeCard.user_id == user_id,
                                                           KnowledgeCard.concept_id == concept_id,
                                                           KnowledgeCard.status != CardStatus.ARCHIVED))
            if card is None:
                card = KnowledgeCard(id=new_id("crd"), user_id=user_id, concept_id=concept_id, title=out.title,
                                     body=out.body, generator=prompt_tag)
                s.add(card)
            elif card.status == CardStatus.CONFIRMED:
                raise PermissionError("this card was confirmed; edit it instead of redrafting")
            card.title, card.body, card.generator, card.status = out.title, out.body, prompt_tag, CardStatus.DRAFT
            card.sources = [CardSource(evidence_id=e.id, evidence_revision=e.revision)
                            for e in evidence if short(e.id) in cited] or \
                [CardSource(evidence_id=e.id, evidence_revision=e.revision) for e in evidence[:3]]
            s.flush()
            return self._card_out(card)

    def update_card(self, user_id: str, card_id: str, *, title: str | None, body: str | None,
                    status: str | None) -> dict[str, Any]:
        with self.db.session() as s:
            card = s.get(KnowledgeCard, card_id)
            if card is None or card.user_id != user_id:
                raise KeyError(card_id)
            if title is not None:
                card.title = title.strip()[:200]
            if body is not None:
                card.body = body
            if status is not None:
                card.status = CardStatus(status)
            s.flush()
            return self._card_out(card)

    def cards(self, user_id: str) -> list[dict[str, Any]]:
        with self.db.session() as s:
            return [self._card_out(c) for c in s.scalars(
                sa.select(KnowledgeCard).where(KnowledgeCard.user_id == user_id,
                                               KnowledgeCard.status != CardStatus.ARCHIVED)
                .order_by(KnowledgeCard.updated_at.desc()))]

    @staticmethod
    def _card_out(card: KnowledgeCard) -> dict[str, Any]:
        return {"id": card.id, "concept_id": card.concept_id, "title": card.title, "body": card.body,
                "status": card.status.value, "sources": [{"id": x.evidence_id, "revision": x.evidence_revision}
                                                         for x in card.sources]}

    # ------------------------------------------------------------------ links
    def resolve_link(self, user_id: str, link_id: str, status: str) -> None:
        from seedots.common.db import utcnow

        with self.db.session() as s:
            link = s.get(ConceptLink, link_id)
            if link is None or link.user_id != user_id:
                raise KeyError(link_id)
            link.status, link.resolved_at = LinkStatus(status), utcnow()

    # ------------------------------------------------------------------ search
    def search(self, user_id: str, q: str, limit: int = 12) -> dict[str, Any]:
        q = q.strip()
        if not q:
            return {"concepts": [], "moments": [], "cards": []}
        like = f"%{q.lower()}%"
        with self.db.session() as s:
            visible = visible_media_ids(s, user_id)
            met = sa.select(Occurrence.concept_id).where(Occurrence.media_id.in_(visible))
            kw = set(s.scalars(sa.select(Concept.id).where(Concept.status == ConceptStatus.ACTIVE, Concept.id.in_(met),
                                                           sa.or_(sa.func.lower(Concept.name).like(like),
                                                                  sa.func.lower(Concept.definition).like(like)))))
            kw |= set(s.scalars(sa.select(ConceptAlias.concept_id).where(sa.func.lower(ConceptAlias.alias).like(like),
                                                                         ConceptAlias.concept_id.in_(met))))
            vec = self.embedder.embed([q])[0]
            sem = sorted(((cosine(vec, v), cid) for v, cid in s.execute(
                sa.select(ConceptEmbedding.vector, ConceptEmbedding.concept_id)
                .join(Concept, Concept.id == ConceptEmbedding.concept_id)
                .where(ConceptEmbedding.model == self.embedder.name, Concept.status == ConceptStatus.ACTIVE,
                       Concept.id.in_(met)))), reverse=True)
            ranked = list(dict.fromkeys([*kw, *[cid for score, cid in sem if score >= 0.35]]))[:limit]
            concepts = {c.id: c for c in s.scalars(sa.select(Concept).where(Concept.id.in_(ranked)))}
            moments = s.execute(sa.select(EvidenceSnapshot, Video.title).join(Video, Video.media_id == EvidenceSnapshot.media_id)
                                .where(EvidenceSnapshot.media_id.in_(visible), EvidenceSnapshot.kind == "sentence",
                                       EvidenceSnapshot.is_current.is_(True),
                                       sa.func.lower(sa.cast(EvidenceSnapshot.content, sa.Text)).like(like))
                                .limit(limit)).all()
            cards = s.scalars(sa.select(KnowledgeCard).where(
                KnowledgeCard.user_id == user_id, KnowledgeCard.status != CardStatus.ARCHIVED,
                sa.or_(sa.func.lower(KnowledgeCard.title).like(like), sa.func.lower(KnowledgeCard.body).like(like)))
                .limit(limit)).all()
            return {
                "concepts": [{"id": cid, "name": concepts[cid].name, "definition": concepts[cid].definition,
                              "match": "keyword" if cid in kw else "semantic"} for cid in ranked if cid in concepts],
                "moments": [{"media_id": e.media_id, "title": title, "id": e.id, "t0": e.t0,
                             "text": e.content.get("text", "")} for e, title in moments],
                "cards": [self._card_out(c) for c in cards],
            }


__all__ = ["Knowledge", "OccurrenceEvidence"]
