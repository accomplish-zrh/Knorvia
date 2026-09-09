"""T2 — durable generation jobs: persistence, replay, restart cut."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import HTTPException
import pytest

from knorvia.api.routers import classroom as classroom_router
from knorvia.services.classroom.jobs import ClassroomJob, ClassroomJobStore
from knorvia.services.classroom.store import ClassroomStore


def _scripted_llm(responses: list[str], monkeypatch) -> None:
    async def fake_complete(prompt, system_prompt="", **kwargs):
        if len(responses) == 1:
            return responses[0]
        return responses.pop(0)

    import knorvia.services.llm

    monkeypatch.setattr(knorvia.services.llm, "complete", fake_complete)


def _outlines_payload() -> str:
    return json.dumps(
        {
            "title": "任务课",
            "outlines": [
                {"id": "s1", "type": "slide", "title": "A", "key_points": ["x"]},
                {"id": "s2", "type": "slide", "title": "B", "key_points": ["y"]},
            ],
        },
        ensure_ascii=False,
    )


SCENE_JSON = json.dumps(
    {
        "title": "A",
        "key_points": ["x"],
        "actions": [{"type": "speech", "agent_id": "teacher", "text": "讲 A"}],
    }
)


async def _wait_terminal(job_store: ClassroomJobStore, job_id: str) -> ClassroomJob:
    for _ in range(400):
        job = job_store.get(job_id)
        if job is not None and job.status in {"done", "failed"}:
            return job
        await asyncio.sleep(0.05)
    raise AssertionError("generation job never reached a terminal state")


def _install_stores(monkeypatch, tmp_path):
    lesson_store = ClassroomStore(root=tmp_path / "classrooms")
    job_store = ClassroomJobStore(root=tmp_path / "classrooms" / "_jobs")
    monkeypatch.setattr(classroom_router, "get_classroom_store", lambda: lesson_store)
    monkeypatch.setattr(
        classroom_router, "get_classroom_job_store", lambda: job_store
    )
    return lesson_store, job_store


def _parse_sse(chunks: list[str]) -> list[tuple[str, dict[str, Any]]]:
    events: list[tuple[str, dict[str, Any]]] = []
    for chunk in chunks:
        for block in chunk.split("\n\n"):
            if not block.strip():
                continue
            event_type = ""
            data = ""
            for line in block.split("\n"):
                if line.startswith("event:"):
                    event_type = line[6:].strip()
                elif line.startswith("data:"):
                    data = line[5:].strip()
            events.append((event_type, json.loads(data)))
    return events


class TestJobStore:
    def test_create_persists_and_roundtrips(self, tmp_path):
        store = ClassroomJobStore(root=tmp_path / "_jobs")
        job = store.create("递归", {"topic": "递归", "minutes": 12})
        loaded = store.get(job.id)
        assert loaded is not None
        assert loaded.status == "pending"
        assert loaded.topic == "递归"
        assert loaded.payload == {"topic": "递归", "minutes": 12}
        assert loaded.created_at > 0

    def test_events_append_and_persist(self, tmp_path):
        store = ClassroomJobStore(root=tmp_path / "_jobs")
        job = store.create("T", {})
        store.mark_running(job.id)
        store.append_event(job.id, "progress", {"step": "initializing"})
        store.append_event(job.id, "done", {"id": "lesson-1", "title": "T"})
        store.mark_done(job.id, "lesson-1")
        loaded = store.get(job.id)
        assert loaded is not None
        assert [e["type"] for e in loaded.events] == ["progress", "done"]
        assert loaded.events[0]["data"]["step"] == "initializing"
        assert loaded.status == "done"
        assert loaded.result_classroom_id == "lesson-1"

    def test_mark_failed_records_error(self, tmp_path):
        store = ClassroomJobStore(root=tmp_path / "_jobs")
        job = store.create("T", {})
        store.mark_failed(job.id, "boom")
        loaded = store.get(job.id)
        assert loaded is not None and loaded.status == "failed"
        assert loaded.error == "boom"

    def test_store_list_does_not_collect_jobs(self, tmp_path):
        lessons = ClassroomStore(root=tmp_path / "classrooms")
        jobs = ClassroomJobStore(root=tmp_path / "classrooms" / "_jobs")
        lessons.save(_lesson_document())
        jobs.create("T", {})
        cards = lessons.list()
        assert len(cards) == 1

    def test_get_missing_is_none(self, tmp_path):
        assert ClassroomJobStore(root=tmp_path / "_jobs").get("nope") is None


def _lesson_document():
    from knorvia.services.classroom.models import ClassroomDocument

    return ClassroomDocument(id="lesson-1", title="t", topic="t")


class TestRestartRecovery:
    def test_leftover_running_and_pending_marked_failed(self, tmp_path):
        root = tmp_path / "_jobs"
        first = ClassroomJobStore(root=root)
        running = first.create("T", {})
        first.mark_running(running.id)
        pending = first.create("T2", {})

        reopened = ClassroomJobStore(root=root)
        r = reopened.get(running.id)
        p = reopened.get(pending.id)
        assert r is not None and r.status == "failed"
        assert r.error == "interrupted by restart"
        assert p is not None and p.status == "failed"

    def test_terminal_jobs_survive_restart(self, tmp_path):
        root = tmp_path / "_jobs"
        first = ClassroomJobStore(root=root)
        job = first.create("T", {})
        first.mark_done(job.id, "lesson-1")
        reopened = ClassroomJobStore(root=root)
        loaded = reopened.get(job.id)
        assert loaded is not None and loaded.status == "done"


class TestGenerationEndpoint:
    @pytest.mark.asyncio
    async def test_generate_returns_job_and_finishes_in_background(
        self, tmp_path, monkeypatch
    ):
        lesson_store, job_store = _install_stores(monkeypatch, tmp_path)
        _scripted_llm([_outlines_payload(), SCENE_JSON, SCENE_JSON], monkeypatch)

        result = await classroom_router.generate(
            classroom_router.GenerateRequest(topic="递归")
        )
        job_id = result["job_id"]
        assert job_id

        job = await _wait_terminal(job_store, job_id)
        assert job.status == "done"
        assert job.result_classroom_id
        # The lesson really landed on disk even though the request returned
        # long before generation finished.
        assert lesson_store.get(job.result_classroom_id) is not None
        event_types = [e["type"] for e in job.events]
        assert event_types[0] == "progress"
        assert event_types[-1] == "done"
        assert job.events[-1]["data"]["id"] == job.result_classroom_id

    @pytest.mark.asyncio
    async def test_job_payload_never_contains_kb_text(self, tmp_path, monkeypatch):
        _install_stores(monkeypatch, tmp_path)
        _scripted_llm([_outlines_payload(), SCENE_JSON, SCENE_JSON], monkeypatch)

        async def fake_grounding(kb_name, topic):
            return "绝密知识库原文 SECRET-KB-TEXT"

        monkeypatch.setattr(classroom_router, "_resolve_kb_grounding", fake_grounding)
        result = await classroom_router.generate(
            classroom_router.GenerateRequest(topic="递归", kb_name="我的库")
        )
        job_store = classroom_router.get_classroom_job_store()
        job = await _wait_terminal(job_store, result["job_id"])
        assert job.status == "done"
        job_files = list(job_store._root.glob("*.json"))
        assert len(job_files) == 1
        assert "SECRET-KB-TEXT" not in job_files[0].read_text(encoding="utf-8")
        assert job.payload.get("kb_name") == "我的库"

    @pytest.mark.asyncio
    async def test_snapshot_endpoint_404_for_missing_job(self):
        with pytest.raises(HTTPException) as exc_info:
            await classroom_router.get_generation_job("missing-job")
        assert exc_info.value.status_code == 404


class TestJobEventStream:
    @pytest.mark.asyncio
    async def test_stream_replays_all_events_then_closes(self, tmp_path, monkeypatch):
        _install_stores(monkeypatch, tmp_path)
        _scripted_llm([_outlines_payload(), SCENE_JSON, SCENE_JSON], monkeypatch)
        result = await classroom_router.generate(
            classroom_router.GenerateRequest(topic="递归")
        )
        job_store = classroom_router.get_classroom_job_store()
        job = await _wait_terminal(job_store, result["job_id"])

        response = await classroom_router.stream_generation_job_events(job.id)
        chunks = []
        async for chunk in response.body_iterator:
            chunks.append(chunk)
        events = _parse_sse(chunks)
        # The replay covers the WHOLE history and ends at the terminal event.
        assert [t for t, _ in events] == [e["type"] for e in job.events]
        assert events[-1][0] == "done"
        assert events[-1][1]["id"] == job.result_classroom_id

    @pytest.mark.asyncio
    async def test_abandoned_stream_does_not_stop_the_job(self, tmp_path, monkeypatch):
        lesson_store, job_store = _install_stores(monkeypatch, tmp_path)

        # Slow the fake down so the stream is abandoned mid-generation.
        async def slow_complete(prompt, system_prompt="", **kwargs):
            await asyncio.sleep(0.3)
            if prompt.startswith("You are a curriculum") or "Design a micro-lesson" in prompt or "curriculum" in system_prompt:
                return _outlines_payload()
            return SCENE_JSON

        import knorvia.services.llm

        monkeypatch.setattr(knorvia.services.llm, "complete", slow_complete)

        result = await classroom_router.generate(
            classroom_router.GenerateRequest(topic="递归")
        )
        response = await classroom_router.stream_generation_job_events(
            result["job_id"]
        )
        iterator = response.body_iterator
        first = await iterator.__anext__()
        assert "event:" in first
        # Client disconnects.
        await iterator.aclose()

        job = await _wait_terminal(job_store, result["job_id"])
        assert job.status == "done"
        assert lesson_store.get(job.result_classroom_id) is not None

    @pytest.mark.asyncio
    async def test_stream_404_for_missing_job(self):
        with pytest.raises(HTTPException) as exc_info:
            await classroom_router.stream_generation_job_events("missing-job")
        assert exc_info.value.status_code == 404
