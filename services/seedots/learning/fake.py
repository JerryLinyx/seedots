"""Offline stand-in brain for SEEDOTS_LLM_FAKE=1 (keyless development, tests). It exercises
the shapes of every task — including a tool call in the coach — but its content is trivial."""
from __future__ import annotations

import json
import re

from seedots.common.llm import FakeToolCall

from seedots.common.llm.phrases import phrases


def _sentences(text: str) -> list[tuple[str, str]]:
    return re.findall(r"^(s\d{4}) \[[^\]]+\](?: <- now)? (.+)$", text, flags=re.M)


def learning_brain(task: str, system: str, user: str):
    if task == "concepts":
        sents = _sentences(user)
        concepts = []
        for name in phrases([t for _, t in sents], 3):
            ev = [sid for sid, t in sents if name in t.lower()][:4] or [sents[0][0]]
            slug = name.replace(" ", "_")
            concepts.append({"name": name, "aliases": [], "definition": f"What the video calls {name}.",
                             "role": "defined", "evidence": ev,
                             "misconceptions": [{"id": f"{slug}_confusion", "text": f"{name} means something else"}]})
        return json.dumps({"concepts": concepts})
    if task == "items":
        sents = _sentences(user)
        names = re.findall(r"^- ([^:]+):", user, flags=re.M)
        if "missing (concept, level)" in system:
            gaps = re.findall(r"([^;:]+?) @ level (\d)", system.split("cells, if the chapter supports them:")[-1])
            return json.dumps({"items": [{
                "type": "multi_choice", "concept": n.strip(), "level": int(lv),
                "stem": f"Which two statements fit what the video says about '{n.strip()}'?",
                "options": [sents[0][1][:80], sents[1][1][:80], "It is never discussed", "It is the opposite idea"],
                "answer": [0, 1], "explanation": "Both are said in the chapter.", "hints": [],
                "evidence": [sents[0][0], sents[1][0]]} for n, lv in gaps if len(sents) >= 2][:2]})
        items = []
        for name in names:
            ev = [sid for sid, t in sents if name.lower() in t.lower()][:2] or [sents[0][0]]
            quote = next(t for sid, t in sents if sid == ev[0])
            items.append({"type": "single_choice", "concept": name, "level": 1,
                          "stem": f"Which statement matches what the video says about '{name}'?",
                          "options": [quote[:90], f"{name} is never mentioned", f"{name} is the opposite idea"],
                          "answer": 0, "explanation": "This is what the video says.",
                          "hints": ["Look at the sentence where it first appears."], "evidence": ev,
                          "misconception": f"{name}_confusion"})
        if len(sents) >= 3 and names:
            items.append({"type": "ordering", "concept": names[0], "level": 2,
                          "stem": "Put these statements in the order the video presents them.",
                          "items": [t[:70] for _, t in sents[:3]], "answer": None,
                          "explanation": "That is the order of the narration.", "hints": [],
                          "evidence": [sid for sid, _ in sents[:3]]})
        if len(sents) >= 6 and names:
            items.append({"type": "predict", "concept": names[0], "level": 2,
                          "stem": "What will the video say next about this?", "options": [sents[5][1][:80], "Nothing", "The opposite"],
                          "answer": 0, "explanation": "The video says it shortly after.", "hints": [],
                          "evidence": [sents[4][0], sents[5][0]], "reveal_after": sents[5][0]})
        return json.dumps({"items": items})
    if task == "select_action":
        cands = json.loads(re.search(r"Candidates: (\[.*?\])", user).group(1))
        offered = json.loads(re.search(r"Offered items: (\[.*\])", user, flags=re.S).group(1))
        for action in ("predict", "quiz"):
            if action in cands:
                it = next(i for i in offered if i["for_action"] == action)
                return json.dumps({"action": action, "item_id": it["item_id"], "reason": "fake model", "confidence": 0.5})
        if "link" in cands:
            return json.dumps({"action": "link", "item_id": None, "reason": "fake model", "confidence": 0.5})
        return json.dumps({"action": "check_in", "item_id": None, "reason": "fake model", "confidence": 0.5})
    if task == "concept_judge":
        name = re.search(r"New mention: (.+)", user).group(1).strip().lower()
        for key, cand in re.findall(r"^(c\d+): ([^(]+)", user, flags=re.M):
            if cand.strip().lower().rstrip("s") == name.rstrip("s"):
                return json.dumps({"match": key, "confidence": 0.9, "reason": "same name"})
        return json.dumps({"match": None, "confidence": 0.7, "reason": "different"})
    if task == "card":
        name = re.search(r"Concept: (.+)", user).group(1).strip()
        sid = re.search(r"^(s\d{4}) ", user, flags=re.M)
        cite = f" [{sid.group(1)}]" if sid else ""
        quote = re.search(r"^s\d{4} \([^)]*\) (.+)$", user, flags=re.M)
        return json.dumps({"title": name.capitalize(), "body": (
            f"{name.capitalize()}: {quote.group(1) if quote else 'what the video explains here'}{cite}\n\n"
            f"Watch for the usual mix-up of treating it as a neighbouring idea. (offline draft)")})
    if task == "coach":
        if "other video" in user.lower() and "<tool concept_elsewhere>" not in user:
            first = re.search(r"Concepts here and common mistakes: ([^(;\n]+)", system)
            return FakeToolCall("concept_elsewhere", {"name": first.group(1).strip() if first else "x"})
        refs = re.findall(r'"id": "(o\d+)"', user)
        sid = re.search(r"(s\d{4}) \[", system)
        cite = f" [{refs[0]}]" if refs else (f" [{sid.group(1)}]" if sid else "")
        return (f"(offline fake model) Here the video is building up its main point{cite}. "
                f"Try restating it in your own words. What would change if the opposite were true?")
    return "{}"
