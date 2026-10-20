"""Caption parsing (WebVTT / SRT) and sentence building.

Handles YouTube auto-captions, whose cues roll: each cue repeats the previous line and
carries inline word timestamps. We de-duplicate repeated lines, then rebuild sentences
from punctuation, long pauses, or a word limit (auto-captions have little punctuation).
"""
from __future__ import annotations

import html
import re
from dataclasses import dataclass

from seedots.common.timefmt import fmt_ts  # noqa: F401  (re-export)

TS = r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})"
CUE_LINE = re.compile(rf"^\s*{TS}\s*-->\s*{TS}")
TAG = re.compile(r"<[^>]+>")


@dataclass
class Segment:
    start: float
    end: float
    text: str


@dataclass
class Sentence:
    t0: float
    t1: float
    text: str


def _secs(h: str | None, m: str, s: str, ms: str) -> float:
    return int(h or 0) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000


def _clean(line: str) -> str:
    line = TAG.sub("", line)
    line = html.unescape(line)
    line = re.sub(r"\[(?:Music|Applause|Laughter|音乐|掌声)\]", "", line, flags=re.I)
    return re.sub(r"\s+", " ", line).strip()


def parse_cues(text: str) -> list[Segment]:
    """Parse VTT or SRT into raw cues (text may contain several lines joined by \n)."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    out: list[Segment] = []
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        m = CUE_LINE.match(lines[i])
        if not m:
            i += 1
            continue
        g = m.groups()
        start, end = _secs(*g[0:4]), _secs(*g[4:8])
        i += 1
        body: list[str] = []
        # a cue ends at a truly empty line; YouTube cues may start with a line holding one space
        while i < len(lines) and lines[i] != "":
            body.append(lines[i])
            i += 1
        out.append(Segment(start, end, "\n".join(body)))
    return out


def dedupe_segments(cues: list[Segment]) -> list[Segment]:
    """Turn (possibly rolling) cues into non-overlapping text segments."""
    segs: list[Segment] = []
    last_line = ""
    for cue in cues:
        if cue.end - cue.start < 0.05:  # YouTube's 10ms transition cues
            continue
        for raw in cue.text.split("\n"):
            line = _clean(raw)
            if not line or line == last_line:
                continue
            if segs and line.startswith(last_line) and last_line:
                # extended version of the previous line: keep only the new tail
                tail = line[len(last_line):].strip()
                last_line = line
                if tail:
                    segs.append(Segment(cue.start, cue.end, tail))
                continue
            segs.append(Segment(cue.start, cue.end, line))
            last_line = line
    # make times monotonic
    for a, b in zip(segs, segs[1:]):
        if b.start < a.start:
            b.start = a.start
        if a.end > b.start and b.start > a.start:
            a.end = b.start
    return segs


SENT_SPLIT = re.compile(r"(?<=[.!?。！？])\s+")
END_PUNCT = re.compile(r"[.!?。！？][\"')\]]*$")


def build_sentences(segments: list[Segment], max_words: int = 32, pause: float = 1.5) -> list[Sentence]:
    """Group segments into sentences; a cue that holds several sentences is split with
    times interpolated by character position."""
    pieces: list[Segment] = []
    for seg in segments:
        parts = [p for p in SENT_SPLIT.split(seg.text) if p.strip()]
        if len(parts) <= 1:
            pieces.append(seg)
            continue
        total = sum(len(p) for p in parts) or 1
        t = seg.start
        dur = max(seg.end - seg.start, 0.0)
        for p in parts:
            d = dur * len(p) / total
            pieces.append(Segment(t, t + d, p))
            t += d

    sentences: list[Sentence] = []
    buf: list[Segment] = []

    def flush() -> None:
        if buf:
            text = " ".join(s.text for s in buf).strip()
            if text:
                sentences.append(Sentence(round(buf[0].start, 3), round(buf[-1].end, 3), text))
            buf.clear()

    for piece in pieces:
        if buf and piece.start - buf[-1].end >= pause:
            flush()
        buf.append(piece)
        words = sum(len(s.text.split()) for s in buf)
        if END_PUNCT.search(piece.text) or words >= max_words:
            flush()
    flush()
    return sentences


def parse_to_sentences(caption_text: str) -> list[Sentence]:
    return build_sentences(dedupe_segments(parse_cues(caption_text)))

