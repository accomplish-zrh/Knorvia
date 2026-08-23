"""Agent-facing Image Studio API.

Chat tools must create pictures through this module so jobs, assets, model
grants, parameter allow-lists, and upscale fallback stay on the same path as
the Image Studio UI. Nothing here calls the raw imagegen service.
"""

from __future__ import annotations

import asyncio
import base64
import logging
from typing import Any
from urllib.parse import unquote, urlparse

from knorvia.multi_user.model_access import allowed_imagegen_options
from knorvia.services.image_studio.engine import (
    cancel_job,
    capture_job_authorization,
    start_job,
)
from knorvia.services.image_studio.store import (
    MAX_UPLOAD_IMAGE_BYTES,
    ImageStudioStore,
    get_image_studio_store,
)

logger = logging.getLogger(__name__)

STUDIO_LEVEL_PARAMETERS = frozenset({"target_resolution", "upscale_model"})
COSTLY_RESOLUTIONS = frozenset({"2K", "4K"})
FINAL_STATUSES = frozenset({"succeeded", "partial", "failed", "cancelled", "interrupted"})
DEFAULT_PARAMETERS = ("n", "size", "quality", "style", "output_format")
MAX_FALLBACK_MODELS = 2
MAX_JOB_WAIT_POLLS = 900
_LOCAL_ATTACHMENT_PREFIX = "/api/attachments/"
_OUTPUTS_URL_PREFIX = "/api/outputs/"
_POLICY_MARKERS = ("policy", "safety", "blocked", "nsfw", "moderation", "content filter")
_TRANSIENT_MARKERS = (
    "429",
    "500",
    "502",
    "503",
    "504",
    "overloaded",
    "temporarily unavailable",
    "timeout",
    "timed out",
    "connection reset",
)


def list_usable_models() -> list[dict[str, Any]]:
    return list(allowed_imagegen_options().get("options") or [])


def advertised_operations(model: dict[str, Any] | None) -> list[str]:
    operations = (model or {}).get("capabilities", {}).get("operations") or ["generate"]
    return [item for item in operations if item in {"generate", "edit", "inpaint"}]


def advertised_parameters(model: dict[str, Any] | None) -> set[str]:
    names = (model or {}).get("capabilities", {}).get("parameters") or list(DEFAULT_PARAMETERS)
    allowed = set(STUDIO_LEVEL_PARAMETERS)
    allowed.update(str(name) for name in names)
    return allowed


def resolve_studio_operation(
    requested: str,
    *,
    has_inputs: bool,
    has_mask: bool,
    model_operations: list[str],
) -> str:
    """Map an agent intent onto a backend operation the selected model accepts."""
    ops = model_operations or ["generate"]
    intent = (requested or "generate").strip().lower()
    if intent == "enhance":
        if has_inputs and "edit" in ops:
            return "edit"
        if "generate" in ops:
            return "generate"
        raise ValueError("No configured model can enhance this image.")
    if intent == "inpaint" or has_mask:
        if has_mask and "inpaint" in ops:
            return "inpaint"
        if has_inputs and "edit" in ops:
            return "edit"
        raise ValueError("Local redraw needs a mask and a model that supports inpaint.")
    if intent == "edit" or has_inputs:
        if has_inputs and "edit" in ops:
            return "edit"
        if has_inputs:
            raise ValueError("No configured model supports image editing.")
        return "generate" if "generate" in ops else ops[0]
    if "generate" in ops:
        return "generate"
    return ops[0]


def select_studio_model(
    options: list[dict[str, Any]],
    *,
    operation: str,
    profile_id: str = "",
    model_id: str = "",
) -> dict[str, Any]:
    if not options:
        raise ValueError("No image model is assigned to this account.")
    named = None
    if profile_id and model_id:
        named = next(
            (
                item
                for item in options
                if item.get("profile_id") == profile_id and item.get("model_id") == model_id
            ),
            None,
        )
    want = "edit" if operation == "enhance" else operation
    ordered: list[dict[str, Any]] = []
    if named:
        ordered.append(named)
    ordered.extend(item for item in options if item is not named)
    for item in ordered:
        ops = advertised_operations(item)
        if want == "generate" and "generate" in ops:
            return item
        if want in ops:
            return item
        if want == "enhance" and ("edit" in ops or "generate" in ops):
            return item
    raise ValueError(f"No configured model supports {want}.")


def fallback_models(
    options: list[dict[str, Any]],
    current: dict[str, Any],
    operation: str,
) -> list[dict[str, Any]]:
    remaining: list[dict[str, Any]] = []
    current_key = (current.get("profile_id"), current.get("model_id"))
    for item in options:
        if (item.get("profile_id"), item.get("model_id")) == current_key:
            continue
        try:
            selected = select_studio_model([item], operation=operation)
        except ValueError:
            continue
        remaining.append(selected)
        if len(remaining) >= MAX_FALLBACK_MODELS:
            break
    return remaining


def filter_studio_parameters(
    raw: dict[str, Any],
    model: dict[str, Any] | None,
) -> dict[str, Any]:
    allowed = advertised_parameters(model)
    cleaned: dict[str, Any] = {}
    for key, value in raw.items():
        if key not in allowed or value in (None, ""):
            continue
        cleaned[key] = value
    return cleaned


def needs_confirmation(operation: str, parameters: dict[str, Any]) -> bool:
    count = int(parameters.get("n") or 1)
    resolution = str(parameters.get("target_resolution") or "").upper()
    return count > 1 or resolution in COSTLY_RESOLUTIONS or operation == "inpaint"


def project_for_session(store: ImageStudioStore, session_id: str | None) -> dict[str, Any]:
    if session_id:
        return store.project_for_session(
            session_id,
            title=f"Chat · {session_id[:48]}",
            legacy_title=f"Chat · {session_id[:16]}",
        )
    return store.ensure_default_project()


def recent_session_outputs(
    store: ImageStudioStore,
    project_id: str,
    *,
    limit: int = 4,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for job in store.list_jobs(project_id, limit=8):
        if job.get("status") not in {"succeeded", "partial"}:
            continue
        for output in job.get("outputs") or []:
            asset = store.get_asset(output["asset_id"])
            if not asset:
                continue
            rows.append(
                {
                    "asset_id": asset["id"],
                    "job_id": job["id"],
                    "prompt": job.get("prompt") or "",
                }
            )
            if len(rows) >= limit:
                return rows
    return rows


def import_image_bytes(
    store: ImageStudioStore,
    project_id: str,
    data: bytes,
    mime: str = "",
    *,
    kind: str = "input",
) -> dict[str, Any]:
    sniffed = store.sniff_mime(data)
    if mime and mime != sniffed:
        mime = sniffed
    return store.save_asset(project_id, data, sniffed, kind=kind)


def decode_attachment(attachment: dict[str, Any]) -> tuple[bytes, str] | None:
    raw = str(attachment.get("base64") or "")
    if raw:
        if raw.startswith("data:") and "," in raw:
            header, raw = raw.split(",", 1)
            mime = header.split(";")[0].removeprefix("data:") or "image/png"
        else:
            mime = str(attachment.get("mime_type") or "image/png")
        if len(raw) > ((MAX_UPLOAD_IMAGE_BYTES + 2) // 3) * 4:
            return None
        try:
            data = base64.b64decode(raw, validate=True)
        except Exception:
            return None
        if data and len(data) <= MAX_UPLOAD_IMAGE_BYTES:
            return data, mime
    return _bytes_from_local_url(str(attachment.get("url") or ""))


def collect_input_asset_ids(
    store: ImageStudioStore,
    project_id: str,
    *,
    explicit_ids: list[str] | None = None,
    attachments: list[dict[str, Any]] | None = None,
    parent_job_id: str | None = None,
    reuse_recent: bool = False,
) -> list[str]:
    """Resolve references: explicit ids, chat images, parent job, then last outputs."""
    ids: list[str] = []
    for asset_id in explicit_ids or []:
        if asset_id and store.get_asset(asset_id) and asset_id not in ids:
            ids.append(asset_id)
        if len(ids) >= 4:
            return ids
    for attachment in attachments or []:
        studio_id = str(attachment.get("studio_asset_id") or "")
        if studio_id and store.get_asset(studio_id):
            if studio_id not in ids:
                ids.append(studio_id)
        else:
            decoded = decode_attachment(attachment)
            if not decoded:
                continue
            data, mime = decoded
            try:
                asset = import_image_bytes(store, project_id, data, mime)
            except Exception as exc:
                logger.info("Skipping chat attachment that Image Studio cannot store: %s", exc)
                continue
            if asset["id"] not in ids:
                ids.append(asset["id"])
        if len(ids) >= 4:
            return ids
    if not ids and parent_job_id:
        parent = store.get_job(parent_job_id)
        for output in (parent or {}).get("outputs") or []:
            asset_id = str(output.get("asset_id") or "")
            if asset_id and store.get_asset(asset_id) and asset_id not in ids:
                ids.append(asset_id)
            if len(ids) >= 4:
                return ids
    if not ids and reuse_recent:
        for row in recent_session_outputs(store, project_id):
            if row["asset_id"] not in ids:
                ids.append(row["asset_id"])
            if len(ids) >= 4:
                break
    return ids[:4]


def plan_studio_job(
    *,
    prompt: str,
    operation: str = "generate",
    n: int = 1,
    size: str = "",
    aspect_ratio: str = "",
    target_resolution: str = "",
    quality: str = "",
    style: str = "",
    output_format: str = "",
    upscale_model: str = "",
    profile_id: str = "",
    model_id: str = "",
    input_asset_ids: list[str] | None = None,
    mask_asset_id: str | None = None,
    parent_job_id: str | None = None,
    options: list[dict[str, Any]] | None = None,
    language: str = "en",
) -> dict[str, Any]:
    prompt = (prompt or "").strip()
    if not prompt:
        raise ValueError("A prompt is required.")
    models = options if options is not None else list_usable_models()
    inputs = [item for item in (input_asset_ids or []) if item]
    has_mask = bool(mask_asset_id)
    probe = select_studio_model(
        models, operation=operation or "generate", profile_id=profile_id, model_id=model_id
    )
    backend_op = resolve_studio_operation(
        operation,
        has_inputs=bool(inputs),
        has_mask=has_mask,
        model_operations=advertised_operations(probe),
    )
    model = select_studio_model(
        models, operation=backend_op, profile_id=profile_id, model_id=model_id
    )
    if backend_op not in advertised_operations(model):
        raise ValueError("The selected image model does not support this operation.")
    if backend_op == "generate" and (inputs or has_mask):
        raise ValueError("Generate mode does not accept input images.")
    if backend_op != "generate" and not inputs:
        raise ValueError("Edit and local redraw require an input image.")
    if backend_op == "inpaint" and not has_mask:
        raise ValueError("Local redraw requires a mask.")
    parameters = filter_studio_parameters(
        {
            "n": max(1, min(int(n or 1), 4)),
            "size": size,
            "aspect_ratio": aspect_ratio,
            "target_resolution": str(target_resolution or "").upper(),
            "quality": quality,
            "style": style,
            "output_format": output_format,
            "upscale_model": upscale_model or ("general" if target_resolution else ""),
        },
        model,
    )
    return {
        "operation": backend_op,
        "requested_operation": operation or "generate",
        "profile_id": model["profile_id"],
        "model_id": model["model_id"],
        "model_name": model.get("model_name") or model["model_id"],
        "profile_name": model.get("profile_name") or model["profile_id"],
        "provider": model.get("provider") or "",
        "prompt": prompt,
        "input_asset_ids": inputs,
        "mask_asset_id": mask_asset_id,
        "parent_job_id": parent_job_id or None,
        "parameters": parameters,
        "needs_confirmation": needs_confirmation(backend_op, parameters),
        "cost_hint": _cost_hint(backend_op, parameters, language=language),
        "language": "zh" if str(language or "").lower().startswith("zh") else "en",
    }


def _cost_hint(operation: str, parameters: dict[str, Any], *, language: str = "en") -> str:
    count = int(parameters.get("n") or 1)
    resolution = str(parameters.get("target_resolution") or "native")
    zh = str(language or "").lower().startswith("zh")
    if zh:
        if operation == "inpaint":
            return f"局部重绘 ×{count}，{resolution}（使用已分配的生图模型）。"
        if count > 1 or resolution.upper() in COSTLY_RESOLUTIONS:
            return f"{operation} ×{count}，{resolution} — 将使用已分配的生图模型，可能更久。"
        return f"{operation} ×{count}，{resolution}。"
    if operation == "inpaint":
        return f"Local redraw ×{count}, {resolution} (uses the assigned image model)."
    if count > 1 or resolution.upper() in COSTLY_RESOLUTIONS:
        return f"{operation} ×{count}, {resolution} — this uses the assigned image model and may take longer."
    return f"{operation} ×{count}, {resolution}."


async def run_studio_image_job(
    plan: dict[str, Any],
    *,
    session_id: str | None = None,
    workspace_dir: str | None = None,
    attachments: list[dict[str, Any]] | None = None,
    event_sink: Any = None,
    store: ImageStudioStore | None = None,
    options: list[dict[str, Any]] | None = None,
    target_node_id: str | None = None,
) -> dict[str, Any]:
    studio = store or get_image_studio_store()
    project = project_for_session(studio, session_id)
    working = dict(plan)
    inputs = list(working.get("input_asset_ids") or [])
    if not inputs and attachments and working["operation"] != "generate":
        inputs = collect_input_asset_ids(
            studio,
            project["id"],
            attachments=attachments,
            parent_job_id=working.get("parent_job_id"),
            reuse_recent=True,
        )
        if working["operation"] != "generate" and not inputs:
            raise ValueError("Edit and local redraw require an input image.")
        working["input_asset_ids"] = inputs

    models = options if options is not None else list_usable_models()
    current = {
        "profile_id": working["profile_id"],
        "model_id": working["model_id"],
        "model_name": working.get("model_name"),
        "profile_name": working.get("profile_name"),
        "provider": working.get("provider"),
        "capabilities": {"operations": [working["operation"]]},
    }
    fallback_candidates = (
        fallback_models(models, current, working["operation"])
        if working.get("allow_model_fallback") is True
        else []
    )
    attempts = [working] + [
        {
            **working,
            "profile_id": candidate["profile_id"],
            "model_id": candidate["model_id"],
            "model_name": candidate.get("model_name") or candidate["model_id"],
            "profile_name": candidate.get("profile_name") or candidate["profile_id"],
            "provider": candidate.get("provider") or "",
        }
        for candidate in fallback_candidates
    ]

    last_error = ""
    fallback_notes: list[str] = []
    for index, attempt in enumerate(attempts):
        try:
            authorization = capture_job_authorization(attempt["profile_id"], attempt["model_id"])
        except PermissionError:
            # A grant may be revoked between planning and persistence, and
            # isolated embedders may inject a model view without a catalog.
            # Persisting no snapshot is still fail-closed: the real engine will
            # reject this job before provider dispatch. Test embedders that
            # replace start_job can continue exercising artifact plumbing.
            authorization = {}
        job = studio.create_job(
            project["id"],
            {
                "operation": attempt["operation"],
                "profile_id": attempt["profile_id"],
                "model_id": attempt["model_id"],
                "prompt": attempt["prompt"],
                "input_asset_ids": attempt.get("input_asset_ids") or [],
                "mask_asset_id": attempt.get("mask_asset_id"),
                "parent_job_id": attempt.get("parent_job_id"),
                "parameters": attempt.get("parameters") or {},
                **authorization,
            },
        )
        if target_node_id:
            try:
                from knorvia.services.image_studio.board import mark_node_running

                mark_node_running(
                    studio,
                    project["id"],
                    target_node_id,
                    job_id=job["id"],
                    prompt=str(attempt.get("prompt") or ""),
                )
            except Exception:
                logger.debug("Could not reserve Image Studio board node", exc_info=True)
        start_job(studio, job["id"])
        await _emit(
            event_sink,
            f"Image Studio queued ({attempt.get('model_name') or attempt['model_id']})",
            studio_job_id=job["id"],
            studio_project_id=project["id"],
            studio_status=str(job.get("status") or "queued"),
        )
        try:
            job = await _wait_for_job(
                studio,
                job["id"],
                event_sink=event_sink,
                project_id=project["id"],
            )
        except asyncio.CancelledError:
            cancel_job(studio, job["id"])
            raise
        if job.get("status") in {"succeeded", "partial"}:
            try:
                studio.place_job_on_board(project["id"], job, target_node_id=target_node_id)
            except Exception:
                logger.debug("Could not place Image Studio job on the board", exc_info=True)
            files = _copy_outputs(studio, job, workspace_dir)
            warnings = list((job.get("actual_params") or {}).get("warnings") or [])
            warnings.extend(fallback_notes)
            return {
                "job": job,
                "project": project,
                "files": files,
                "warnings": warnings,
                "usage": job.get("usage") or {},
                "fallback_used": index > 0,
                "plan": attempt,
            }
        last_error = job.get("error_message") or f"Image Studio job {job.get('status')}."
        if job.get("status") in {"cancelled"} or not _is_retryable_failure(job):
            return {
                "job": job,
                "project": project,
                "files": [],
                "warnings": fallback_notes,
                "usage": job.get("usage") or {},
                "fallback_used": False,
                "plan": attempt,
            }
        if index + 1 >= len(attempts):
            return {
                "job": job,
                "project": project,
                "files": [],
                "warnings": fallback_notes,
                "usage": job.get("usage") or {},
                "fallback_used": False,
                "plan": attempt,
            }
        note = f"Fell back from {attempt.get('model_name') or attempt['model_id']}: {last_error}"
        fallback_notes.append(note)
        await _emit(
            event_sink,
            note,
            studio_job_id=job.get("id"),
            studio_project_id=project["id"],
            studio_status=str(job.get("status") or "failed"),
        )

    raise RuntimeError(last_error or "Image Studio job failed.")


async def cancel_studio_job(job_id: str, *, store: ImageStudioStore | None = None) -> bool:
    studio = store or get_image_studio_store()
    return cancel_job(studio, job_id)


def citation_lines(plan: dict[str, Any], result: dict[str, Any]) -> list[str]:
    job = result.get("job") or {}
    project = result.get("project") or {}
    lines = [
        f"Image Studio project: {project.get('id') or ''}",
        f"Image Studio job: {job.get('id') or ''}",
        f"Model: {plan.get('profile_name')} · {plan.get('model_name')}",
        f"Operation: {job.get('operation') or plan.get('operation')}",
    ]
    asset_ids = [
        str(output.get("asset_id") or "")
        for output in job.get("outputs") or []
        if output.get("asset_id")
    ]
    if asset_ids:
        lines.append("Asset ids: " + ", ".join(asset_ids))
    target = result.get("target_node_id") or plan.get("target_node_id")
    if target:
        lines.append(f"Board node: {target}")
    generate_ids = result.get("generate_ids") or plan.get("generate_ids") or []
    if generate_ids:
        lines.append("Generate cards: " + ", ".join(str(item) for item in generate_ids))
    lines.append(
        "Reuse these asset ids as input_asset_ids, or this job as parent_job_id, "
        "or a board node as board_node_id / iterate_from, for further edits. "
        "Cite each file by its exact filename."
    )
    return lines


def _is_retryable_failure(job: dict[str, Any]) -> bool:
    if job.get("status") not in {"failed", "interrupted"}:
        return False
    message = str(job.get("error_message") or "").lower()
    if any(marker in message for marker in _POLICY_MARKERS):
        return False
    return any(marker in message for marker in _TRANSIENT_MARKERS)


def _bytes_from_local_url(url: str) -> tuple[bytes, str] | None:
    if not url:
        return None
    path = urlparse(url).path or url
    if path.startswith(_LOCAL_ATTACHMENT_PREFIX):
        parts = path[len(_LOCAL_ATTACHMENT_PREFIX) :].split("/")
        if len(parts) != 3:
            return None
        sid, aid, name = (unquote(part) for part in parts)
        try:
            from knorvia.services.storage import get_attachment_store

            resolve = getattr(get_attachment_store(), "resolve_path", None)
            if resolve is None:
                return None
            target = resolve(session_id=sid, attachment_id=aid, filename=name)
            if not target:
                return None
            if target.stat().st_size > MAX_UPLOAD_IMAGE_BYTES:
                return None
            with target.open("rb") as handle:
                data = handle.read(MAX_UPLOAD_IMAGE_BYTES + 1)
        except Exception:
            logger.debug("Could not resolve chat attachment %s", url, exc_info=True)
            return None
        return (data, "image/png") if data else None
    if path.startswith(_OUTPUTS_URL_PREFIX):
        try:
            from knorvia.services.session.artifact_attachments import _resolve_artifact_path

            target = _resolve_artifact_path(path)
            if target is None:
                return None
            if target.stat().st_size > MAX_UPLOAD_IMAGE_BYTES:
                return None
            with target.open("rb") as handle:
                data = handle.read(MAX_UPLOAD_IMAGE_BYTES + 1)
        except Exception:
            logger.debug("Could not resolve generated image %s", url, exc_info=True)
            return None
        return (data, "image/png") if data else None
    return None


async def _wait_for_job(
    store: ImageStudioStore,
    job_id: str,
    *,
    event_sink: Any = None,
    project_id: str = "",
) -> dict[str, Any]:
    last = ""
    for _ in range(MAX_JOB_WAIT_POLLS):
        job = store.get_job(job_id) or {}
        status = str(job.get("status") or "")
        if status != last:
            last = status
            await _emit(
                event_sink,
                f"Image Studio {status}",
                studio_job_id=job_id,
                studio_project_id=project_id or str(job.get("project_id") or ""),
                studio_status=status,
            )
        if status in FINAL_STATUSES:
            return job
        await asyncio.sleep(0.4)
    cancel_job(store, job_id)
    raise TimeoutError("Image Studio job timed out.")


def _copy_outputs(
    store: ImageStudioStore, job: dict[str, Any], workspace_dir: str | None
) -> list[dict[str, Any]]:
    from pathlib import Path

    files: list[dict[str, Any]] = []
    if not workspace_dir:
        return files
    root = Path(workspace_dir)
    root.mkdir(parents=True, exist_ok=True)
    for index, output in enumerate(job.get("outputs") or [], start=1):
        asset = store.get_asset(output["asset_id"])
        if not asset:
            continue
        source = store.asset_path(asset["id"])
        suffix = source.suffix or ".png"
        name = f"studio_{job['id'][-8:]}_{index}{suffix}"
        target = root / name
        target.write_bytes(source.read_bytes())
        files.append(
            {
                "path": str(target),
                "filename": name,
                "mime": asset.get("mime") or "image/png",
                "asset_id": asset["id"],
            }
        )
    return files


async def _emit(event_sink: Any, message: str, **metadata: Any) -> None:
    if event_sink is None:
        return
    try:
        extra = {key: value for key, value in metadata.items() if value not in (None, "")}
        if extra:
            await event_sink("tool_log", message, extra)
        else:
            await event_sink("tool_log", message)
    except Exception:
        logger.debug("Image Studio progress emit failed", exc_info=True)


__all__ = [
    "advertised_operations",
    "advertised_parameters",
    "cancel_studio_job",
    "citation_lines",
    "collect_input_asset_ids",
    "decode_attachment",
    "fallback_models",
    "filter_studio_parameters",
    "import_image_bytes",
    "list_usable_models",
    "needs_confirmation",
    "plan_studio_job",
    "project_for_session",
    "recent_session_outputs",
    "resolve_studio_operation",
    "run_studio_image_job",
    "select_studio_model",
]
