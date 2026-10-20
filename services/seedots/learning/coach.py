"""AI Coach: a grounded, streaming tutor for the current moment (tech plan §7).
It never sends video to the model: the context is the pre-extracted transcript, chapter
and concepts around the current time."""
from __future__ import annotations

import re
from typing import Iterator

from seedots.common.ids import new_id, now_ms
from seedots.common.llm import Gateway
from seedots.common.timefmt import fmt_ts
from seedots.learning.store import LearningStore

CITE = re.compile(r"\[(s\d{4})\]")


def short(eid: str) -> str:
    return eid.rsplit(".", 1)[-1]


class Coach:
    def __init__(self, store: LearningStore, gateway: Gateway):
        self.store, self.gateway = store, gateway

    def context(self, media_id: str, t: float) -> dict:
        video = self.store.video(media_id) or {}
        sents = self.store.evidence(media_id, "sentence", t - 90, t + 30)
        chapter = next((c for c in (video.get("chapters") or []) if c["t0"] <= t < c["t1"]), None)
        occ = [o for o in self.store.occurrences(media_id) if not chapter or o["chapter_id"] == chapter["id"]]
        concepts = self.store.concepts(sorted({o["concept_id"] for o in occ}))
        return {"video": video, "sentences": sents, "chapter": chapter, "concepts": concepts}

    def ask(self, user_id: str, media_id: str, t: float, question: str) -> Iterator[dict]:
        ctx = self.context(media_id, t)
        sents = ctx["sentences"]
        by_short = {short(s.id): s for s in sents}
        marks = [m for m in self.store.marks(user_id, media_id) if abs(m["t"] - t) < 180][-5:]
        history = [{"role": m["role"], "content": m["content"]} for m in self.store.messages(user_id, media_id, 8)]
        variables = {
            "title": ctx["video"].get("title") or "",
            "chapter": (ctx["chapter"] or {}).get("title", "unknown"),
            "concepts": "; ".join(f"{c['name']} (mistakes: " + ", ".join(m["text"] for m in c["misconceptions"][:2])
                                  + ")" for c in ctx["concepts"]) or "none",
            "marks": "; ".join(f"{m['type']} at {fmt_ts(m['t'])}" + (f" — {m['note']}" if m.get("note") else "")
                               for m in marks) or "none",
            "now": fmt_ts(t),
            "context": "\n".join(f"{short(s.id)} [{fmt_ts(s.t0)}]{' <- now' if s.t0 <= t < s.t1 else ''} "
                                 f"{s.content['text']}" for s in sents) or "(no transcript near this moment)",
            "question": question.strip() or "I'm confused about this part. Can you explain it?",
        }
        self.store.insert("messages", {"id": new_id("msg"), "user_id": user_id, "media_id": media_id,
                                       "role": "user", "content": variables["question"], "media_time": t,
                                       "evidence_ids": [], "created_at": now_ms()})
        text = ""
        for delta in self.gateway.stream("coach", variables, history=history, evidence_ids=[s.id for s in sents]):
            text += delta
            yield {"type": "delta", "text": delta}
        cites = []
        for sid in dict.fromkeys(CITE.findall(text)):
            u = by_short.get(sid)
            if u:
                cites.append({"ref": sid, "id": u.id, "t0": u.t0, "t1": u.t1})
        self.store.insert("messages", {"id": new_id("msg"), "user_id": user_id, "media_id": media_id,
                                       "role": "assistant", "content": text, "media_time": t,
                                       "evidence_ids": [c["id"] for c in cites], "created_at": now_ms()})
        yield {"type": "done", "citations": cites}
