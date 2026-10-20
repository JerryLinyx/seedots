"""Processors turn a source into EvidenceUnits. All share one shape:
`run(...) -> list[EvidenceUnit]` so new ones (ASR, keyframes, region OCR) slot in later."""
from __future__ import annotations

from pydantic import BaseModel, Field

from seedots.common.contracts import EvidenceUnit
from seedots.common.llm import Gateway, LLMError
from seedots.media.captions import Sentence, fmt_ts, parse_to_sentences

CAPTIONS_VERSION = "captions@1"
OUTLINE_VERSION = "outline@1"


def sentence_id(media_id: str, i: int) -> str:
    return f"{media_id}.s{i:04d}"


def short(eid: str) -> str:
    return eid.rsplit(".", 1)[-1]


def caption_evidence(media_id: str, caption_text: str, source: str) -> list[EvidenceUnit]:
    sentences: list[Sentence] = parse_to_sentences(caption_text)
    conf = 0.75 if source == "auto_caption" else 0.95
    return [
        EvidenceUnit(id=sentence_id(media_id, i + 1), media_id=media_id, t0=s.t0, t1=s.t1, kind="sentence",
                     content={"text": s.text}, source=source, processor=CAPTIONS_VERSION, confidence=conf)
        for i, s in enumerate(sentences)
    ]


class ChapterOut(BaseModel):
    title: str = Field(max_length=120)
    summary: str = ""
    start: str
    end: str


class OutlineOut(BaseModel):
    chapters: list[ChapterOut]


def _window_chapters(sentences: list[EvidenceUnit], span: float = 180.0) -> list[tuple[int, int, str, str]]:
    out: list[tuple[int, int, str, str]] = []
    start = 0
    for i, s in enumerate(sentences):
        if s.t1 - sentences[start].t0 >= span or i == len(sentences) - 1:
            out.append((start, i, f"Part {len(out) + 1}", ""))
            start = i + 1
    return [c for c in out if c[0] <= c[1]]


def _normalize(chapters: list[ChapterOut], index: dict[str, int], n: int) -> list[tuple[int, int, str, str]]:
    """Repair the model's ranges into a contiguous cover of [0, n)."""
    starts = []
    for c in chapters:
        if c.start in index:
            starts.append((index[c.start], c.title.strip() or "Untitled", c.summary.strip()))
    starts.sort()
    dedup: list[tuple[int, str, str]] = []
    for s in starts:
        if not dedup or s[0] != dedup[-1][0]:
            dedup.append(s)
    if not dedup:
        raise LLMError("outline referenced no known sentence ids")
    if dedup[0][0] != 0:
        dedup[0] = (0, dedup[0][1], dedup[0][2])
    out = []
    for k, (st, title, summ) in enumerate(dedup):
        end = dedup[k + 1][0] - 1 if k + 1 < len(dedup) else n - 1
        out.append((st, end, title, summ))
    return out


def outline_evidence(media_id: str, title: str, sentences: list[EvidenceUnit], hints: list[dict],
                     gateway: Gateway | None) -> list[EvidenceUnit]:
    if not sentences:
        return []
    index = {short(s.id): i for i, s in enumerate(sentences)}
    source, processor, conf = "llm_outline", OUTLINE_VERSION, 0.8
    try:
        if gateway is None:
            raise LLMError("no gateway")
        lines = "\n".join(f"{short(s.id)} [{fmt_ts(s.t0)}] {s.content['text'][:220]}" for s in sentences)
        hint_txt = "; ".join(f"{h.get('title')} @ {fmt_ts(h.get('t0') or 0)}" for h in hints) or "none"
        out = gateway.run("outline", {"title": title, "hints": hint_txt, "sentences": lines}, OutlineOut,
                          evidence_ids=[s.id for s in sentences])
        ranges = _normalize(out.chapters, index, len(sentences))
    except LLMError:
        ranges = _window_chapters(sentences)
        source, processor, conf = "manual", "outline-fallback@1", 0.5

    units = []
    for k, (a, b, t, summ) in enumerate(ranges):
        ids = [s.id for s in sentences[a:b + 1]]
        units.append(EvidenceUnit(
            id=f"{media_id}.c{k + 1:02d}", media_id=media_id, t0=sentences[a].t0, t1=sentences[b].t1,
            kind="chapter", content={"title": t, "summary": summ, "sentence_ids": ids},
            source=source, processor=processor, confidence=conf, needs_review=conf < 0.6))
    return units
