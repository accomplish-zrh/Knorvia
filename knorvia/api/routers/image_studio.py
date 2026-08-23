from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from knorvia.multi_user.model_access import allowed_imagegen_options
from knorvia.services.image_studio.engine import (
    cancel_job,
    capture_job_authorization,
    start_job,
)
from knorvia.services.image_studio.ncnn_upscaler import get_ncnn_upscaler
from knorvia.services.image_studio.store import (
    UPLOAD_CHUNK_BYTES,
    BoardConflictError,
    ImageStudioQueueFullError,
    get_image_studio_store,
    parse_output_count,
)


def require_image_studio_enabled() -> None:
    if str(os.getenv("KNORVIA_IMAGE_STUDIO_ENABLED", "true")).strip().lower() in {
        "0",
        "false",
        "no",
        "off",
    }:
        raise HTTPException(status_code=404, detail="Image Studio is disabled")


router = APIRouter(dependencies=[Depends(require_image_studio_enabled)])
ALLOWED_MIME = {"image/png", "image/jpeg", "image/webp"}
MAX_INPUT_BYTES = 10 * 1024 * 1024


class ProjectCreate(BaseModel):
    title: str = Field(default="Untitled Project", max_length=160)


class ProjectPatch(BaseModel):
    title: str = Field(max_length=160)


class UploadCreate(BaseModel):
    filename: str = Field(max_length=255)
    mime: str
    size: int = Field(gt=0, le=MAX_INPUT_BYTES)
    sha256: str = Field(min_length=64, max_length=64)


class JobCreate(BaseModel):
    operation: Literal["generate", "edit", "inpaint"] = "generate"
    image_profile_id: str
    model_id: str
    prompt: str = Field(min_length=1, max_length=20_000)
    input_asset_ids: list[str] = Field(default_factory=list, max_length=4)
    mask_asset_id: str | None = None
    parent_job_id: str | None = None
    parameters: dict[str, Any] = Field(default_factory=dict)


class AssetPatch(BaseModel):
    favorite: bool


def _project(project_id: str) -> dict[str, Any]:
    project = get_image_studio_store().get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def _allowed(profile_id: str, model_id: str) -> dict[str, Any]:
    options = allowed_imagegen_options().get("options", [])
    item = next(
        (
            row
            for row in options
            if row.get("profile_id") == profile_id and row.get("model_id") == model_id
        ),
        None,
    )
    if not item:
        raise HTTPException(
            status_code=403, detail="This image model is not assigned to your account."
        )
    return item


def _expected_board_revision(request: Request, payload: dict[str, Any]) -> int | None:
    raw: Any = request.headers.get("if-match")
    if raw is None:
        raw = payload.get("revision")
    if raw is None:
        return None
    text = str(raw).strip()
    if text.startswith("W/"):
        text = text[2:].strip()
    text = text.strip('"')
    try:
        revision = int(text)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="Invalid board revision") from exc
    if revision < 0:
        raise HTTPException(status_code=422, detail="Invalid board revision")
    return revision


async def _read_upload_chunk(request: Request) -> bytes:
    raw_length = request.headers.get("content-length")
    if raw_length:
        try:
            content_length = int(raw_length)
            if content_length < 0:
                raise HTTPException(status_code=400, detail="Invalid Content-Length")
            if content_length > UPLOAD_CHUNK_BYTES:
                raise HTTPException(status_code=413, detail="Upload chunk is too large")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Invalid Content-Length") from exc
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > UPLOAD_CHUNK_BYTES:
            raise HTTPException(status_code=413, detail="Upload chunk is too large")
        data.extend(chunk)
    return bytes(data)


@router.get("/models")
async def models() -> dict[str, Any]:
    return allowed_imagegen_options()


@router.get("/upscaler")
async def upscaler_status() -> dict[str, Any]:
    return get_ncnn_upscaler().status()


@router.post("/upscaler/install")
async def install_upscaler() -> dict[str, Any]:
    try:
        return await asyncio.to_thread(get_ncnn_upscaler().install)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/projects")
async def list_projects(query: str = "", limit: int = 30) -> dict[str, Any]:
    store = get_image_studio_store()
    projects = store.list_projects(query, limit)
    if not projects and not query:
        projects = [store.ensure_default_project()]
    return {"projects": projects}


@router.post("/projects", status_code=201)
async def create_project(payload: ProjectCreate) -> dict[str, Any]:
    return get_image_studio_store().create_project(payload.title)


@router.get("/projects/{project_id}")
async def get_project(project_id: str) -> dict[str, Any]:
    project = _project(project_id)
    store = get_image_studio_store()
    return {
        **project,
        "jobs": store.list_jobs(project_id),
        "assets": store.list_assets(project_id),
    }


@router.get("/projects/{project_id}/board")
async def get_board(project_id: str) -> dict[str, Any]:
    _project(project_id)
    return get_image_studio_store().get_board(project_id)


@router.put("/projects/{project_id}/board")
async def put_board(project_id: str, request: Request, payload: dict[str, Any]) -> dict[str, Any]:
    _project(project_id)
    expected_revision = _expected_board_revision(request, payload)
    try:
        return get_image_studio_store().save_board(
            project_id, payload, expected_revision=expected_revision
        )
    except BoardConflictError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "board_revision_conflict",
                "message": str(exc),
                "expected_revision": exc.expected_revision,
                "current_revision": exc.current_revision,
            },
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.patch("/projects/{project_id}")
async def patch_project(project_id: str, payload: ProjectPatch) -> dict[str, Any]:
    _project(project_id)
    return get_image_studio_store().update_project(project_id, payload.title) or {}


@router.delete("/projects/{project_id}")
async def delete_project(project_id: str) -> dict[str, bool]:
    _project(project_id)
    return {"deleted": get_image_studio_store().delete_project(project_id)}


@router.post("/projects/{project_id}/restore")
async def restore_project(project_id: str) -> dict[str, Any]:
    project = get_image_studio_store().restore_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


@router.get("/projects/{project_id}/export")
async def export_project(project_id: str) -> FileResponse:
    project = _project(project_id)
    try:
        path = await asyncio.to_thread(get_image_studio_store().export_project, project_id)
    except ValueError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    safe_name = "".join(
        char if char.isalnum() or char in "-_" else "_" for char in project["title"]
    )
    return FileResponse(
        path, media_type="application/zip", filename=f"{safe_name or 'image-studio'}.zip"
    )


@router.post("/projects/{project_id}/uploads", status_code=201)
async def create_upload(project_id: str, payload: UploadCreate) -> dict[str, Any]:
    _project(project_id)
    if payload.mime not in ALLOWED_MIME:
        raise HTTPException(status_code=422, detail="Only PNG, JPEG and WebP images are supported")
    try:
        return get_image_studio_store().create_upload(
            project_id, payload.filename, payload.mime, payload.size, payload.sha256
        )
    except ValueError as exc:
        status = 429 if "too many active" in str(exc).lower() else 422
        raise HTTPException(status_code=status, detail=str(exc)) from exc


@router.put("/uploads/{upload_id}/parts/{index}", status_code=204)
async def upload_part(upload_id: str, index: int, request: Request) -> None:
    data = await _read_upload_chunk(request)
    store = get_image_studio_store()
    try:
        await asyncio.to_thread(store.write_upload_part, upload_id, index, data)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Upload not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/uploads/{upload_id}/complete")
async def complete_upload(upload_id: str) -> dict[str, Any]:
    store = get_image_studio_store()
    try:
        return await asyncio.to_thread(store.complete_upload, upload_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Upload not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/assets/{asset_id}")
async def get_asset(asset_id: str) -> dict[str, Any]:
    asset = get_image_studio_store().get_asset(asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset


@router.get("/assets/{asset_id}/content")
async def asset_content(asset_id: str) -> FileResponse:
    store = get_image_studio_store()
    asset = store.get_asset(asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    return FileResponse(store.asset_path(asset_id), media_type=asset["mime"])


@router.patch("/assets/{asset_id}")
async def patch_asset(asset_id: str, payload: AssetPatch) -> dict[str, Any]:
    asset = get_image_studio_store().set_favorite(asset_id, payload.favorite)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset


@router.delete("/assets/{asset_id}")
async def delete_asset(asset_id: str) -> dict[str, bool]:
    store = get_image_studio_store()
    if not store.get_asset(asset_id):
        raise HTTPException(status_code=404, detail="Asset not found")
    return {"deleted": store.delete_asset(asset_id)}


@router.post("/assets/{asset_id}/restore")
async def restore_asset(asset_id: str) -> dict[str, Any]:
    asset = get_image_studio_store().restore_asset(asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    return asset


@router.post("/projects/{project_id}/jobs", status_code=202)
async def create_job(project_id: str, payload: JobCreate) -> dict[str, Any]:
    _project(project_id)
    option = _allowed(payload.image_profile_id, payload.model_id)
    capabilities = option.get("capabilities") or {}
    operations = capabilities.get("operations") or ["generate"]
    if payload.operation not in operations:
        raise HTTPException(
            status_code=422, detail="The selected model does not support this operation"
        )
    if payload.operation == "generate" and (payload.input_asset_ids or payload.mask_asset_id):
        raise HTTPException(status_code=422, detail="Generate mode does not accept input images")
    if payload.operation != "generate" and not payload.input_asset_ids:
        raise HTTPException(status_code=422, detail="Edit mode requires an input image")
    if payload.operation == "inpaint" and not payload.mask_asset_id:
        raise HTTPException(status_code=422, detail="Inpaint mode requires a mask")
    if len(payload.input_asset_ids) > int(capabilities.get("max_inputs") or 4):
        raise HTTPException(status_code=422, detail="Too many input images for this model")
    supported_parameters = set(
        capabilities.get("parameters") or ["n", "size", "quality", "style", "output_format"]
    )
    # Studio-level post-processing target. It is valid even when the provider
    # has no native image_size parameter because the runner can upscale.
    supported_parameters.add("target_resolution")
    supported_parameters.add("upscale_model")
    unsupported = sorted(set(payload.parameters) - supported_parameters)
    if unsupported:
        raise HTTPException(
            status_code=422,
            detail={
                "code": "unsupported_parameter",
                "message": f"Unsupported image parameter: {unsupported[0]}",
                "field": unsupported[0],
            },
        )
    store = get_image_studio_store()
    for asset_id in [
        *payload.input_asset_ids,
        *([payload.mask_asset_id] if payload.mask_asset_id else []),
    ]:
        asset = store.get_asset(asset_id)
        if not asset or asset["project_id"] != project_id:
            raise HTTPException(status_code=404, detail="Input asset not found")
    if payload.operation == "inpaint" and payload.mask_asset_id:
        base_asset = store.get_asset(payload.input_asset_ids[0])
        mask_asset = store.get_asset(payload.mask_asset_id)
        if not mask_asset or mask_asset.get("mime") != "image/png":
            raise HTTPException(status_code=422, detail="Inpaint mask must be a PNG image")
        if not base_asset or (
            int(base_asset.get("width") or 0),
            int(base_asset.get("height") or 0),
        ) != (int(mask_asset.get("width") or 0), int(mask_asset.get("height") or 0)):
            raise HTTPException(
                status_code=422, detail="Inpaint mask must match the base image dimensions"
            )
    try:
        count = parse_output_count(payload.parameters)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if count > min(4, int(capabilities.get("max_outputs") or 4)):
        raise HTTPException(status_code=422, detail="Invalid output count")
    try:
        authorization = capture_job_authorization(payload.image_profile_id, payload.model_id)
        job = store.create_job(
            project_id,
            {
                "operation": payload.operation,
                "profile_id": payload.image_profile_id,
                "model_id": payload.model_id,
                "prompt": payload.prompt,
                "input_asset_ids": payload.input_asset_ids,
                "mask_asset_id": payload.mask_asset_id,
                "parent_job_id": payload.parent_job_id,
                "parameters": payload.parameters,
                **authorization,
            },
        )
        start_job(store, job["id"])
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ImageStudioQueueFullError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    return job


@router.get("/projects/{project_id}/jobs")
async def list_jobs(
    project_id: str,
    limit: int = 50,
    cursor: float | None = None,
    status: str = "",
    model_id: str = "",
    query: str = "",
    favorite: bool = False,
) -> dict[str, Any]:
    _project(project_id)
    jobs = get_image_studio_store().list_jobs(
        project_id,
        limit,
        before=cursor,
        status=status,
        model_id=model_id,
        query=query,
        favorite=favorite,
    )
    page_size = min(max(1, limit), 100)
    return {
        "jobs": jobs,
        "next_cursor": jobs[-1]["created_at"] if len(jobs) == page_size else None,
    }


@router.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict[str, Any]:
    job = get_image_studio_store().get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.get("/jobs/{job_id}/events")
async def job_events(job_id: str, after_seq: int = 0) -> dict[str, Any]:
    store = get_image_studio_store()
    if not store.get_job(job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    return {"events": store.events_after(job_id, after_seq)}


@router.post("/jobs/{job_id}/cancel")
async def cancel(job_id: str) -> dict[str, bool]:
    store = get_image_studio_store()
    if not store.get_job(job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    return {"cancelled": cancel_job(store, job_id)}


@router.post("/jobs/{job_id}/retry", status_code=202)
async def retry(job_id: str) -> dict[str, Any]:
    store = get_image_studio_store()
    old = store.get_job(job_id)
    if not old:
        raise HTTPException(status_code=404, detail="Job not found")
    _allowed(old["profile_id"], old["model_id"])
    refs = [item["asset_id"] for item in old["inputs"] if item["role"] == "reference"]
    mask = next((item["asset_id"] for item in old["inputs"] if item["role"] == "mask"), None)
    try:
        authorization = capture_job_authorization(old["profile_id"], old["model_id"])
        job = store.create_job(
            old["project_id"],
            {
                "operation": old["operation"],
                "profile_id": old["profile_id"],
                "model_id": old["model_id"],
                "prompt": old["prompt"],
                "input_asset_ids": refs,
                "mask_asset_id": mask,
                "parent_job_id": old["parent_job_id"],
                "retry_of_job_id": old["id"],
                "parameters": old["requested_params"],
                **authorization,
            },
        )
        start_job(store, job["id"])
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ImageStudioQueueFullError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    return job


@router.websocket("/ws")
async def image_studio_ws(ws: WebSocket) -> None:
    """Replay persisted job events and continue following a running job."""
    from knorvia.api.routers.auth import ws_auth_failed, ws_require_auth
    from knorvia.multi_user.context import reset_current_user

    if str(os.getenv("KNORVIA_IMAGE_STUDIO_ENABLED", "true")).strip().lower() in {
        "0",
        "false",
        "no",
        "off",
    }:
        await ws.close(code=1008)
        return
    user_token = await ws_require_auth(ws)
    if user_token is ws_auth_failed:
        return
    await ws.accept()
    try:
        while True:
            raw = await ws.receive_text()
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await ws.send_json({"type": "error", "message": "Invalid JSON"})
                continue
            if message.get("type") == "ping":
                await ws.send_json({"type": "pong"})
                continue
            if message.get("type") != "subscribe_job":
                await ws.send_json({"type": "error", "message": "Unsupported operation"})
                continue
            job_id = str(message.get("job_id") or "")
            after_seq = max(0, int(message.get("after_seq") or 0))
            store = get_image_studio_store()
            if not store.get_job(job_id):
                await ws.send_json({"type": "error", "message": "Job not found"})
                continue
            while True:
                events = store.events_after(job_id, after_seq)
                for event in events:
                    after_seq = event["seq"]
                    await ws.send_json(event)
                job = store.get_job(job_id)
                if not job or job["status"] in {
                    "succeeded",
                    "partial",
                    "failed",
                    "cancelled",
                    "interrupted",
                }:
                    await ws.send_json(
                        {"type": "subscription.complete", "job_id": job_id, "after_seq": after_seq}
                    )
                    break
                await asyncio.sleep(0.4)
    except WebSocketDisconnect:
        pass
    finally:
        if user_token is not None:
            reset_current_user(user_token)
