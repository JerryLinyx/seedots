"""Real-model evaluation of the lab agent (lab_spec) on the chapters already in the learning database.

Runs on a copy of the database, so nothing the app shows changes. Needs the rig service running and a
model key in .env. Usage (from services/):

    .venv/bin/python scripts/eval_labs.py --out /tmp/labs.json [--media med_x] [--workers 4] [--limit 10]

Reports, per chapter: whether a lab was made, which rig, how many try_rig calls, the server's verdict,
seconds and tokens; and in total: coverage, rig mix, first-try pass rate, time and tokens.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import shutil
import sys
import tempfile
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import sqlalchemy as sa

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from seedots.common.config import load_settings  # noqa: E402
from seedots.learning.app import build_container  # noqa: E402
from seedots.learning.models import Chapter, UsageLog, Video  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--media", action="append", default=[])
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    base = load_settings()
    src = Path(base.learning_db_url.removeprefix("sqlite:///"))
    tmp = Path(tempfile.mkdtemp(prefix="seedots-eval-"))
    for suffix in ("", "-wal", "-shm"):
        if Path(f"{src}{suffix}").exists():
            shutil.copy(f"{src}{suffix}", tmp / f"learning.sqlite3{suffix}")
    settings = dataclasses.replace(base, learning_db_url=f"sqlite:///{tmp / 'learning.sqlite3'}", data_dir=tmp,
                                   workflow_engine="inprocess")
    c = build_container(settings, inline=True)
    if not c.scenes.rigs or not c.scenes.rigs.available:
        sys.exit(f"rig service not reachable at {settings.rigs_url}")

    with c.db.session() as s:
        q = sa.select(Chapter.id, Chapter.media_id, Chapter.title, Video.title).join(Video, Video.media_id == Chapter.media_id) \
            .where(Chapter.retired_at.is_(None)).order_by(Chapter.media_id, Chapter.ord)
        if args.media:
            q = q.where(Chapter.media_id.in_(args.media))
        chapters = list(s.execute(q))
    if args.limit:
        chapters = chapters[: args.limit]
    print(f"{len(chapters)} chapters, db copy at {tmp}", flush=True)

    def one(row) -> dict:
        cid, mid, title, vtitle = row
        t0 = time.time()
        try:
            res = c.scenes.make_lab(mid, cid, None)
        except Exception as exc:                       # an eval keeps going
            res = {"scene": None, "reason": f"{type(exc).__name__}: {exc}"[:300]}
        out = {"video": vtitle, "chapter": title, "seconds": round(time.time() - t0, 1), **res}
        print(json.dumps(out, ensure_ascii=False), flush=True)
        return out

    with ThreadPoolExecutor(args.workers) as pool:
        rows = list(pool.map(one, chapters))

    with c.db.session() as s:
        usage = list(s.execute(sa.select(UsageLog.task, sa.func.count(), sa.func.sum(UsageLog.input_tokens),
                                         sa.func.sum(UsageLog.output_tokens), sa.func.avg(UsageLog.latency_ms))
                               .where(UsageLog.task == "lab_spec").group_by(UsageLog.task)))
    made = [r for r in rows if r.get("scene")]
    summary = {
        "chapters": len(rows),
        "labs": len(made),
        "coverage": round(len(made) / max(1, len(rows)), 2),
        "rigs": Counter(r["component"] for r in made),
        "first_round": sum(1 for r in made if r.get("attempts") == 1),
        "try_rig_calls_avg": round(sum(r.get("tries", 0) for r in rows) / max(1, len(rows)), 2),
        "seconds_avg": round(sum(r["seconds"] for r in rows) / max(1, len(rows)), 1),
        "no_lab_reasons": Counter((r.get("reason") or "")[:80] for r in rows if not r.get("scene")).most_common(8),
        "usage": [dict(zip(("task", "calls", "input_tokens", "output_tokens", "latency_ms_avg"), u)) for u in usage],
    }
    Path(args.out).write_text(json.dumps({"summary": summary, "rows": rows}, ensure_ascii=False, indent=1, default=str))
    print(json.dumps(summary, ensure_ascii=False, indent=1, default=str))


if __name__ == "__main__":
    main()
