"""Deterministic stand-in model for SEEDOTS_LLM_FAKE=1 and tests. It only exercises the
pipeline shape; its questions are deliberately simple."""
from __future__ import annotations

import json
import re
from collections import Counter

STOP = set("""the a an and or but of to in on for with that this these those is are was were be been being it its as at by
from into about than then there their they them you your we our i me my he she his her not no so if what which who
when where how why can could would should will just also very more most some any all one two like get got do does did
have has had going really actually because know think kind sort lot thing things way make made see look okay right""".split())


def _sentences(text: str) -> list[tuple[str, str]]:
    return re.findall(r"^(s\d{4}) \[[^\]]+\](?: <- now)? (.+)$", text, flags=re.M)


def learning_fake(task: str, messages: list[dict]) -> str:
    user = messages[-1]["content"]
    system = messages[0]["content"]
    if task == "concepts":
        sents = _sentences(user)
        words = Counter(w for _, t in sents for w in re.findall(r"[a-zA-Z]{5,}", t.lower()) if w not in STOP)
        concepts = []
        for w, _ in words.most_common(2):
            ev = [sid for sid, t in sents if w in t.lower()][:4]
            concepts.append({"name": w, "aliases": [], "definition": f"What the video calls {w}.",
                             "role": "defined", "evidence": ev,
                             "misconceptions": [{"id": f"{w}_confusion", "text": f"{w} means something else"}]})
        return json.dumps({"concepts": concepts})
    if task == "items":
        sents = _sentences(user)
        names = re.findall(r"^- ([^:]+):", user, flags=re.M)
        items = []
        for name in names:
            ev = [sid for sid, t in sents if name.lower() in t.lower()][:2] or [sents[0][0]]
            quote = next(t for sid, t in sents if sid == ev[0])
            items.append({"type": "single_choice", "concept": name, "level": 1,
                          "stem": f"Which statement matches what the video says about '{name}'?",
                          "options": [quote[:90], f"{name} is never mentioned", f"{name} is the opposite idea"],
                          "answer": 0, "explanation": "This is what the video says.",
                          "hints": ["Look at the sentence where it first appears."], "evidence": ev})
        if len(sents) >= 3 and names:
            items.append({"type": "ordering", "concept": names[0], "level": 2,
                          "stem": "Put these statements in the order the video presents them.",
                          "items": [t[:70] for _, t in sents[:3]], "answer": None,
                          "explanation": "That is the order of the narration.", "hints": [],
                          "evidence": [sid for sid, _ in sents[:3]]})
        return json.dumps({"items": items})
    if task == "select_action":
        cands = json.loads(re.search(r"Candidates: (\[.*?\])", user).group(1))
        items = json.loads(re.search(r"Offered items: (\[.*\])", user, flags=re.S).group(1))
        for action in ("predict", "quiz"):
            if action in cands:
                it = next(i for i in items if i["for_action"] == action)
                return json.dumps({"action": action, "item_id": it["item_id"], "reason": "fake model", "confidence": 0.5})
        return json.dumps({"action": "check_in", "item_id": None, "reason": "fake model", "confidence": 0.5})
    if task == "coach":
        sid = re.search(r"(s\d{4}) \[", system)
        cite = f" [{sid.group(1)}]" if sid else ""
        return (f"(offline fake model) Here the video is building up its main point{cite}. "
                f"Try restating it in your own words. What would change if the opposite were true?")
    return "{}"
