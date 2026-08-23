"""Batched job-follow endpoint for the Video Studio workbench."""

from __future__ import annotations

import importlib
from typing import Any

import pytest

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
except Exception:  # pragma: no cover - optional dependency in lightweight envs
    FastAPI = None
    TestClient = None

pytestmark = pytest.mark.skipif(
    FastAPI is None or TestClient is None, reason="fastapi not installed"
)

if FastAPI is not None and TestClient is not None:
    router_module = importlib.import_module("knorvia.api.routers.video_studio")
    store_mod = importlib.import_module("knorvia.services.video_studio.store")
    router = router_module.router
else:  # pragma: no cover - optional dependency in lightweight envs
    router_module = None
    store_mod = None


PROJECT_ID = "proj_follow"


class _FakeStore:
    def __init__(self) -> None:
        self.projects = {PROJECT_ID: {"id": PROJECT_ID, "title": "Follow"}}
        self.jobs: dict[str, dict[str, Any]] = {}
        self.events: dict[str, list[dict[str, Any]]] = {}

    def get_project(self, project_id: str) -> dict[str, Any] | None:
        return self.projects.get(project_id)

    def get_job(self, job_id: str) -> dict[str, Any] | None:
        return self.jobs.get(job_id)

    def events_after(self, job_id: str, after_seq: int = 0) -> list[dict[str, Any]]:
        return [event for event in self.events.get(job_id, []) if event["seq"] > after_seq]


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> Any:
    if FastAPI is None or TestClient is None or router is None:  # pragma: no cover
        pytest.skip("fastapi not installed")
    fake = _FakeStore()
    monkeypatch.setattr(router_module, "get_video_studio_store", lambda: fake)
    app = FastAPI()
    app.include_router(router, prefix="/api/v1/video-studio")
    with TestClient(app) as test_client:
        yield test_client, fake


def _job(job_id: str) -> dict[str, Any]:
    return {
        "id": job_id,
        "project_id": PROJECT_ID,
        "status": "running",
        "progress": 0.4,
        "output_asset_ids": [],
    }


def test_follow_returns_jobs_and_incremental_events(client: Any) -> None:
    test_client, fake = client
    fake.jobs = {"job_a": _job("job_a"), "job_b": _job("job_b")}
    fake.events = {
        "job_a": [
            {"seq": 1, "type": "job.progress", "message": "halfway"},
            {"seq": 2, "type": "job.progress", "message": "almost"},
        ]
    }
    response = test_client.post(
        f"/api/v1/video-studio/projects/{PROJECT_ID}/jobs:follow",
        json={"jobs": [{"job_id": "job_a", "after_seq": 1}, {"job_id": "job_b"}]},
    )
    assert response.status_code == 200
    payload = response.json()
    assert set(payload["jobs"]) == {"job_a", "job_b"}
    events_a = payload["events"]["job_a"]
    assert [event["seq"] for event in events_a["events"]] == [2]
    assert events_a["next_seq"] == 2
    # No new events for job_b — cursor stays where the caller was.
    assert payload["events"]["job_b"] == {"events": [], "next_seq": 0}


def test_follow_skips_missing_and_foreign_jobs(client: Any) -> None:
    test_client, fake = client
    fake.jobs = {"job_a": _job("job_a")}
    response = test_client.post(
        f"/api/v1/video-studio/projects/{PROJECT_ID}/jobs:follow",
        json={
            "jobs": [
                {"job_id": "job_a"},
                {"job_id": "job_gone"},
                {"job_id": "job_other_project"},
            ]
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert set(payload["jobs"]) == {"job_a"}
    assert set(payload["events"]) == {"job_a"}


def test_follow_unknown_project_is_404(client: Any) -> None:
    test_client, _fake = client
    response = test_client.post(
        "/api/v1/video-studio/projects/proj_missing/jobs:follow",
        json={"jobs": [{"job_id": "job_a"}]},
    )
    assert response.status_code == 404


def test_follow_rejects_oversized_batch(client: Any) -> None:
    test_client, _fake = client
    response = test_client.post(
        f"/api/v1/video-studio/projects/{PROJECT_ID}/jobs:follow",
        json={"jobs": [{"job_id": f"job_{index}"} for index in range(51)]},
    )
    assert response.status_code == 422
