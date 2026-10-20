"""Speech recognition port: used only when a source has no usable caption track.

Implementation: any OpenAI-compatible `/audio/transcriptions` endpoint (Whisper-style,
`response_format=verbose_json` with segment timestamps). Configure SEEDOTS_ASR_MODEL
(and optionally SEEDOTS_ASR_BASE_URL / SEEDOTS_ASR_API_KEY).
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Protocol

from seedots.common.config import ModelEndpoint
from seedots.common.workflow import PermanentError
from seedots.media.captions import Segment

MAX_UPLOAD_BYTES = 24 * 1024 * 1024        # common provider limit; longer audio is chunked


class Transcriber(Protocol):
    name: str

    def transcribe(self, audio: Path, language: str) -> list[Segment]: ...


def extract_audio(video: Path, out_dir: Path, chunk_s: int = 600) -> list[tuple[Path, float]]:
    """Mono 16 kHz MP3 chunks (path, offset seconds). Small enough for hosted ASR limits."""
    if not shutil.which("ffmpeg"):
        raise PermanentError("ffmpeg is required for speech recognition")
    out_dir.mkdir(parents=True, exist_ok=True)
    pattern = out_dir / "audio_%03d.mp3"
    proc = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(video), "-vn", "-ac", "1", "-ar", "16000",
                           "-b:a", "48k", "-f", "segment", "-segment_time", str(chunk_s), str(pattern)],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        raise PermanentError("Could not read an audio track from the file: " + proc.stderr.strip()[-200:])
    chunks = sorted(out_dir.glob("audio_*.mp3"))
    if not chunks:
        raise PermanentError("The file has no audio track")
    return [(p, i * chunk_s) for i, p in enumerate(chunks)]


class OpenAITranscriber:
    def __init__(self, endpoint: ModelEndpoint):
        self.endpoint = endpoint
        self.name = f"asr:{endpoint.model}"

    def transcribe(self, audio: Path, language: str) -> list[Segment]:
        import httpx

        if audio.stat().st_size > MAX_UPLOAD_BYTES:
            raise PermanentError("audio chunk exceeds the transcription upload limit")
        with audio.open("rb") as f:
            r = httpx.post(f"{self.endpoint.base_url}/audio/transcriptions",
                           headers={"Authorization": f"Bearer {self.endpoint.api_key}"},
                           data={"model": self.endpoint.model, "language": language,
                                 "response_format": "verbose_json", "timestamp_granularities[]": "segment"},
                           files={"file": (audio.name, f, "audio/mpeg")}, timeout=600)
        if r.status_code >= 400:
            raise RuntimeError(f"ASR HTTP {r.status_code}: {r.text[:200]}")   # transient: retried
        body = r.json()
        segs = body.get("segments") or []
        if not segs and body.get("text"):
            raise PermanentError("the ASR endpoint returned no timestamps (needs verbose_json segments)")
        return [Segment(float(s["start"]), float(s["end"]), str(s.get("text", "")).strip()) for s in segs
                if str(s.get("text", "")).strip()]


def transcribe_file(t: Transcriber, video: Path, language: str, workdir: Path) -> list[Segment]:
    out: list[Segment] = []
    for chunk, offset in extract_audio(video, workdir / "asr"):
        out += [Segment(s.start + offset, s.end + offset, s.text) for s in t.transcribe(chunk, language)]
    return out


def build_transcriber(endpoint: ModelEndpoint) -> Transcriber | None:
    return OpenAITranscriber(endpoint) if endpoint.configured else None
