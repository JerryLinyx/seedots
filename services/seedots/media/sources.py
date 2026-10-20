"""Source adapters: how a video is obtained and what the pipeline can do with it.

  Upload    we hold the file; captions from a sidecar if given, otherwise ASR.
  Platform  YouTube: played with the official embed only. We never download the video;
            transcripts come from the platform caption track (subtitles only).
  WebPage   any page with a video, via the vendored mediagrab (services/grabber):
            network sniffing, HLS/DASH/MSE capture, yt-dlp hybrid. Requires the user's
            rights attestation; DRM is refused. We hold the file, so ASR and frames work.

register() is fast and decides identity + capabilities. acquire() runs inside the
analysis workflow and may take minutes.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlparse

from seedots.common.contracts import Capabilities
from seedots.common.platforms import youtube_id
from seedots.common.workflow import PermanentError


class SourceError(PermanentError):
    """A failure the user can act on; the message is shown in the UI."""


@dataclass
class Registration:
    dedupe_key: str
    title: str
    duration: float | None
    capabilities: Capabilities
    platform: str | None = None
    external_id: str | None = None
    content_hash: str | None = None
    platform_meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class Acquired:
    file: Path | None = None              # a media file we hold
    captions: str | None = None           # VTT / SRT text
    caption_source: str | None = None     # caption | auto_caption
    title: str | None = None
    duration: float | None = None
    mime: str | None = None


class SourceAdapter(Protocol):
    kind: str

    def register(self, uri: str) -> Registration: ...

    def acquire(self, uri: str, language: str, workdir: Path) -> Acquired: ...


def _run(args: list[str], timeout: int = 180, cwd: Path | None = None) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout, cwd=cwd)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("timed out while fetching the source") from exc     # transient
    except FileNotFoundError as exc:
        raise SourceError(f"{args[0]} is not installed") from exc


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def probe_duration(path: Path) -> float | None:
    if not shutil.which("ffprobe"):
        return None
    proc = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                           str(path)], capture_output=True, text=True)
    try:
        return float(proc.stdout.strip())
    except ValueError:
        return None


def _sidecar_captions(path: Path) -> str | None:
    for ext in (".vtt", ".srt"):
        side = path.with_suffix(ext)
        if side.exists():
            return side.read_text(encoding="utf-8", errors="replace")
    return None


# ------------------------------------------------------------------------------ YouTube
def _ytdlp() -> list[str]:
    exe = shutil.which("yt-dlp")
    if exe:
        return [exe, "--ignore-config", "--no-playlist"]
    try:
        import yt_dlp  # noqa: F401
    except ImportError as exc:
        raise SourceError("yt-dlp is not installed (pip install yt-dlp)") from exc
    return [sys.executable, "-m", "yt_dlp", "--ignore-config", "--no-playlist"]


def classify_ytdlp(stderr: str) -> Exception:
    s = stderr.lower()
    for needle, msg in (("private video", "This video is private"),
                        ("sign in to confirm your age", "Age-restricted videos are not supported"),
                        ("members-only", "Members-only videos are not supported"),
                        ("video unavailable", "This video is unavailable"),
                        ("drm", "DRM-protected videos are not supported")):
        if needle in s:
            return SourceError(msg)
    if "not a bot" in s or "429" in s or "timed out" in s:
        return RuntimeError("The platform asked us to slow down; retrying")   # transient
    tail = stderr.strip().splitlines()[-1][:200] if stderr.strip() else ""
    return SourceError("Could not read the video from the platform" + (f": {tail}" if tail else ""))


class YouTubeAdapter:
    kind = "platform"

    def register(self, uri: str) -> Registration:
        vid = youtube_id(uri)
        if not vid:
            raise SourceError("Not a recognisable YouTube link")
        proc = _run([*_ytdlp(), "--skip-download", "-J", f"https://www.youtube.com/watch?v={vid}"])
        if proc.returncode != 0:
            raise classify_ytdlp(proc.stderr)
        info = json.loads(proc.stdout)
        if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
            raise SourceError("Live or upcoming streams are not supported")
        if info.get("playable_in_embed") is False:
            raise SourceError("The uploader does not allow this video to be embedded, so it cannot be played here")
        if info.get("made_for_kids"):
            raise SourceError("Videos marked 'made for kids' are not supported")
        meta = {
            "video_id": vid,
            "channel": info.get("channel") or info.get("uploader"),
            "chapters": [{"title": c.get("title"), "t0": c.get("start_time"), "t1": c.get("end_time")}
                         for c in (info.get("chapters") or [])],
            "caption_languages": sorted((info.get("subtitles") or {}).keys())[:30],
            "auto_caption_languages": sorted((info.get("automatic_captions") or {}).keys())[:30],
        }
        return Registration(
            dedupe_key=f"youtube:{vid}", title=info.get("title") or vid, duration=info.get("duration"),
            capabilities=Capabilities(has_file=False, frames=False, native_seek=False, playback="youtube_embed"),
            platform="youtube", external_id=vid, platform_meta=meta)

    def acquire(self, uri: str, language: str, workdir: Path) -> Acquired:
        vid = youtube_id(uri)
        url = f"https://www.youtube.com/watch?v={vid}"
        with tempfile.TemporaryDirectory(dir=workdir) as tmp:
            for flag, source in (("--write-subs", "caption"), ("--write-auto-subs", "auto_caption")):
                proc = _run([*_ytdlp(), "--skip-download", "--sub-langs", f"{language}.*,{language}",
                             "--sub-format", "vtt", flag, "-o", str(Path(tmp) / "%(id)s.%(ext)s"), url])
                files = sorted(Path(tmp).glob("*.vtt"))
                if proc.returncode == 0 and files:
                    # prefer the exact language track, e.g. x.en.vtt over x.en-GB.vtt
                    files.sort(key=lambda p: (p.suffixes[-2:-1] != [f".{language}"], p.name))
                    return Acquired(captions=files[0].read_text(encoding="utf-8"), caption_source=source)
                if proc.returncode != 0 and "subtitle" not in proc.stderr.lower():
                    raise classify_ytdlp(proc.stderr)
        raise SourceError(f"No {language} captions are available for this video. Platform videos are never "
                          f"downloaded, so speech recognition cannot run on them")


# ------------------------------------------------------------------------------ Upload
class UploadAdapter:
    """`uri` is the stored file path; captions may sit next to it as .vtt / .srt."""
    kind = "upload"

    def register(self, uri: str) -> Registration:
        path = Path(uri)
        if not path.exists():
            raise SourceError("Uploaded file is missing")
        digest = sha256_file(path)
        return Registration(
            dedupe_key=f"sha256:{digest}", title=path.stem.replace("_", " "), duration=probe_duration(path),
            capabilities=Capabilities(has_file=True, frames=True, native_seek=True, playback="file"),
            content_hash=f"sha256:{digest}")

    def acquire(self, uri: str, language: str, workdir: Path) -> Acquired:
        path = Path(uri)
        captions = _sidecar_captions(path)
        return Acquired(file=path, captions=captions, caption_source="caption" if captions else None,
                        duration=probe_duration(path))


# ------------------------------------------------------------------------------ Web page
class WebPageAdapter:
    kind = "webpage"

    def __init__(self, grabber_dir: Path):
        self.grabber_dir = grabber_dir

    def register(self, uri: str) -> Registration:
        u = urlparse(uri)
        if u.scheme not in ("http", "https") or not u.netloc:
            raise SourceError("Enter a full web address (https://…)")
        if youtube_id(uri):
            raise SourceError("YouTube links are added as platform videos, not web pages")
        return Registration(
            dedupe_key="web:" + hashlib.sha256(uri.strip().encode()).hexdigest(), title=u.netloc + u.path[:60],
            duration=None, capabilities=Capabilities(has_file=True, frames=True, native_seek=True, playback="file"))

    def acquire(self, uri: str, language: str, workdir: Path) -> Acquired:
        node = shutil.which("node")
        entry = self.grabber_dir / "bin" / "mediagrab.mjs"
        if not node or not entry.exists():
            raise SourceError("Web page import needs Node.js 20+ and services/grabber (npm install there)")
        out = workdir / "grab"
        out.mkdir(parents=True, exist_ok=True)
        proc = _run([node, str(entry), uri, "--json", "--subs", "-p", "1", "-o", str(out)], timeout=3600,
                    cwd=self.grabber_dir)
        try:
            report = json.loads(proc.stdout[proc.stdout.index("{"):]) if "{" in proc.stdout else {}
        except ValueError:
            report = {}
        results = [r for r in report.get("results", []) if r.get("path") and not r.get("error")]
        if not results:
            err = next((r.get("error") for r in report.get("results", []) if r.get("error")), "") or \
                proc.stderr.strip()[-300:]
            if "drm" in err.lower() or "contentprotection" in err.lower():
                raise SourceError("This page's video is DRM-protected and cannot be used")
            raise SourceError("No downloadable video was found on this page" + (f" ({err})" if err else ""))
        path = Path(results[0]["path"])
        subs = sorted(out.glob(f"*.{language}*.vtt")) + sorted(out.glob("*.vtt")) + sorted(out.glob("*.srt"))
        captions = subs[0].read_text(encoding="utf-8", errors="replace") if subs else None
        return Acquired(file=path, captions=captions, caption_source="caption" if captions else None,
                        title=report.get("title"), duration=probe_duration(path))


def adapter_for(kind: str, uri: str, grabber_dir: Path) -> SourceAdapter:
    if kind == "upload":
        return UploadAdapter()
    if kind == "platform":
        if youtube_id(uri):
            return YouTubeAdapter()
        raise SourceError("Only YouTube links are supported among platforms right now; "
                          "try adding other sites as a web page")
    if kind == "webpage":
        return WebPageAdapter(grabber_dir)
    raise SourceError(f"Unknown source kind {kind!r}")
