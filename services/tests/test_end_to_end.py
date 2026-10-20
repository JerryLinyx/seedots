"""Foundation -> webhook -> content generation -> runtime -> coach, offline with the fake model."""
import json
import tempfile
import unittest
from pathlib import Path

from seedots.common.contracts import SIGNATURE_HEADER, MediaEvent, verify
from seedots.common.db import Database
from seedots.common.llm import FakeTransport, Gateway, TaskConfig
from seedots.learning import pipeline as lp
from seedots.learning.coach import Coach
from seedots.learning.fake import learning_fake
from seedots.learning.runtime import LLMSelector, Runtime, Signal
from seedots.learning.service import handle_media_event
from seedots.learning.store import SCHEMA as LSCHEMA, LearningStore
from seedots.media.fake import media_fake
from seedots.media.service import MediaService
from seedots.media.store import SCHEMA as MSCHEMA, MediaStore
from seedots.media.webhooks import Dispatcher
from tests.fixtures import long_vtt

ROOT = Path(__file__).resolve().parents[1] / "seedots"


class InProcessMedia:
    """MediaClient backed directly by the foundation's store (no HTTP)."""

    def __init__(self, store: MediaStore):
        self.store = store

    def get(self, media_id):
        return self.store.get_media(media_id)

    def evidence(self, media_id, kinds="sentence,chapter", t0=None, t1=None):
        return self.store.evidence(media_id, kinds=kinds.split(","), t0=t0, t1=t1)


class EndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        video = d / "lesson.mp4"
        video.write_bytes(b"not really a video")
        video.with_suffix(".vtt").write_text(long_vtt(40))
        self.mstore = MediaStore(Database(d / "m.sqlite3", MSCHEMA))
        mgw = Gateway(FakeTransport(media_fake), ROOT / "media" / "prompts", "fake")
        self.media = MediaService(self.mstore, mgw, d)
        self.lstore = LearningStore(Database(d / "l.sqlite3", LSCHEMA))
        self.lgw = Gateway(FakeTransport(learning_fake), ROOT / "learning" / "prompts", "fake",
                           tasks={"select_action": TaskConfig()})
        self.video = video

    def tearDown(self):
        self.tmp.cleanup()

    def test_full_loop(self):
        m = self.media.register(kind="upload", uri=str(self.video), visibility="private", owner="demo",
                                language="en", rights_attestation="uploader")
        self.media.analyze(m["id"], priority_from=130.0, background=False)
        m = self.mstore.get_media(m["id"])
        self.assertEqual(m["status"], "ready", m["status_detail"])
        sentences = self.mstore.evidence(m["id"], kinds=["sentence"])
        chapters = self.mstore.evidence(m["id"], kinds=["chapter"])
        self.assertEqual(len(sentences), 40)
        self.assertEqual(len(chapters), 3)  # fake outline: 14 sentences per chapter
        covered = [sid for c in chapters for sid in c.content["sentence_ids"]]
        self.assertEqual(covered, [s.id for s in sentences])

        # re-running analysis is a no-op (stages are idempotent)
        self.media.analyze(m["id"], background=False)
        self.assertEqual(len(self.mstore.evidence(m["id"], kinds=["chapter"])), 3)

        # deliver the outbox through a signed webhook into the learning backend
        received = []

        def poster(url, body, headers):
            self.assertTrue(verify(body, "s3cret", headers[SIGNATURE_HEADER]))
            received.append(MediaEvent.model_validate_json(body))
            return 200

        Dispatcher(self.mstore, "http://learning/hooks", "s3cret", poster).deliver_once()
        types = [e.type for e in received]
        self.assertEqual(types[:2], ["media.registered", "media.outline_ready"])
        ready = [e for e in received if e.type == "media.chapter_ready"]
        # priority: the chapter holding t=130 first, then the rest
        self.assertEqual(ready[0].data["chapter_id"], chapters[1].id)

        client = InProcessMedia(self.mstore)
        pipe = lp.ChapterPipeline(self.lstore, client, self.lgw)
        queue = []
        for ev in received:
            handle_media_event(ev, self.lstore, client, lambda mid, cid: queue.append((mid, cid)))
        # duplicate delivery is ignored
        self.assertEqual(handle_media_event(received[0], self.lstore, client, lambda *a: None), "duplicate")
        for mid, cid in queue:
            pipe.run(mid, cid)
        self.assertEqual(pipe.run(*queue[0]), {"skipped": True})

        items = self.lstore.items(m["id"])
        self.assertGreater(len(items), 0)
        for it in items:
            self.assertTrue(it["evidence_ids"])
            self.assertTrue(all(e.startswith(m["id"]) for e in it["evidence_ids"]))
        self.assertGreater(len(self.lstore.all_concepts()), 0)

        # runtime: chapter end -> quiz (rules and fake model agree)
        rt = Runtime(self.lstore, LLMSelector(self.lgw, self.lstore))
        sig = Signal(kind="chapter_end", t=chapters[0].t1 - 0.1, chapter_id=chapters[0].id)
        d = rt.decide("u1", m["id"], sig, use_llm=True)
        self.assertEqual(d["action"], "quiz")
        self.assertNotIn("answer_key", d["item"])
        item = self.lstore.item(d["item"]["id"])

        # wrong answer on an unreviewed item: graded, but not counted toward mastery
        wrong = {"index": 99} if "index" in item["answer_key"] else {"order": [], "pairs": []}
        res = rt.attempt("u1", item["id"], wrong, assisted=False)
        self.assertFalse(res["correct"])
        self.assertFalse(res["counted_toward_mastery"])

        # repeated rewinds after a wrong answer -> rule suggests rewatching the evidence
        rew = rt.decide("u1", m["id"], Signal(kind="rewind_repeat", t=chapters[0].t0 + 5), use_llm=False)
        self.assertEqual(rew["action"], "rewatch")
        self.assertIn("t0", rew["rewatch"])

        # a reviewed item answered correctly first time counts
        other = next(i for i in self.lstore.items(m["id"]) if i["id"] != item["id"] and i["type"] == "single_choice")
        self.lstore.set_review(other["id"], "human_reviewed")
        ok = rt.attempt("u2", other["id"], {"index": other["answer_key"]["index"]}, assisted=False)
        self.assertTrue(ok["correct"])
        self.assertTrue(ok["counted_toward_mastery"])

        # model failure falls back to rules
        class Broken:
            name = "broken"

            def select(self, ctx):
                raise RuntimeError("boom")

        d2 = Runtime(self.lstore, Broken()).decide("u3", m["id"], sig, use_llm=True)
        self.assertTrue(d2["fallback"])
        self.assertEqual(d2["action"], d2["rule_action"])

        # coach streams and resolves citations to evidence ids
        parts = list(Coach(self.lstore, self.lgw).ask("u1", m["id"], 30.0, "why?"))
        self.assertEqual(parts[-1]["type"], "done")
        self.assertTrue(parts[-1]["citations"])
        self.assertTrue(parts[-1]["citations"][0]["id"].startswith(m["id"]))


class GatewayTests(unittest.TestCase):
    def test_invalid_json_is_retried_once_then_fails(self):
        from pydantic import BaseModel

        from seedots.common.llm import LLMError

        class Out(BaseModel):
            chapters: list

        calls = []

        def bad(task, messages):
            calls.append(1)
            return "not json" if len(calls) == 1 else json.dumps({"chapters": []})

        gw = Gateway(FakeTransport(bad), ROOT / "media" / "prompts", "fake")
        out = gw.run("outline", {"title": "t", "hints": "none", "sentences": "s0001 [00:00] hi"}, Out)
        self.assertEqual(out.chapters, [])
        self.assertEqual(len(calls), 2)

        gw2 = Gateway(FakeTransport(lambda t, m: "nope"), ROOT / "media" / "prompts", "fake")
        with self.assertRaises(LLMError):
            gw2.run("outline", {"title": "x", "hints": "none", "sentences": "s0001 [00:00] hi"}, Out)


if __name__ == "__main__":
    unittest.main()
