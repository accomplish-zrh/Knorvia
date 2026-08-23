"""HTTP API for the creative library and unified Create workbench."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from knorvia.services.creative_agent.runner import run_canvas, submit_create_generation
from knorvia.services.creative_library.store import (
    ENTRY_KINDS,
    IMAGE_MIMES,
    VIDEO_MIMES,
    get_creative_library_store,
)

router = APIRouter()

MAX_UPLOAD = 64 * 1024 * 1024


class TextAssetCreate(BaseModel):
    title: str = Field(default="Untitled", max_length=160)
    content: str = Field(min_length=1, max_length=50_000)
    tags: list[str] = Field(default_factory=list)
    source: str = Field(default="", max_length=200)
    note: str = Field(default="", max_length=2_000)


class AssetPatch(BaseModel):
    title: str | None = Field(default=None, max_length=160)
    content: str | None = Field(default=None, max_length=50_000)
    tags: list[str] | None = None
    source: str | None = Field(default=None, max_length=200)
    note: str | None = Field(default=None, max_length=2_000)


class PromptCreate(BaseModel):
    title: str = Field(default="Untitled", max_length=160)
    body: str = Field(min_length=1, max_length=50_000)
    category: str = Field(default="", max_length=80)
    tags: list[str] = Field(default_factory=list)
    language: str = Field(default="en", max_length=8)


class PromptPatch(BaseModel):
    title: str | None = Field(default=None, max_length=160)
    body: str | None = Field(default=None, max_length=50_000)
    category: str | None = Field(default=None, max_length=80)
    tags: list[str] | None = None
    language: str | None = Field(default=None, max_length=8)


class ConversationCreate(BaseModel):
    title: str = Field(default="", max_length=160)


class CreateSubmit(BaseModel):
    conversation_id: str | None = None
    prompt: str = Field(min_length=1, max_length=20_000)
    mode: Literal["agent", "image", "video"] = "agent"
    language: str = Field(default="en", max_length=8)
    model_key: str = Field(default="", max_length=240)
    smart_planning: bool = True
    library_asset_ids: list[str] = Field(default_factory=list, max_length=8)
    first_frame_asset_id: str = Field(default="", max_length=80)
    last_frame_asset_id: str = Field(default="", max_length=80)
    preferences: dict[str, Any] = Field(default_factory=dict)


class CanvasRunCreate(BaseModel):
    prompt: str = Field(min_length=1, max_length=20_000)
    language: str = Field(default="en", max_length=8)
    selected_ids: list[str] = Field(default_factory=list, max_length=20)
    model_key: str = Field(default="", max_length=240)
    smart_planning: bool = True
    preferences: dict[str, Any] = Field(default_factory=dict)


def _store():
    return get_creative_library_store()


@router.get("/assets")
async def list_assets(
    kind: str = "",
    keyword: str = "",
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=48),
) -> dict[str, Any]:
    return _store().list_assets(kind=kind, keyword=keyword, page=page, page_size=page_size)


@router.post("/assets")
async def create_text_asset(payload: TextAssetCreate) -> dict[str, Any]:
    try:
        return _store().create_text_asset(
            title=payload.title,
            content=payload.content,
            tags=payload.tags,
            source=payload.source,
            note=payload.note,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/assets/upload")
async def upload_asset(
    file: UploadFile = File(...),
    title: str = Form(default=""),
    source: str = Form(default=""),
    note: str = Form(default=""),
) -> dict[str, Any]:
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(status_code=422, detail="Upload is too large")
    mime = (file.content_type or "").split(";", 1)[0].strip().lower()
    if mime not in IMAGE_MIMES and mime not in VIDEO_MIMES:
        raise HTTPException(status_code=422, detail="Unsupported library media type")
    try:
        return _store().create_media_asset(
            data,
            mime,
            title=title or (file.filename or "Untitled"),
            source=source,
            note=note,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/assets/{asset_id}")
async def get_asset(asset_id: str) -> dict[str, Any]:
    asset = _store().get_asset(asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Library asset not found")
    return asset


@router.get("/assets/{asset_id}/content")
async def get_asset_content(asset_id: str) -> Response:
    payload = _store().asset_bytes(asset_id)
    asset = _store().get_asset(asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Library asset not found")
    if asset["kind"] == "text":
        return Response(content=asset["content"], media_type="text/plain; charset=utf-8")
    if not payload:
        raise HTTPException(status_code=404, detail="Library file not found")
    data, mime = payload
    return Response(content=data, media_type=mime)


@router.patch("/assets/{asset_id}")
async def patch_asset(asset_id: str, payload: AssetPatch) -> dict[str, Any]:
    try:
        return _store().update_asset(asset_id, payload.model_dump(exclude_unset=True))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Library asset not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.delete("/assets/{asset_id}")
async def delete_asset(asset_id: str) -> dict[str, Any]:
    return {"deleted": _store().delete_asset(asset_id)}


@router.get("/prompts")
async def list_prompts(
    origin: str = "",
    keyword: str = "",
    category: str = "",
    tag: str = "",
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=48),
) -> dict[str, Any]:
    return _store().list_prompts(
        origin=origin,
        keyword=keyword,
        category=category,
        tag=tag,
        page=page,
        page_size=page_size,
    )


@router.post("/prompts")
async def create_prompt(payload: PromptCreate) -> dict[str, Any]:
    try:
        return _store().create_prompt(
            title=payload.title,
            body=payload.body,
            category=payload.category,
            tags=payload.tags,
            language=payload.language,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.patch("/prompts/{prompt_id}")
async def patch_prompt(prompt_id: str, payload: PromptPatch) -> dict[str, Any]:
    try:
        return _store().update_prompt(prompt_id, payload.model_dump(exclude_unset=True))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Prompt not found") from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.delete("/prompts/{prompt_id}")
async def delete_prompt(prompt_id: str) -> dict[str, Any]:
    try:
        return {"deleted": _store().delete_prompt(prompt_id)}
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@router.get("/conversations")
async def list_conversations() -> dict[str, Any]:
    return {"items": _store().list_conversations()}


@router.post("/conversations")
async def create_conversation(payload: ConversationCreate) -> dict[str, Any]:
    try:
        return _store().create_conversation(payload.title)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/conversations/{conversation_id}")
async def get_conversation(conversation_id: str) -> dict[str, Any]:
    conversation = _store().get_conversation(conversation_id)
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return {**conversation, "messages": _store().list_messages(conversation_id)}


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(conversation_id: str) -> dict[str, Any]:
    return {"deleted": _store().delete_conversation(conversation_id)}


@router.post("/create")
async def submit_create(payload: CreateSubmit) -> dict[str, Any]:
    try:
        return submit_create_generation(
            conversation_id=payload.conversation_id,
            prompt=payload.prompt,
            mode=payload.mode,
            language=payload.language,
            model_key=payload.model_key,
            smart_planning=payload.smart_planning,
            library_asset_ids=payload.library_asset_ids,
            first_frame_asset_id=payload.first_frame_asset_id,
            last_frame_asset_id=payload.last_frame_asset_id,
            preferences=payload.preferences,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/canvas-runs/{studio}/{project_id}")
async def start_canvas_run(
    studio: Literal["image", "video"],
    project_id: str,
    payload: CanvasRunCreate,
) -> dict[str, Any]:
    try:
        return run_canvas(
            studio=studio,
            project_id=project_id,
            prompt=payload.prompt,
            language=payload.language,
            selected_ids=payload.selected_ids,
            model_key=payload.model_key,
            smart_planning=payload.smart_planning,
            preferences=payload.preferences,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/canvas-runs/{run_id}")
async def get_canvas_run(run_id: str) -> dict[str, Any]:
    run = _store().get_canvas_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Canvas run not found")
    return run


class EntryCreate(BaseModel):
    kind: str = Field(min_length=1, max_length=32)
    title: str = Field(default="", max_length=160)
    parent_id: str | None = Field(default=None, max_length=80)
    content: str = Field(default="", max_length=200_000)


class EntryPatch(BaseModel):
    title: str | None = Field(default=None, max_length=160)
    content: str | None = Field(default=None, max_length=200_000)
    parent_id: str | None = Field(default=None, max_length=80)


@router.get("/tree")
async def list_library_tree() -> dict[str, Any]:
    return _store().list_tree()


@router.post("/entries")
async def create_library_entry(payload: EntryCreate) -> dict[str, Any]:
    if payload.kind not in ENTRY_KINDS:
        raise HTTPException(status_code=422, detail="Unsupported library entry kind")
    try:
        return _store().create_entry(
            kind=payload.kind,
            title=payload.title,
            parent_id=payload.parent_id,
            content=payload.content,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Folder not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/entries/upload")
async def upload_library_entry(
    file: UploadFile = File(...),
    parent_id: str = Form(default=""),
    title: str = Form(default=""),
) -> dict[str, Any]:
    data = await file.read(MAX_UPLOAD + 1)
    if len(data) > MAX_UPLOAD:
        raise HTTPException(status_code=422, detail="Upload is too large")
    try:
        return _store().upload_entry(
            data,
            file.filename or "upload.bin",
            file.content_type or "",
            parent_id=parent_id or None,
            title=title,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Folder not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/entries/{entry_id}")
async def get_library_entry(entry_id: str) -> dict[str, Any]:
    entry = _store().get_entry(entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Library entry not found")
    return entry


@router.get("/entries/{entry_id}/content")
async def get_library_entry_content(entry_id: str) -> Response:
    entry = _store().get_entry(entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Library entry not found")
    payload = _store().entry_bytes(entry_id)
    if payload is None:
        raise HTTPException(status_code=404, detail="Library file not found")
    data, mime = payload
    return Response(content=data, media_type=mime or "application/octet-stream")


@router.patch("/entries/{entry_id}")
async def patch_library_entry(entry_id: str, payload: EntryPatch) -> dict[str, Any]:
    try:
        provided = payload.model_dump(exclude_unset=True)
        parent_id = provided.pop("parent_id", None) if "parent_id" in provided else None
        entry = (
            _store().update_entry(entry_id, provided) if provided else _store().get_entry(entry_id)
        )
        if not entry:
            raise KeyError(entry_id)
        if "parent_id" in payload.model_fields_set:
            entry = _store().move_entry(entry_id, parent_id)
        return entry
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Library entry not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.delete("/entries/{entry_id}")
async def delete_library_entry(entry_id: str) -> dict[str, Any]:
    return {"deleted": _store().delete_entry(entry_id)}
