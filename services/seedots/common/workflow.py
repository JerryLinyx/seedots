"""Workflow port (tech plan §2: Temporal for both the foundation and the learning backend).

A service describes long-running work as named *workflows* made of idempotent *steps*:

    plan(workflow, arg)            -> ["captions", "outline", "publish"]
    run_step(workflow, arg, step)  -> does the step; safe to repeat
    failed(workflow, arg, error)   -> terminal failure hook

Two engines run the same StepRunner unchanged:
  * InProcessEngine - threads + per-step retries; for local dev and tests.
  * TemporalEngine  - one generic Temporal workflow that executes the plan as activities
                      (seedots.common.temporal). Durable retries, visibility, replay.
"""
from __future__ import annotations

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Protocol

log = logging.getLogger("seedots.workflow")


class PermanentError(RuntimeError):
    """A failure that retrying cannot fix (bad input, unsupported source). Not retried."""


class StepRunner(Protocol):
    def plan(self, workflow: str, arg: dict[str, Any]) -> list[str]: ...
    def run_step(self, workflow: str, arg: dict[str, Any], step: str) -> None: ...
    def failed(self, workflow: str, arg: dict[str, Any], error: str) -> None: ...


class Engine(Protocol):
    def start(self, workflow: str, workflow_id: str, arg: dict[str, Any]) -> bool:
        """Start unless a run with this id is already in flight. Returns True if started."""
        ...


def execute(runner: StepRunner, workflow: str, arg: dict[str, Any], *, attempts: int = 3,
            backoff: float = 1.0) -> None:
    """Run a whole plan in the calling thread, retrying transient step failures."""
    try:
        for step in runner.plan(workflow, arg):
            for attempt in range(1, attempts + 1):
                try:
                    runner.run_step(workflow, arg, step)
                    break
                except PermanentError:
                    raise
                except Exception:
                    if attempt == attempts:
                        raise
                    log.warning("%s/%s attempt %d failed; retrying", workflow, step, attempt, exc_info=True)
                    time.sleep(backoff * 2 ** (attempt - 1))
    except Exception as exc:
        log.exception("workflow %s failed", workflow)
        runner.failed(workflow, arg, str(exc) or type(exc).__name__)


class InProcessEngine:
    def __init__(self, runner: StepRunner, *, workers: int = 2, inline: bool = False, backoff: float = 1.0):
        self.runner, self.inline, self.backoff = runner, inline, backoff
        self._pool = None if inline else ThreadPoolExecutor(max_workers=workers, thread_name_prefix="wf")
        self._running: set[str] = set()
        self._lock = threading.Lock()

    def start(self, workflow: str, workflow_id: str, arg: dict[str, Any]) -> bool:
        with self._lock:
            if workflow_id in self._running:
                return False
            self._running.add(workflow_id)

        def go() -> None:
            try:
                execute(self.runner, workflow, arg, backoff=self.backoff)
            finally:
                with self._lock:
                    self._running.discard(workflow_id)

        if self.inline:
            go()
        else:
            self._pool.submit(go)
        return True

    def shutdown(self) -> None:
        if self._pool:
            self._pool.shutdown(wait=False, cancel_futures=True)


def build_engine(kind: str, runner: StepRunner, *, service: str, temporal_address: str = "",
                 inline: bool = False) -> Engine:
    if kind == "temporal":
        from seedots.common.temporal import TemporalEngine

        return TemporalEngine(temporal_address, namespace=f"seedots-{service}", task_queue=f"seedots-{service}")
    return InProcessEngine(runner, inline=inline)
