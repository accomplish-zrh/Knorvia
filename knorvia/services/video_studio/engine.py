from __future__ import annotations

import asyncio
from copy import deepcopy
from dataclasses import dataclass, field, replace
import hashlib
import json
import logging
from pathlib import Path
import re
import time
from typing import Any
from uuid import uuid4

import httpx

from knorvia.multi_user.context import get_current_user
from knorvia.multi_user.model_access import allowed_videogen_options
from knorvia.multi_user.models import LOCAL_ADMIN_ID, CurrentUser
from knorvia.multi_user.paths import local_admin_user, scope_for_user, user_context
from knorvia.services.config.model_catalog import get_model_catalog_service
from knorvia.services.config.provider_runtime import resolve_videogen_runtime_config
from knorvia.services.generation_http import GenerationProviderError, sanitize_provider_detail

from .ffmpeg_tool import FFmpegUnavailableError, get_ffmpeg_tool
from .provider import BaseVideoStudioAdapter, VideoInput, get_video_studio_adapter
from .store import MAX_PENDING_JOBS, VideoStudioQueueFullError, VideoStudioStore

logger = logging.getLogger(__name__)
WORKERS_PER_STORE = 1
PROVIDER_CANCEL_GRACE_SECONDS = 5.0
PROVIDER_RETRY_MAX_SECONDS = 10.0

_runners: dict[str, "_StoreRunner"] = {}
_active: dict[str, asyncio.Task[None]] = {}
_semaphores: dict[int, asyncio.Semaphore] = {}


def _consume_task_result(task: asyncio.Task[Any]) -> None:
    try:
        task.result()
    except BaseException:
        pass


def _global_semaphore() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    return _semaphores.setdefault(id(loop), asyncio.Semaphore(4))


def _safe_error(exc: Exception) -> str:
    message = sanitize_provider_detail(str(exc))
    message = re.sub(
        r"((?:x-)?api[-_]?key|authorization|access[-_]?token|secret|password)\s*[:=]\s*[^,;\s]+",
        r"\1=[REDACTED]",
        message,
        flags=re.I,
    )
    message = re.sub(r"(https?://)[^/@\s]+:[^/@\s]+@", r"\1[REDACTED]@", message)
    return message[:1000]


def _config_revision(catalog: dict[str, Any], profile_id: str, model_id: str) -> str:
    state = catalog.get("services", {}).get("videogen", {})
    profile = next(
        (item for item in state.get("profiles", []) if str(item.get("id") or "") == profile_id),
        None,
    )
    if profile is None:
        raise ValueError("The selected video model is unavailable.")
    model = next(
        (item for item in profile.get("models", []) if str(item.get("id") or "") == model_id),
        None,
    )
    if model is None:
        raise ValueError("The selected video model is unavailable.")
    connection_id = str(profile.get("connection_id") or "")
    connection = next(
        (
            item
            for item in catalog.get("connections", [])
            if str(item.get("id") or "") == connection_id
        ),
        {},
    )
    credential_material = {
        "api_key": connection.get("api_key") or profile.get("api_key") or "",
        "extra_headers": connection.get("extra_headers") or profile.get("extra_headers") or {},
    }
    credential_digest = hashlib.sha256(
        json.dumps(
            credential_material, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        ).encode()
    ).hexdigest()
    public = {
        "profile": {
            key: profile.get(key)
            for key in (
                "id",
                "binding",
                "adapter",
                "base_url",
                "api_version",
                "connection_id",
            )
        },
        "connection": {
            **{key: connection.get(key) for key in ("id", "provider", "base_url", "api_version")},
            "credential_digest": credential_digest,
        },
        "model": {
            key: model.get(key)
            for key in (
                "id",
                "model",
                "adapter",
                "aspect_ratio",
                "duration",
                "resolution",
                "fps",
                "audio_mode",
                "capabilities",
            )
        },
    }
    encoded = json.dumps(public, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def capture_video_authorization(profile_id: str, model_id: str) -> dict[str, str]:
    allowed = any(
        str(item.get("profile_id") or "") == profile_id
        and str(item.get("model_id") or "") == model_id
        for item in allowed_videogen_options().get("options", [])
    )
    if not allowed:
        raise PermissionError("This video model is not assigned to your account.")
    catalog = deepcopy(get_model_catalog_service().load())
    return {
        "owner_user_id": get_current_user().id,
        "config_revision": _config_revision(catalog, profile_id, model_id),
    }


def _resolve_owner(owner_user_id: str) -> CurrentUser:
    from knorvia.services.partners.scope import (
        PARTNER_USER_PREFIX,
        is_partner_user_id,
        partner_user,
    )

    owner_user_id = str(owner_user_id or "")
    if is_partner_user_id(owner_user_id):
        partner_id = owner_user_id.removeprefix(PARTNER_USER_PREFIX)
        from knorvia.services.partners import get_partner_manager

        config = get_partner_manager().load_config(partner_id) if partner_id else None
        if config is None:
            raise PermissionError("The queued video job partner no longer exists.")
        return partner_user(partner_id, name=str(config.name or partner_id))

    from knorvia.services.auth import AUTH_ENABLED, list_users

    if not AUTH_ENABLED:
        if owner_user_id != LOCAL_ADMIN_ID:
            raise PermissionError("The queued video job owner is unavailable.")
        return local_admin_user()
    record = next(
        (item for item in list_users() if str(item.get("id") or "") == owner_user_id), None
    )
    if record is None or bool(record.get("disabled", False)):
        raise PermissionError("The queued video job owner is disabled or no longer exists.")
    role = str(record.get("role") or "user")
    username = str(record.get("username") or "")
    if role not in {"admin", "user"} or not username:
        raise PermissionError("The queued video job owner is unavailable.")
    return CurrentUser(
        id=owner_user_id,
        username=username,
        role=role,
        scope=scope_for_user(owner_user_id, is_admin=role == "admin"),
    )


def _authorized_catalog(job: dict[str, Any]) -> dict[str, Any]:
    if str(job.get("owner_user_id") or "") != get_current_user().id:
        raise PermissionError("The queued video job belongs to another account.")
    allowed = any(
        str(item.get("profile_id") or "") == job["profile_id"]
        and str(item.get("model_id") or "") == job["model_id"]
        for item in allowed_videogen_options().get("options", [])
    )
    if not allowed:
        raise PermissionError("This video model is no longer assigned to your account.")
    catalog = deepcopy(get_model_catalog_service().load())
    if _config_revision(catalog, job["profile_id"], job["model_id"]) != str(
        job.get("config_revision") or ""
    ):
        raise PermissionError(
            "The video model configuration changed after this job was queued; retry it."
        )
    state = catalog.get("services", {}).get("videogen", {})
    state["active_profile_id"] = job["profile_id"]
    state["active_model_id"] = job["model_id"]
    return catalog


@dataclass
class _StoreRunner:
    store: VideoStudioStore
    queue: asyncio.Queue[str] = field(
        default_factory=lambda: asyncio.Queue(maxsize=MAX_PENDING_JOBS)
    )
    scheduled: set[str] = field(default_factory=set)
    workers: list[asyncio.Task[None]] = field(default_factory=list)

    def ensure_started(self) -> None:
        self.workers = [task for task in self.workers if not task.done()]
        while len(self.workers) < WORKERS_PER_STORE:
            task = asyncio.create_task(self._worker(), name="video-studio-worker")
            task.add_done_callback(self._worker_done)
            self.workers.append(task)
        for job_id in self.store.resumable_job_ids():
            if not self.enqueue(job_id):
                break

    @staticmethod
    def _worker_done(task: asyncio.Task[None]) -> None:
        if task.cancelled():
            return
        exc = task.exception()
        if exc:
            logger.error(
                "Video Studio worker stopped unexpectedly",
                exc_info=(type(exc), exc, exc.__traceback__),
            )

    def enqueue(self, job_id: str) -> bool:
        if job_id in self.scheduled:
            return True
        self.scheduled.add(job_id)
        try:
            self.queue.put_nowait(job_id)
        except asyncio.QueueFull:
            self.scheduled.discard(job_id)
            self._compact_queue()
            self.scheduled.add(job_id)
            try:
                self.queue.put_nowait(job_id)
            except asyncio.QueueFull:
                self.scheduled.discard(job_id)
                return False
        return True

    def _compact_queue(self) -> None:
        """Drop terminal jobs that still occupy bounded in-memory queue slots."""
        retained: list[str] = []
        while True:
            try:
                queued_id = self.queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            self.queue.task_done()
            self.scheduled.discard(queued_id)
            job = self.store._internal_job(queued_id)
            if job and job["status"] in {"queued", "submitting", "running"}:
                retained.append(queued_id)
        for queued_id in retained:
            self.queue.put_nowait(queued_id)
            self.scheduled.add(queued_id)

    async def _worker(self) -> None:
        while True:
            job_id = await self.queue.get()
            try:
                job = self.store._internal_job(job_id)
                if not job or job["status"] not in {"queued", "submitting", "running"}:
                    continue
                async with _global_semaphore():
                    task = asyncio.create_task(_run(self.store, job_id), name=f"video:{job_id}")
                    _active[job_id] = task
                    try:
                        await task
                    except asyncio.CancelledError:
                        current = asyncio.current_task()
                        if current is not None and current.cancelling():
                            task.cancel()
                            _done, pending = await asyncio.wait(
                                {task}, timeout=PROVIDER_CANCEL_GRACE_SECONDS
                            )
                            if pending:
                                task.add_done_callback(_consume_task_result)
                                logger.warning(
                                    "Video Studio job %s ignored shutdown cancellation",
                                    job_id,
                                )
                            raise
                    finally:
                        _active.pop(job_id, None)
            finally:
                self.scheduled.discard(job_id)
                self.queue.task_done()


async def _cancel_provider_task(
    adapter: BaseVideoStudioAdapter,
    task_id: str,
    config,
    *,
    job_id: str,
) -> None:
    if task_id:
        cancel_task = asyncio.create_task(adapter.cancel(task_id, config))
        try:
            _done, pending = await asyncio.wait(
                {cancel_task}, timeout=PROVIDER_CANCEL_GRACE_SECONDS
            )
            if pending:
                cancel_task.cancel()
                cancel_task.add_done_callback(_consume_task_result)
                logger.info("Provider cancellation timed out for video job %s", job_id)
            else:
                try:
                    cancel_task.result()
                except asyncio.CancelledError:
                    logger.info("Provider cancelled its own cancellation call for job %s", job_id)
        except Exception:
            logger.info("Provider cancellation failed for video job %s", job_id, exc_info=True)


async def _cancel_provider_if_needed(
    store: VideoStudioStore,
    job_id: str,
    adapter: BaseVideoStudioAdapter,
    config,
) -> None:
    job = store._internal_job(job_id)
    task_id = str((job or {}).get("provider_task_id") or "")
    await _cancel_provider_task(adapter, task_id, config, job_id=job_id)


def _is_retryable_provider_error(exc: Exception) -> bool:
    """Return whether an accepted remote task should survive this failure."""

    if isinstance(exc, PermissionError):
        return False
    if isinstance(
        exc, (httpx.HTTPError, TimeoutError, ConnectionError, OSError, json.JSONDecodeError)
    ):
        return True
    if not isinstance(exc, GenerationProviderError):
        return False
    message = str(exc).lower()
    status_match = re.search(r"\bhttp\s+(\d{3})\b", message)
    if status_match:
        status = int(status_match.group(1))
        return status in {408, 425, 429} or status >= 500
    non_retryable = (
        "unsupported status",
        "unsafe output url",
        "private address",
        "invalid origin",
        "invalid openai video content reference",
        "configured video endpoint url is invalid",
        "exceeds the storage limit",
        "no endpoint url configured",
        "unauthorized",
        "forbidden",
        "authentication failed",
        "permission denied",
        "credential revoked",
    )
    return not any(marker in message for marker in non_retryable)


def _provider_retry_delay(attempt: int, config, deadline: float) -> float:
    try:
        interval = float(config.poll_interval)
    except (TypeError, ValueError):
        interval = 0.5
    base = max(0.1, min(interval, 1.0))
    delay = min(PROVIDER_RETRY_MAX_SECONDS, base * (2 ** min(max(attempt - 1, 0), 6)))
    return max(0.0, min(delay, deadline - time.time()))


async def _timeout_provider_job(
    store: VideoStudioStore,
    job_id: str,
    adapter: BaseVideoStudioAdapter,
    task_id: str,
    config,
) -> None:
    await _cancel_provider_task(adapter, task_id, config, job_id=job_id)
    store.transition_terminal(
        job_id,
        "failed",
        error_code="provider_timeout",
        error_message="Video generation exceeded the configured time limit.",
    )


def _local_extend_unavailable_message(exc: FFmpegUnavailableError) -> str:
    """Two-path extend hint: local last-frame engine vs native extend models."""
    return (
        "Extending this clip with the local last-frame method requires the local "
        "composition engine (FFmpeg). Install it (Video Studio → Export → "
        "“Install the local composition engine”, or put ffmpeg/ffprobe on PATH "
        "/ point KNORVIA_FFMPEG_DIR at them), or switch to a video model with "
        "native extend support (e.g. Kling). "
        "本地末帧续写需要本地合成引擎（FFmpeg）：请安装本地合成引擎，或改用支持"
        f"原生延长的模型（如可灵）。 ({exc})"
    )


async def _local_extend_first_frame_inputs(
    store: VideoStudioStore,
    job_id: str,
    job: dict[str, Any],
    inputs: list[VideoInput],
) -> list[VideoInput]:
    """Extend path one (parity roadmap §C1): derive the last frame locally.

    Extracts the source clip's final frame with the local ffmpeg runtime,
    adopts it as a project image asset and returns the image_to_video-style
    input list: the derived first frame plus any audio references, with the
    source video never sent to the provider. The prompt and parameters are
    forwarded verbatim — the continue-from semantics ride entirely on the
    first-frame image. Adapters declaring ``native_extend`` (path two, e.g.
    the Kling endpoint) never reach this rewrite.
    """
    source_asset: dict[str, Any] | None = None
    for item in job.get("inputs") or []:
        asset = store.get_asset(str((item or {}).get("asset_id") or ""))
        if asset and asset.get("kind") == "video":
            source_asset = asset
            break
    if source_asset is None:
        raise ValueError("An extend job requires a source video asset.")
    # update_progress() only applies to running jobs; this runs while the job
    # is still submitting, so the stage note goes through the event stream.
    store.add_event(
        job_id,
        "job.progress",
        {
            "status": "submitting",
            "progress": 0.0,
            "stage": "extending",
            "message": "Extracting the last frame locally for the extend continuation…",
        },
    )
    frame = store.uploads_root / f"extend_{uuid4().hex}.png"
    try:
        await get_ffmpeg_tool().extract_last_frame(store.asset_path(str(source_asset["id"])), frame)
        data = frame.read_bytes()
    finally:
        frame.unlink(missing_ok=True)
    stem = Path(str(source_asset.get("filename") or "clip")).stem or "clip"
    asset = store.import_asset_bytes(
        str(job["project_id"]), data, "image/png", filename=f"{stem}-last-frame.png"
    )
    store.add_event(
        job_id,
        "job.extend_derived",
        {
            "extend_mode": "local_last_frame",
            "source_video_asset_id": source_asset["id"],
            "derived_first_frame_asset_id": asset["id"],
        },
    )
    return [
        VideoInput(store.asset_path(asset["id"]), "image/png", "image", role="first-frame"),
        *(item for item in inputs if item.kind == "audio"),
    ]


async def _run(store: VideoStudioStore, job_id: str) -> None:
    initial = store._internal_job(job_id)
    if not initial:
        return
    try:
        owner = _resolve_owner(str(initial.get("owner_user_id") or ""))
    except PermissionError as exc:
        store.transition_terminal(
            job_id, "failed", error_code="authorization_error", error_message=_safe_error(exc)
        )
        return
    with user_context(owner):
        await _run_in_owner_context(store, job_id)


async def _run_in_owner_context(store: VideoStudioStore, job_id: str) -> None:
    job = store._internal_job(job_id)
    if not job:
        return
    if str(job.get("operation") or "") == "compose":
        # Local ffmpeg work: no provider catalog, grants or cost confirmation.
        from .composition import run_compose_job

        await run_compose_job(store, job_id)
        return
    adapter: BaseVideoStudioAdapter | None = None
    config = None
    try:
        catalog = _authorized_catalog(job)
        config = resolve_videogen_runtime_config(catalog=catalog)
        parameters = dict(job["parameters"])
        config = replace(
            config,
            duration=str(parameters.get("duration") or config.duration),
            aspect_ratio=str(parameters.get("aspect_ratio") or config.aspect_ratio),
            resolution=str(parameters.get("resolution") or config.resolution),
        )
        adapter = get_video_studio_adapter(config.adapter)
        inputs: list[VideoInput] = []
        for item in job.get("inputs") or []:
            asset_id = item["asset_id"] if isinstance(item, dict) else str(item)
            if not asset_id:
                raise ValueError("An input video asset is no longer available.")
            asset = store.get_asset(asset_id)
            if not asset:
                raise ValueError("An input video asset is no longer available.")
            role = item.get("role") if isinstance(item, dict) else None
            inputs.append(
                VideoInput(
                    store.asset_path(asset_id),
                    asset["mime_type"],
                    asset["kind"],
                    role=str(role or "reference"),
                )
            )

        if job["status"] == "queued":
            if not store.claim_submission(job_id):
                return
            if str(job.get("operation") or "") == "extend" and not getattr(
                adapter, "native_extend", False
            ):
                inputs = await _local_extend_first_frame_inputs(store, job_id, job, inputs)
            submit_task = asyncio.create_task(
                adapter.submit(
                    job["prompt"],
                    config,
                    inputs=inputs,
                    parameters=parameters,
                    idempotency_key=job["client_request_id"],
                )
            )
            done, pending = await asyncio.wait(
                {submit_task}, timeout=max(1, config.request_timeout)
            )
            if pending:
                submit_task.cancel()
                submit_task.add_done_callback(_consume_task_result)
                raise TimeoutError("Video provider submission timed out.")
            task_id = submit_task.result()
            if not store.record_provider_task(job_id, task_id):
                await _cancel_provider_task(adapter, task_id, config, job_id=job_id)
                return
        job = store._internal_job(job_id) or job
        task_id = str(job.get("provider_task_id") or "")
        if not task_id:
            raise RuntimeError("A submitted video job has no provider task id.")

        deadline = float(job.get("started_at") or time.time()) + max(1, config.poll_timeout)
        polled_once = False
        transient_failures = 0
        while True:
            current = store._internal_job(job_id)
            if not current or current["status"] == "cancelled":
                await _cancel_provider_if_needed(store, job_id, adapter, config)
                return
            if current["status"] not in {"submitting", "running"}:
                return
            if polled_once and time.time() >= deadline:
                await _timeout_provider_job(store, job_id, adapter, task_id, config)
                return
            try:
                result = await adapter.poll(task_id, config)
                polled_once = True
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                polled_once = True
                if not _is_retryable_provider_error(exc):
                    raise
                current = store._internal_job(job_id)
                if not current or current["status"] == "cancelled":
                    await _cancel_provider_if_needed(store, job_id, adapter, config)
                    return
                if time.time() >= deadline:
                    await _timeout_provider_job(store, job_id, adapter, task_id, config)
                    return
                transient_failures += 1
                store.update_progress(
                    job_id,
                    float(current.get("progress") or 0.01),
                    "retrying",
                    f"Temporary video provider error; retrying: {_safe_error(exc)}",
                )
                await asyncio.sleep(_provider_retry_delay(transient_failures, config, deadline))
                continue
            if result.state == "succeeded":
                if not result.output_url:
                    raise RuntimeError("Video provider completed without an output URL.")
                temporary = store.uploads_root / f"provider_{uuid4().hex}.tmp"
                try:
                    mime_type = await adapter.download(result.output_url, config, temporary)
                except asyncio.CancelledError:
                    temporary.unlink(missing_ok=True)
                    raise
                except Exception as exc:
                    temporary.unlink(missing_ok=True)
                    if not _is_retryable_provider_error(exc):
                        raise
                    current = store._internal_job(job_id)
                    if not current or current["status"] == "cancelled":
                        await _cancel_provider_if_needed(store, job_id, adapter, config)
                        return
                    if time.time() >= deadline:
                        await _timeout_provider_job(store, job_id, adapter, task_id, config)
                        return
                    transient_failures += 1
                    store.update_progress(
                        job_id,
                        max(float(current.get("progress") or 0.01), 0.99),
                        "retrying_download",
                        f"Temporary video download error; retrying: {_safe_error(exc)}",
                    )
                    await asyncio.sleep(_provider_retry_delay(transient_failures, config, deadline))
                    continue
                asset = store.adopt_output_file(
                    job["project_id"], temporary, mime_type, filename=f"{job_id}.mp4"
                )
                if not store.complete_job_with_output(job_id, asset["id"]):
                    store.delete_asset(asset["id"])
                return
            if result.state in {"failed", "cancelled", "interrupted"}:
                store.transition_terminal(
                    job_id,
                    "cancelled" if result.state == "cancelled" else "failed",
                    error_code="provider_cancelled"
                    if result.state == "cancelled"
                    else "provider_error",
                    error_message=_safe_error(RuntimeError(result.error or result.state)),
                )
                return
            transient_failures = 0
            # Always inspect the provider once after a restart, even when the
            # original local deadline elapsed while Knorvia was closed. A
            # completed remote task remains recoverable; only a still-running
            # task is timed out and cancelled here.
            if time.time() >= deadline:
                await _timeout_provider_job(store, job_id, adapter, task_id, config)
                return
            store.update_progress(job_id, result.progress, "rendering")
            await asyncio.sleep(max(0.1, config.poll_interval))
    except asyncio.CancelledError:
        current = store._internal_job(job_id)
        # API cancellation persists the cancelled state before interrupting this
        # child. Process shutdown leaves running jobs resumable and must not
        # issue a billable provider cancellation.
        if current and current["status"] == "cancelled" and adapter and config:
            await _cancel_provider_if_needed(store, job_id, adapter, config)
        raise
    except PermissionError as exc:
        store.transition_terminal(
            job_id, "failed", error_code="authorization_error", error_message=_safe_error(exc)
        )
    except FFmpegUnavailableError as exc:
        store.transition_terminal(
            job_id,
            "failed",
            error_code="ffmpeg_unavailable",
            error_message=_local_extend_unavailable_message(exc),
        )
    except Exception as exc:
        store.transition_terminal(
            job_id, "failed", error_code="provider_error", error_message=_safe_error(exc)
        )


def _runner(store: VideoStudioStore) -> _StoreRunner:
    key = str(store.root)
    runner = _runners.get(key)
    if runner is None or runner.store is not store:
        runner = _StoreRunner(store)
        _runners[key] = runner
    runner.ensure_started()
    return runner


def start_video_job(store: VideoStudioStore, job_id: str) -> None:
    runner = _runner(store)
    if not runner.enqueue(job_id):
        if store.transition_terminal(
            job_id,
            "failed",
            error_code="queue_full",
            error_message="Video Studio queue is full.",
        ):
            raise VideoStudioQueueFullError("Video Studio queue is full.")


def resume_video_jobs(store: VideoStudioStore) -> None:
    _runner(store)


def cancel_video_job(store: VideoStudioStore, job_id: str) -> bool:
    previous_status = store.cancel_active_job(job_id)
    task = _active.get(job_id)
    # A submitting request may already have been accepted remotely while its
    # response (and task id) is in flight. Let that bounded submit finish so the
    # worker can persist-or-cancel the returned provider id. Queued work is safe
    # to interrupt, and running work already has a persisted provider id.
    if previous_status and previous_status != "submitting" and task is not None:
        task.cancel()
    return previous_status is not None


async def shutdown_video_studio_runners() -> None:
    workers = [task for runner in _runners.values() for task in runner.workers]
    for task in workers:
        task.cancel()
    if workers:
        await asyncio.gather(*workers, return_exceptions=True)
    _runners.clear()
    _active.clear()
    _semaphores.clear()


__all__ = [
    "cancel_video_job",
    "capture_video_authorization",
    "resume_video_jobs",
    "shutdown_video_studio_runners",
    "start_video_job",
]
