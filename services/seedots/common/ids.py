from __future__ import annotations

import hashlib
import time
import uuid


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def stable_id(prefix: str, *parts: str) -> str:
    digest = hashlib.sha1("\x1f".join(parts).encode()).hexdigest()[:16]
    return f"{prefix}_{digest}"


def now_ms() -> int:
    return int(time.time() * 1000)
