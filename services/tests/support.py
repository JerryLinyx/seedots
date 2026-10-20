"""Shared test wiring: settings pointing at a temp dir, fake model, inline workflows."""
from __future__ import annotations

import dataclasses
import shutil
import subprocess
from pathlib import Path

from seedots.common.config import ModelEndpoint, load_settings


def test_settings(tmp: Path, **over):
    base = load_settings()
    return dataclasses.replace(
        base, data_dir=tmp, llm=ModelEndpoint("http://fake", "", "fake"), llm_fake=True,
        embeddings=ModelEndpoint(), asr=ModelEndpoint(), vlm=ModelEndpoint(),
        media_db_url=f"sqlite:///{tmp / 'media.sqlite3'}", learning_db_url=f"sqlite:///{tmp / 'learning.sqlite3'}",
        auto_migrate=True, workflow_engine="inprocess", media_webhook_url="http://learning.test/hooks/media",
        webhook_secret="s3cret-test", action_selector="llm", llm_reasoning="auto", llm_max_tokens={}, **over)


def make_video(path: Path, seconds: int = 30) -> Path:
    """A small real video with hard scene changes (for keyframes), or a stub if no ffmpeg."""
    if shutil.which("ffmpeg"):
        third = seconds // 3
        filt = (f"color=c=red:s=320x180:r=5:d={third}[a];color=c=blue:s=320x180:r=5:d={third}[b];"
                f"color=c=green:s=320x180:r=5:d={seconds - 2 * third}[c];[a][b][c]concat=n=3:v=1:a=0[v];"
                f"sine=frequency=440:duration={seconds}[s]")
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-filter_complex", filt, "-map", "[v]", "-map", "[s]",
                        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", str(path)],
                       check=True)
    else:
        path.write_bytes(b"not really a video")
    return path
