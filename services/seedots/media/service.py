"""Application layer of the foundation: register -> analyze (workflow of processor steps) ->
publish events; plus corrections and webhook subscriptions.

MediaService is the StepRunner for both workflow engines (in-process and Temporal)."""
from __future__ import annotations

import logging
from datetime import timedelta
from pathlib import Path
from typing import Any

import sqlalchemy as sa

from seedots.common.contracts import EvidenceUnit
from seedots.common.db import Database, utcnow
from seedots.common.ids import new_id
from seedots.common.llm import Gateway
from seedots.common.workflow import Engine, PermanentError
from seedots.media import repo
from seedots.media.asr import Transcriber
from seedots.media.models import (AnalysisJob, JobStatus, MediaAsset, MediaStatus, SourceKind, StageRun,
                                  StageStatus, Visibility, WebhookSubscription)
from seedots.media.processors import BY_NAME, PIPELINE, StageContext
from seedots.media.sources import SourceError, adapter_for

log = logging.getLogger("seedots.media")

ANALYZE = "media.analyze"
PLATFORM_META_TTL = timedelta(days=30)      # YouTube API policy: refresh or drop within 30 days


class MediaService:
    def __init__(self, db: Database, *, data_dir: Path, gateway: Gateway | None, transcriber: Transcriber | None,
                 grabber_dir: Path):
        self.db, self.data_dir, self.gateway, self.transcriber = db, data_dir, gateway, transcriber
        self.grabber_dir = grabber_dir
        self.engine: Engine | None = None      # set by the container (engine needs the runner first)

    # ================================================================== register
    def register(self, *, kind: str, uri: str, visibility: str, owner: str | None, language: str,
                 rights_attestation: dict[str, Any] | None) -> str:
        if kind == "webpage" and not (rights_attestation and rights_attestation.get("statement")):
            raise SourceError("Confirm you have the right to use this video before adding a web page")
        if kind == "platform":
            visibility, owner = "public", None
        elif visibility != "private" or not owner:
            visibility = "private"           # uploads and web grabs are isolated per owner
            if not owner:
                raise SourceError("Private media needs an owner")
        reg = adapter_for(kind, uri, self.grabber_dir).register(uri)
        with self.db.session() as s:
            q = sa.select(MediaAsset).where(MediaAsset.dedupe_key == reg.dedupe_key,
                                            MediaAsset.visibility == visibility)
            if visibility == "private":
                q = q.where(MediaAsset.owner_id == owner)
            existing = s.scalar(q)
            if existing:
                return existing.id
            media_id = new_id("med")
            s.add(MediaAsset(
                id=media_id, source_kind=kind, source_uri=uri, platform=reg.platform, external_id=reg.external_id,
                content_hash=reg.content_hash, dedupe_key=reg.dedupe_key, visibility=visibility, owner_id=owner,
                language=language, title=reg.title, duration_s=reg.duration,
                capabilities=reg.capabilities.model_dump(), platform_meta=reg.platform_meta,
                platform_meta_expires_at=utcnow() + PLATFORM_META_TTL if reg.platform_meta else None,
                rights_attestation={**rights_attestation, "at": utcnow().isoformat(), "source_url": uri}
                if rights_attestation else None))
            s.flush()
            repo.emit(s, media_id, "media.registered", {"title": reg.title})
        return media_id

    # ================================================================== analyze
    def analyze(self, media_id: str, priority_from: float | None = None) -> str:
        """Start (or join) the analysis job. Re-analysing a finished media re-runs only the
        steps whose processor version changed."""
        with self.db.session() as s:
            a = s.get(MediaAsset, media_id)
            if a is None:
                raise KeyError(media_id)
            live = s.scalar(sa.select(AnalysisJob).where(AnalysisJob.media_id == media_id,
                                                         AnalysisJob.status.in_(["accepted", "running"])))
            if live:
                if priority_from is not None:
                    live.priority_from = priority_from
                return live.id
            job = AnalysisJob(id=new_id("job"), media_id=media_id, status=JobStatus.ACCEPTED,
                              priority_from=priority_from, engine=type(self.engine).__name__,
                              workflow_id=f"analyze-{media_id}")
            s.add(job)
            a.status, a.status_detail = MediaStatus.ANALYZING, "queued"
            job_id = job.id
        self.engine.start(ANALYZE, f"analyze-{media_id}", {"media_id": media_id, "job_id": job_id})
        return job_id

    def resume(self) -> int:
        """After a restart (in-process engine): pick unfinished jobs up again."""
        with self.db.session() as s:
            jobs = [(j.media_id, j.id) for j in s.scalars(sa.select(AnalysisJob).where(
                AnalysisJob.status.in_(["accepted", "running"])))]
        for media_id, job_id in jobs:
            self.engine.start(ANALYZE, f"analyze-{media_id}", {"media_id": media_id, "job_id": job_id})
        return len(jobs)

    # ------------------------------------------------------------------ StepRunner
    def plan(self, workflow: str, arg: dict[str, Any]) -> list[str]:
        with self.db.session() as s:
            a = s.get(MediaAsset, arg["media_id"])
            snapshot = {"capabilities": a.capabilities, "source_kind": a.source_kind.value}
            job = s.get(AnalysisJob, arg.get("job_id")) if arg.get("job_id") else None
            if job:
                job.status, job.started_at = JobStatus.RUNNING, job.started_at or utcnow()
        return [p.name for p in PIPELINE if p.applies(snapshot)]

    def run_step(self, workflow: str, arg: dict[str, Any], step: str) -> None:
        media_id = arg["media_id"]
        proc = BY_NAME[step]
        with self.db.session() as s:
            run = repo.stage_run(s, media_id, step, proc.version)
            if run and run.status == StageStatus.DONE:
                return
            if run is None:
                run = StageRun(media_id=media_id, stage=step, processor_version=proc.version, attempts=0)
                s.add(run)
            run.status, run.job_id, run.attempts = StageStatus.RUNNING, arg.get("job_id"), run.attempts + 1
            run.started_at, run.error = utcnow(), None
            a = s.get(MediaAsset, media_id)
            a.status_detail = step
            source_kind, uri = a.source_kind.value, a.source_uri
        ctx = StageContext(media_id=media_id, job_id=arg.get("job_id"), workdir=self.workdir(media_id), db=self.db,
                           gateway=self.gateway, transcriber=self.transcriber,
                           adapter=adapter_for(source_kind, uri, self.grabber_dir))
        try:
            stats = proc.run(ctx)
        except Exception as exc:
            with self.db.session() as s:
                run = repo.stage_run(s, media_id, step, proc.version)
                run.status, run.error, run.finished_at = StageStatus.FAILED, str(exc)[:500], utcnow()
            raise
        with self.db.session() as s:
            run = repo.stage_run(s, media_id, step, proc.version)
            run.status, run.stats, run.finished_at = StageStatus.DONE, stats or {}, utcnow()
            if step == PIPELINE[-1].name and arg.get("job_id"):
                job = s.get(AnalysisJob, arg["job_id"])
                job.status, job.finished_at = JobStatus.COMPLETED, utcnow()

    def failed(self, workflow: str, arg: dict[str, Any], error: str) -> None:
        media_id = arg["media_id"]
        with self.db.session() as s:
            a = s.get(MediaAsset, media_id)
            a.status, a.status_detail = MediaStatus.FAILED, error[:500]
            if arg.get("job_id"):
                job = s.get(AnalysisJob, arg["job_id"])
                job.status, job.error, job.finished_at = JobStatus.FAILED, error[:500], utcnow()
            repo.emit(s, media_id, "media.failed", {"reason": error[:500]})

    def workdir(self, media_id: str) -> Path:
        d = self.data_dir / "media" / media_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    # ================================================================== corrections
    def correct_sentence(self, evidence_id: str, text: str, by: str) -> EvidenceUnit:
        """A user correction is a new revision; the old one stays for audit and for content
        that already cites it. Consumers learn about it from media.evidence_revised."""
        text = text.strip()
        if not text:
            raise PermanentError("Text cannot be empty")
        with self.db.session() as s:
            row = repo.evidence_row(s, evidence_id)
            if row is None:
                raise KeyError(evidence_id)
            if row.kind.value != "sentence":
                raise PermanentError("Only sentence text can be corrected")
            units = [u if u.id != evidence_id else u.model_copy(update={
                "content": {"text": text}, "source": "user_correction", "processor": f"user:{by}",
                "confidence": 1.0, "needs_review": False}) for u in repo.current_evidence(s, row.media_id, ["sentence"])]
            repo.write_evidence(s, row.media_id, "sentence", units)
            new = repo.to_unit(repo.evidence_row(s, evidence_id))
            repo.emit(s, row.media_id, "media.evidence_revised",
                      {"evidence_id": new.id, "revision": new.revision, "kind": "sentence"})
        return new

    # ================================================================== subscriptions
    def subscribe(self, url: str, secret: str, event_types: list[str] | None = None) -> str:
        with self.db.session() as s:
            sub = s.scalar(sa.select(WebhookSubscription).where(WebhookSubscription.url == url))
            if sub is None:
                sub = WebhookSubscription(id=new_id("sub"), url=url, secret=secret)
                s.add(sub)
            sub.secret, sub.event_types, sub.active = secret, event_types or [], True
            return sub.id


__all__ = ["ANALYZE", "MediaService", "SourceKind", "Visibility"]
