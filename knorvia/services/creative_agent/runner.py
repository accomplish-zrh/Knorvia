"""Start Create jobs and canvas runs through the existing studios."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from knorvia.multi_user.model_access import allowed_videogen_options
from knorvia.services.creative_library.store import (
    CreativeLibraryStore,
    get_creative_library_store,
)
from knorvia.services.image_studio.agent import (
    list_usable_models,
    plan_studio_job,
    project_for_session,
)
from knorvia.services.image_studio.engine import capture_job_authorization, start_job
from knorvia.services.image_studio.store import ImageStudioStore, get_image_studio_store
from knorvia.services.video_studio.service import create_agent_video_job
from knorvia.services.video_studio.store import VideoStudioStore, get_video_studio_store

from .handoff import import_library_asset_to_image, import_library_asset_to_video
from .ops import apply_image_ops, apply_video_ops, generate_targets, plan_image_ops, plan_video_ops
from .planning import (
    build_internal_brief,
    infer_creation_mode,
    parse_custom_pixels,
    public_create_reply,
)


def _split_model_key(value: str) -> tuple[str, str]:
    text = str(value or "")
    if "::" in text:
        profile_id, model_id = text.split("::", 1)
        return profile_id, model_id
    if ":" in text:
        profile_id, model_id = text.split(":", 1)
        return profile_id, model_id
    if "/" in text:
        profile_id, model_id = text.split("/", 1)
        return profile_id, model_id
    return "", text


def _default_image_model(profile_id: str = "", model_id: str = "") -> dict[str, Any]:
    options = list_usable_models()
    if not options:
        raise ValueError("No image model is assigned to this account.")
    if profile_id and model_id:
        named = next(
            (
                item
                for item in options
                if item.get("profile_id") == profile_id and item.get("model_id") == model_id
            ),
            None,
        )
        if named:
            return named
    return next((item for item in options if item.get("is_active_default")), options[0])


def _default_video_model(profile_id: str = "", model_id: str = "") -> dict[str, Any]:
    options = list(allowed_videogen_options().get("options") or [])
    if not options:
        raise ValueError("No video model is assigned to this account.")
    if profile_id and model_id:
        named = next(
            (
                item
                for item in options
                if item.get("profile_id") == profile_id and item.get("model_id") == model_id
            ),
            None,
        )
        if named:
            return named
    return next((item for item in options if item.get("is_active_default")), options[0])


def _incoming(board: dict[str, Any], node_id: str) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    nodes = {str(node.get("id")): node for node in board.get("nodes") or []}
    rows: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for edge in board.get("edges") or []:
        if str(edge.get("to") or "") != node_id:
            continue
        source = nodes.get(str(edge.get("from") or ""))
        if source:
            rows.append((source, edge))
    return rows


def _start_image_job(
    store: ImageStudioStore,
    project_id: str,
    *,
    prompt: str,
    model: dict[str, Any],
    input_asset_ids: list[str],
    mask_asset_id: str | None,
    parameters: dict[str, Any],
    target_node_id: str | None = None,
    language: str = "en",
) -> dict[str, Any]:
    plan = plan_studio_job(
        prompt=prompt,
        operation="edit" if input_asset_ids else "generate",
        n=int(parameters.get("n") or 1),
        size=str(parameters.get("size") or ""),
        aspect_ratio=str(parameters.get("aspect_ratio") or ""),
        target_resolution=str(parameters.get("target_resolution") or ""),
        quality=str(parameters.get("quality") or ""),
        profile_id=str(model.get("profile_id") or ""),
        model_id=str(model.get("model_id") or ""),
        input_asset_ids=input_asset_ids,
        mask_asset_id=mask_asset_id,
        options=[model],
        language=language,
    )
    authorization = capture_job_authorization(plan["profile_id"], plan["model_id"])
    job = store.create_job(
        project_id,
        {
            "operation": plan["operation"],
            "profile_id": plan["profile_id"],
            "model_id": plan["model_id"],
            "prompt": plan["prompt"],
            "input_asset_ids": plan["input_asset_ids"],
            "mask_asset_id": plan.get("mask_asset_id"),
            "parameters": plan["parameters"],
            **authorization,
        },
    )
    if target_node_id:
        store.update_board(
            project_id,
            lambda board: _mark_node(board, target_node_id, job["id"], "running"),
        )
    start_job(store, job["id"])
    return job


def _mark_node(board: dict[str, Any], node_id: str, job_id: str, status: str) -> None:
    for node in board.get("nodes") or []:
        if node.get("id") == node_id:
            node["jobId"] = job_id
            node["status"] = status
            return


def submit_create_generation(
    *,
    conversation_id: str | None,
    prompt: str,
    mode: str = "agent",
    language: str = "en",
    model_key: str = "",
    smart_planning: bool = True,
    library_asset_ids: list[str] | None = None,
    first_frame_asset_id: str = "",
    last_frame_asset_id: str = "",
    preferences: dict[str, Any] | None = None,
    library: CreativeLibraryStore | None = None,
    image_store: ImageStudioStore | None = None,
    video_store: VideoStudioStore | None = None,
) -> dict[str, Any]:
    store = library or get_creative_library_store()
    prefs = dict(preferences or {})
    conversation = store.get_conversation(conversation_id) if conversation_id else None
    if conversation is None:
        conversation = store.create_conversation(prompt[:80] or "New creation")
    conversation_id = str(conversation["id"])
    first_id = first_frame_asset_id or str(prefs.get("first_frame_asset_id") or "")
    last_id = last_frame_asset_id or str(prefs.get("last_frame_asset_id") or "")
    refs = [item for item in (library_asset_ids or prefs.get("library_asset_ids") or []) if item]
    resolved_mode = infer_creation_mode(
        prompt,
        mode,
        has_video_ref=any((store.get_asset(item) or {}).get("kind") == "video" for item in refs),
        has_last_frame=bool(last_id),
    )
    brief = build_internal_brief(
        prompt,
        mode=resolved_mode,
        language=language,
        reference_ids=refs,
        smart_planning=smart_planning,
        first_frame_id=first_id,
        last_frame_id=last_id,
    )
    user_message = store.add_message(
        conversation_id,
        role="user",
        content=prompt,
        mode=resolved_mode,
        prefs={**prefs, "library_asset_ids": refs, "model_key": model_key},
        brief={},
    )
    profile_id, model_id = _split_model_key(model_key)
    session_key = f"create:{conversation_id}"
    job: dict[str, Any]
    if resolved_mode == "video":
        vstore = video_store or get_video_studio_store()
        resolver = getattr(vstore, "resolve_workspace_project", None)
        if callable(resolver):
            project = resolver(
                session_key,
                title=f"Create · {conversation_id[:48]}",
                legacy_title=f"Create · {conversation_id[:16]}",
            )
        else:
            project = vstore.project_for_session(
                session_key,
                title=f"Create · {conversation_id[:48]}",
            )
        inputs: list[dict[str, str]] = []
        for asset_id in refs:
            imported = import_library_asset_to_video(store, vstore, project["id"], asset_id)
            role = "reference"
            if asset_id == first_id:
                role = "first-frame"
            elif asset_id == last_id:
                role = "last-frame"
            elif imported.get("kind") == "video":
                role = "continue-from"
            inputs.append({"asset_id": imported["id"], "role": role})
        model = _default_video_model(profile_id, model_id)
        operation = (
            "image_to_video"
            if any(item["role"] == "first-frame" for item in inputs)
            else "text_to_video"
        )
        if last_id and not first_id:
            raise ValueError("A last-frame reference also needs a first frame")
        parameters = {
            "aspect_ratio": prefs.get("aspect_ratio") or "",
            "resolution": prefs.get("resolution") or "",
            "duration": prefs.get("duration") or prefs.get("seconds") or "",
            "reference_mode": prefs.get("reference_mode")
            or ("first-last" if last_id else "first-frame" if first_id else "auto"),
        }
        parameters = {key: value for key, value in parameters.items() if value not in {"", None}}
        job = create_agent_video_job(
            store=vstore,
            project_id=project["id"],
            profile_id=str(model["profile_id"]),
            model_id=str(model["model_id"]),
            operation=operation,
            prompt=prompt,
            input_asset_ids=None,
            inputs=inputs,
            parameters=parameters,
            client_request_id=f"create-{uuid4().hex}",
            confirmed_cost=True,
        )
        studio = "video"
        project_id = project["id"]
    else:
        istore = image_store or get_image_studio_store()
        project = project_for_session(istore, session_key)
        inputs_ids: list[str] = []
        for asset_id in refs:
            imported = import_library_asset_to_image(store, istore, project["id"], asset_id)
            if imported["id"] not in inputs_ids:
                inputs_ids.append(imported["id"])
        model = _default_image_model(profile_id, model_id)
        pixels = parse_custom_pixels(str(prefs.get("custom_pixels") or ""))
        parameters = {
            "n": int(prefs.get("n") or 1),
            "aspect_ratio": prefs.get("aspect_ratio") or "",
            "quality": prefs.get("quality") or "",
            "target_resolution": prefs.get("target_resolution") or "",
            "size": f"{pixels[0]}x{pixels[1]}" if pixels else (prefs.get("size") or ""),
        }
        job = _start_image_job(
            istore,
            project["id"],
            prompt=prompt,
            model=model,
            input_asset_ids=inputs_ids,
            mask_asset_id=None,
            parameters=parameters,
            language=language,
        )
        studio = "image"
        project_id = project["id"]
    public_job = {
        "studio": studio,
        "project_id": project_id,
        "job_id": job.get("id"),
        "status": job.get("status") or "queued",
    }
    if not conversation.get("title") or conversation.get("title") in {"New creation", "新的创作"}:
        store.touch_conversation(conversation_id, prompt[:80])
    assistant = store.add_message(
        conversation_id,
        role="assistant",
        content=public_create_reply(mode=resolved_mode, language=language, job=job),
        mode=resolved_mode,
        prefs={"model_key": model_key},
        brief=brief,
        job=public_job,
    )
    return {
        "conversation": store.get_conversation(conversation_id),
        "user_message": user_message,
        "assistant_message": assistant,
        "job": public_job,
    }


def run_canvas(
    *,
    studio: str,
    project_id: str,
    prompt: str,
    language: str = "en",
    selected_ids: list[str] | None = None,
    model_key: str = "",
    smart_planning: bool = True,
    preferences: dict[str, Any] | None = None,
    library: CreativeLibraryStore | None = None,
    image_store: ImageStudioStore | None = None,
    video_store: VideoStudioStore | None = None,
) -> dict[str, Any]:
    prefs = dict(preferences or {})
    store = library or get_creative_library_store()
    surface = "video" if studio == "video" else "image"
    brief = build_internal_brief(
        prompt,
        mode=surface,
        language=language,
        smart_planning=smart_planning,
    )
    job_ids: list[str] = []
    try:
        if surface == "video":
            vstore = video_store or get_video_studio_store()
            board = vstore.get_board(project_id)
            ops = plan_video_ops(
                prompt,
                board,
                brief=brief,
                selected_ids=selected_ids,
                language=language,
                model_key=model_key,
                ratio=str(prefs.get("aspect_ratio") or ""),
                resolution=str(prefs.get("resolution") or ""),
                seconds=int(prefs["seconds"]) if prefs.get("seconds") else None,
                reference_mode=str(prefs.get("reference_mode") or ""),
            )

            def mutate(current: dict[str, Any]) -> None:
                next_board = apply_video_ops(current, ops)
                current.clear()
                current.update(next_board)

            vstore.update_board(project_id, mutate)
            board = vstore.get_board(project_id)
            profile_id, model_id = _split_model_key(model_key)
            model = _default_video_model(profile_id, model_id)
            for node_id in generate_targets(ops)[:1]:
                node = next(
                    (item for item in board.get("nodes") or [] if item.get("id") == node_id), None
                )
                if not node:
                    continue
                inputs = []
                for source, edge in _incoming(board, node_id):
                    asset_id = str(source.get("assetId") or source.get("outputAssetId") or "")
                    if not asset_id:
                        continue
                    inputs.append(
                        {"asset_id": asset_id, "role": str(edge.get("role") or "reference")}
                    )
                job = create_agent_video_job(
                    store=vstore,
                    project_id=project_id,
                    profile_id=str(model["profile_id"]),
                    model_id=str(model["model_id"]),
                    operation=str(node.get("operation") or "text_to_video"),
                    prompt=str(node.get("prompt") or prompt),
                    input_asset_ids=None,
                    inputs=inputs,
                    parameters={
                        key: value
                        for key, value in {
                            "aspect_ratio": node.get("ratio") or prefs.get("aspect_ratio"),
                            "resolution": node.get("resolution") or prefs.get("resolution"),
                            "duration": node.get("seconds") or prefs.get("seconds"),
                            "reference_mode": node.get("referenceMode")
                            or prefs.get("reference_mode"),
                        }.items()
                        if value not in {None, ""}
                    },
                    client_request_id=f"canvas-{uuid4().hex}",
                    confirmed_cost=True,
                    board_node_id=node_id,
                )
                job_ids.append(str(job.get("id") or ""))
        else:
            istore = image_store or get_image_studio_store()
            board = istore.get_board(project_id)
            pixels = parse_custom_pixels(str(prefs.get("custom_pixels") or ""))
            ops = plan_image_ops(
                prompt,
                board,
                brief=brief,
                selected_ids=selected_ids,
                language=language,
                model_key=model_key,
                ratio=str(prefs.get("aspect_ratio") or ""),
                quality=str(prefs.get("quality") or ""),
                custom_width=pixels[0] if pixels else None,
                custom_height=pixels[1] if pixels else None,
            )

            def mutate_image(current: dict[str, Any]) -> None:
                next_board = apply_image_ops(current, ops)
                current.clear()
                current.update(next_board)

            istore.update_board(project_id, mutate_image)
            board = istore.get_board(project_id)
            profile_id, model_id = _split_model_key(model_key)
            model = _default_image_model(profile_id, model_id)
            for node_id in generate_targets(ops)[:1]:
                inputs_ids: list[str] = []
                mask_id = None
                for source, edge in _incoming(board, node_id):
                    asset_id = str(source.get("assetId") or "")
                    if not asset_id:
                        continue
                    if str(edge.get("role") or "") == "mask":
                        mask_id = asset_id
                    elif asset_id not in inputs_ids:
                        inputs_ids.append(asset_id)
                job = _start_image_job(
                    istore,
                    project_id,
                    prompt=prompt,
                    model=model,
                    input_asset_ids=inputs_ids,
                    mask_asset_id=mask_id,
                    parameters={
                        "n": int(prefs.get("n") or 1),
                        "aspect_ratio": prefs.get("aspect_ratio") or "",
                        "quality": prefs.get("quality") or "",
                        "target_resolution": prefs.get("target_resolution") or "",
                    },
                    target_node_id=node_id,
                    language=language,
                )
                job_ids.append(str(job.get("id") or ""))
        run = store.create_canvas_run(
            studio=surface,
            project_id=project_id,
            prompt=prompt,
            ops=ops,
            brief=brief,
            job_ids=[item for item in job_ids if item],
            status="completed",
        )
    except Exception as exc:
        run = store.create_canvas_run(
            studio=surface,
            project_id=project_id,
            prompt=prompt,
            ops=[],
            brief=brief,
            job_ids=job_ids,
            status="failed",
            error_message=str(exc),
        )
        raise
    return run
