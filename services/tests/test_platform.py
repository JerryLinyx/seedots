"""Platform pieces in isolation: gateway, prompts, migrations, workflow engine, webhooks."""
import json
import tempfile
import unittest
from pathlib import Path

from pydantic import BaseModel

from seedots.common.llm import BudgetExceeded, Gateway, LLMError, PromptLibrary, TaskSpec, fake_model
from seedots.common.llm.prompts import PromptError
from seedots.common.workflow import InProcessEngine, PermanentError, execute


class Out(BaseModel):
    n: int


class MemCache:
    def __init__(self):
        self.d = {}

    def get(self, k):
        return self.d.get(k)

    def put(self, k, task, pv, model, out):
        self.d[k] = out


def prompts(tmp: Path) -> PromptLibrary:
    (tmp / "count.v1.md").write_text("## system\nCount {{what}}.\n## user\n{{text}}")
    (tmp / "count.v2.md").write_text("## system\nCount the {{what}} carefully.\n## user\n{{text}}")
    (tmp / "talk.v1.md").write_text("## system\nBe brief.\n## user\n{{q}}")
    return PromptLibrary(tmp)


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.lib = prompts(Path(self.tmp.name))
        self.usage = []

    def tearDown(self):
        self.tmp.cleanup()

    def gw(self, brain, **spec):
        return Gateway(prompts=self.lib, model_factory=fake_model(brain), model_name="fake",
                       tasks=[TaskSpec("count", Out, **spec), TaskSpec("talk", None)],
                       usage_sink=self.usage.append, cache=MemCache())

    def test_latest_prompt_version_and_usage_log(self):
        seen = []
        gw = self.gw(lambda task, system, user: seen.append(system) or '{"n": 3}')
        self.assertEqual(gw.run("count", {"what": "dots", "text": "..."}).n, 3)
        self.assertIn("carefully", seen[0])
        self.assertEqual(self.usage[0].prompt_version, "count.v2")
        self.assertTrue(self.usage[0].ok)
        pinned = self.gw(lambda *a: '{"n": 1}', prompt_version=1)
        pinned.run("count", {"what": "dots", "text": "..."})
        self.assertEqual(self.usage[-1].prompt_version, "count.v1")

    def test_invalid_output_is_repaired_once_then_fails(self):
        calls = []
        gw = self.gw(lambda *a: calls.append(1) or ("nope" if len(calls) == 1 else '{"n": 2}'))
        self.assertEqual(gw.run("count", {"what": "x", "text": "y"}).n, 2)
        self.assertEqual(len(calls), 2)
        with self.assertRaises(LLMError):
            self.gw(lambda *a: "never json").run("count", {"what": "x", "text": "y"})
        self.assertFalse(self.usage[-1].ok)

    def test_cache_and_budget(self):
        calls = []
        gw = self.gw(lambda *a: calls.append(1) or '{"n": 5}', cache=True, daily_token_budget=10_000)
        gw.run("count", {"what": "x", "text": "same"})
        gw.run("count", {"what": "x", "text": "same"})
        self.assertEqual(len(calls), 1)
        tight = self.gw(lambda *a: '{"n": 5}', daily_token_budget=1)
        tight.run("count", {"what": "x", "text": "a"})
        with self.assertRaises(BudgetExceeded):
            tight.run("count", {"what": "x", "text": "b"})

    def thinking_gw(self, needs: int, *, reject_reasoning=False, **gw):
        """A reasoning model that burns `needs` tokens thinking: below that cap it stops with
        finish_reason=length and no answer."""
        from pydantic_ai.exceptions import ModelHTTPError
        from pydantic_ai.messages import ModelResponse, TextPart
        from pydantic_ai.models.function import FunctionModel

        seen = []

        def call(messages, info):
            st = dict(info.model_settings or {})
            seen.append(st)
            if reject_reasoning and "openai_reasoning_effort" in st:
                raise ModelHTTPError(400, "fake", {"error": "unknown parameter: reasoning_effort"})
            if st.get("max_tokens", 0) < needs:
                return ModelResponse(parts=[], finish_reason="length")
            return ModelResponse(parts=[TextPart('{"n": 7}')])

        g = Gateway(prompts=self.lib, model_factory=lambda task: FunctionModel(call), model_name="fake",
                    tasks=[TaskSpec("count", Out, max_tokens=2000, reasoning="low")],
                    usage_sink=self.usage.append, **gw)
        return g, seen

    def test_token_limit_before_answer_retries_with_larger_cap(self):
        gw, seen = self.thinking_gw(5000)
        self.assertEqual(gw.run("count", {"what": "x", "text": "y"}).n, 7)
        self.assertEqual([s["max_tokens"] for s in seen], [2000, 6000])
        self.assertEqual(self.usage[-1].context_manifest["max_tokens_retry"], 6000)
        self.assertEqual(seen[0]["openai_reasoning_effort"], "low")
        # only one retry: a model that needs even more still fails, with the reason logged
        gw, seen = self.thinking_gw(50_000)
        with self.assertRaises(LLMError) as ctx:
            gw.run("count", {"what": "x", "text": "y"})
        self.assertIn("token limit", str(ctx.exception))
        self.assertEqual(len(seen), 2)

    def test_reasoning_setting_and_overrides(self):
        gw, seen = self.thinking_gw(0, reasoning="off", max_tokens={"count": 9000})
        gw.run("count", {"what": "x", "text": "y"})
        self.assertNotIn("openai_reasoning_effort", seen[0])
        self.assertEqual(seen[0]["max_tokens"], 9000)
        gw, seen = self.thinking_gw(0, reasoning="high")
        gw.run("count", {"what": "x", "text": "y"})
        self.assertEqual(seen[0]["openai_reasoning_effort"], "high")
        # a provider that rejects the parameter: drop it, retry, and stop sending it
        gw, seen = self.thinking_gw(0, reject_reasoning=True)
        self.assertEqual(gw.run("count", {"what": "x", "text": "y"}).n, 7)
        gw.run("count", {"what": "x", "text": "z"})
        self.assertEqual(["openai_reasoning_effort" in s for s in seen], [True, False, False])

    def test_missing_variable_is_an_error(self):
        with self.assertRaises(PromptError):
            self.gw(lambda *a: '{"n": 1}').run("count", {"what": "x"})

    def test_stream(self):
        import asyncio

        gw = self.gw(lambda *a: "one two three")

        async def collect():
            return [d async for d in gw.stream("talk", {"q": "hi"})]
        self.assertEqual("".join(asyncio.run(collect())), "one two three")
        self.assertIsNotNone(self.usage[-1].first_token_ms)


class Steps:
    def __init__(self, fail_times=0, permanent=False):
        self.fail_times, self.permanent, self.ran, self.failed_with = fail_times, permanent, [], None

    def plan(self, wf, arg):
        return ["a", "b"]

    def run_step(self, wf, arg, step):
        if step == "b" and self.fail_times:
            self.fail_times -= 1
            raise (PermanentError if self.permanent else RuntimeError)("x")
        self.ran.append(step)

    def failed(self, wf, arg, error):
        self.failed_with = error


class WorkflowTests(unittest.TestCase):
    def test_transient_failures_are_retried(self):
        r = Steps(fail_times=2)
        execute(r, "wf", {}, backoff=0)
        self.assertEqual(r.ran, ["a", "b"])
        self.assertIsNone(r.failed_with)

    def test_permanent_failure_is_not_retried(self):
        r = Steps(fail_times=1, permanent=True)
        execute(r, "wf", {}, backoff=0)
        self.assertEqual(r.ran, ["a"])
        self.assertEqual(r.failed_with, "x")

    def test_engine_dedupes_running_ids(self):
        e = InProcessEngine(Steps(), inline=True)
        self.assertTrue(e.start("wf", "id-1", {}))


class MigrationTests(unittest.TestCase):
    def test_migrations_match_models_and_render_for_postgres(self):
        import contextlib
        import io

        from alembic import command

        from seedots.common.migrate import alembic_config, upgrade

        with tempfile.TemporaryDirectory() as tmp:
            for service in ("media", "learning"):
                url = f"sqlite:///{tmp}/{service}.db"
                upgrade(service, url)
                command.check(alembic_config(service, url))          # models == migrations
                command.downgrade(alembic_config(service, url), "base")
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    command.upgrade(alembic_config(service, "postgresql://x@localhost/x"), "head", sql=True)
                self.assertIn("JSONB", buf.getvalue())
                self.assertIn("WHERE", buf.getvalue())                # partial indexes survive


class WebhookTests(unittest.TestCase):
    def test_retry_backoff_dead_and_replay(self):
        import dataclasses

        from seedots.common.contracts import SIGNATURE_HEADER, verify
        from seedots.common.db import utcnow
        from seedots.media import repo
        from seedots.media.app import build_container
        from seedots.media.models import MediaAsset, WebhookDelivery
        from seedots.media.webhooks import MAX_ATTEMPTS
        from tests.support import test_settings

        with tempfile.TemporaryDirectory() as tmp:
            status = {"code": 500}
            got = []

            def poster(url, body, headers):
                self.assertTrue(verify(body, "s3cret-test", headers[SIGNATURE_HEADER]))
                got.append(json.loads(body))
                return status["code"]

            c = build_container(dataclasses.replace(test_settings(Path(tmp))), inline=True, poster=poster)
            with c.db.session() as s:
                s.add(MediaAsset(id="med_x", source_kind="platform", source_uri="u", dedupe_key="k",
                                 visibility="public", language="en", capabilities={}))
                s.flush()
                ev = repo.emit(s, "med_x", "media.registered", {})
            self.assertEqual(c.dispatcher.deliver_once(), 0)
            for _ in range(MAX_ATTEMPTS):
                with c.db.session() as s:
                    for d in s.query(WebhookDelivery):
                        d.next_attempt_at = utcnow()
                c.dispatcher.deliver_once()
            with c.db.session() as s:
                self.assertEqual(s.query(WebhookDelivery).one().status.value, "dead")
            status["code"] = 200
            with c.db.session() as s:
                self.assertEqual(repo.replay(s, ev.event_id), 1)
            self.assertEqual(c.dispatcher.deliver_once(), 1)
            self.assertEqual(got[-1]["event_id"], ev.event_id)


if __name__ == "__main__":
    unittest.main()
