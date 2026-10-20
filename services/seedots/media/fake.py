"""Offline stand-in brain for SEEDOTS_LLM_FAKE=1 (keyless development, tests). It only
exercises the pipeline shape; its outlines are fixed-size windows."""
from __future__ import annotations

import json
import re

from seedots.common.llm.phrases import phrases


def media_brain(task: str, system: str, user: str) -> str:
    if task == "outline":
        rows = re.findall(r"^(s\d{4}) \[[^\]]+\] (.+)$", user, flags=re.M)
        chapters = []
        for k in range(0, len(rows), 14):
            chunk = rows[k:k + 14]
            top = phrases([t for _, t in chunk], 1)
            chapters.append({"title": top[0].capitalize() if top else f"Section {k // 14 + 1}",
                             "summary": chunk[0][1][:140], "start": chunk[0][0], "end": chunk[-1][0]})
        return json.dumps({"chapters": chapters})
    return "{}"
