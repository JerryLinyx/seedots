"""Temporal implementation of the workflow port. Optional dependency: `pip install temporalio`.

One generic workflow executes any StepRunner plan as activities, so services never write
Temporal-specific code:

    StepsWorkflow(req) -> activity plan(req) -> activity step(req, s) for each s
                       -> on terminal failure: activity failed(req, error)

Run a worker per service (separate namespaces, tech plan §2):

    python -m seedots.common.temporal media      # foundation worker
    python -m seedots.common.temporal learning   # learning backend worker
"""
from __future__ import annotations

import asyncio
import sys
from datetime import timedelta
from typing import Any

from temporalio import activity, workflow
from temporalio.client import Client
from temporalio.common import RetryPolicy, WorkflowIDConflictPolicy
from temporalio.exceptions import ActivityError, ApplicationError
from temporalio.worker import Worker

STEP_RETRY = RetryPolicy(initial_interval=timedelta(seconds=2), backoff_coefficient=2.0,
                         maximum_interval=timedelta(minutes=2), maximum_attempts=5,
                         non_retryable_error_types=["PermanentError"])


@workflow.defn(name="seedots.steps")
class StepsWorkflow:
    @workflow.run
    async def run(self, req: dict[str, Any]) -> None:
        opts = {"start_to_close_timeout": timedelta(minutes=30), "retry_policy": STEP_RETRY}
        try:
            steps = await workflow.execute_activity("seedots.plan", req, **opts)
            for step in steps:
                await workflow.execute_activity("seedots.step", {**req, "step": step}, **opts)
        except ActivityError as exc:
            await workflow.execute_activity("seedots.failed", {**req, "error": str(exc.cause or exc)},
                                            start_to_close_timeout=timedelta(minutes=1))
            raise


def activities_for(runner) -> list:
    from seedots.common.workflow import PermanentError

    @activity.defn(name="seedots.plan")
    def plan(req: dict[str, Any]) -> list[str]:
        return runner.plan(req["workflow"], req["arg"])

    @activity.defn(name="seedots.step")
    def step(req: dict[str, Any]) -> None:
        try:
            runner.run_step(req["workflow"], req["arg"], req["step"])
        except PermanentError as exc:
            raise ApplicationError(str(exc), type="PermanentError", non_retryable=True) from exc

    @activity.defn(name="seedots.failed")
    def failed(req: dict[str, Any]) -> None:
        runner.failed(req["workflow"], req["arg"], req.get("error", ""))

    return [plan, step, failed]


class TemporalEngine:
    def __init__(self, address: str, *, namespace: str, task_queue: str):
        self.address, self.namespace, self.task_queue = address, namespace, task_queue

    async def _start(self, workflow_name: str, workflow_id: str, arg: dict[str, Any]) -> None:
        client = await Client.connect(self.address, namespace=self.namespace)
        await client.start_workflow(StepsWorkflow.run, {"workflow": workflow_name, "arg": arg},
                                    id=workflow_id, task_queue=self.task_queue,
                                    id_conflict_policy=WorkflowIDConflictPolicy.USE_EXISTING)

    def start(self, workflow: str, workflow_id: str, arg: dict[str, Any]) -> bool:
        asyncio.run(self._start(workflow, workflow_id, arg))
        return True


async def run_worker(service: str) -> None:  # pragma: no cover - needs a Temporal server
    from concurrent.futures import ThreadPoolExecutor

    if service == "media":
        from seedots.media.app import build_container
    else:
        from seedots.learning.app import build_container
    container = build_container()
    client = await Client.connect(container.settings.temporal_address, namespace=f"seedots-{service}")
    worker = Worker(client, task_queue=f"seedots-{service}", workflows=[StepsWorkflow],
                    activities=activities_for(getattr(container, "workflows", None) or container.runner),
                    activity_executor=ThreadPoolExecutor(max_workers=4))
    await worker.run()


if __name__ == "__main__":  # pragma: no cover
    asyncio.run(run_worker(sys.argv[1] if len(sys.argv) > 1 else "media"))
