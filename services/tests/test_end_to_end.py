"""Both services, wired over their real HTTP APIs (in-process), with the offline model:

upload -> foundation analysis -> signed webhooks -> content generation -> pack -> runtime
-> grading/mastery -> coach (with a tool call) -> cross-video link -> map/search/cards
-> corrections -> isolation -> concept merge + rollback.
"""
import json
import tempfile
import unittest
from pathlib import Path

import sqlalchemy as sa
from fastapi.testclient import TestClient

from seedots.learning.api import create_app as learning_app
from seedots.learning.app import build_container as learning_container
from seedots.learning.models import Concept, ItemConcept, LearningItem, Mastery, Occurrence
from seedots.learning.runtime import Runtime, Signal
from seedots.media.api import create_app as media_app
from seedots.media.app import build_container as media_container
from tests.fixtures import long_vtt
from tests.support import make_video, test_settings


def sse_events(text: str) -> list[tuple[str, dict]]:
    out = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line)
        if "event" in lines:
            out.append((lines["event"], json.loads(lines["data"])))
    return out


class EndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        d = Path(cls.tmp.name)
        settings = test_settings(d)
        holder = {}

        def poster(url, body, headers):
            return holder["learning"].post("/hooks/media", content=body, headers=headers).status_code

        cls.mc = media_container(settings, inline=True, poster=poster)
        cls.media = TestClient(media_app(cls.mc))
        cls.lc = learning_container(settings, media_http=cls.media, inline=True)
        cls.api = TestClient(learning_app(cls.lc))
        holder["learning"] = cls.api
        cls.d = d

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def upload(self, user: str, name: str, seconds: int, vtt: str) -> dict:
        video = make_video(self.d / f"{name}.mp4", seconds)
        r = self.api.post("/api/videos/upload", headers={"X-SeeDots-User": user},
                          files={"file": (f"{name}.mp4", video.open("rb"), "video/mp4"),
                                 "captions": (f"{name}.vtt", vtt.encode(), "text/vtt")})
        self.assertEqual(r.status_code, 201, r.text)
        self.mc.dispatcher.deliver_once()
        return r.json()

    def test_full_loop(self):
        U1 = {"X-SeeDots-User": "u1"}
        v = self.upload("u1", "lesson", 240, long_vtt(40))
        mid = v["media_id"]

        # ---- foundation finished; content generated per chapter via webhooks
        m = self.media.get(f"/v1/media/{mid}").json()
        self.assertEqual(m["status"], "ready", m)
        video = self.api.get(f"/api/videos/{mid}", headers=U1).json()
        self.assertEqual(video["content"]["chapters_total"], 3)
        self.assertEqual(video["content"]["chapters_done"], 3, video)
        self.assertGreater(video["content"]["items"], 0)

        pack = self.api.get(f"/api/videos/{mid}/pack", headers=U1).json()
        self.assertEqual(len(pack["sentences"]), 40)
        self.assertEqual([c["content_status"] for c in pack["chapters"]], ["done"] * 3)
        self.assertTrue(pack["concepts"])
        self.assertTrue(pack["frames"])                          # keyframes from scene changes
        self.assertNotIn("answer_key", json.dumps(pack["items"]))
        for it in pack["items"]:
            self.assertTrue(it["evidence"] or it["type"] == "predict")
        self.assertIn("predict", {it["type"] for it in pack["items"]})
        predict = next(it for it in pack["items"] if it["type"] == "predict")
        self.assertIsNotNone(predict["show_before"])

        # ---- duplicate / forged webhooks
        ev = self.media.get("/v1/events", params={"media_id": mid}).json()[0]
        body = json.dumps(ev).encode()
        self.assertEqual(self.api.post("/hooks/media", content=body,
                                       headers={"X-SeeDots-Signature": "nope"}).status_code, 401)
        from seedots.common.contracts import sign
        r = self.api.post("/hooks/media", content=body, headers={"X-SeeDots-Signature": sign(body, "s3cret-test")})
        self.assertEqual(r.json()["status"], "duplicate")

        # ---- runtime: chapter end -> quiz (model) ; wrong answer on an unreviewed item is not counted
        ch0 = pack["chapters"][0]
        d = self.api.post("/api/decide", headers=U1, json={"media_id": mid, "signal": {
            "kind": "chapter_end", "t": ch0["t1"] - 0.1, "chapter_id": ch0["id"]}}).json()
        self.assertEqual(d["action"], "quiz", d)
        self.assertNotIn("answer_key", d["item"])
        item_id = d["item"]["id"]
        wrong = {"index": 99, "indices": [], "order": [], "pairs": []}
        res = self.api.post("/api/attempts", headers=U1, json={"item_id": item_id, "response": wrong,
                                                               "decision_id": d["decision_id"]}).json()
        self.assertFalse(res["correct"])
        self.assertFalse(res["counted_toward_mastery"])

        # ---- repeated rewinds after a miss -> rewatch the evidence span (rules)
        self.lc.runtime.use_llm = False
        rew = self.api.post("/api/decide", headers=U1, json={"media_id": mid, "signal": {
            "kind": "rewind_repeat", "t": ch0["t0"] + 5}}).json()
        self.lc.runtime.use_llm = True
        self.assertEqual(rew["action"], "rewatch")
        self.assertIn("t0", rew["rewatch"])

        # ---- model failure falls back to the rule choice
        class Broken:
            name = "broken"

            def select(self, ctx, s):
                raise RuntimeError("boom")

        fb = Runtime(self.lc.db, Broken()).decide("u1", mid, Signal(kind="chapter_end", t=ch0["t1"] - 0.1,
                                                                    chapter_id=ch0["id"]))
        self.assertTrue(fb["fallback"])
        self.assertEqual(fb["action"], fb["rule_action"])

        # ---- reviewed item, first independent correct answer -> counted
        single = next(it for it in pack["items"] if it["type"] == "single_choice" and it["id"] != item_id)
        self.api.post(f"/api/items/{single['id']}/review", headers=U1, json={"status": "human_reviewed"})
        with self.lc.db.session() as s:
            key = s.get(LearningItem, single["id"]).answer_key["index"]
        ok = self.api.post("/api/attempts", headers=U1, json={"item_id": single["id"], "response": {"index": key}}).json()
        self.assertTrue(ok["correct"])
        self.assertTrue(ok["counted_toward_mastery"])

        # ---- coach streams, cites evidence ids, keeps one thread per video
        r = self.api.post("/api/coach", headers=U1, json={"media_id": mid, "t": 30, "question": "why?"})
        parts = sse_events(r.text)
        self.assertEqual(parts[-1][0], "done")
        cites = parts[-1][1]["citations"]
        self.assertTrue(cites and cites[0]["id"].startswith(mid))
        self.assertEqual(len(self.api.get(f"/api/coach/{mid}", headers=U1).json()), 2)

        # ---- a second video teaching the same concepts -> shared library, link, coach tool
        v2 = self.upload("u1", "lesson2", 120,
                         long_vtt(20, "Here {i} we revisit how the {topic} behaves during training."))
        mid2 = v2["media_id"]
        pack2 = self.api.get(f"/api/videos/{mid2}/pack", headers=U1).json()
        shared = [c for c in pack2["concepts"] if c["elsewhere"]]
        self.assertTrue(shared, pack2["concepts"])
        link = self.api.post("/api/decide", headers=U1, json={"media_id": mid2, "signal": {
            "kind": "concept_seen_before", "t": shared[0]["occurrences"][0]["t0"],
            "concept_id": shared[0]["id"]}}).json()
        self.assertEqual(link["action"], "link", link)
        self.assertEqual(link["link"]["media_id"], mid)
        self.assertEqual(self.api.post(f"/api/links/{link['link']['id']}", headers=U1,
                                       json={"status": "confirmed"}).json(), {"ok": True})
        r = self.api.post("/api/coach", headers=U1, json={"media_id": mid2, "t": 10,
                                                          "question": "Where did I see this in another video?"})
        done = sse_events(r.text)[-1][1]
        self.assertTrue(any(c.get("media_id") == mid for c in done["citations"]), done)

        # ---- knowledge map, search, cards
        kmap = self.api.get("/api/map", headers=U1).json()
        self.assertTrue(any(n["videos"] == 2 for n in kmap["nodes"]))
        found = self.api.get("/api/search", headers=U1, params={"q": shared[0]["name"]}).json()
        self.assertTrue(found["concepts"])
        self.assertTrue(found["moments"], (shared[0]["name"], found))
        card = self.api.post(f"/api/concepts/{shared[0]['id']}/card", headers=U1).json()
        self.assertEqual(card["status"], "draft")
        self.assertTrue(card["sources"])
        card = self.api.patch(f"/api/cards/{card['id']}", headers=U1, json={"status": "confirmed"}).json()
        self.assertEqual(card["status"], "confirmed")
        self.assertEqual(self.api.post(f"/api/concepts/{shared[0]['id']}/card", headers=U1).status_code, 409)

        # ---- transcript correction -> new revision, snapshot updated, old revision kept
        sid = pack["sentences"][2]["id"]
        fixed = self.api.patch(f"/api/evidence/{sid}", headers=U1, json={"text": "Corrected words."}).json()
        self.assertEqual(fixed["revision"], 2)
        again = self.api.get(f"/api/videos/{mid}/pack", headers=U1).json()
        self.assertEqual(again["sentences"][2]["text"], "Corrected words.")

        # ---- private uploads are isolated
        self.assertEqual(self.api.get(f"/api/videos/{mid}/pack", headers={"X-SeeDots-User": "u2"}).status_code, 404)

        # ---- file proxy supports range requests (seeking)
        r = self.api.get(f"/api/videos/{mid}/file", headers={**U1, "Range": "bytes=0-99"})
        self.assertEqual(r.status_code, 206)
        self.assertEqual(len(r.content), 100)

        # ---- usage is logged per task with prompt versions
        tasks = {u["task"] for u in self.api.get("/api/usage").json()}
        self.assertTrue({"concepts", "items", "select_action", "coach", "card"} <= tasks, tasks)

    def test_concept_merge_and_rollback(self):
        from seedots.learning.concepts import Mention

        lib, db = self.lc.library, self.lc.db
        a = lib.resolve(Mention(name="stochastic gradient descent", definition="noisy steps"))
        b = lib.resolve(Mention(name="SGD optimizer", definition="noisy steps"))
        self.assertNotEqual(a.concept_id, b.concept_id)
        with db.session() as s:
            from seedots.learning.catalog import ensure_user
            ensure_user(s, "u1")
            s.add(Mastery(user_id="u1", concept_id=b.concept_id, level=2, streak=0, independent_correct=2,
                          independent_wrong=0, assisted=0)) if s.get(Mastery, ("u1", b.concept_id)) is None else None
        with db.session() as s:
            log_id = lib.merge(s, b.concept_id, a.concept_id, actor="curator")
        with db.session() as s:
            self.assertEqual(s.get(Concept, b.concept_id).status.value, "merged")
            self.assertIsNotNone(s.get(Mastery, ("u1", a.concept_id)))
        again = lib.resolve(Mention(name="SGD optimizer"))
        self.assertEqual(again.concept_id, a.concept_id)        # the merged name is now an alias
        with db.session() as s:
            lib.rollback(s, log_id, actor="curator")
        with db.session() as s:
            self.assertEqual(s.get(Concept, b.concept_id).status.value, "active")
            self.assertIsNotNone(s.get(Mastery, ("u1", b.concept_id)))
            self.assertIsNone(s.get(Mastery, ("u1", a.concept_id)))
            with self.assertRaises(ValueError):
                lib.rollback(s, log_id, actor="curator")

    def test_merge_moves_items_and_occurrences(self):
        lib, db = self.lc.library, self.lc.db
        with db.session() as s:
            occ = s.scalars(sa.select(Occurrence)).all()
            if len({o.concept_id for o in occ}) < 2:
                self.skipTest("needs the full loop's concepts")
            src, dst = sorted({o.concept_id for o in occ})[:2]
            before_items = set(s.scalars(sa.select(ItemConcept.item_id).where(ItemConcept.concept_id == src)))
        with db.session() as s:
            log_id = lib.merge(s, src, dst, actor="t")
        with db.session() as s:
            moved = set(s.scalars(sa.select(ItemConcept.item_id).where(ItemConcept.concept_id == dst)))
            self.assertTrue(before_items <= moved)
            self.assertFalse(s.scalars(sa.select(Occurrence).where(Occurrence.concept_id == src)).all())
        with db.session() as s:
            lib.rollback(s, log_id, actor="t")
        with db.session() as s:
            back = set(s.scalars(sa.select(ItemConcept.item_id).where(ItemConcept.concept_id == src)))
            self.assertEqual(back, before_items)


if __name__ == "__main__":
    unittest.main()
