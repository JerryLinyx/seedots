"""Deterministic stand-in for the model when SEEDOTS_LLM_FAKE=1 (dev without a key, tests)."""
from __future__ import annotations

import json
import re


def media_fake(task: str, messages: list[dict]) -> str:
    if task == "outline":
        ids = re.findall(r"^(s\d{4}) ", messages[-1]["content"], flags=re.M)
        chapters = []
        for k in range(0, len(ids), 14):
            chunk = ids[k:k + 14]
            chapters.append({"title": f"Section {len(chapters) + 1}", "summary": "", "start": chunk[0], "end": chunk[-1]})
        return json.dumps({"chapters": chapters})
    return "{}"
