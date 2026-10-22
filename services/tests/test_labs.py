"""Labs on the rig service: the client and tools, the pipeline's lab agent, the builder's route choice,
the coach's observe_lab tool and the "lab" action, end to end over the API with the fake model."""
import json
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from tests.support import node_runs_ts, rig_service, test_settings

GOOD = {
    "version": 2, "rig": "iteration", "title": "Step size", "prompt": "Change the learning rate.",
    "params": [{"name": "lr", "label": "Learning rate", "min": 0.02, "max": 1.1, "step": 0.01, "value": 0.1}],
    "config": {"start": "0", "update": "x - lr*2*(x - 3)", "steps": 30, "objective": "(x - 3)^2",
               "x": {"min": -1, "max": 7, "label": "x"}},
    "predict": {"question": "What if it is 1.05?", "set": {"lr": 1.05}, "observe": "behaviour", "kind": "category"},
}


@unittest.skipUnless(node_runs_ts(), "the rig service needs Node 22.18+")
class RigToolsTests(unittest.TestCase):
    def test_client_and_tools(self):
        from seedots.learning.scenes.lab_tools import authoring_tools, coaching_tools
        from seedots.learning.scenes.rigs import RigClient

        with rig_service() as url:
            rigs = RigClient.at(url)
            self.assertTrue(rigs.available)
            list_rigs, describe_rig, try_rig = authoring_tools(rigs)
            self.assertEqual(list_rigs("softmax temperature over a few classes")["rigs"][0]["id"], "distribution")
            self.assertIn("example_specs", describe_rig("iteration"))
            ok = try_rig(GOOD)
            self.assertTrue(ok["ok"], ok)
            self.assertNotIn("answer", ok)                      # the answer never goes back to the model
            bad = json.loads(json.dumps(GOOD))
            bad["config"]["update"] = "x - q*2"
            rep = try_rig(bad)
            self.assertFalse(rep["ok"])
            self.assertIn("unknown name q", " ".join(rep["problems"]))
            self.assertEqual(rigs.check(GOOD)["answer"], "blows up")

            observe_lab, sweep_lab = coaching_tools(rigs, {"scn_1": {"id": "scn_1", "title": "Step size", "spec": GOOD}})
            self.assertIn("no lab", observe_lab("scn_9", {"lr": 1})["error"])
            got = observe_lab("scn_1", {"lr": 5})
            self.assertEqual(got["settings"]["lr"], 1.1)          # clamped to the slider
            self.assertEqual(got["observed"]["behaviour"], "blows up")
            self.assertIn("no param", observe_lab("scn_1", {"zzz": 1})["error"])
            self.assertEqual(len(sweep_lab("scn_1", "lr")["points"]), 11)

    def test_unreachable_service_is_reported_not_raised(self):
        from seedots.learning.scenes.lab_tools import authoring_tools
        from seedots.learning.scenes.rigs import RigClient

        rigs = RigClient.at("http://127.0.0.1:9")
        self.assertFalse(rigs.available)
        _, _, try_rig = authoring_tools(rigs)
        self.assertFalse(try_rig(GOOD)["ok"])


@unittest.skipUnless(node_runs_ts(), "the rig service needs Node 22.18+")
class LabEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from seedots.learning.api import create_app as learning_app
        from seedots.learning.app import build_container as learning_container
        from seedots.media.api import create_app as media_app
        from seedots.media.app import build_container as media_container

        cls.svc = rig_service()
        url = cls.svc.__enter__()
        cls.tmp = tempfile.TemporaryDirectory()
        settings = test_settings(Path(cls.tmp.name), rigs_url=url)
        holder = {}
        cls.mc = media_container(settings, inline=True,
                                 poster=lambda u, b, h: holder["l"].post("/hooks/media", content=b, headers=h).status_code)
        cls.media = TestClient(media_app(cls.mc))
        cls.lc = learning_container(settings, media_http=cls.media, inline=True)
        cls.api = TestClient(learning_app(cls.lc))
        holder["l"] = cls.api

    @classmethod
    def tearDownClass(cls):
        cls.svc.__exit__(None, None, None)
        cls.tmp.cleanup()

    def test_pipeline_lab_builder_route_coach_and_action(self):
        from tests.fixtures import long_vtt
        from tests.support import make_video

        U = {"X-SeeDots-User": "u1"}
        video = make_video(Path(self.tmp.name) / "gd.mp4", 120)
        r = self.api.post("/api/videos/upload", headers=U, files={
            "file": ("gd.mp4", video.open("rb"), "video/mp4"), "captions": ("gd.vtt", long_vtt(20).encode(), "text/vtt")})
        mid = r.json()["media_id"]
        self.mc.dispatcher.deliver_once()
        pack = self.api.get(f"/api/videos/{mid}/pack", headers=U).json()

        # 1. the pipeline made a rig lab: checked by the rig service, the answer kept out of the spec
        labs = [s for s in pack["scenes"] if s["engine"] == "rig"]
        self.assertTrue(labs, pack["scenes"])
        lab = labs[0]
        self.assertEqual(lab["component"], "rig:iteration")
        self.assertEqual(lab["spec"]["version"], 2)
        self.assertEqual(lab["checks"], {"rig checks": "passed"})
        self.assertEqual(lab["activity"], "make_it_happen")
        self.assertNotIn("answer", json.dumps(lab["spec"]))
        self.assertIsNotNone(lab["evidence"][0]["t0"])
        usage = {u["task"]: u for u in self.api.get("/api/usage").json()}
        self.assertEqual(usage["lab_spec"]["context_manifest"]["tools"], ["list_rigs", "describe_rig", "try_rig"])

        # 2. a learner request a rig can show: the builder takes the rig route, no sandbox or screenshot
        chapter = lab["chapter_id"]
        sc = self.api.post("/api/scenes", headers=U, json={"media_id": mid, "chapter_id": chapter,
                                                           "request": "use a template to show the step size"}).json()
        done = self.api.get(f"/api/scenes/{sc['id']}", headers=U).json()
        self.assertEqual(done["status"], "ready", done)
        self.assertEqual(done["engine"], "rig")
        self.assertEqual(done["route"]["route"], "rig")
        self.assertEqual(done["checks"]["rig checks"], "passed")
        self.assertEqual(done["checks"]["screenshot review"], "skipped")
        notes = " ".join(e["note"] for e in done["progress"]["log"])
        self.assertIn("iteration rig", notes)
        self.assertEqual(self.api.get(f"/api/scenes/{sc['id']}/runner", headers=U).status_code, 404)
        # the build streamed what it was doing: rigs read, a draft checked and offered, then done
        live = self.api.get(f"/api/scenes/{sc['id']}/live", headers=U).text
        kinds = [line[7:] for line in live.splitlines() if line.startswith("event: ")]
        for k in ("stage", "draft_try", "tool_done", "draft", "done"):
            self.assertIn(k, kinds)
        self.assertEqual(kinds[-1], "done")
        draft = next(json.loads(b.split("data: ", 1)[1]) for b in live.split("\n\n") if b.startswith("event: draft\n"))
        self.assertEqual(draft["spec"]["rig"], "iteration")

        # 3. the coach answers "what if" with a number from the lab, and links to it
        t = pack["chapters"][0]["t0"] + 5
        raw = self.api.post("/api/coach", headers=U, json={"media_id": mid, "t": t,
                                                           "question": "What if the learning rate were 1.05?"}).text
        body = "".join(json.loads(line[5:]).get("text", "") for line in raw.splitlines() if line.startswith("data:"))
        self.assertIn("blows up", body)
        self.assertIn("#lab-scn_", body)

        # 4. at a chapter end with no question left, the rules invite the learner into the lab
        self.lc.runtime.use_llm = False
        for item in self.api.get(f"/api/videos/{mid}/pack", headers=U).json().get("items", []):
            self.api.post("/api/attempts", headers=U, json={"item_id": item["id"], "response": {}})
        d = self.api.post("/api/decide", headers=U, json={"media_id": mid, "signal": {
            "kind": "chapter_end", "t": pack["chapters"][0]["t1"], "chapter_id": chapter}}).json()
        self.assertEqual(d["action"], "lab", d)
        self.assertEqual(d["lab"]["engine"], "rig")


if __name__ == "__main__":
    unittest.main()
