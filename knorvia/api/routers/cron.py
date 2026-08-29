"""HTTP API for the built-in scheduled-task store."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from knorvia.multi_user.context import get_current_user
from knorvia.services.cron import (
    CronOwner,
    get_cron_service,
    validate_schedule,
)
from knorvia.services.cron.service import (
    MAX_CRON_EXPRESSION_LENGTH,
    MAX_MESSAGE_LENGTH,
    MAX_NAME_LENGTH,
    MAX_SESSION_ID_LENGTH,
    MAX_TIMEZONE_LENGTH,
)
from knorvia.services.cron.templates import list_templates
from knorvia.tools.cron_tool import _build_schedule

router = APIRouter()


def _owner(*, session_id: str = "", language: str = "en") -> CronOwner:
    user = get_current_user()
    return CronOwner(
        kind="chat",
        user_id=user.id,
        is_admin=user.is_admin,
        session_id=session_id,
        language=language or "en",
    )


def _job_payload(job: Any) -> dict[str, Any]:
    return {
        "id": job.id,
        "name": job.name,
        "message": job.message,
        "enabled": job.enabled,
        "delete_after_run": job.delete_after_run,
        "created_at_ms": job.created_at_ms,
        "schedule": {
            "kind": job.schedule.kind,
            "at_ms": job.schedule.at_ms,
            "every_seconds": job.schedule.every_seconds,
            "expr": job.schedule.expr,
            "tz": job.schedule.tz,
        },
        "owner": {
            "kind": job.owner.kind,
            "session_id": job.owner.session_id,
            "partner_id": job.owner.partner_id,
            "language": job.owner.language,
        },
        "state": {
            "next_run_at_ms": job.state.next_run_at_ms,
            "last_run_at_ms": job.state.last_run_at_ms,
            "last_status": job.state.last_status,
            "last_error": job.state.last_error,
            "run_history": [
                {
                    "run_at_ms": record.run_at_ms,
                    "status": record.status,
                    "duration_ms": record.duration_ms,
                    "error": record.error,
                }
                for record in job.state.run_history
            ],
        },
    }


class CronCreateRequest(BaseModel):
    name: str = Field(default="", max_length=MAX_NAME_LENGTH)
    message: str = Field(..., min_length=1, max_length=MAX_MESSAGE_LENGTH)
    session_id: str = Field(default="", max_length=MAX_SESSION_ID_LENGTH)
    language: str = Field(default="en", max_length=32)
    at: str | None = None
    every_seconds: int | None = None
    cron_expr: str | None = Field(default=None, max_length=MAX_CRON_EXPRESSION_LENGTH)
    tz: str | None = Field(default=None, max_length=MAX_TIMEZONE_LENGTH)


class CronPatchRequest(BaseModel):
    name: str | None = Field(default=None, max_length=MAX_NAME_LENGTH)
    message: str | None = Field(default=None, max_length=MAX_MESSAGE_LENGTH)
    session_id: str | None = Field(default=None, max_length=MAX_SESSION_ID_LENGTH)
    enabled: bool | None = None
    at: str | None = None
    every_seconds: int | None = None
    cron_expr: str | None = Field(default=None, max_length=MAX_CRON_EXPRESSION_LENGTH)
    tz: str | None = Field(default=None, max_length=MAX_TIMEZONE_LENGTH)


@router.get("/templates")
async def list_cron_templates(language: str = "en") -> dict[str, Any]:
    """Built-in automation catalog the web UI offers on the Templates tab."""
    return {"templates": list_templates(language=language)}


@router.get("/jobs")
async def list_cron_jobs() -> dict[str, Any]:
    service = get_cron_service()
    jobs = service.list_jobs(owner_key=_owner().key)
    return {"jobs": [_job_payload(job) for job in jobs]}


@router.post("/jobs")
async def create_cron_job(payload: CronCreateRequest) -> dict[str, Any]:
    service = get_cron_service()
    try:
        schedule = _build_schedule(payload.model_dump())
        validate_schedule(schedule)
        job = service.add_job(
            name=payload.name,
            message=payload.message,
            schedule=schedule,
            owner=_owner(session_id=payload.session_id, language=payload.language),
        )
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _job_payload(job)


@router.get("/jobs/runs")
async def list_cron_runs(limit: int = 200) -> dict[str, Any]:
    """Recent runs across the caller's tasks, newest first.

    Backed by the service's run journal, so entries survive task deletion
    (per-job ``run_history`` in ``/jobs`` does not).
    """
    service = get_cron_service()
    runs = service.list_runs(_owner().key, limit=limit)
    return {
        "runs": [
            {
                "job_id": run.job_id,
                "job_name": run.job_name,
                "run_at_ms": run.run_at_ms,
                "status": run.status,
                "duration_ms": run.duration_ms,
                "error": run.error,
            }
            for run in runs
        ]
    }


@router.patch("/jobs/{job_id}")
async def patch_cron_job(job_id: str, payload: CronPatchRequest) -> dict[str, Any]:
    service = get_cron_service()
    owner = _owner()
    schedule = None
    raw = payload.model_dump(exclude_unset=True)
    if any(key in raw for key in ("at", "every_seconds", "cron_expr")):
        try:
            schedule = _build_schedule(
                {
                    "at": payload.at or "",
                    "every_seconds": payload.every_seconds,
                    "cron_expr": payload.cron_expr or "",
                    "tz": payload.tz or "",
                }
            )
        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        job = service.update_job(
            job_id,
            name=payload.name,
            message=payload.message,
            session_id=payload.session_id,
            schedule=schedule,
            owner_key=owner.key,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if job is None:
        raise HTTPException(status_code=404, detail="Scheduled task not found")
    if payload.enabled is not None:
        job = service.set_enabled(job_id, payload.enabled, owner_key=owner.key)
    return _job_payload(job)


@router.post("/jobs/{job_id}/run")
async def run_cron_job(job_id: str) -> dict[str, Any]:
    job = get_cron_service().run_now(job_id, owner_key=_owner().key)
    if job is None:
        raise HTTPException(status_code=404, detail="Scheduled task not found")
    return _job_payload(job)


@router.delete("/jobs/{job_id}")
async def delete_cron_job(job_id: str) -> dict[str, Any]:
    if not get_cron_service().cancel_job(job_id, owner_key=_owner().key):
        raise HTTPException(status_code=404, detail="Scheduled task not found")
    return {"ok": True}
