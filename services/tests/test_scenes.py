"""Interactive scenes: expression language, L1 validation, Scene Kit rules, the real headless
sandbox, and the L2 workflow end to end over the API."""
import json
import math
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from seedots.learning.scenes import expr, kit, spec
from seedots.learning.scenes.sandbox import NodeSandbox, run_protocol

FAKE = (Path(__file__).resolve().parents[1] / "seedots" / "learning" / "scenes" / "fake_scene.js").read_text()
GD = {"component": "iteration", "title": "Step size", "prompt": "Change the learning rate", "start": 0.0,
      "update": "x - lr*2*(x-3)", "steps": 30, "objective": "(x-3)^2", "x": {"min": -1, "max": 7},
      "params": [{"name": "lr", "label": "Learning rate", "min": 0.02, "max": 1.1, "step": 0.01, "value": 0.1}],
      "predict": {"question": "What if it is 1.05?", "param": "lr", "to": 1.05, "observe": {"kind": "behaviour"}},
      "evidence": ["s0001"]}

_probe = None


def sandbox_works() -> bool:
    global _probe
    if _probe is None:
        sb = NodeSandbox()
        _probe = sb.available and sb.run(kit.runner_html("kit.ready();", "canvas"),
                                         [{"op": "wait_ready", "timeout": 8000}]).ok
    return _probe


class ExprTests(unittest.TestCase):
    def test_precedence_and_functions(self):
        self.assertAlmostEqual(expr.evaluate(expr.parse("2 + 3*x^2"), {"x": 2}), 14)
        self.assertAlmostEqual(expr.evaluate(expr.parse("-x^2"), {"x": 3}), -9)
        self.assertAlmostEqual(expr.evaluate(expr.parse("2^3^2"), {}), 512)
        self.assertAlmostEqual(expr.evaluate(expr.parse("max(1, sin(pi/2), 0.5)"), {}), 1)

    def test_domain_errors_are_nan(self):
        self.assertTrue(math.isnan(expr.evaluate(expr.parse("log(x)"), {"x": -1})))
        self.assertTrue(math.isnan(expr.evaluate(expr.parse("1/x"), {"x": 0})))

    def test_only_the_grammar_is_reachable(self):
        for bad in ["__import__('os')", "x.real", "x[0]", "open(x)", "lambda: 1", "a; b", "x if x else 1"]:
            with self.assertRaises(expr.ExprError, msg=bad):
                expr.check(bad, {"x", "a", "b"})
        with self.assertRaises(expr.ExprError):
            expr.check("y + 1", {"x"})


class L1Tests(unittest.TestCase):
    def test_answer_is_computed_by_code(self):
        _, report = spec.validate(GD, {"s0001"})
        self.assertEqual(report["answer"], "blows up")
        bouncing = json.loads(json.dumps(GD))
        bouncing["predict"]["to"] = 1.0
        self.assertEqual(spec.validate(bouncing, {"s0001"})[1]["answer"], "keeps bouncing")
        plot = {"component": "function_plot", "title": "Parabola", "prompt": "Change a", "x": {"min": -3, "max": 3},
                "curves": [{"expr": "a*x^2"}], "params": [{"name": "a", "label": "a", "min": -2, "max": 2,
                                                         "step": 0.1, "value": 1}],
                "predict": {"question": "?", "param": "a", "to": -1, "observe": {"kind": "value_at", "x": 2}},
                "evidence": ["s0001"]}
        self.assertEqual(spec.validate(plot, {"s0001"})[1]["answer"], "goes down")
        self.assertNotIn("answer", json.dumps(spec.public(spec.validate(plot, {"s0001"})[0])))

    def test_invariants(self):
        cases = {
            "unknown name": {**GD, "update": "x - eta*2*(x-3)"},
            "unused": {**GD, "params": GD["params"] + [{"name": "k", "label": "k", "min": 0, "max": 1, "step": 0.1,
                                                         "value": 0.5}]},
            "evidence": {**GD, "evidence": ["s9999"]},
            "no change": {**GD, "predict": {**GD["predict"], "to": 0.1}},
            "blows up by default": {**GD, "params": [{**GD["params"][0], "value": 1.08}]},
            "bad range": {**GD, "params": [{**GD["params"][0], "min": 2}]},
        }
        for name, case in cases.items():
            with self.assertRaises(spec.SceneInvalid, msg=name):
                spec.validate(case, {"s0001"})


class KitTests(unittest.TestCase):
    def test_static_rules(self):
        self.assertTrue(kit.static_check(FAKE, "canvas").ok)
        for bad, why in [("fetch('/x')", "network"), ("parent.document.title", "outside"), ("eval('1')", "dynamic"),
                         ("el.innerHTML = s", "HTML"), ("localStorage.x = 1", "storage"),
                         ("import('x')", "module"), ("window.top.location = 'x'", "outside")]:
            rep = kit.static_check(bad + "; kit.param('a', {}); kit.observe('a', 1); kit.ready();", "canvas")
            self.assertFalse(rep.ok, bad)
            self.assertTrue(any(why in p for p in rep.problems), (bad, rep.problems))
        self.assertIn("missing", " ".join(kit.static_check("kit.ready()", "canvas").problems))
        self.assertFalse(kit.static_check(FAKE, "three").ok)            # loaded but unused engine

    def test_runner_cannot_be_broken_out_of(self):
        page = kit.runner_html("const s = '</script><script>alert(1)</script>'; kit.ready();", "canvas")
        self.assertEqual(page.count("</script>"), 2)                    # kit + scene, nothing injected
        self.assertIn("Content-Security-Policy", page)


@unittest.skipUnless(sandbox_works(), "headless Chromium sandbox not available")
class SandboxTests(unittest.TestCase):
    DECL = {"params": [{"name": "lr", "min": 0.02, "max": 1.1, "value": 0.1}],
            "predict": {"param": "lr", "to": 1.05, "observation": "behaviour",
                        "options": ["settles down", "keeps bouncing", "blows up"]}}

    def test_good_scene_passes_and_the_answer_comes_from_running_it(self):
        res = run_protocol(NodeSandbox(), FAKE, "canvas", self.DECL)
        self.assertTrue(res.ok, res.problems)
        self.assertEqual(res.answer, "blows up")
        self.assertTrue(res.screenshot and res.screenshot[:4] == b"\x89PNG")

    def test_broken_scenes_are_caught(self):
        throws = FAKE.replace("kit.onChange(draw);", "kit.onChange(function () { nope(); });")
        res = run_protocol(NodeSandbox(), throws, "canvas", self.DECL)
        self.assertFalse(res.ok)
        self.assertTrue(any("threw" in p for p in res.problems), res.problems)
        silent = "kit.param('lr', {min: 0.02, max: 1.1, step: 0.01, value: 0.1}); kit.ready(); kit.observe('x', 1);"
        res = run_protocol(NodeSandbox(), silent, "canvas", self.DECL)
        self.assertTrue(any("blank" in p for p in res.problems))
        self.assertTrue(any("behaviour" in p for p in res.problems))
        nonetwork = "kit.param('lr', {min: 0.02, max: 1.1, step: 0.01, value: 0.1}); var i = new Image(); " \
                    "i.src = 'https://example.com/x.png?leak=1'; kit.ready();"
        res = run_protocol(NodeSandbox(), nonetwork, "canvas", self.DECL)   # CSP blocks it; scene still runs
        self.assertTrue(res.params)


class SceneEndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from seedots.learning.api import create_app as learning_app
        from seedots.learning.app import build_container as learning_container
        from seedots.media.api import create_app as media_app
        from seedots.media.app import build_container as media_container
        from tests.support import test_settings

        cls.tmp = tempfile.TemporaryDirectory()
        settings = test_settings(Path(cls.tmp.name))
        holder = {}
        cls.mc = media_container(settings, inline=True,
                                 poster=lambda u, b, h: holder["l"].post("/hooks/media", content=b, headers=h).status_code)
        cls.media = TestClient(media_app(cls.mc))
        cls.lc = learning_container(settings, media_http=cls.media, inline=True)
        cls.api = TestClient(learning_app(cls.lc))
        holder["l"] = cls.api

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_l1_from_pipeline_and_l2_on_request(self):
        from tests.fixtures import long_vtt
        from tests.support import make_video

        U = {"X-SeeDots-User": "u1"}
        video = make_video(Path(self.tmp.name) / "gd.mp4", 120)
        r = self.api.post("/api/videos/upload", headers=U, files={
            "file": ("gd.mp4", video.open("rb"), "video/mp4"), "captions": ("gd.vtt", long_vtt(20).encode(), "text/vtt")})
        mid = r.json()["media_id"]
        self.mc.dispatcher.deliver_once()
        pack = self.api.get(f"/api/videos/{mid}/pack", headers=U).json()

        l1 = [s for s in pack["scenes"] if s["level"] == "l1"]
        self.assertTrue(l1, pack["scenes"])
        self.assertEqual(l1[0]["status"], "ready")
        self.assertEqual(l1[0]["spec"]["predict"]["options"], spec.BEHAVIOUR_OPTIONS)
        self.assertNotIn("blows up\"", json.dumps(l1[0]["spec"]["predict"]).replace('"blows up"]', ""))
        self.assertTrue(l1[0]["evidence"][0]["t0"] is not None)

        if not sandbox_works():
            self.skipTest("headless Chromium sandbox not available for L2")
        chapter = pack["chapters"][0]["id"]
        sc = self.api.post("/api/scenes", headers=U, json={"media_id": mid, "chapter_id": chapter,
                                                           "request": "let me play with the step size"}).json()
        done = self.api.get(f"/api/scenes/{sc['id']}", headers=U).json()     # inline engine: already finished
        self.assertEqual(done["status"], "ready", done)
        stages = [e["stage"] for e in done["progress"]["log"]]
        for st in ("queued", "drafting", "checking", "verifying", "reviewing", "ready"):
            self.assertIn(st, stages)
        self.assertEqual(done["checks"], {"safety rules": "passed", "scripted run": "passed",
                                          "screenshot review": "passed"})
        self.assertNotIn("code", done["spec"])
        page = self.api.get(f"/api/scenes/{sc['id']}/runner", headers=U)
        self.assertIn("sandbox allow-scripts", page.headers["content-security-policy"])
        self.assertIn("window.__kit", page.text)
        self.assertEqual(self.api.get(f"/api/scenes/{sc['id']}/preview.png", headers=U).content[:4], b"\x89PNG")
        self.assertEqual(self.api.get(f"/api/scenes/{sc['id']}", headers={"X-SeeDots-User": "u2"}).status_code, 404)

        usage = {u["task"]: u for u in self.api.get("/api/usage").json()}
        self.assertIn("run_checks", usage["scene_code"]["context_manifest"]["tools"])
        self.assertGreaterEqual(usage["scene_code"]["requests"], 2)           # agent loop: tool call + answer
        self.assertEqual(usage["scene_review"]["context_manifest"]["images"], 1)


if __name__ == "__main__":
    unittest.main()
