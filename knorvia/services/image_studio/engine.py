from __future__ import annotations

import asyncio
from copy import deepcopy
from dataclasses import dataclass, field, replace
import hashlib
from io import BytesIO
import json
import logging
import re
from typing import Any

from PIL import Image

from knorvia.multi_user.context import get_current_user
from knorvia.multi_user.model_access import allowed_imagegen_options
from knorvia.multi_user.models import LOCAL_ADMIN_ID, CurrentUser
from knorvia.multi_user.paths import local_admin_user, scope_for_user, user_context
from knorvia.services.config.model_catalog import get_model_catalog_service
from knorvia.services.config.provider_runtime import resolve_imagegen_runtime_config
from knorvia.services.generation_http import sanitize_provider_detail
from knorvia.services.imagegen.adapters import get_imagegen_adapter

from .ncnn_upscaler import get_ncnn_upscaler
from .store import MAX_PENDING_JOBS, ImageStudioQueueFullError, ImageStudioStore
from .upscale import target_long_edge, upscale_to_target

_active: dict[str, asyncio.Task[None]] = {}
_shutdown_jobs: set[str] = set()
_runners: dict[str, "_StoreRunner"] = {}
_global_semaphores: dict[int, asyncio.Semaphore] = {}
logger = logging.getLogger(__name__)
WORKERS_PER_STORE = 2


def _global_semaphore() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    key = id(loop)
    semaphore = _global_semaphores.get(key)
    if semaphore is None:
        semaphore = _global_semaphores[key] = asyncio.Semaphore(4)
    return semaphore


@dataclass
class _StoreRunner:
    store: ImageStudioStore
    queue: asyncio.Queue[str] = field(
        default_factory=lambda: asyncio.Queue(maxsize=MAX_PENDING_JOBS)
    )
    scheduled: set[str] = field(default_factory=set)
    workers: list[asyncio.Task[None]] = field(default_factory=list)

    def ensure_started(self) -> None:
        self.workers = [task for task in self.workers if not task.done()]
        for index in range(len(self.workers), WORKERS_PER_STORE):
            worker = asyncio.create_task(self._worker(), name=f"image-studio-worker:{index}")
            worker.add_done_callback(self._worker_done)
            self.workers.append(worker)
        for job_id in self.store.queued_job_ids():
            if not self.enqueue(job_id):
                break

    @staticmethod
    def _worker_done(task: asyncio.Task[None]) -> None:
        if task.cancelled():
            return
        try:
            exc = task.exception()
        except asyncio.CancelledError:
            return
        if exc is not None:
            logger.error(
                "Image Studio worker stopped unexpectedly",
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
            return False
        return True

    async def _worker(self) -> None:
        while True:
            job_id = await self.queue.get()
            try:
                job = self.store.get_job(job_id)
                if not job or job["status"] != "queued":
                    continue
                async with _global_semaphore():
                    task = asyncio.create_task(
                        _run(self.store, job_id), name=f"image-studio:{job_id}"
                    )
                    _active[job_id] = task
                    try:
                        await task
                    except asyncio.CancelledError:
                        current = asyncio.current_task()
                        if current is not None and current.cancelling():
                            task.cancel()
                            await asyncio.gather(task, return_exceptions=True)
                            raise
                        # Cancelling one job propagates CancelledError through
                        # the child task, but must not terminate this worker.
                    finally:
                        _active.pop(job_id, None)
            finally:
                self.scheduled.discard(job_id)
                self.queue.task_done()


def _safe_error(exc: Exception) -> str:
    message = sanitize_provider_detail(str(exc))
    message = re.sub(
        r"((?:x-)?api[-_]?key|authorization|access[-_]?token|secret|password)\s*[:=]\s*[^,;\s]+",
        r"\1=[REDACTED]",
        message,
        flags=re.I,
    )
    message = re.sub(r"(https?://)[^/@\s]+:[^/@\s]+@", r"\1[REDACTED]@", message, flags=re.I)
    return message[:1000]


def _model_config_revision(catalog: dict[str, Any], profile_id: str, model_id: str) -> str:
    state = catalog.get("services", {}).get("imagegen", {})
    profile = next(
        (item for item in state.get("profiles", []) if str(item.get("id") or "") == profile_id),
        None,
    )
    if profile is None:
        raise ValueError("The selected image model is unavailable.")
    model = next(
        (item for item in profile.get("models", []) if str(item.get("id") or "") == model_id),
        None,
    )
    if model is None:
        raise ValueError("The selected image model is unavailable.")
    connection_id = str(profile.get("connection_id") or "")
    connection = next(
        (
            item
            for item in catalog.get("connections", [])
            if str(item.get("id") or "") == connection_id
        ),
        {},
    )
    # Hash routing and capability facts, never credentials or arbitrary headers.
    public_config = {
        "profile": {
            key: profile.get(key)
            for key in ("id", "binding", "base_url", "api_version", "connection_id")
        },
        "connection": {
            key: connection.get(key) for key in ("id", "provider", "base_url", "api_version")
        },
        "model": {
            key: model.get(key)
            for key in (
                "id",
                "model",
                "adapter",
                "size",
                "quality",
                "style",
                "response_format",
                "aspect_ratio",
                "image_size",
                "background",
                "compression",
                "capabilities",
            )
        },
    }
    encoded = json.dumps(
        public_config, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def capture_job_authorization(profile_id: str, model_id: str) -> dict[str, str]:
    option = next(
        (
            item
            for item in allowed_imagegen_options().get("options", [])
            if str(item.get("profile_id") or "") == profile_id
            and str(item.get("model_id") or "") == model_id
        ),
        None,
    )
    if option is None:
        raise PermissionError("This image model is not assigned to your account.")
    catalog = deepcopy(get_model_catalog_service().load())
    return {
        "owner_user_id": get_current_user().id,
        "config_revision": _model_config_revision(catalog, profile_id, model_id),
    }


def _resolve_job_owner(owner_user_id: str) -> CurrentUser:
    """Resolve a persisted owner against live account/partner state.

    Worker tasks outlive the request that created them, so their inherited
    ContextVar cannot be used for authorization.  Reconstruct the owner for
    every dispatch and reject deleted, disabled, or otherwise invalid owners.
    """
    from knorvia.services.partners.scope import (
        PARTNER_USER_PREFIX,
        is_partner_user_id,
        partner_user,
    )

    owner_user_id = str(owner_user_id or "")
    if is_partner_user_id(owner_user_id):
        partner_id = owner_user_id.removeprefix(PARTNER_USER_PREFIX)
        if not partner_id:
            raise PermissionError("The queued image job owner is unavailable.")
        from knorvia.services.partners import get_partner_manager

        config = get_partner_manager().load_config(partner_id)
        if config is None:
            raise PermissionError("The queued image job partner no longer exists.")
        return partner_user(partner_id, name=str(config.name or partner_id))

    from knorvia.services.auth import AUTH_ENABLED, list_users

    if not AUTH_ENABLED:
        if owner_user_id != LOCAL_ADMIN_ID:
            raise PermissionError("The queued image job owner is unavailable.")
        return local_admin_user()

    record = next(
        (item for item in list_users() if str(item.get("id") or "") == owner_user_id),
        None,
    )
    if record is None or bool(record.get("disabled", False)):
        raise PermissionError("The queued image job owner is disabled or no longer exists.")
    role = str(record.get("role") or "user")
    username = str(record.get("username") or "")
    if role not in {"admin", "user"} or not username:
        raise PermissionError("The queued image job owner is unavailable.")
    return CurrentUser(
        id=owner_user_id,
        username=username,
        role=role,
        scope=scope_for_user(owner_user_id, is_admin=role == "admin"),
    )


def _authorized_catalog(job: dict[str, Any]) -> dict[str, Any]:
    owner_user_id = str(job.get("owner_user_id") or "")
    config_revision = str(job.get("config_revision") or "")
    current_user = get_current_user()
    if not owner_user_id or not config_revision:
        raise PermissionError(
            "This queued image job predates authorization snapshots; retry it explicitly."
        )
    if owner_user_id != current_user.id:
        raise PermissionError("The queued image job belongs to another account.")
    # Re-resolve the current grant immediately before dispatch. Revocation must
    # win even if the task was already persisted in the queue.
    allowed = any(
        str(item.get("profile_id") or "") == job["profile_id"]
        and str(item.get("model_id") or "") == job["model_id"]
        for item in allowed_imagegen_options().get("options", [])
    )
    if not allowed:
        raise PermissionError("This image model is no longer assigned to your account.")
    # Use this exact snapshot for both revision validation and provider config;
    # loading a third copy afterwards would reintroduce a configuration TOCTOU.
    catalog = deepcopy(get_model_catalog_service().load())
    current_revision = _model_config_revision(catalog, job["profile_id"], job["model_id"])
    if current_revision != config_revision:
        raise PermissionError(
            "The image model configuration changed after this job was queued; retry it."
        )
    state = catalog.get("services", {}).get("imagegen", {})
    state["active_profile_id"] = job["profile_id"]
    state["active_model_id"] = job["model_id"]
    return catalog


def _native_resolution_rejected(exc: Exception) -> bool:
    message = str(exc).lower()
    names_resolution = "image_size" in message or "resolution" in message
    names_target = bool(re.search(r"\b[124]k\b", message))
    rejects_value = any(word in message for word in ("unsupported", "not supported", "invalid"))
    return rejects_value and (names_resolution or names_target)


async def _run(store: ImageStudioStore, job_id: str) -> None:
    queued = store.get_job(job_id)
    if not queued:
        return
    owner_user_id = str(queued.get("owner_user_id") or "")
    try:
        # A legacy job without a snapshot is entered as local only so the
        # inner authorization guard can produce the explicit migration error;
        # it still cannot reach a provider.
        owner = _resolve_job_owner(owner_user_id) if owner_user_id else local_admin_user()
    except PermissionError as exc:
        if store.claim_job(job_id):
            store.update_job(
                job_id,
                "failed",
                error_code="authorization_error",
                error_message=_safe_error(exc),
                from_statuses=("running",),
            )
        return
    with user_context(owner):
        await _run_in_owner_context(store, job_id)


async def _run_in_owner_context(store: ImageStudioStore, job_id: str) -> None:
    job = store.get_job(job_id)
    if not job or not store.claim_job(job_id):
        return
    job = store.get_job(job_id) or job
    try:
        params = job["requested_params"]
        target_resolution = str(params.get("target_resolution") or "").upper()
        upscale_preset = str(params.get("upscale_model") or "general").lower()
        if upscale_preset not in {"general", "illustration"}:
            upscale_preset = "general"
        if target_resolution and target_long_edge(target_resolution) is None:
            raise ValueError("Unsupported target resolution.")
        catalog = _authorized_catalog(job)
        config = resolve_imagegen_runtime_config(catalog=catalog)
        requested_native_resolution = str(params.get("image_size") or "")
        if target_resolution and config.adapter == "gemini_interactions":
            requested_native_resolution = target_resolution
        config = replace(
            config,
            size=str(params.get("size") or config.size),
            quality=str(params.get("quality") or config.quality),
            style=str(params.get("style") or config.style),
            response_format=str(params.get("output_format") or config.response_format),
            aspect_ratio=str(params.get("aspect_ratio") or config.aspect_ratio),
            image_size=str(requested_native_resolution or config.image_size),
            background=str(params.get("background") or config.background),
            compression=(
                int(params["compression"])
                if str(params.get("compression") or "").isdigit()
                else config.compression
            ),
        )
        adapter = get_imagegen_adapter(config.adapter)
        count = max(1, min(int(params.get("n") or 1), 4))
        parent_context_id = None
        if job.get("parent_job_id"):
            parent = store.get_job(job["parent_job_id"])
            if (
                parent
                and parent.get("profile_id") == job["profile_id"]
                and parent.get("model_id") == job["model_id"]
            ):
                parent_context_id = parent.get("provider_context_id")
        refs: list[tuple[bytes, str]] = []
        mask: tuple[bytes, str] | None = None
        if job["operation"] != "generate":
            for item in job["inputs"]:
                asset = store.get_asset(item["asset_id"])
                if not asset:
                    raise ValueError("An input image is no longer available.")
                pair = (store.asset_path(asset["id"]).read_bytes(), asset["mime"])
                if item["role"] == "mask":
                    mask = pair
                else:
                    refs.append(pair)

        async def invoke(active_config):
            if job["operation"] == "generate":
                return await adapter.generate_with_metadata(
                    job["prompt"], active_config, n=count, parent_context_id=parent_context_id
                )
            return await adapter.edit_with_metadata(
                job["prompt"],
                active_config,
                images=refs,
                mask=mask,
                n=count,
                parent_context_id=parent_context_id,
            )

        fallback_warnings: list[str] = []
        try:
            response = await invoke(config)
        except Exception as exc:
            if (
                not target_resolution
                or config.image_size != target_resolution
                or not _native_resolution_rejected(exc)
            ):
                raise
            config = replace(config, image_size="")
            response = await invoke(config)
            fallback_warnings.append(
                f"Native {target_resolution} output was unavailable; generated at provider default before compatibility upscaling."
            )
        if (store.get_job(job_id) or {}).get("status") == "cancelled":
            return
        saved = 0
        upscales: list[dict[str, Any]] = []
        ai_upscale_available = True
        for position, (content, mime) in enumerate(response.images[:count]):
            try:
                ai_upscale: dict[str, Any] | None = None
                target_edge = target_long_edge(target_resolution)
                if target_edge and ai_upscale_available:
                    try:
                        with Image.open(BytesIO(content)) as image:
                            needs_upscale = max(image.size) < target_edge
                        if needs_upscale:
                            content, mime, ai_upscale = await get_ncnn_upscaler().upscale(
                                content,
                                mime,
                                target_edge,
                                preset=upscale_preset,
                            )
                    except Exception:
                        ai_upscale_available = False
                        fallback_warnings.append(
                            "Local AI upscaling was unavailable; used basic resizing instead."
                        )
                content, mime, upscale = await asyncio.to_thread(
                    upscale_to_target, content, mime, target_resolution
                )
                applied = ai_upscale or upscale
                if applied:
                    upscales.append({"position": position, **applied})
                asset = store.save_asset(job["project_id"], content, mime, kind="output")
                store.add_job_output(job_id, asset["id"], position)
                saved += 1
            except Exception:
                continue
        actual = {
            "n": count,
            "size": config.size,
            "quality": config.quality,
            "style": config.style,
            "output_format": config.response_format,
            "aspect_ratio": config.aspect_ratio,
            "image_size": config.image_size,
            "target_resolution": target_resolution,
            "upscale_model": upscale_preset,
            "upscale": upscales,
            "background": config.background,
            "compression": config.compression,
            "warnings": [*response.warnings, *fallback_warnings],
        }
        if saved == 0:
            raise ValueError("No generated image could be saved.")
        completed = store.update_job(
            job_id,
            "succeeded" if saved == count else "partial",
            actual=actual,
            provider_context_id=response.provider_context_id,
            revised_prompt=response.revised_prompt,
            usage=response.usage,
            from_statuses=("running",),
        )
        if not completed:
            return
        finished = store.get_job(job_id)
        if finished:
            try:
                store.place_job_on_board(job["project_id"], finished)
            except Exception:
                import logging

                logging.getLogger(__name__).debug(
                    "Could not place Image Studio job on the board", exc_info=True
                )
    except asyncio.CancelledError:
        target_status = "interrupted" if job_id in _shutdown_jobs else "cancelled"
        store.update_job(job_id, target_status, from_statuses=("running",))
        raise
    except PermissionError as exc:
        store.update_job(
            job_id,
            "failed",
            error_code="authorization_error",
            error_message=_safe_error(exc),
            from_statuses=("running",),
        )
    except Exception as exc:
        store.update_job(
            job_id,
            "failed",
            error_code="provider_error",
            error_message=_safe_error(exc),
            from_statuses=("running",),
        )


def _runner_for(store: ImageStudioStore) -> _StoreRunner:
    key = str(store.db_path)
    runner = _runners.get(key)
    if runner is None:
        runner = _runners[key] = _StoreRunner(store)
    return runner


def resume_queued_jobs(store: ImageStudioStore) -> None:
    queued = store.queued_job_ids()
    if not queued:
        return
    asyncio.get_running_loop()
    runner = _runner_for(store)
    runner.ensure_started()
    for job_id in queued:
        if not runner.enqueue(job_id):
            break


def start_job(store: ImageStudioStore, job_id: str) -> None:
    runner = _runner_for(store)
    runner.ensure_started()
    if runner.enqueue(job_id):
        return
    store.update_job(
        job_id,
        "failed",
        error_code="queue_full",
        error_message="Image Studio already has too many scheduled jobs.",
        from_statuses=("queued",),
    )
    raise ImageStudioQueueFullError("Image Studio already has too many scheduled jobs.")


def cancel_job(store: ImageStudioStore, job_id: str) -> bool:
    if not store.update_job(
        job_id,
        "cancelled",
        from_statuses=("queued", "running"),
    ):
        return False
    task = _active.get(job_id)
    # Persist cancellation before signalling the coroutine.  Even an adapter
    # that delays or suppresses CancelledError can no longer save its response.
    if task:
        task.cancel()
    return True


async def shutdown_image_studio_runners() -> None:
    _shutdown_jobs.update(_active)
    for task in list(_active.values()):
        task.cancel()
    if _active:
        await asyncio.gather(*list(_active.values()), return_exceptions=True)
    workers = [task for runner in _runners.values() for task in runner.workers]
    for task in workers:
        task.cancel()
    if workers:
        await asyncio.gather(*workers, return_exceptions=True)
    _active.clear()
    _runners.clear()
    _shutdown_jobs.clear()


__all__ = [
    "cancel_job",
    "capture_job_authorization",
    "resume_queued_jobs",
    "shutdown_image_studio_runners",
    "start_job",
]
