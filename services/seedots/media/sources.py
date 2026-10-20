"""Source adapters: decide how a video is obtained and what the pipeline can do with it.

  Upload    - we hold the file (+ a caption sidecar for now; ASR not configured yet)
  Platform  - YouTube: official embed for playback; we never download the video.
              In this dev build captions come from the platform's caption track
              (subtitles only, --skip-download). The production route per the plan is a
              model that reads the link directly (e.g. Gemini via TokenRouter's gemini format).
  WebPage   - mediagrab (Kiwi) integration: not wired in this build.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from seedots.common.contracts import Capabilities


class SourceError(RuntimeError):
    """A failure the user can act on; message is shown in the UI."""


@dataclass
class Registration:
    dedupe_key: str
    title: str
    duration: float | None
    capabilities: Capabilities
    platform_meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class CaptionTrack:
    text: str
    source: str          # caption | auto_caption | manual
    language: str


class SourceAdapter(Protocol):
    kind: str

    def register(self, uri: str) -> Registration: ...

    def captions(self, uri: str, language: str, media_dir: Path) -> CaptionTrack: ...


# ------------------------------------------------------------------ YouTube

YT_PATTERNS = [
    r"(?:youtube\.com/watch\?(?:.*&)?v=)([\w-]{11})",
    r"(?:youtu\.be/)([\w-]{11})",
    r"(?:youtube\.com/(?:embed|shorts|live)/)([\w-]{11})",
]


def youtube_id(uri: str) -> str | None:
    for p in YT_PATTERNS:
        m = re.search(p, uri)
        if m:
            return m.group(1)
    if re.fullmatch(r"[\w-]{11}", uri):
        return uri
    return None


def _ytdlp_cmd() -> list[str]:
    exe = shutil.which("yt-dlp")
    if exe:
        return [exe]
    try:
        import yt_dlp  # noqa: F401
        return [sys.executable, "-m", "yt_dlp"]
    except ImportError as exc:
        raise SourceError("yt-dlp is not installed (pip install yt-dlp)") from exc


def _run(args: list[str], timeout: int = 120) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise SourceError("Timed out while contacting the platform") from exc


class YouTubeAdapter:
    kind = "platform"

    def register(self, uri: str) -> Registration:
        vid = youtube_id(uri)
        if not vid:
            raise SourceError("Not a recognisable YouTube link")
        url = f"https://www.youtube.com/watch?v={vid}"
        proc = _run([*_ytdlp_cmd(), "--ignore-config", "--no-playlist", "--skip-download", "-J", url])
        if proc.returncode != 0:
            raise SourceError(_classify(proc.stderr))
        info = json.loads(proc.stdout)
        if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
            raise SourceError("Live or upcoming streams are not supported")
        meta = {
            "video_id": vid,
            "channel": info.get("channel") or info.get("uploader"),
            "playable_in_embed": info.get("playable_in_embed"),
            "made_for_kids": info.get("made_for_kids"),
            "chapters": [{"title": c.get("title"), "t0": c.get("start_time"), "t1": c.get("end_time")}
                         for c in (info.get("chapters") or [])],
            "has_captions": sorted((info.get("subtitles") or {}).keys())[:20],
            "has_auto_captions": "en" in (info.get("automatic_captions") or {}),
        }
        if meta["made_for_kids"]:
            raise SourceError("Videos marked 'made for kids' are not supported")
        if meta["playable_in_embed"] is False:
            raise SourceError("The uploader does not allow this video to be embedded, so it cannot be played here")
        return Registration(
            dedupe_key=f"youtube:{vid}",
            title=info.get("title") or vid,
            duration=info.get("duration"),
            capabilities=Capabilities(has_file=False, frames=False, native_seek=False, playback="youtube_embed"),
            platform_meta=meta,
        )

    def captions(self, uri: str, language: str, media_dir: Path) -> CaptionTrack:
        vid = youtube_id(uri)
        url = f"https://www.youtube.com/watch?v={vid}"
        with tempfile.TemporaryDirectory(dir=media_dir) as tmp:
            for auto, source in ((False, "caption"), (True, "auto_caption")):
                args = [*_ytdlp_cmd(), "--ignore-config", "--no-playlist", "--skip-download",
                        "--sub-langs", f"{language}.*,{language}", "--sub-format", "vtt",
                        "--write-auto-subs" if auto else "--write-subs",
                        "-o", str(Path(tmp) / "%(id)s.%(ext)s"), url]
                proc = _run(args)
                files = sorted(Path(tmp).glob("*.vtt"))
                if proc.returncode == 0 and files:
                    # prefer the exact language track, e.g. foo.en.vtt over foo.en-GB.vtt
                    files.sort(key=lambda p: (p.suffixes[-2:-1] != [f".{language}"], p.name))
                    return CaptionTrack(files[0].read_text(encoding="utf-8"), source, language)
        raise SourceError(f"No {language} captions are available for this video, and speech recognition "
                          f"is not configured yet")


def _classify(stderr: str) -> str:
    s = stderr.lower()
    if "private video" in s:
        return "This video is private"
    if "sign in to confirm your age" in s:
        return "Age-restricted videos are not supported"
    if "not a bot" in s:
        return "YouTube asked for bot verification; try again later"
    if "video unavailable" in s:
        return "This video is unavailable"
    return "Could not read the video from the platform: " + stderr.strip().splitlines()[-1][:200] if stderr.strip() \
        else "Could not read the video from the platform"


# ------------------------------------------------------------------ Upload


class UploadAdapter:
    """`uri` is the stored file path; captions come from a sidecar file next to it."""
    kind = "upload"

    def register(self, uri: str) -> Registration:
        path = Path(uri)
        if not path.exists():
            raise SourceError("Uploaded file is missing")
        import hashlib

        h = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        return Registration(
            dedupe_key=f"sha256:{h.hexdigest()}",
            title=path.stem,
            duration=_probe_duration(path),
            capabilities=Capabilities(has_file=True, frames=True, native_seek=True, playback="file"),
        )

    def captions(self, uri: str, language: str, media_dir: Path) -> CaptionTrack:
        path = Path(uri)
        for ext in (".vtt", ".srt"):
            side = path.with_suffix(ext)
            if side.exists():
                return CaptionTrack(side.read_text(encoding="utf-8", errors="replace"), "caption", language)
        raise SourceError("Upload a .vtt or .srt caption file with the video; speech recognition is not configured yet")


def _probe_duration(path: Path) -> float | None:
    exe = shutil.which("ffprobe")
    if not exe:
        return None
    proc = subprocess.run([exe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                          capture_output=True, text=True)
    try:
        return float(proc.stdout.strip())
    except ValueError:
        return None


# ------------------------------------------------------------------ Web page


class WebPageAdapter:
    kind = "webpage"

    def register(self, uri: str) -> Registration:
        raise SourceError("Web page videos are not wired in this build yet (mediagrab integration is next)")

    def captions(self, uri: str, language: str, media_dir: Path) -> CaptionTrack:
        raise SourceError("Web page videos are not wired in this build yet")


def adapter_for(kind: str, uri: str) -> SourceAdapter:
    if kind == "upload":
        return UploadAdapter()
    if kind == "platform":
        if youtube_id(uri):
            return YouTubeAdapter()
        raise SourceError("Only YouTube links are supported among platforms right now")
    if kind == "webpage":
        return WebPageAdapter()
    raise SourceError(f"Unknown source kind {kind!r}")
