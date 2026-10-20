"""Tiny keyphrase picker used by the offline brains (no model): frequent two-word phrases,
falling back to single words. Good enough to make keyless development look plausible."""
from __future__ import annotations

import re
from collections import Counter

STOP = set("""the a an and or but of to in on for with that this these those is are was were be been being it its as at by
from into about than then there their they them you your we our i me my he she his her not no so if what which who
when where how why can could would should will just also very more most some any all one two like get got do does did
have has had going really actually because know think kind sort lot thing things way make made see look okay right
sentence explains behaves during training today time next last first instead each every much many simply exactly
here revisit""".split())


def words(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-zA-Z][a-zA-Z-]+", text.lower())]


def phrases(texts: list[str], k: int = 3) -> list[str]:
    bi: Counter[str] = Counter()
    uni: Counter[str] = Counter()
    for t in texts:
        ws = words(t)
        for a, b in zip(ws, ws[1:]):
            if a not in STOP and b not in STOP and len(a) > 3 and len(b) > 3:
                bi[f"{a} {b}"] += 1
        for w in ws:
            if w not in STOP and len(w) > 4:
                uni[w] += 1
    picked = [p for p, n in bi.most_common() if n >= 2][:k]
    for w, _ in uni.most_common():
        if len(picked) >= k:
            break
        if not any(w in p for p in picked):
            picked.append(w)
    return picked
