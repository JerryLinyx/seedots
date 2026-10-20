"""Platform link recognition shared by both services (pure functions, no I/O)."""
from __future__ import annotations

import re

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
    if re.fullmatch(r"[\w-]{11}", uri.strip()):
        return uri.strip()
    return None
