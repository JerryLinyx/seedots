"""Shared test wiring: settings pointing at a temp dir, fake model, inline workflows."""
from __future__ import annotations

import contextlib
import dataclasses
import os
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
        webhook_secret="s3cret-test", action_selector="llm", llm_reasoning="auto", llm_max_tokens={},
        **{"rigs_url": "http://127.0.0.1:9", **over})   # no rig service unless a test starts one (rig_service)


test_settings.__test__ = False   # a helper, not a test (pytest collects it where it is imported)

RIGS_DIR = Path(__file__).resolve().parents[1] / "rigs"


def node_runs_ts() -> bool:
    """The rig service runs TypeScript directly: Node 22.18 or later."""
    node = shutil.which("node")
    if not node:
        return False
    out = subprocess.run([node, "-p", "process.versions.node"], capture_output=True, text=True).stdout.strip()
    major, minor = (int(x) for x in out.split(".")[:2])
    return major > 22 or (major == 22 and minor >= 18)


@contextlib.contextmanager
def rig_service():
    """Start services/rigs on a free port for one test; yields its base URL."""
    import socket
    import time
    import urllib.request

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    proc = subprocess.Popen(["node", "server.ts"], cwd=RIGS_DIR, env={**os.environ, "SEEDOTS_RIGS_PORT": str(port)},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    url = f"http://127.0.0.1:{port}"
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(f"{url}/healthz", timeout=0.5)
                break
            except OSError:
                time.sleep(0.1)
        yield url
    finally:
        proc.terminate()
        proc.wait(timeout=5)


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
