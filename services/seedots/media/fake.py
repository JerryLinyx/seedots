"""Offline stand-in brain for SEEDOTS_LLM_FAKE=1 (keyless development, tests). It only
exercises the pipeline shape; its outlines are fixed-size windows."""
from __future__ import annotations

import json
import re


def media_brain(task: str, system: str, user: str) -> str:
    if task == "outline":
        ids = re.findall(r"^(s\d{4}) ", user, flags=re.M)
        chapters = [{"title": f"Section {k // 14 + 1}", "summary": "", "start": ids[k], "end": ids[min(k + 13, len(ids) - 1)]}
                    for k in range(0, len(ids), 14)]
        return json.dumps({"chapters": chapters})
    return "{}"
