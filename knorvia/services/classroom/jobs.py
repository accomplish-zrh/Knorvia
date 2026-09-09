"""Classroom generation jobs — durable, replayable generation tasks.

A job outlives its HTTP request: the client gets a ``job_id`` immediately,
the generation keeps running server-side (asyncio task, not request-bound),
every protocol event is appended to ``data/classrooms/_jobs/{id}.json``
(atomic tmp+replace, same discipline as the classroom store), and any later
reader — or the same client after a refresh — can replay the full event
history and then follow live. Cross-restart tracking is file-based; on
startup leftover ``running``/``pending`` jobs are honestly marked failed
(no scene-level mid-flight recovery — deliberately out of scope).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import json
import logging
from pathlib import Path
import threading
import time
from typing import Any
import uuid

from knorvia.multi_user.paths import get_admin_path_service

logger = logging.getLogger(__name__)

JOB_STATUSES = ("pending", "running", "done", "failed")
TERMINAL_STATUSES = ("done", "failed")
EVENT_TYPES = ("progress", "done", "error")

_WAKEUP_POLL_SECONDS = 2.0


@dataclass
class ClassroomJob:
    """One generation task + its full, replayable event history."""

    id: str
    status: str = "pending"  # pending | running | done | failed
    topic: str = ""
    # Request summary (names/references only — never KB text or attachments).
    payload: dict[str, Any] = field(default_factory=dict)
    events: list[dict[str, Any]] = field(default_factory=list)
    result_classroom_id: str = ""
    error: str = ""
    created_at: float = 0.0
    updated_at: float = 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.id,
            "status": self.status,
            "topic": self.topic,
            "payload": dict(self.payload),
            "events": [dict(event) for event in self.events],
            "result_classroom_id": self.result_classroom_id,
            "error": self.error,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ClassroomJob":
        status = str(data.get("status") or "pending")
        if status not in JOB_STATUSES:
            status = "failed"
        return cls(
            id=str(data.get("job_id") or data.get("id") or ""),
            status=status,
            topic=str(data.get("topic") or ""),
            payload=data.get("payload") or {},
            events=[
                {
                    "ts": float(event.get("ts") or 0.0),
                    "type": str(event.get("type") or "progress"),
                    "data": event.get("data") or {},
                }
                for event in (data.get("events") or [])
                if isinstance(event, dict)
            ],
            result_classroom_id=str(data.get("result_classroom_id") or ""),
            error=str(data.get("error") or ""),
            created_at=float(data.get("created_at") or 0.0),
            updated_at=float(data.get("updated_at") or 0.0),
        )


class ClassroomJobStore:
    """JSON-file job store with atomic writes and in-process wakeups."""

    def __init__(self, root: Path | None = None) -> None:
        self._root = (
            root
            or get_admin_path_service().workspace_root / "classrooms" / "_jobs"
        )
        self._root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._wakeups: dict[str, set[asyncio.Event]] = {}
        self.recover_interrupted()

    def _path(self, job_id: str) -> Path:
        safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in job_id)
        return self._root / f"{safe}.json"

    def _write(self, job: ClassroomJob) -> None:
        payload = json.dumps(job.to_dict(), ensure_ascii=False, indent=2)
        path = self._path(job.id)
        with self._lock:
            temporary = path.with_suffix(f".{threading.get_ident()}.tmp")
            temporary.write_text(payload, encoding="utf-8")
            temporary.replace(path)

    def _read(self, job_id: str) -> ClassroomJob | None:
        path = self._path(job_id)
        if not path.exists():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return ClassroomJob.from_dict(data)
        except (OSError, json.JSONDecodeError):
            logger.exception("Failed to read classroom job %s", job_id)
            return None

    def create(self, topic: str, payload: dict[str, Any]) -> ClassroomJob:
        now = time.time()
        job = ClassroomJob(
            id=f"job-{uuid.uuid4().hex[:12]}",
            status="pending",
            topic=topic,
            payload=dict(payload),
            created_at=now,
            updated_at=now,
        )
        self._write(job)
        return job

    def get(self, job_id: str) -> ClassroomJob | None:
        return self._read(job_id)

    def _mutate(self, job_id: str, mutate) -> ClassroomJob | None:
        job = self._read(job_id)
        if job is None:
            return None
        mutate(job)
        job.updated_at = time.time()
        self._write(job)
        self._wake(job_id)
        return job

    def mark_running(self, job_id: str) -> None:
        self._mutate(job_id, lambda job: setattr(job, "status", "running"))

    def mark_done(self, job_id: str, classroom_id: str) -> None:
        def mutate(job: ClassroomJob) -> None:
            job.status = "done"
            job.result_classroom_id = classroom_id

        self._mutate(job_id, mutate)

    def mark_failed(self, job_id: str, error: str) -> None:
        def mutate(job: ClassroomJob) -> None:
            job.status = "failed"
            job.error = str(error or "")[:500]

        self._mutate(job_id, mutate)

    def append_event(self, job_id: str, event_type: str, data: dict[str, Any]) -> None:
        """Append one protocol event (``progress``/``done``/``error``) + persist."""

        def mutate(job: ClassroomJob) -> None:
            job.events.append({"ts": time.time(), "type": event_type, "data": dict(data)})

        self._mutate(job_id, mutate)

    def register_wakeup(self, job_id: str) -> asyncio.Event:
        event = asyncio.Event()
        self._wakeups.setdefault(job_id, set()).add(event)
        return event

    def _wake(self, job_id: str) -> None:
        for event in self._wakeups.pop(job_id, set()):
            event.set()

    async def wait_for_events(self, job_id: str, timeout: float = _WAKEUP_POLL_SECONDS) -> None:
        """Block until new events/status land or *timeout* elapses (poll fallback)."""
        event = self.register_wakeup(job_id)
        try:
            await asyncio.wait_for(event.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            return
        finally:
            registered = self._wakeups.get(job_id)
            if registered is not None:
                registered.discard(event)

    def recover_interrupted(self) -> int:
        """Mark leftover running/pending jobs failed (honest restart cut)."""
        recovered = 0
        for path in self._root.glob("*.json"):
            try:
                job = ClassroomJob.from_dict(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, json.JSONDecodeError):
                continue
            if job.status in {"pending", "running"}:
                job.status = "failed"
                job.error = "interrupted by restart"
                job.updated_at = time.time()
                self._write(job)
                recovered += 1
        if recovered:
            logger.info("Marked %s leftover classroom job(s) as failed", recovered)
        return recovered


_store: ClassroomJobStore | None = None


def get_classroom_job_store() -> ClassroomJobStore:
    global _store
    if _store is None:
        _store = ClassroomJobStore()
    return _store


__all__ = [
    "ClassroomJob",
    "ClassroomJobStore",
    "EVENT_TYPES",
    "JOB_STATUSES",
    "TERMINAL_STATUSES",
    "get_classroom_job_store",
]
