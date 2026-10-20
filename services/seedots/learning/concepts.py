"""Global concept library: normalisation, audit, merge and rollback (tech plan §4).

A mention extracted from a chapter resolves to a canonical concept in three tiers:
  1. exact   - normalised name or alias already in the library          -> attach
  2. recall  - nearest concepts by embedding, then an LLM judge decides  -> attach if confident
  3. unsure  - the mention gets its own concept + a pending merge candidate for a person
Every create / attach / merge is logged; a merge records exactly what moved so it can be undone.
"""
from __future__ import annotations

import hashlib
import logging
import math
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

import sqlalchemy as sa
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from seedots.common.config import ModelEndpoint
from seedots.common.db import Database, utcnow
from seedots.common.ids import stable_id
from seedots.common.llm import Gateway, LLMError
from seedots.learning.models import (CandidateStatus, CardStatus, Concept, ConceptAlias, ConceptCandidate,
                                     ConceptEmbedding, ConceptLink, ConceptMergeLog, ConceptStatus, ItemConcept,
                                     KnowledgeCard, Mastery, MergeAction, Misconception, Occurrence,
                                     OccurrenceEvidence)

log = logging.getLogger("seedots.learning.concepts")

ATTACH_AT = 0.75        # judge confidence to attach automatically
PROPOSE_AT = 0.40       # below ATTACH_AT but above this: new concept + pending merge candidate
RECALL_MIN = 0.35       # cosine floor for recall
RECALL_K = 5


def normalize(name: str) -> str:
    s = re.sub(r"[^a-z0-9一-鿿]+", " ", name.lower()).strip()
    words = [w[:-1] if len(w) > 3 and w.endswith("s") and not w.endswith("ss") else w for w in s.split()]
    return " ".join(words)


# ------------------------------------------------------------------------------ embeddings
class Embedder(Protocol):
    name: str

    def embed(self, texts: Sequence[str]) -> list[list[float]]: ...


class HashEmbedder:
    """Local lexical fallback (character trigrams hashed into 256 dims). Catches spelling and
    word-order variants; real synonyms need a semantic model (SEEDOTS_EMBED_MODEL)."""
    name = "hash3@256"
    DIM = 256

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        out = []
        for text in texts:
            v = [0.0] * self.DIM
            t = f"  {normalize(text)}  "
            for i in range(len(t) - 2):
                h = int(hashlib.md5(t[i:i + 3].encode()).hexdigest()[:8], 16)
                v[h % self.DIM] += 1.0 if h & 1 else -1.0
            out.append(_unit(v))
        return out


class OpenAIEmbedder:
    def __init__(self, endpoint: ModelEndpoint):
        self.endpoint, self.name = endpoint, f"openai:{endpoint.model}"

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        import httpx

        r = httpx.post(f"{self.endpoint.base_url}/embeddings", timeout=60,
                       headers={"Authorization": f"Bearer {self.endpoint.api_key}"},
                       json={"model": self.endpoint.model, "input": list(texts)})
        r.raise_for_status()
        return [_unit(d["embedding"]) for d in sorted(r.json()["data"], key=lambda d: d["index"])]


def build_embedder(endpoint: ModelEndpoint) -> Embedder:
    return OpenAIEmbedder(endpoint) if endpoint.configured else HashEmbedder()


def _unit(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


# ------------------------------------------------------------------------------ judge
class JudgeOut(BaseModel):
    match: str | None = Field(None, description="candidate key such as c2, or null if none is the same concept")
    confidence: float = Field(ge=0, le=1)
    reason: str = ""


@dataclass
class Mention:
    name: str
    definition: str = ""
    aliases: list[str] = field(default_factory=list)
    misconceptions: list[tuple[str, str]] = field(default_factory=list)   # (slug, text)
    context: str = ""                                                     # a sentence where it appears


@dataclass
class Resolution:
    concept_id: str
    how: str                       # exact | judged | created | proposed
    score: float = 1.0


class ConceptLibrary:
    """Owns its transactions: lookups and writes are short; the judge (a model call) runs
    between them with no transaction open."""

    def __init__(self, db: Database, gateway: Gateway | None, embedder: Embedder):
        self.db, self.gateway, self.embedder = db, gateway, embedder

    # ------------------------------------------------------------------ resolve
    def resolve(self, m: Mention, *, actor: str = "system") -> Resolution:
        norms = [n for n in dict.fromkeys([normalize(m.name)] + [normalize(a) for a in m.aliases]) if n]
        if not norms:
            raise ValueError("empty concept name")
        for attempt in range(2):                    # a concurrent worker may create the same concept
            try:
                return self._resolve(m, norms, actor)
            except IntegrityError:
                if attempt:
                    raise
        raise AssertionError("unreachable")

    def _resolve(self, m: Mention, norms: list[str], actor: str) -> Resolution:
        with self.db.session() as s:
            hit = self._exact(s, norms)
            if hit is not None:
                self._enrich(s, hit, m)
                self._log(s, MergeAction.ATTACH, hit.id, actor, {"mention": m.name, "how": "exact"})
                return Resolution(hit.id, "exact")
            vec = self.embedder.embed([self._embed_text(m.name, m.definition)])[0]
            recalled = [(key, c.id, score, self._describe(key, c)) for key, (c, score) in self._recall(s, vec)]

        verdict: JudgeOut | None = None             # no transaction open during the model call
        if recalled and self.gateway is not None:
            try:
                verdict = self._judge(m, recalled)
            except LLMError as exc:
                log.warning("concept judge failed: %s", exc)
        chosen = next(((cid, score) for key, cid, score, _ in recalled if verdict and key == verdict.match), None)

        with self.db.session() as s:
            if chosen is not None and verdict.confidence >= ATTACH_AT:
                concept = s.get(Concept, chosen[0])
                if concept is not None and concept.status == ConceptStatus.ACTIVE:
                    self._enrich(s, concept, m)
                    self._log(s, MergeAction.ATTACH, concept.id, "judge", {
                        "mention": m.name, "how": "judged", "confidence": verdict.confidence, "score": chosen[1]})
                    return Resolution(concept.id, "judged", chosen[1])
            hit = self._exact(s, norms)               # created meanwhile by another worker?
            if hit is not None:
                return Resolution(hit.id, "exact")
            created = self._create(s, m, vec, actor)
            if chosen is not None and verdict.confidence >= PROPOSE_AT:
                s.add(ConceptCandidate(concept_id=created.id, suggested_concept_id=chosen[0], score=chosen[1],
                                       judge=verdict.model_dump()))
                return Resolution(created.id, "proposed", chosen[1])
            return Resolution(created.id, "created")

    @staticmethod
    def _embed_text(name: str, definition: str) -> str:
        return f"{name}. {definition}".strip()

    @staticmethod
    def _describe(key: str, c: Concept) -> str:
        aliases = ", ".join(a.alias for a in c.aliases[:6]) or "none"
        return f"{key}: {c.name} (aliases: {aliases}) — {c.definition or 'no definition'}"

    def _exact(self, s: Session, norms: list[str]) -> Concept | None:
        c = s.scalar(sa.select(Concept).where(Concept.norm_name.in_(norms), Concept.status == ConceptStatus.ACTIVE))
        if c is not None:
            return c
        alias = s.scalar(sa.select(ConceptAlias).join(Concept, Concept.id == ConceptAlias.concept_id)
                         .where(ConceptAlias.norm.in_(norms), Concept.status == ConceptStatus.ACTIVE))
        return s.get(Concept, alias.concept_id) if alias else None

    def _recall(self, s: Session, vec: list[float]) -> list[tuple[str, tuple[Concept, float]]]:
        rows = s.execute(sa.select(ConceptEmbedding.vector, Concept).join(Concept, Concept.id == ConceptEmbedding.concept_id)
                         .where(ConceptEmbedding.model == self.embedder.name,
                                Concept.status == ConceptStatus.ACTIVE)).all()
        scored = sorted(((cosine(vec, v), c) for v, c in rows), key=lambda x: -x[0])
        top = [(score, c) for score, c in scored[:RECALL_K] if score >= RECALL_MIN]
        return [(f"c{i + 1}", (c, score)) for i, (score, c) in enumerate(top)]

    def _judge(self, m: Mention, recalled: list[tuple[str, str, float, str]]) -> JudgeOut:
        return self.gateway.run("concept_judge", {
            "name": m.name, "definition": m.definition or "none", "context": m.context or "none",
            "candidates": "\n".join(line for *_, line in recalled)}, manifest={"candidates": [r[1] for r in recalled]})

    def _create(self, s: Session, m: Mention, vec: list[float], actor: str) -> Concept:
        norm = normalize(m.name)
        cid = stable_id("con", norm)
        if s.get(Concept, cid) is not None:          # a merged-away concept once had this name
            cid = stable_id("con", norm, utcnow().isoformat())
        c = Concept(id=cid, name=m.name.strip()[:200], norm_name=norm, definition=m.definition.strip())
        s.add(c)
        s.flush()
        self._enrich(s, c, m)
        s.add(ConceptEmbedding(concept_id=c.id, model=self.embedder.name, vector=vec,
                               text=self._embed_text(m.name, m.definition)))
        self._log(s, MergeAction.CREATE, c.id, actor, {"mention": m.name})
        return c

    def _enrich(self, s: Session, c: Concept, m: Mention) -> None:
        if not c.definition and m.definition:
            c.definition = m.definition.strip()
        have = {a.norm for a in c.aliases} | {c.norm_name}
        for alias in [m.name, *m.aliases]:
            n = normalize(alias)
            if n and n not in have:
                c.aliases.append(ConceptAlias(norm=n, alias=alias.strip()[:200]))
                have.add(n)
        slugs = {x.slug for x in c.misconceptions}
        for slug, text in m.misconceptions:
            slug = re.sub(r"[^a-z0-9_]+", "_", slug.lower()).strip("_")[:80]
            if slug and slug not in slugs:
                c.misconceptions.append(Misconception(slug=slug, text=text.strip()))
                slugs.add(slug)
        s.flush()

    @staticmethod
    def _log(s: Session, action: MergeAction, concept_id: str, actor: str, detail: dict[str, Any],
             other: str | None = None, reverts: int | None = None) -> ConceptMergeLog:
        row = ConceptMergeLog(action=action, concept_id=concept_id, other_concept_id=other, actor=actor,
                              detail=detail, reverts_id=reverts)
        s.add(row)
        s.flush()
        return row

    # ------------------------------------------------------------------ merge / rollback
    def merge(self, s: Session, source_id: str, target_id: str, *, actor: str) -> int:
        """Fold `source` into `target`. Returns the merge-log id (pass it to rollback())."""
        src, dst = s.get(Concept, source_id), s.get(Concept, target_id)
        if not src or not dst or src.id == dst.id:
            raise ValueError("need two different concepts")
        if src.status != ConceptStatus.ACTIVE or dst.status != ConceptStatus.ACTIVE:
            raise ValueError("both concepts must be active")
        d: dict[str, Any] = {k: [] for k in ("occ_moved", "occ_absorbed", "items_moved", "items_dropped",
                                             "aliases_added", "misc_moved", "mastery_moved", "mastery_dropped",
                                             "cards_moved", "cards_archived", "links_moved", "links_dropped")}
        # occurrences: repoint, or fold evidence into the target's occurrence of the same chapter
        target_occ = {o.chapter_id: o for o in s.scalars(sa.select(Occurrence).where(Occurrence.concept_id == dst.id))}
        for o in list(s.scalars(sa.select(Occurrence).where(Occurrence.concept_id == src.id))):
            if o.chapter_id in target_occ:
                t = target_occ[o.chapter_id]
                have = {e.evidence_id for e in t.evidence}
                added = [e for e in o.evidence if e.evidence_id not in have]
                for e in added:
                    t.evidence.append(OccurrenceEvidence(evidence_id=e.evidence_id, evidence_revision=e.evidence_revision))
                d["occ_absorbed"].append({"row": _row(o), "evidence": [[e.evidence_id, e.evidence_revision] for e in o.evidence],
                                          "target": t.id, "added": [e.evidence_id for e in added],
                                          "target_t": [t.t0, t.t1]})
                t.t0, t.t1 = min(t.t0, o.t0), max(t.t1, o.t1)
                s.delete(o)
            else:
                o.concept_id = dst.id
                d["occ_moved"].append(o.id)
        # items
        linked = set(s.scalars(sa.select(ItemConcept.item_id).where(ItemConcept.concept_id == dst.id)))
        for ic in list(s.scalars(sa.select(ItemConcept).where(ItemConcept.concept_id == src.id))):
            if ic.item_id in linked:
                d["items_dropped"].append(ic.item_id)
                s.delete(ic)
            else:
                s.delete(ic)
                s.flush()
                s.add(ItemConcept(item_id=ic.item_id, concept_id=dst.id))
                d["items_moved"].append(ic.item_id)
        # aliases (source name becomes an alias of the target)
        have = {a.norm for a in dst.aliases} | {dst.norm_name}
        for alias in [ConceptAlias(norm=src.norm_name, alias=src.name), *src.aliases]:
            if alias.norm not in have:
                dst.aliases.append(ConceptAlias(norm=alias.norm, alias=alias.alias))
                have.add(alias.norm)
                d["aliases_added"].append(alias.norm)
        # misconceptions without a slug clash move over
        slugs = {m.slug for m in dst.misconceptions}
        for m in list(src.misconceptions):
            if m.slug not in slugs:
                m.concept_id = dst.id
                d["misc_moved"].append(m.id)
        # per-user projections
        for row in list(s.scalars(sa.select(Mastery).where(Mastery.concept_id == src.id))):
            if s.get(Mastery, (row.user_id, dst.id)) is None:
                row.concept_id = dst.id
                d["mastery_moved"].append(row.user_id)
            else:
                d["mastery_dropped"].append(_row(row))
                s.delete(row)
        for card in list(s.scalars(sa.select(KnowledgeCard).where(KnowledgeCard.concept_id == src.id))):
            clash = s.scalar(sa.select(KnowledgeCard).where(KnowledgeCard.user_id == card.user_id,
                                                            KnowledgeCard.concept_id == dst.id,
                                                            KnowledgeCard.status != CardStatus.ARCHIVED))
            if clash is not None and card.status != CardStatus.ARCHIVED:
                d["cards_archived"].append([card.id, card.status.value])
                card.status = CardStatus.ARCHIVED
                s.flush()
            card.concept_id = dst.id
            d["cards_moved"].append(card.id)
        for link in list(s.scalars(sa.select(ConceptLink).where(ConceptLink.concept_id == src.id))):
            clash = s.scalar(sa.select(ConceptLink).where(
                ConceptLink.user_id == link.user_id, ConceptLink.concept_id == dst.id,
                ConceptLink.from_media_id == link.from_media_id, ConceptLink.to_occurrence_id == link.to_occurrence_id))
            if clash is not None:
                d["links_dropped"].append(_row(link))
                s.delete(link)
            else:
                link.concept_id = dst.id
                d["links_moved"].append(link.id)
        s.flush()
        src.status, src.merged_into_id = ConceptStatus.MERGED, dst.id
        for cand in s.scalars(sa.select(ConceptCandidate).where(ConceptCandidate.concept_id == src.id,
                                                                ConceptCandidate.status == CandidateStatus.PENDING)):
            cand.status, cand.resolved_at, cand.resolved_by = CandidateStatus.MERGED, utcnow(), actor
        s.flush()
        return self._log(s, MergeAction.MERGE, src.id, actor, d, other=dst.id).id

    def rollback(self, s: Session, log_id: int, *, actor: str) -> int:
        entry = s.get(ConceptMergeLog, log_id)
        if entry is None or entry.action != MergeAction.MERGE:
            raise ValueError("not a merge")
        if s.scalar(sa.select(ConceptMergeLog.id).where(ConceptMergeLog.reverts_id == log_id)):
            raise ValueError("already rolled back")
        src, dst, d = s.get(Concept, entry.concept_id), s.get(Concept, entry.other_concept_id), entry.detail
        if s.scalar(sa.select(Concept.id).where(Concept.status == ConceptStatus.ACTIVE, Concept.norm_name == src.norm_name,
                                                Concept.id != src.id)):
            raise ValueError("another active concept now uses this name")
        src.status, src.merged_into_id = ConceptStatus.ACTIVE, None
        s.flush()
        for oid in d["occ_moved"]:
            s.get(Occurrence, oid).concept_id = src.id
        for a in d["occ_absorbed"]:
            t = s.get(Occurrence, a["target"])
            if t is not None:
                for e in list(t.evidence):
                    if e.evidence_id in a["added"]:
                        t.evidence.remove(e)
                t.t0, t.t1 = a["target_t"]
            o = _restore(Occurrence, a["row"])
            o.evidence = [OccurrenceEvidence(evidence_id=e, evidence_revision=r) for e, r in a["evidence"]]
            s.add(o)
        for item_id in d["items_moved"]:
            s.execute(sa.delete(ItemConcept).where(ItemConcept.item_id == item_id, ItemConcept.concept_id == dst.id))
            s.add(ItemConcept(item_id=item_id, concept_id=src.id))
        for item_id in d["items_dropped"]:
            s.add(ItemConcept(item_id=item_id, concept_id=src.id))
        for norm in d["aliases_added"]:
            s.execute(sa.delete(ConceptAlias).where(ConceptAlias.concept_id == dst.id, ConceptAlias.norm == norm))
        for mid in d["misc_moved"]:
            s.get(Misconception, mid).concept_id = src.id
        for uid in d["mastery_moved"]:
            s.get(Mastery, (uid, dst.id)).concept_id = src.id
        for row in d["mastery_dropped"]:
            s.add(_restore(Mastery, row))
        for cid in d["cards_moved"]:
            s.get(KnowledgeCard, cid).concept_id = src.id
        s.flush()
        for cid, status in d["cards_archived"]:
            s.get(KnowledgeCard, cid).status = CardStatus(status)
        for lid in d["links_moved"]:
            s.get(ConceptLink, lid).concept_id = src.id
        for row in d["links_dropped"]:
            s.add(_restore(ConceptLink, row))
        s.flush()
        return self._log(s, MergeAction.ROLLBACK, src.id, actor, {"merge": log_id}, other=dst.id, reverts=log_id).id

    def resolve_candidate(self, s: Session, candidate_id: int, *, merge: bool, actor: str) -> int | None:
        cand = s.get(ConceptCandidate, candidate_id)
        if cand is None or cand.status != CandidateStatus.PENDING:
            raise ValueError("no pending candidate")
        if merge:
            return self.merge(s, cand.concept_id, cand.suggested_concept_id, actor=actor)
        cand.status, cand.resolved_at, cand.resolved_by = CandidateStatus.KEPT_SEPARATE, utcnow(), actor
        return None


def _row(obj: Any) -> dict[str, Any]:
    """Column values, JSON-safe, for the merge log."""
    out = {}
    for c in obj.__table__.columns:
        v = getattr(obj, c.key)
        out[c.key] = v.value if hasattr(v, "value") else (v.isoformat() if hasattr(v, "isoformat") else v)
    return out


def _restore(model: type, row: dict[str, Any]) -> Any:
    """Inverse of _row(): parse timestamps back for DateTime columns."""
    from datetime import datetime

    vals = dict(row)
    for c in model.__table__.columns:
        if isinstance(c.type, sa.DateTime) and isinstance(vals.get(c.key), str):
            vals[c.key] = datetime.fromisoformat(vals[c.key])
    return model(**vals)
