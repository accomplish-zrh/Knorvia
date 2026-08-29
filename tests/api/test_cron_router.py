"""Router tests for /api/v1/cron — templates catalog + job payload extras."""

from __future__ import annotations

import importlib
from pathlib import Path

import pytest

pytest.importorskip("fastapi")

FastAPI = pytest.importorskip("fastapi").FastAPI
TestClient = pytest.importorskip("fastapi.testclient").TestClient
cron_router = importlib.import_module("knorvia.api.routers.cron").router

from knorvia.services.cron.service import (
    CronJob,
    CronOwner,
    CronRunRecord,
    CronSchedule,
    CronService,
)


def _build_app(service: CronService) -> FastAPI:
    app = FastAPI()
    app.include_router(cron_router, prefix="/api/v1/cron")
    return app


@pytest.fixture
def client(tmp_path: Path, monkeypatch) -> TestClient:
    service = CronService(store_path=tmp_path / "cron" / "jobs.json", on_job=None)
    monkeypatch.setattr("knorvia.api.routers.cron.get_cron_service", lambda: service)
    return TestClient(_build_app(service))


class TestTemplatesEndpoint:
    def test_lists_localized_templates(self, client: TestClient) -> None:
        en = client.get("/api/v1/cron/templates").json()["templates"]
        assert len(en) >= 8
        first = en[0]
        for key in ("id", "icon", "title", "description", "message", "schedule"):
            assert key in first
        assert all(template["title"] for template in en)

        zh = client.get("/api/v1/cron/templates?language=zh").json()["templates"]
        assert zh[0]["title"] != en[0]["title"]
        # Chinese language variants still resolve when a region suffix rides along.
        zh_cn = client.get("/api/v1/cron/templates?language=zh-CN").json()
        assert zh_cn["templates"][0]["title"] == zh[0]["title"]

    def test_template_schedules_are_valid(self, client: TestClient) -> None:
        from knorvia.services.cron.service import validate_schedule

        for template in client.get("/api/v1/cron/templates").json()["templates"]:
            schedule = template["schedule"]
            validate_schedule(
                CronSchedule(
                    kind=schedule["kind"],
                    at_ms=schedule.get("at_ms"),
                    every_seconds=schedule.get("every_seconds"),
                    expr=schedule.get("expr"),
                    tz=schedule.get("tz"),
                )
            )

    def test_templates_are_not_owner_scoped(self, client: TestClient) -> None:
        # Templates are static product content; the endpoint takes no auth scope.
        response = client.get("/api/v1/cron/templates")
        assert response.status_code == 200
        assert isinstance(response.json()["templates"], list)


class TestRunHistoryInPayload:
    def test_run_history_round_trips_through_list_jobs(
        self, client: TestClient, monkeypatch
    ) -> None:
        created = client.post(
            "/api/v1/cron/jobs",
            json={
                "name": "digest",
                "message": "produce a digest",
                "cron_expr": "0 9 * * *",
                "tz": "UTC",
            },
        )
        assert created.status_code == 200, created.text

        # Simulate two completed runs directly against the store's scheduler
        # bookkeeping, then confirm list exposes them.
        import knorvia.api.routers.cron as cron_module

        service = cron_module.get_cron_service()
        job_id = created.json()["id"]
        owner_key = _owner_key(client)
        job = next(j for j in service.list_jobs(owner_key) if j.id == job_id)
        job.state.run_history = [
            CronRunRecord(run_at_ms=1000, status="ok", duration_ms=42),
            CronRunRecord(run_at_ms=2000, status="error", duration_ms=5, error="boom"),
        ]
        monkeypatch.setattr(service, "_save", lambda: None)

        jobs = client.get("/api/v1/cron/jobs").json()["jobs"]
        history = jobs[0]["state"]["run_history"]
        assert [(r["status"], r["error"]) for r in history] == [("ok", None), ("error", "boom")]
        assert history[1]["duration_ms"] == 5


class TestRunsEndpoint:
    def test_lists_journalled_runs_newest_first(self, client: TestClient) -> None:
        import knorvia.api.routers.cron as cron_module
        from knorvia.services.cron.service import CronRunLogEntry

        service = cron_module.get_cron_service()
        owner_key = _owner_key(client)
        for index, run_at in enumerate((1_000, 3_000, 2_000)):
            service._append_run_log(
                CronRunLogEntry(
                    job_id=f"j{index}",
                    job_name=f"Task {index}",
                    owner_key=owner_key,
                    run_at_ms=run_at,
                    status="ok",
                    duration_ms=10 * index,
                    error=None,
                )
            )

        payload = client.get("/api/v1/cron/jobs/runs").json()
        assert [run["run_at_ms"] for run in payload["runs"]] == [3_000, 2_000, 1_000]
        first = payload["runs"][0]
        for key in ("job_id", "job_name", "status", "duration_ms", "error"):
            assert key in first

        limited = client.get("/api/v1/cron/jobs/runs?limit=1").json()
        assert len(limited["runs"]) == 1

    def test_foreign_owner_entries_are_filtered(self, client: TestClient) -> None:
        import knorvia.api.routers.cron as cron_module
        from knorvia.services.cron.service import CronRunLogEntry

        service = cron_module.get_cron_service()
        service._append_run_log(
            CronRunLogEntry(
                job_id="x",
                job_name="Partner task",
                owner_key="partner:p1",
                run_at_ms=5_000,
                status="ok",
                duration_ms=1,
                error=None,
            )
        )
        assert client.get("/api/v1/cron/jobs/runs").json()["runs"] == []


def _owner_key(_client: TestClient) -> str:
    """The fallback local admin's owner key (auth disabled in tests)."""
    return f"chat:{CronOwner(kind='chat').user_id or 'local-admin'}"


class TestCreateFromTemplateShape:
    @staticmethod
    def _to_create_payload(template: dict) -> dict:
        """Translate a template's schedule into CronCreateRequest fields —
        the same mapping the web UI applies when creating from a template."""
        schedule = template["schedule"]
        translated: dict = {
            "name": template["title"],
            "message": template["message"],
        }
        if schedule["kind"] == "cron":
            translated["cron_expr"] = schedule["expr"]
            translated["tz"] = schedule.get("tz")
        elif schedule["kind"] == "every":
            translated["every_seconds"] = schedule["every_seconds"]
        return translated

    def test_apply_template_payload_creates_job(self, client: TestClient) -> None:
        templates = client.get("/api/v1/cron/templates").json()["templates"]
        for template in templates:
            created = client.post("/api/v1/cron/jobs", json=self._to_create_payload(template))
            assert created.status_code == 200, (template["id"], created.text)
            body = created.json()
            assert body["name"] == template["title"]
            assert body["message"] == template["message"]
            assert body["enabled"] is True
