"""Versioned prompt files.

Each task has files `<task>.v<N>.md` with a `## system` and a `## user` section and
`{{variable}}` placeholders. Versions are immutable once used in production: change a
prompt by adding v<N+1>, then pin or unpin the task. The version used is logged with every
call (usage_logs.prompt_version) so evaluation can compare versions.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

FILE = re.compile(r"^(?P<task>[a-z0-9_]+)\.v(?P<v>\d+)\.md$")
VAR = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}")


class PromptError(KeyError):
    pass


@dataclass(frozen=True)
class Prompt:
    task: str
    version: int
    system: str
    user: str

    @property
    def tag(self) -> str:
        return f"{self.task}.v{self.version}"

    def render(self, variables: dict[str, Any]) -> tuple[str, str]:
        def fill(template: str) -> str:
            def sub(m: re.Match) -> str:
                name = m.group(1)
                if name not in variables:
                    raise PromptError(f"{self.tag}: missing variable {name!r}")
                value = variables[name]
                return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
            return VAR.sub(sub, template).strip()
        return fill(self.system), fill(self.user)


def _parse(task: str, version: int, text: str) -> Prompt:
    parts = re.split(r"^## (system|user)\s*$", text, flags=re.M)
    sections = {parts[i]: parts[i + 1].strip() for i in range(1, len(parts) - 1, 2)}
    if "system" not in sections:
        raise PromptError(f"{task}.v{version}: missing '## system' section")
    return Prompt(task, version, sections["system"], sections.get("user", "{{input}}"))


class PromptLibrary:
    def __init__(self, *dirs: Path):
        self._prompts: dict[str, dict[int, Prompt]] = {}
        for d in dirs:
            for path in sorted(Path(d).glob("*.md")):
                m = FILE.match(path.name)
                if m:
                    task, v = m.group("task"), int(m.group("v"))
                    self._prompts.setdefault(task, {})[v] = _parse(task, v, path.read_text(encoding="utf-8"))

    def get(self, task: str, version: int | None = None) -> Prompt:
        versions = self._prompts.get(task)
        if not versions:
            raise PromptError(f"no prompt for task {task!r}")
        v = version if version is not None else max(versions)
        if v not in versions:
            raise PromptError(f"no prompt {task}.v{v}")
        return versions[v]

    def tasks(self) -> list[str]:
        return sorted(self._prompts)
