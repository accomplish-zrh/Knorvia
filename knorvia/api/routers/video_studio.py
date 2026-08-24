from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import re
from typing import Any, Literal

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from starlette.background import BackgroundTask

from knorvia.multi_user.model_access import allowed_videogen_options
from knorvia.services.video_studio.board import (
    BOARD_TEMPLATE_IDS,
    export_board_to_shots,
    import_storyboard_shots,
    place_template,
)
from knorvia.services.video_studio.composition import (
    compose_project,
    list_compositions,
)
from knorvia.services.video_studio.engine import cancel_video_job
from knorvia.services.video_studio.ffmpeg_tool import (
    FFmpegUnavailableError,
    get_ffmpeg_tool,
)
from knorvia.services.video_studio.service import (
    create_shot_keyframe,
    create_shot_voiceover,
    create_video_job,
    find_video_option,
    reroll_parameters,
)
from knorvia.services.video_studio.store import (
    MAX_STORYBOARD_SHOTS,
    MIME_LIMITS,
    UPLOAD_CHUNK_BYTES,
    BoardConflictError,
    StoryboardConflictError,
    VideoStudioQueueFullError,
    VideoStudioRetryConflictError,
    get_video_studio_store,
)
from knorvia.services.video_studio.thumbnails import (
    ThumbnailError,
    ensure_asset_thumbnail,
)


def require_video_studio_enabled() -> None:
    if str(os.getenv("KNORVIA_VIDEO_STUDIO_ENABLED", "true")).strip().lower() in {
        "0",
        "false",
        "no",
        "off",
    }:
        raise HTTPException(status_code=404, detail="Video Studio is disabled")


router = APIRouter(dependencies=[Depends(require_video_studio_enabled)])


class ProjectCreate(BaseModel):
    title: str = Field(default="Untitled Project", max_length=160)


class ProjectPatch(BaseModel):
    """Title rename and/or the §Phase D3 project-level BGM slot.

    Absent fields stay unchanged; ``bgm_asset_id=""`` explicitly clears the
    slot (an absent key keeps it, so a title-only PATCH never drops the music).
    """

    title: str | None = Field(default=None, min_length=1, max_length=160)
    bgm_asset_id: str | None = Field(default=None, max_length=160)
    bgm_volume: float | None = Field(default=None, ge=0.0, le=2.0)
    bgm_fade_in: float | None = Field(default=None, ge=0.0, le=10.0)
    bgm_fade_out: float | None = Field(default=None, ge=0.0, le=10.0)


class DirectorDeskSave(BaseModel):
    """Full ``project.get`` export document from the embedded director desk."""

    director_desk: dict[str, Any] = Field(default_factory=dict)


class ProductionSave(BaseModel):
    production: dict[str, Any] = Field(default_factory=dict)


class ProductionReviewBody(BaseModel):
    notes: str = Field(default="", max_length=4000)


class ProductionApplyBody(BaseModel):
    replace: bool = False
    place_on_board: bool = True


class UploadCreate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    filename: str = Field(max_length=255)
    mime_type: str = Field(alias="mime")
    size: int = Field(gt=0)
    sha256: str = Field(min_length=64, max_length=64)


class JobInput(BaseModel):
    asset_id: str = Field(min_length=1, max_length=160)
    role: Literal["reference", "first-frame", "last-frame", "audio", "continue-from"] = "reference"


class JobCreate(BaseModel):
    profile_id: str = Field(min_length=1, max_length=160)
    model_id: str = Field(min_length=1, max_length=160)
    operation: str = Field(min_length=1, max_length=64)
    prompt: str = Field(min_length=1, max_length=20_000)
    input_asset_ids: list[str] = Field(default_factory=list, max_length=50)
    inputs: list[JobInput] = Field(default_factory=list, max_length=50)
    parameters: dict[str, Any] = Field(default_factory=dict)
    client_request_id: str = Field(min_length=1, max_length=128)
    confirmed_cost: bool = False
    storyboard_shot_id: str | None = Field(default=None, max_length=128)
    board_node_id: str | None = Field(default=None, max_length=128)


class RetryCreate(BaseModel):
    client_request_id: str = Field(min_length=1, max_length=128)
    confirmed_cost: bool = False
    storyboard_shot_id: str | None = Field(default=None, max_length=128)
    board_node_id: str | None = Field(default=None, max_length=128)


class RerollCreate(BaseModel):
    """§Phase C5 paid reroll — one variant per confirmation, never batched."""

    client_request_id: str = Field(min_length=1, max_length=128)
    confirmed_cost: bool = False
    storyboard_shot_id: str | None = Field(default=None, max_length=128)
    board_node_id: str | None = Field(default=None, max_length=128)


class ShotJobBind(BaseModel):
    """Switch a shot's current output to one of its historical variant jobs."""

    job_id: str = Field(min_length=1, max_length=128)


class JobFollowCursor(BaseModel):
    """One followed job and the event sequence already consumed by the client."""

    job_id: str = Field(min_length=1, max_length=160)
    after_seq: int = Field(default=0, ge=0)


class JobFollowRequest(BaseModel):
    """Batched job+event polling — one request instead of two per running job.

    The workbench previously opened a private 1.2 s poll loop per active job,
    so N parallel generations meant ~2N requests against this backend every
    cycle. Unknown or foreign job ids are silently skipped (same visibility
    rules as ``GET /jobs/{id}``), never an error, so a batch stays valid even
    when a job was deleted mid-follow.
    """

    jobs: list[JobFollowCursor] = Field(max_length=50)


class BoardStoryboardImport(BaseModel):
    """Strip → board import body; ``force`` disables title+prompt dedup."""

    force: bool = False


class ShotKeyframeCreate(BaseModel):
    prompt: str | None = Field(default=None, max_length=20_000)
    profile_id: str = Field(default="", max_length=160)
    model_id: str = Field(default="", max_length=160)
    size: str = Field(default="", max_length=64)
    aspect_ratio: str = Field(default="", max_length=32)
    confirmed_cost: bool = False


class ShotVoiceoverCreate(BaseModel):
    text: str = Field(min_length=1, max_length=20_000)
    voice: str = Field(default="", max_length=160)
    format: str = Field(default="", max_length=16)
    confirmed_cost: bool = False


class ComposeSubtitle(BaseModel):
    mode: str = Field(default="off", max_length=32)
    style: str = Field(default="", max_length=500)
    # Phase D2: the saved subtitle document burned by mode="from_asset".
    srt_asset_id: str = Field(default="", max_length=160)
    # §Phase E2: custom burn-in overrides on top of the preset (validated
    # server-side: 12–72pt and ASS ``&H`` hex colours only).
    font_size: int | None = Field(default=None, ge=12, le=72)
    primary_colour: str = Field(default="", max_length=16)


class ComposeAudio(BaseModel):
    """§Phase D3: per-request BGM overrides on top of the project slot.

    An absent ``bgm_asset_id`` falls back to the project's saved slot; an empty
    string explicitly composes without music. Fade in/out are independent.
    """

    voiceovers: bool = True
    bgm_asset_id: str = Field(default="", max_length=160)
    bgm_volume: float = Field(default=0.6, ge=0.0, le=2.0)
    bgm_fade_in: float = Field(default=1.0, ge=0.0, le=10.0)
    bgm_fade_out: float = Field(default=1.0, ge=0.0, le=10.0)


class ComposeOutput(BaseModel):
    resolution: str = Field(default="720p", max_length=16)
    fps: int = Field(default=30, ge=1, le=120)
    format: str = Field(default="mp4", max_length=8)
    # §Phase E5: experimental local 720p→1080p frame-by-frame pre-step.
    # Slow CPU work, never a provider call; forces 1080p output.
    upscale: bool = False


class ComposeCreate(BaseModel):
    shot_order: list[str] | None = Field(default=None, max_length=200)
    subtitle: ComposeSubtitle = Field(default_factory=ComposeSubtitle)
    audio: ComposeAudio = Field(default_factory=ComposeAudio)
    output: ComposeOutput = Field(default_factory=ComposeOutput)
    client_request_id: str = Field(min_length=1, max_length=128)


class SubtitleDocumentSave(BaseModel):
    """Phase D2 subtitle editor save: the SRT text plus a friendly filename."""

    content: str = Field(min_length=1, max_length=5_000_000)
    filename: str = Field(default="subtitles.srt", max_length=160)


class CharacterCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=4000)
    reference_asset_ids: list[str] = Field(default_factory=list, max_length=50)
    voice_hint: str = Field(default="", max_length=160)


class CharacterUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=4000)
    reference_asset_ids: list[str] | None = Field(default=None, max_length=50)
    voice_hint: str | None = Field(default=None, max_length=160)


class CharacterThreeViewCreate(BaseModel):
    prompt: str | None = Field(default=None, max_length=20_000)
    profile_id: str = Field(default="", max_length=160)
    model_id: str = Field(default="", max_length=160)
    size: str = Field(default="", max_length=64)
    aspect_ratio: str = Field(default="", max_length=32)
    confirmed_cost: bool = False


def _project(project_id: str) -> dict[str, Any]:
    project = get_video_studio_store().get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Video project not found")
    return project


def _expected_revision(request: Request, payload: dict[str, Any]) -> int:
    raw: Any = request.headers.get("if-match", payload.get("revision"))
    if raw is None:
        raise HTTPException(status_code=428, detail="A storyboard revision is required")
    text = str(raw).strip()
    if text.startswith("W/"):
        text = text[2:].strip()
    try:
        value = int(text.strip('"'))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="Invalid storyboard revision") from exc
    if value < 0:
        raise HTTPException(status_code=422, detail="Invalid storyboard revision")
    return value


async def _read_upload_chunk(request: Request) -> bytes:
    raw_length = request.headers.get("content-length")
    if raw_length:
        try:
            if int(raw_length) < 0 or int(raw_length) > UPLOAD_CHUNK_BYTES:
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
    return allowed_videogen_options()


@router.get("/capability-presets")
async def capability_presets() -> dict[str, Any]:
    from knorvia.services.video_studio.capability_presets import list_capability_presets

    return {"presets": list_capability_presets()}


@router.get("/ffmpeg/status")
async def ffmpeg_status() -> dict[str, Any]:
    return get_ffmpeg_tool().status()


@router.post("/ffmpeg/install")
async def ffmpeg_install() -> dict[str, Any]:
    tool = get_ffmpeg_tool()
    if tool.installed():
        return tool.status()
    try:
        return await asyncio.to_thread(tool.install)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/projects")
async def list_projects(query: str = "", limit: int = 30) -> dict[str, Any]:
    store = get_video_studio_store()
    projects = store.list_projects(query=query, limit=limit)
    if not projects and not query:
        projects = [store.ensure_default_project()]
    active = store.get_active_project()
    return {
        "projects": projects,
        "active_project_id": (active or {}).get("id"),
    }


@router.post("/projects", status_code=201)
async def create_project(payload: ProjectCreate) -> dict[str, Any]:
    return get_video_studio_store().create_project(payload.title)


@router.post("/projects/{project_id}/activate")
async def activate_project(project_id: str) -> dict[str, Any]:
    """Mark this project as the workspace's current Video Studio project.

    Chat ``videogen`` binds a new session to this project so Agent jobs land
    on the same storyboard the user is looking at.
    """
    store = get_video_studio_store()
    _project(project_id)
    try:
        project = store.set_active_project(project_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Video project not found") from exc
    return {"project": project, "active_project_id": project["id"]}


@router.get("/projects/{project_id}")
async def get_project(project_id: str) -> dict[str, Any]:
    return _project(project_id)


@router.patch("/projects/{project_id}")
async def patch_project(project_id: str, payload: ProjectPatch) -> dict[str, Any]:
    _project(project_id)
    provided = payload.model_fields_set
    if not provided:
        raise HTTPException(status_code=422, detail="Provide a field to update")
    kwargs: dict[str, Any] = {}
    if "bgm_asset_id" in provided:
        # Only an explicitly provided key reaches the store, so "" clears the
        # slot while an absent key preserves it.
        kwargs["bgm_asset_id"] = payload.bgm_asset_id or ""
    for field in ("bgm_volume", "bgm_fade_in", "bgm_fade_out"):
        if field in provided and getattr(payload, field) is not None:
            kwargs[field] = getattr(payload, field)
    try:
        return (
            get_video_studio_store().update_project(
                project_id,
                payload.title if "title" in provided else None,
                **kwargs,
            )
            or {}
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/projects/{project_id}/director-desk")
async def get_director_desk(project_id: str) -> dict[str, Any]:
    _project(project_id)
    return get_video_studio_store().get_director_desk(project_id)


@router.put("/projects/{project_id}/director-desk")
async def put_director_desk(project_id: str, payload: DirectorDeskSave) -> dict[str, Any]:
    _project(project_id)
    try:
        return get_video_studio_store().save_director_desk(project_id, payload.director_desk)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.delete("/projects/{project_id}/director-desk", status_code=204)
async def delete_director_desk(project_id: str) -> None:
    _project(project_id)
    if not get_video_studio_store().clear_director_desk(project_id):
        raise HTTPException(status_code=404, detail="Video project not found")


@router.get("/projects/{project_id}/production")
async def get_production(project_id: str) -> dict[str, Any]:
    """Episode production document: script, analysis, review gate, readiness."""
    store = get_video_studio_store()
    _project(project_id)
    from knorvia.services.video_studio.production import production_readiness

    payload = store.get_production(project_id)
    payload["readiness"] = production_readiness(
        payload["production"],
        characters=store.list_characters(project_id),
        shots=store.get_storyboard(project_id).get("shots") or [],
    )
    return payload


@router.put("/projects/{project_id}/production")
async def put_production(project_id: str, payload: ProductionSave) -> dict[str, Any]:
    store = get_video_studio_store()
    _project(project_id)
    try:
        saved = store.save_production(project_id, payload.production)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    from knorvia.services.video_studio.production import production_readiness

    saved["readiness"] = production_readiness(
        saved["production"],
        characters=store.list_characters(project_id),
        shots=store.get_storyboard(project_id).get("shots") or [],
    )
    return saved


@router.post("/projects/{project_id}/production/analyze")
async def analyze_production(project_id: str) -> dict[str, Any]:
    """Parse the stored script into scenes, cast, and shot drafts. Free."""
    store = get_video_studio_store()
    _project(project_id)
    from knorvia.services.video_studio.production import analyze_script, normalize_production

    current = store.get_production(project_id)["production"]
    try:
        analysis = analyze_script(
            current["script"]["text"],
            title=current["script"].get("title") or "",
            language=current["script"].get("language") or "",
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    current["analysis"] = analysis
    current["stage"] = "review"
    current["review"]["status"] = "draft"
    current["review"]["confirmed_at"] = None
    saved = store.save_production(project_id, normalize_production(current))
    from knorvia.services.video_studio.production import production_readiness

    saved["readiness"] = production_readiness(
        saved["production"],
        characters=store.list_characters(project_id),
        shots=store.get_storyboard(project_id).get("shots") or [],
    )
    return saved


@router.post("/projects/{project_id}/production/confirm")
async def confirm_production(project_id: str, payload: ProductionReviewBody) -> dict[str, Any]:
    """Human review gate. Required before applying analysis to the storyboard."""
    store = get_video_studio_store()
    _project(project_id)
    import time

    from knorvia.services.video_studio.production import confirm_review, production_readiness

    try:
        production = confirm_review(
            store.get_production(project_id)["production"],
            notes=payload.notes,
            now=time.time(),
        )
        saved = store.save_production(project_id, production)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    saved["readiness"] = production_readiness(
        saved["production"],
        characters=store.list_characters(project_id),
        shots=store.get_storyboard(project_id).get("shots") or [],
    )
    return saved


@router.post("/projects/{project_id}/production/reopen")
async def reopen_production(project_id: str, payload: ProductionReviewBody) -> dict[str, Any]:
    store = get_video_studio_store()
    _project(project_id)
    from knorvia.services.video_studio.production import production_readiness, reopen_review

    production = reopen_review(
        store.get_production(project_id)["production"],
        notes=payload.notes,
    )
    saved = store.save_production(project_id, production)
    saved["readiness"] = production_readiness(
        saved["production"],
        characters=store.list_characters(project_id),
        shots=store.get_storyboard(project_id).get("shots") or [],
    )
    return saved


@router.post("/projects/{project_id}/production/apply")
async def apply_production_endpoint(
    project_id: str, payload: ProductionApplyBody
) -> dict[str, Any]:
    """Write confirmed analysis into the storyboard and character library. Free."""
    store = get_video_studio_store()
    _project(project_id)
    from knorvia.services.video_studio.production import apply_production, production_readiness

    try:
        result = apply_production(
            store,
            project_id,
            replace=payload.replace,
            place_on_board=payload.place_on_board,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    result["readiness"] = production_readiness(
        result["production"],
        characters=store.list_characters(project_id),
        shots=(result.get("storyboard") or {}).get("shots") or [],
    )
    return result


@router.delete("/projects/{project_id}")
async def delete_project(project_id: str) -> dict[str, bool]:
    _project(project_id)
    try:
        return {"deleted": get_video_studio_store().delete_project(project_id)}
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.get("/projects/{project_id}/storyboard")
async def get_storyboard(project_id: str) -> dict[str, Any]:
    _project(project_id)
    return get_video_studio_store().get_storyboard(project_id)


@router.put("/projects/{project_id}/storyboard")
async def put_storyboard(
    project_id: str, request: Request, payload: dict[str, Any]
) -> dict[str, Any]:
    _project(project_id)
    revision = _expected_revision(request, payload)
    try:
        return get_video_studio_store().save_storyboard(
            project_id, payload, expected_revision=revision
        )
    except StoryboardConflictError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "storyboard_revision_conflict",
                "message": str(exc),
                "expected_revision": exc.expected_revision,
                "current_revision": exc.current_revision,
            },
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/projects/{project_id}/storyboard/shots/{shot_id}/jobs")
async def list_shot_jobs(project_id: str, shot_id: str) -> dict[str, Any]:
    """§Phase C5 read-only variant history: every job bound to this shot."""
    store = get_video_studio_store()
    _project(project_id)
    board = store.get_storyboard(project_id)
    if not any(shot.get("id") == shot_id for shot in board["shots"]):
        raise HTTPException(status_code=404, detail="Storyboard shot not found")
    return {"jobs": store.list_shot_jobs(project_id, shot_id)}


@router.post("/projects/{project_id}/storyboard/shots/{shot_id}/bind-job")
async def bind_shot_job(project_id: str, shot_id: str, payload: ShotJobBind) -> dict[str, Any]:
    """§Phase C5: make one historical variant the shot's current take.

    Reuses the worker's own binding path, so a running variant finishes into
    the shot automatically and a succeeded variant republishes its output
    immediately. Free — no provider call, no cost confirmation.
    """
    store = get_video_studio_store()
    _project(project_id)
    board = store.get_storyboard(project_id)
    if not any(shot.get("id") == shot_id for shot in board["shots"]):
        raise HTTPException(status_code=404, detail="Storyboard shot not found")
    job = store.get_job(payload.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Video job not found")
    if job["project_id"] != project_id:
        raise HTTPException(status_code=422, detail="Video job belongs to a different project")
    if job.get("storyboard_shot_id") != shot_id:
        raise HTTPException(status_code=422, detail="Video job was not generated for this shot")
    try:
        store.patch_storyboard_shot_job(project_id, shot_id, payload.job_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    outputs = job.get("output_asset_ids") or []
    if outputs:
        store.patch_storyboard_job_output(project_id, payload.job_id, str(outputs[0]))
    updated = store.get_storyboard(project_id)
    shot = next((item for item in updated["shots"] if item.get("id") == shot_id), None)
    return {"shot": shot}


@router.post("/projects/{project_id}/storyboard/shots/{shot_id}/keyframe", status_code=201)
async def create_shot_keyframe_endpoint(
    project_id: str, shot_id: str, payload: ShotKeyframeCreate
) -> dict[str, Any]:
    """Generate one shot's first-frame image through the paid imagegen channel."""
    _project(project_id)
    try:
        return await create_shot_keyframe(
            get_video_studio_store(),
            project_id=project_id,
            shot_id=shot_id,
            prompt=payload.prompt or "",
            profile_id=payload.profile_id,
            model_id=payload.model_id,
            size=payload.size,
            aspect_ratio=payload.aspect_ratio,
            confirmed_cost=payload.confirmed_cost,
        )
    except PermissionError as exc:
        status = 409 if "confirmation" in str(exc).lower() else 403
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/projects/{project_id}/storyboard/shots/{shot_id}/voiceover", status_code=201)
async def create_shot_voiceover_endpoint(
    project_id: str, shot_id: str, payload: ShotVoiceoverCreate
) -> dict[str, Any]:
    """Synthesize one shot's narration through the shared TTS pipeline."""
    _project(project_id)
    try:
        return await create_shot_voiceover(
            get_video_studio_store(),
            project_id=project_id,
            shot_id=shot_id,
            text=payload.text,
            voice=payload.voice,
            response_format=payload.format,
            confirmed_cost=payload.confirmed_cost,
        )
    except PermissionError as exc:
        status = 409 if "confirmation" in str(exc).lower() else 403
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.get("/projects/{project_id}/characters")
async def list_characters(project_id: str) -> dict[str, Any]:
    """List the project's character library (cross-shot identity anchors)."""
    _project(project_id)
    return {"characters": get_video_studio_store().list_characters(project_id)}


@router.post("/projects/{project_id}/characters", status_code=201)
async def create_character(project_id: str, payload: CharacterCreate) -> dict[str, Any]:
    _project(project_id)
    store = get_video_studio_store()
    try:
        character = store.create_character(
            project_id,
            name=payload.name,
            description=payload.description,
            reference_asset_ids=payload.reference_asset_ids,
            voice_hint=payload.voice_hint,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"character": character}


@router.patch("/projects/{project_id}/characters/{character_id}")
async def update_character(
    project_id: str, character_id: str, payload: CharacterUpdate
) -> dict[str, Any]:
    _project(project_id)
    store = get_video_studio_store()
    try:
        character = store.update_character(
            project_id,
            character_id,
            name=payload.name,
            description=payload.description,
            reference_asset_ids=payload.reference_asset_ids,
            voice_hint=payload.voice_hint,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if character is None:
        raise HTTPException(status_code=404, detail="Character not found")
    return {"character": character}


@router.delete("/projects/{project_id}/characters/{character_id}", status_code=204)
async def delete_character(project_id: str, character_id: str) -> None:
    _project(project_id)
    if not get_video_studio_store().delete_character(project_id, character_id):
        raise HTTPException(status_code=404, detail="Character not found")


@router.post("/projects/{project_id}/characters/{character_id}/three-view", status_code=201)
async def create_character_three_view_endpoint(
    project_id: str, character_id: str, payload: CharacterThreeViewCreate
) -> dict[str, Any]:
    """Generate a character's three-view sheet through the paid imagegen channel."""
    _project(project_id)
    from knorvia.services.video_studio.service import create_character_three_view

    try:
        return await create_character_three_view(
            get_video_studio_store(),
            project_id=project_id,
            character_id=character_id,
            prompt=payload.prompt or "",
            profile_id=payload.profile_id,
            model_id=payload.model_id,
            size=payload.size,
            aspect_ratio=payload.aspect_ratio,
            confirmed_cost=payload.confirmed_cost,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Character not found") from exc
    except PermissionError as exc:
        status = 409 if "confirmation" in str(exc).lower() else 403
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/projects/{project_id}/compose", status_code=202)
async def compose_project_endpoint(project_id: str, payload: ComposeCreate) -> dict[str, Any]:
    """Queue a local, free MP4 composition of the storyboard shots."""
    _project(project_id)
    try:
        get_ffmpeg_tool().ensure()
    except FFmpegUnavailableError as exc:
        raise HTTPException(
            status_code=409,
            detail={"code": "ffmpeg_unavailable", "message": str(exc)},
        ) from exc
    try:
        return compose_project(
            get_video_studio_store(),
            project_id=project_id,
            # exclude_unset keeps "key absent" distinguishable from "key set to
            # the default", which the §Phase D3 BGM fallback relies on: an
            # absent bgm_asset_id inherits the project slot, an explicit "" —
            # or asset id — overrides it for this composition.
            request=payload.model_dump(exclude_unset=True),
            client_request_id=payload.client_request_id,
        )
    except VideoStudioQueueFullError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/projects/{project_id}/compositions")
async def list_project_compositions(project_id: str, limit: int = 50) -> dict[str, Any]:
    _project(project_id)
    page_size = min(max(int(limit), 1), 100)
    compositions = list_compositions(get_video_studio_store(), project_id, limit=page_size)
    return {"compositions": compositions}


@router.post("/projects/{project_id}/subtitle-assets", status_code=201)
async def create_subtitle_asset(project_id: str, payload: SubtitleDocumentSave) -> dict[str, Any]:
    """Save an SRT document from the subtitle editor as a project asset."""
    _project(project_id)
    try:
        asset = get_video_studio_store().save_subtitle_document(
            project_id,
            payload.content,
            filename=payload.filename or "subtitles.srt",
            origin="edited",
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Video project not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"asset": asset}


@router.put("/assets/{asset_id}/subtitle")
async def update_subtitle_asset(asset_id: str, payload: SubtitleDocumentSave) -> dict[str, Any]:
    """Overwrite an existing subtitle asset in place (editor re-save)."""
    store = get_video_studio_store()
    if not store.get_asset(asset_id):
        raise HTTPException(status_code=404, detail="Video asset not found")
    try:
        asset = store.replace_subtitle_document(asset_id, payload.content)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"asset": asset}


def _expected_board_revision(request: Request, payload: dict[str, Any]) -> int | None:
    """Board CAS key: If-Match header or document revision. None = first write."""
    raw: Any = request.headers.get("if-match")
    if raw is None:
        raw = payload.get("revision")
    if raw is None:
        return None
    text = str(raw).strip()
    if text.startswith("W/"):
        text = text[2:].strip()
    try:
        value = int(text.strip('"'))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="Invalid board revision") from exc
    if value < 0:
        raise HTTPException(status_code=422, detail="Invalid board revision")
    return value


@router.get("/projects/{project_id}/board")
async def get_board(project_id: str) -> dict[str, Any]:
    _project(project_id)
    return get_video_studio_store().get_board(project_id)


@router.put("/projects/{project_id}/board")
async def put_board(project_id: str, request: Request, payload: dict[str, Any]) -> dict[str, Any]:
    _project(project_id)
    expected_revision = _expected_board_revision(request, payload)
    try:
        return get_video_studio_store().save_board(
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


@router.post("/projects/{project_id}/board/templates/{template_id}")
async def place_board_template(project_id: str, template_id: str) -> dict[str, Any]:
    """Place a §5.5 template fragment on the canvas. Never creates jobs."""
    _project(project_id)
    if template_id not in BOARD_TEMPLATE_IDS:
        raise HTTPException(status_code=404, detail="Unknown board template")
    store = get_video_studio_store()
    try:
        return await asyncio.to_thread(
            store.update_board,
            project_id,
            lambda document: place_template(document, template_id),
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/projects/{project_id}/board/import-storyboard")
async def import_storyboard_to_board(
    project_id: str, payload: BoardStoryboardImport | None = None
) -> dict[str, Any]:
    """Turn storyboard shots into a row of generate nodes (§7.3, one-way)."""
    _project(project_id)
    store = get_video_studio_store()
    shots = store.get_storyboard(project_id)["shots"]
    force = bool(payload.force) if payload is not None else False
    counts = {"imported": 0, "skipped": 0}

    def mutator(document: dict[str, Any]) -> None:
        counts["imported"], counts["skipped"] = import_storyboard_shots(
            document, shots, force=force
        )

    try:
        board = await asyncio.to_thread(store.update_board, project_id, mutator)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"board": board, "imported": counts["imported"], "skipped": counts["skipped"]}


@router.post("/projects/{project_id}/board/export-storyboard")
async def export_board_to_storyboard(project_id: str) -> dict[str, Any]:
    """Append generate nodes that hold a prompt as storyboard shots (§7.3)."""
    _project(project_id)
    store = get_video_studio_store()
    board = store.get_board(project_id)
    exported = {"count": 0}

    def mutator(document: dict[str, Any]) -> None:
        room = MAX_STORYBOARD_SHOTS - len(document.get("shots") or [])
        if room <= 0:
            return
        shots, count = export_board_to_shots(board, max_shots=room)
        base = len(document.get("shots") or [])
        for index, shot in enumerate(shots):
            shot["order"] = base + index
            # A generate node can outlive its output asset (uploads are
            # deletable); drop the stale reference instead of failing export.
            asset_id = shot.get("output_asset_id")
            if asset_id:
                asset = store.get_asset(asset_id)
                if not asset or asset["project_id"] != project_id:
                    shot["output_asset_id"] = None
        document.setdefault("shots", []).extend(shots)
        exported["count"] = count

    try:
        storyboard = await asyncio.to_thread(store.update_storyboard, project_id, mutator)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"storyboard": storyboard, "exported": exported["count"]}


@router.get("/projects/{project_id}/export")
async def export_project(project_id: str) -> FileResponse:
    project = _project(project_id)
    try:
        path = await asyncio.to_thread(get_video_studio_store().export_project, project_id)
    except ValueError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    safe = re.sub(r"[^\w-]+", "_", str(project["title"]), flags=re.UNICODE).strip("_")
    return FileResponse(
        path,
        media_type="application/zip",
        filename=f"{safe or 'video-studio'}.zip",
        background=BackgroundTask(path.unlink, missing_ok=True),
    )


@router.post("/projects/{project_id}/uploads", status_code=201)
async def create_upload(project_id: str, payload: UploadCreate) -> dict[str, Any]:
    _project(project_id)
    if payload.mime_type not in MIME_LIMITS:
        raise HTTPException(status_code=422, detail="Unsupported media type")
    try:
        return get_video_studio_store().create_upload(
            project_id, payload.filename, payload.mime_type, payload.size, payload.sha256
        )
    except ValueError as exc:
        message = str(exc)
        status = 429 if "too many" in message.lower() or "quota" in message.lower() else 422
        raise HTTPException(status_code=status, detail=message) from exc


@router.put("/uploads/{upload_id}/parts/{index}", status_code=204)
async def upload_part(upload_id: str, index: int, request: Request) -> None:
    data = await _read_upload_chunk(request)
    try:
        await asyncio.to_thread(get_video_studio_store().write_upload_part, upload_id, index, data)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Video upload not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/uploads/{upload_id}/complete")
async def complete_upload(upload_id: str) -> dict[str, Any]:
    try:
        return await asyncio.to_thread(get_video_studio_store().complete_upload, upload_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Video upload not found") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.delete("/uploads/{upload_id}")
async def abort_upload(upload_id: str) -> dict[str, bool]:
    return {"aborted": get_video_studio_store().abort_upload(upload_id)}


@router.get("/projects/{project_id}/assets")
async def list_assets(
    project_id: str,
    kind: str = "",
    limit: int = 50,
    cursor: float | None = None,
) -> dict[str, Any]:
    _project(project_id)
    page_size = min(max(int(limit), 1), 100)
    assets = get_video_studio_store().list_assets(
        project_id, kind=kind, limit=page_size, before=cursor
    )
    return {
        "assets": assets,
        "next_cursor": assets[-1]["created_at"] if len(assets) == page_size else None,
    }


@router.get("/assets/{asset_id}")
async def get_asset(asset_id: str) -> dict[str, Any]:
    asset = get_video_studio_store().get_asset(asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Video asset not found")
    return asset


def _parse_range(value: str, size: int) -> tuple[int, int]:
    if not value.startswith("bytes=") or "," in value:
        raise ValueError
    raw = value[6:].strip()
    if "-" not in raw:
        raise ValueError
    first, last = raw.split("-", 1)
    if not first:
        length = int(last)
        if length <= 0:
            raise ValueError
        return max(0, size - length), size - 1
    start = int(first)
    end = int(last) if last else size - 1
    if start < 0 or start >= size or end < start:
        raise ValueError
    return start, min(end, size - 1)


def _file_chunks(path: Path, start: int, end: int):
    with path.open("rb") as handle:
        handle.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = handle.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


@router.api_route("/assets/{asset_id}/content", methods=["GET", "HEAD"])
async def video_asset_content(asset_id: str, request: Request) -> Response:
    store = get_video_studio_store()
    asset = store.get_asset(asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Video asset not found")
    path = store.asset_path(asset_id)
    size = path.stat().st_size
    headers = {"Accept-Ranges": "bytes", "Content-Type": asset["mime_type"]}
    raw_range = request.headers.get("range")
    if raw_range:
        try:
            start, end = _parse_range(raw_range, size)
        except (TypeError, ValueError):
            return Response(
                status_code=416,
                headers={**headers, "Content-Range": f"bytes */{size}", "Content-Length": "0"},
            )
        headers.update(
            {
                "Content-Range": f"bytes {start}-{end}/{size}",
                "Content-Length": str(end - start + 1),
            }
        )
        if request.method == "HEAD":
            return Response(status_code=206, headers=headers)
        return StreamingResponse(
            _file_chunks(path, start, end),
            status_code=206,
            media_type=asset["mime_type"],
            headers=headers,
        )
    headers["Content-Length"] = str(size)
    if request.method == "HEAD":
        return Response(status_code=200, headers=headers)
    return StreamingResponse(
        _file_chunks(path, 0, size - 1),
        status_code=200,
        media_type=asset["mime_type"],
        headers=headers,
    )


@router.get("/assets/{asset_id}/thumbnail")
async def asset_thumbnail(asset_id: str, t: float = 0.0) -> FileResponse:
    """§Phase F1: cached JPEG thumbnail (videos sample frame ``t``)."""
    if t < 0 or t > 3600:
        raise HTTPException(status_code=422, detail="Thumbnail timestamp is out of range")
    store = get_video_studio_store()
    asset = store.get_asset(asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Video asset not found")
    kind = str(asset.get("kind") or "")
    if kind not in {"image", "video"}:
        raise HTTPException(
            status_code=422,
            detail="Thumbnails are only available for image and video assets",
        )
    if kind == "video":
        try:
            get_ffmpeg_tool().ensure()
        except FFmpegUnavailableError as exc:
            raise HTTPException(
                status_code=409,
                detail={"code": "ffmpeg_unavailable", "message": str(exc)},
            ) from exc
    try:
        path = await ensure_asset_thumbnail(store, str(asset["project_id"]), asset_id, timestamp=t)
    except ThumbnailError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return FileResponse(
        path,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=86400"},
    )


@router.delete("/assets/{asset_id}")
async def delete_asset(asset_id: str) -> dict[str, bool]:
    store = get_video_studio_store()
    if not store.get_asset(asset_id):
        raise HTTPException(status_code=404, detail="Video asset not found")
    try:
        return {"deleted": store.delete_asset(asset_id)}
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/projects/{project_id}/jobs", status_code=202)
async def create_job(project_id: str, payload: JobCreate) -> dict[str, Any]:
    _project(project_id)
    if payload.inputs and payload.input_asset_ids:
        raise HTTPException(
            status_code=422, detail="Pass either input_asset_ids or inputs, not both"
        )
    try:
        return create_video_job(
            get_video_studio_store(),
            project_id=project_id,
            profile_id=payload.profile_id,
            model_id=payload.model_id,
            operation=payload.operation,
            prompt=payload.prompt,
            input_asset_ids=payload.input_asset_ids,
            inputs=[item.model_dump() for item in payload.inputs] or None,
            parameters=payload.parameters,
            client_request_id=payload.client_request_id,
            confirmed_cost=payload.confirmed_cost,
            storyboard_shot_id=payload.storyboard_shot_id,
            board_node_id=payload.board_node_id,
        )
    except PermissionError as exc:
        status = 409 if "confirmation" in str(exc).lower() else 403
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    except VideoStudioQueueFullError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except VideoStudioRetryConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/projects/{project_id}/jobs")
async def list_jobs(
    project_id: str,
    status: str = "",
    limit: int = 50,
    cursor: float | None = None,
) -> dict[str, Any]:
    _project(project_id)
    page_size = min(max(int(limit), 1), 100)
    jobs = get_video_studio_store().list_jobs(
        project_id, status=status, limit=page_size, before=cursor
    )
    return {
        "jobs": jobs,
        "next_cursor": jobs[-1]["created_at"] if len(jobs) == page_size else None,
    }


@router.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict[str, Any]:
    job = get_video_studio_store().get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Video job not found")
    return job


@router.get("/jobs/{job_id}/events")
async def job_events(job_id: str, after_seq: int = 0) -> dict[str, Any]:
    store = get_video_studio_store()
    if not store.get_job(job_id):
        raise HTTPException(status_code=404, detail="Video job not found")
    events = store.events_after(job_id, after_seq)
    return {"events": events, "next_seq": events[-1]["seq"] if events else max(0, after_seq)}


@router.post("/projects/{project_id}/jobs:follow")
async def follow_jobs(project_id: str, payload: JobFollowRequest) -> dict[str, Any]:
    """Batched snapshot + incremental events for every active workbench job."""
    _project(project_id)
    store = get_video_studio_store()
    jobs_out: dict[str, Any] = {}
    events_out: dict[str, Any] = {}
    for cursor in payload.jobs:
        job = store.get_job(cursor.job_id)
        if not job or job["project_id"] != project_id:
            continue
        jobs_out[cursor.job_id] = job
        events = store.events_after(cursor.job_id, cursor.after_seq)
        events_out[cursor.job_id] = {
            "events": events,
            "next_seq": events[-1]["seq"] if events else max(0, cursor.after_seq),
        }
    return {"jobs": jobs_out, "events": events_out}


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str) -> dict[str, bool]:
    store = get_video_studio_store()
    if not store.get_job(job_id):
        raise HTTPException(status_code=404, detail="Video job not found")
    return {"cancelled": cancel_video_job(store, job_id)}


@router.post("/jobs/{job_id}/retry", status_code=202)
async def retry_job(job_id: str, payload: RetryCreate) -> dict[str, Any]:
    store = get_video_studio_store()
    old = store.get_job(job_id)
    if not old:
        raise HTTPException(status_code=404, detail="Video job not found")
    if "storyboard_shot_id" in payload.model_fields_set:
        storyboard_shot_id = payload.storyboard_shot_id
    else:
        candidate = str(old.get("storyboard_shot_id") or "")
        board = store.get_storyboard(old["project_id"])
        storyboard_shot_id = (
            candidate
            if candidate and any(shot.get("id") == candidate for shot in board["shots"])
            else None
        )
    if "board_node_id" in payload.model_fields_set:
        board_node_id = payload.board_node_id
    else:
        candidate = str(old.get("board_node_id") or "")
        document = store.get_board(old["project_id"])
        board_node_id = (
            candidate
            if candidate
            and any(
                node.get("id") == candidate and node.get("kind") == "generate"
                for node in document.get("nodes") or []
            )
            else None
        )
    try:
        return create_video_job(
            store,
            project_id=old["project_id"],
            profile_id=old["profile_id"],
            model_id=old["model_id"],
            operation=old["operation"],
            prompt=old["prompt"],
            input_asset_ids=[],
            inputs=old.get("inputs") or None,
            parameters=old["parameters"],
            client_request_id=payload.client_request_id,
            confirmed_cost=payload.confirmed_cost,
            retry_of_job_id=job_id,
            storyboard_shot_id=storyboard_shot_id,
            board_node_id=board_node_id,
        )
    except PermissionError as exc:
        status = 409 if "confirmation" in str(exc).lower() else 403
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    except VideoStudioQueueFullError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except VideoStudioRetryConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/jobs/{job_id}/reroll", status_code=202)
async def reroll_job(job_id: str, payload: RerollCreate) -> dict[str, Any]:
    """§Phase C5 paid reroll: same parameters (camera included), fresh seed.

    Unlike retry — which is reserved for failed/cancelled/interrupted jobs and
    replays the exact request — a reroll deliberately asks for a *different*
    take of any job, so it never links through ``retry_of_job_id``. Lineage
    is the shot/node binding the new job inherits. Every reroll is
    one paid task and requires its own ``confirmed_cost``.
    """
    if payload.confirmed_cost is not True:
        # Same discipline as create_video_job: reject unconfirmed paid work
        # before any model lookup so the guard can never be bypassed by a
        # model/catalog error path.
        raise HTTPException(
            status_code=409,
            detail="Video generation requires explicit cost confirmation.",
        )
    store = get_video_studio_store()
    old = store.get_job(job_id)
    if not old:
        raise HTTPException(status_code=404, detail="Video job not found")
    if "storyboard_shot_id" in payload.model_fields_set:
        storyboard_shot_id = payload.storyboard_shot_id
    else:
        candidate = str(old.get("storyboard_shot_id") or "")
        board = store.get_storyboard(old["project_id"])
        storyboard_shot_id = (
            candidate
            if candidate and any(shot.get("id") == candidate for shot in board["shots"])
            else None
        )
    if "board_node_id" in payload.model_fields_set:
        board_node_id = payload.board_node_id
    else:
        candidate = str(old.get("board_node_id") or "")
        document = store.get_board(old["project_id"])
        board_node_id = (
            candidate
            if candidate
            and any(
                node.get("id") == candidate and node.get("kind") == "generate"
                for node in document.get("nodes") or []
            )
            else None
        )
    try:
        option = find_video_option(str(old["profile_id"]), str(old["model_id"]))
        parameters = reroll_parameters(old["parameters"], option.get("capabilities") or {})
        return create_video_job(
            store,
            project_id=old["project_id"],
            profile_id=old["profile_id"],
            model_id=old["model_id"],
            operation=old["operation"],
            prompt=old["prompt"],
            input_asset_ids=[],
            inputs=old.get("inputs") or None,
            parameters=parameters,
            client_request_id=payload.client_request_id,
            confirmed_cost=payload.confirmed_cost,
            storyboard_shot_id=storyboard_shot_id,
            board_node_id=board_node_id,
        )
    except PermissionError as exc:
        status = 409 if "confirmation" in str(exc).lower() else 403
        raise HTTPException(status_code=status, detail=str(exc)) from exc
    except VideoStudioQueueFullError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except VideoStudioRetryConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.websocket("/ws")
async def video_studio_ws(ws: WebSocket) -> None:
    from knorvia.api.routers.auth import ws_auth_failed, ws_require_auth
    from knorvia.multi_user.context import reset_current_user

    user_token = await ws_require_auth(ws)
    if user_token is ws_auth_failed:
        return
    await ws.accept()
    try:
        while True:
            try:
                message = json.loads(await ws.receive_text())
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
            try:
                after_seq = max(0, int(message.get("after_seq") or 0))
            except (TypeError, ValueError):
                after_seq = 0
            store = get_video_studio_store()
            if not store.get_job(job_id):
                await ws.send_json({"type": "error", "message": "Video job not found"})
                continue
            while True:
                events = store.events_after(job_id, after_seq)
                for event in events:
                    after_seq = event["seq"]
                    await ws.send_json({"type": "job_event", "job_id": job_id, "event": event})
                job = store.get_job(job_id)
                if not job or job["status"] in {
                    "succeeded",
                    "failed",
                    "cancelled",
                    "interrupted",
                }:
                    await ws.send_json(
                        {"type": "subscription.complete", "job_id": job_id, "after_seq": after_seq}
                    )
                    break
                await asyncio.sleep(0.5)
    except WebSocketDisconnect:
        pass
    finally:
        if user_token is not None:
            reset_current_user(user_token)


__all__ = ["router"]
