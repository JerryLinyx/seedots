"""Pluggable processors. Each one is a workflow step: it reads what earlier steps stored,
writes evidence (or files), and is idempotent per (media, name, version).

    pass 1 (fast, unblocks learning):  fetch -> transcript -> outline -> publish
    pass 2 (enrichment):               keyframes -> complete

Adding a processor = one class + one line in PIPELINE. Processors declare which media they
apply to (capabilities), so the plan adapts to the source.
"""
from __future__ import annotations

import logging
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, ClassVar, Protocol

from pydantic import BaseModel, Field

from seedots.common.contracts import EvidenceUnit
from seedots.common.db import Database
from seedots.common.llm import Gateway, LLMError
from seedots.common.timefmt import fmt_ts
from seedots.common.workflow import PermanentError
from seedots.media import repo
from seedots.media.asr import Transcriber, transcribe_file
from seedots.media.captions import build_sentences, dedupe_segments, parse_cues
from seedots.media.models import AnalysisJob, FileRole, MediaAsset, MediaFile, MediaStatus
from seedots.media.sources import SourceAdapter, SourceError, sha256_file

log = logging.getLogger("seedots.media.processors")


@dataclass
class StageContext:
    media_id: str
    job_id: str | None
    workdir: Path
    db: Database
    gateway: Gateway | None
    transcriber: Transcriber | None
    adapter: SourceAdapter

    def asset(self) -> dict[str, Any]:
        with self.db.session() as s:
            a = s.get(MediaAsset, self.media_id)
            return {c.name: getattr(a, c.name) for c in MediaAsset.__table__.columns}


class Processor(Protocol):
    name: ClassVar[str]
    version: ClassVar[str]

    def applies(self, asset: dict[str, Any]) -> bool: ...
    def run(self, ctx: StageContext) -> dict[str, Any]: ...


def sid(media_id: str, prefix: str, i: int, width: int = 4) -> str:
    return f"{media_id}.{prefix}{i:0{width}d}"


# ------------------------------------------------------------------------------ fetch
class Fetch:
    name, version = "fetch", "fetch@1"

    def applies(self, asset: dict[str, Any]) -> bool:
        return True

    def run(self, ctx: StageContext) -> dict[str, Any]:
        a = ctx.asset()
        got = ctx.adapter.acquire(a["source_uri"], a["language"], ctx.workdir)
        with ctx.db.session() as s:
            asset = s.get(MediaAsset, ctx.media_id)
            if got.title and asset.source_kind.value == "webpage":
                asset.title = got.title
            if got.duration and not asset.duration_s:
                asset.duration_s = got.duration
            if got.file is not None:
                self._file(s, ctx.media_id, FileRole.ORIGINAL, got.file)
                if asset.content_hash is None:
                    asset.content_hash = "sha256:" + sha256_file(got.file)
            if got.captions:
                cap = ctx.workdir / "captions.vtt"
                cap.write_text(got.captions, encoding="utf-8")
                self._file(s, ctx.media_id, FileRole.CAPTIONS, cap, mime="text/vtt")
        return {"caption_source": got.caption_source, "has_file": got.file is not None}

    @staticmethod
    def _file(s, media_id: str, role: FileRole, path: Path, mime: str | None = None) -> None:
        existing = s.query(MediaFile).filter_by(media_id=media_id, role=role).one_or_none()
        row = existing or MediaFile(id=f"{media_id}.{role.value}", media_id=media_id, role=role)
        row.storage_key, row.mime, row.bytes = str(path), mime, path.stat().st_size
        s.add(row)


def _file_path(ctx: StageContext, role: FileRole) -> Path | None:
    with ctx.db.session() as s:
        row = s.query(MediaFile).filter_by(media_id=ctx.media_id, role=role).one_or_none()
        return Path(row.storage_key) if row else None


# ------------------------------------------------------------------------------ transcript
class Transcript:
    name, version = "transcript", "transcript@1"
    CONF = {"caption": 0.95, "auto_caption": 0.75, "asr": 0.85}

    def applies(self, asset: dict[str, Any]) -> bool:
        return True

    def run(self, ctx: StageContext) -> dict[str, Any]:
        with ctx.db.session() as s:
            fetched = repo.stage_stats(s, ctx.media_id, "fetch")
        captions = _file_path(ctx, FileRole.CAPTIONS)
        if captions is not None:
            source = fetched.get("caption_source") or "caption"
            segments = dedupe_segments(parse_cues(captions.read_text(encoding="utf-8")))
        else:
            original = _file_path(ctx, FileRole.ORIGINAL)
            if original is None:
                raise SourceError("No captions are available and there is no file to transcribe")
            if ctx.transcriber is None:
                raise SourceError("This video has no captions and speech recognition is not configured "
                                  "(set SEEDOTS_ASR_MODEL)")
            source = "asr"
            segments = transcribe_file(ctx.transcriber, original, ctx.asset()["language"], ctx.workdir)
        sentences = build_sentences(segments)
        if not sentences:
            raise SourceError("The transcript is empty")
        conf = self.CONF[source]
        units = [EvidenceUnit(id=sid(ctx.media_id, "s", i + 1), media_id=ctx.media_id, t0=x.t0, t1=x.t1,
                              kind="sentence", content={"text": x.text}, source=source, processor=self.version,
                              confidence=conf, needs_review=_suspicious(x.text, x.t1 - x.t0))
                 for i, x in enumerate(sentences)]
        with ctx.db.session() as s:
            stats = repo.write_evidence(s, ctx.media_id, "sentence", units)
        return {"source": source, "sentences": len(units), **stats}


def _suspicious(text: str, dur: float) -> bool:
    """Cheap flags for sentences a person should check (speech too fast, ASR placeholders)."""
    words = len(text.split())
    return bool(re.search(r"\[(inaudible|unclear|\?)\]", text, re.I)) or (dur > 0 and words / dur > 6.5)


# ------------------------------------------------------------------------------ outline
class ChapterOut(BaseModel):
    title: str = Field(max_length=120)
    summary: str = ""
    start: str
    end: str


class OutlineOut(BaseModel):
    chapters: list[ChapterOut]


class Outline:
    """Chapters as ranges of sentence ids. Sources, best first: creator chapters from the
    platform, the outline model, then fixed windows (flagged for review)."""
    name, version = "outline", "outline@2"

    def applies(self, asset: dict[str, Any]) -> bool:
        return True

    def run(self, ctx: StageContext) -> dict[str, Any]:
        a = ctx.asset()
        with ctx.db.session() as s:
            sentences = repo.current_evidence(s, ctx.media_id, ["sentence"])
        if not sentences:
            raise PermanentError("outline needs sentences")
        hints = (a.get("platform_meta") or {}).get("chapters") or []
        ranges, source, conf = self._from_platform(sentences, hints), "platform_chapters", 0.9
        if not ranges:
            try:
                ranges, source, conf = self._from_model(ctx, a, sentences, hints), "llm_outline", 0.8
            except LLMError as exc:
                log.warning("outline model failed for %s: %s", ctx.media_id, exc)
                ranges, source, conf = window_ranges(sentences), "heuristic", 0.5
        units = [EvidenceUnit(
            id=sid(ctx.media_id, "c", k + 1, 2), media_id=ctx.media_id, t0=sentences[i].t0, t1=sentences[j].t1,
            kind="chapter", content={"title": title, "summary": summary,
                                     "sentence_ids": [x.id for x in sentences[i:j + 1]]},
            source=source, processor=self.version, confidence=conf, needs_review=conf < 0.6)
            for k, (i, j, title, summary) in enumerate(ranges)]
        with ctx.db.session() as s:
            stats = repo.write_evidence(s, ctx.media_id, "chapter", units)
        return {"source": source, "chapters": len(units), **stats}

    @staticmethod
    def _from_platform(sentences: list[EvidenceUnit], hints: list[dict]) -> list[tuple[int, int, str, str]]:
        if len(hints) < 2:
            return []
        starts: list[tuple[int, str]] = []
        for h in hints:
            t = float(h.get("t0") or 0)
            i = next((k for k, x in enumerate(sentences) if x.t1 > t), None)
            if i is not None and (not starts or i > starts[-1][0]):
                starts.append((i, str(h.get("title") or "").strip() or f"Part {len(starts) + 1}"))
        if len(starts) < 2:
            return []
        starts[0] = (0, starts[0][1])
        return [(i, (starts[k + 1][0] - 1) if k + 1 < len(starts) else len(sentences) - 1, title, "")
                for k, (i, title) in enumerate(starts)]

    def _from_model(self, ctx: StageContext, a: dict, sentences: list[EvidenceUnit],
                    hints: list[dict]) -> list[tuple[int, int, str, str]]:
        if ctx.gateway is None:
            raise LLMError("no gateway")
        lines = "\n".join(f"{x.short} [{fmt_ts(x.t0)}] {x.content['text'][:220]}" for x in sentences)
        hint_txt = "; ".join(f"{h.get('title')} @ {fmt_ts(h.get('t0') or 0)}" for h in hints) or "none"
        out = ctx.gateway.run("outline", {"title": a.get("title") or "", "hints": hint_txt, "sentences": lines},
                              manifest={"media_id": ctx.media_id, "sentences": len(sentences)})
        return normalize_ranges(out.chapters, {x.short: i for i, x in enumerate(sentences)}, len(sentences))


def normalize_ranges(chapters: list[ChapterOut], index: dict[str, int], n: int) -> list[tuple[int, int, str, str]]:
    """Repair model ranges into a contiguous, ordered cover of all n sentences."""
    starts = sorted({(index[c.start], c.title.strip() or "Untitled", c.summary.strip())
                     for c in chapters if c.start in index})
    dedup: list[tuple[int, str, str]] = []
    for st in starts:
        if not dedup or st[0] != dedup[-1][0]:
            dedup.append(st)
    if not dedup:
        raise LLMError("outline referenced no known sentence ids")
    dedup[0] = (0, dedup[0][1], dedup[0][2])
    return [(st, (dedup[k + 1][0] - 1) if k + 1 < len(dedup) else n - 1, title, summ)
            for k, (st, title, summ) in enumerate(dedup)]


def window_ranges(sentences: list[EvidenceUnit], span: float = 180.0) -> list[tuple[int, int, str, str]]:
    out: list[tuple[int, int, str, str]] = []
    start = 0
    for i, x in enumerate(sentences):
        if x.t1 - sentences[start].t0 >= span or i == len(sentences) - 1:
            out.append((start, i, f"Part {len(out) + 1}", ""))
            start = i + 1
    return out


# ------------------------------------------------------------------------------ publish
def order_by_priority(chapters: list[EvidenceUnit], t: float | None) -> list[EvidenceUnit]:
    """Chapters from the playback position onward first, then the earlier ones."""
    if t is None:
        return chapters
    idx = next((i for i, c in enumerate(chapters) if c.t0 <= t < c.t1), 0)
    return chapters[idx:] + chapters[:idx]


class Publish:
    """Announce the outline, then each chapter in playback-priority order. Learning content
    generation starts from these events, so learners get material while pass 2 runs."""
    name, version = "publish", "publish@1"

    def applies(self, asset: dict[str, Any]) -> bool:
        return True

    def run(self, ctx: StageContext) -> dict[str, Any]:
        with ctx.db.session() as s:
            chapters = repo.current_evidence(s, ctx.media_id, ["chapter"])
            job = s.get(AnalysisJob, ctx.job_id) if ctx.job_id else None
            priority = job.priority_from if job else None
            repo.emit(s, ctx.media_id, "media.outline_ready", {"chapters": [
                {"id": c.id, "revision": c.revision, "t0": c.t0, "t1": c.t1, "title": c.content["title"]}
                for c in chapters]})
            for c in order_by_priority(chapters, priority):
                repo.emit(s, ctx.media_id, "media.chapter_ready",
                          {"chapter_id": c.id, "revision": c.revision, "t0": c.t0, "t1": c.t1,
                           "title": c.content["title"]})
            s.get(MediaAsset, ctx.media_id).status_detail = "enriching"
        return {"chapters": len(chapters), "priority_from": priority}


# ------------------------------------------------------------------------------ keyframes (pass 2)
class Keyframes:
    """Scene-change frames as keyframe evidence (no model needed). Region evidence (formulas,
    diagrams) builds on these once a vision processor is configured."""
    name, version = "keyframes", "keyframes@1"
    THRESHOLD, MIN_GAP, MAX_FRAMES = 0.32, 4.0, 240

    def applies(self, asset: dict[str, Any]) -> bool:
        return bool((asset.get("capabilities") or {}).get("frames")) and shutil.which("ffmpeg") is not None

    def run(self, ctx: StageContext) -> dict[str, Any]:
        video = _file_path(ctx, FileRole.ORIGINAL)
        if video is None:
            return {"skipped": "no file"}
        out = ctx.workdir / "frames"
        if out.exists():
            shutil.rmtree(out)
        out.mkdir(parents=True)
        proc = subprocess.run(
            ["ffmpeg", "-v", "info", "-i", str(video), "-vf",
             f"select='eq(n\\,0)+gt(scene\\,{self.THRESHOLD})',showinfo,scale=640:-2",
             "-vsync", "vfr", "-q:v", "4", str(out / "f%05d.jpg")],
            capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError("ffmpeg keyframes failed: " + proc.stderr.strip()[-200:])
        times = [float(m) for m in re.findall(r"pts_time:([\d.]+)", proc.stderr)]
        frames = sorted(out.glob("f*.jpg"))
        units: list[EvidenceUnit] = []
        last = -1e9
        for t, f in zip(times, frames):
            if t - last < self.MIN_GAP or len(units) >= self.MAX_FRAMES:
                f.unlink()
                continue
            name = f"k{len(units) + 1:04d}.jpg"
            f.rename(out / name)
            units.append(EvidenceUnit(id=sid(ctx.media_id, "k", len(units) + 1), media_id=ctx.media_id, t0=t, t1=t,
                                      kind="keyframe", content={}, frame_ref=f"frames/{name}", source="heuristic",
                                      processor=self.version, confidence=1.0))
            last = t
        for f in out.glob("f*.jpg"):
            f.unlink()
        with ctx.db.session() as s:
            stats = repo.write_evidence(s, ctx.media_id, "keyframe", units)
        return {"keyframes": len(units), **stats}


class Complete:
    name, version = "complete", "complete@1"

    def applies(self, asset: dict[str, Any]) -> bool:
        return True

    def run(self, ctx: StageContext) -> dict[str, Any]:
        with ctx.db.session() as s:
            a = s.get(MediaAsset, ctx.media_id)
            a.status, a.status_detail = MediaStatus.READY, ""
            kinds = {u.kind for u in repo.current_evidence(s, ctx.media_id)}
            repo.emit(s, ctx.media_id, "media.analysis_completed", {"evidence_kinds": sorted(kinds)})
        return {}


PIPELINE: list[Processor] = [Fetch(), Transcript(), Outline(), Publish(), Keyframes(), Complete()]
BY_NAME: dict[str, Processor] = {p.name: p for p in PIPELINE}
