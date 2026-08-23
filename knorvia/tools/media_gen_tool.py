"""Image- and video-generation chat tools.

``imagegen`` is a thin BaseTool over Image Studio: plan, confirm, run, and
cancel all go through ``knorvia.services.image_studio.agent`` so model grants,
parameter allow-lists, assets, and upscale stay on the same path as the UI.
``videogen`` plans and confirms one durable Video Studio job, then returns the
queued job immediately while the studio runner owns provider polling, output
archival, cancellation, and recovery.

Generated files are written into the turn's public workspace and returned as
artifacts — the same ``collect_public_artifacts`` convention as exec /
code_execution, so they surface in chat as cards and can be cited by filename.

Mounting & gating (set by the chat pipeline, not here):

* User-toggleable in /settings/tools, so per-user ``enabled_tools`` grants apply.
* ``imagegen`` mounts when the account has at least one granted image model.
* ``videogen`` mounts only when the account has at least one granted video model.
* ``_workspace_dir`` / ``_session_id`` / ``_chat_attachments`` are injected
  server-side by ``_augment_tool_kwargs``; the LLM supplies the prompt and knobs.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
from pathlib import Path
import re
from typing import TYPE_CHECKING, Any
import uuid

from knorvia.core.tool_protocol import BaseTool, ToolDefinition, ToolParameter, ToolResult

if TYPE_CHECKING:
    from knorvia.services.sandbox.artifacts import SandboxArtifact

logger = logging.getLogger(__name__)

_EXT_BY_CONTENT_TYPE = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
}


def _studio_confirmation_fingerprint(
    planned: list[tuple[str | None, dict[str, Any]]],
) -> str:
    """Return a stable digest for the exact costly operation the user approved.

    The digest excludes display-only copy and includes every field that can
    change the provider request or canvas destination. It is not a secret; it
    binds a server-issued one-shot approval to one immutable plan.
    """

    rows: list[dict[str, Any]] = []
    for node_id, plan in planned:
        rows.append(
            {
                "target_node_id": node_id or None,
                "operation": plan.get("operation"),
                "profile_id": plan.get("profile_id"),
                "model_id": plan.get("model_id"),
                "prompt": plan.get("prompt"),
                "input_asset_ids": list(plan.get("input_asset_ids") or []),
                "mask_asset_id": plan.get("mask_asset_id"),
                "parent_job_id": plan.get("parent_job_id"),
                "parameters": dict(plan.get("parameters") or {}),
            }
        )
    canonical = json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _video_confirmation_fingerprint(plan: dict[str, Any]) -> str:
    """Bind a one-shot user approval to one exact paid video request."""

    canonical = json.dumps(
        {
            "project_id": plan.get("project_id"),
            "profile_id": plan.get("profile_id"),
            "model_id": plan.get("model_id"),
            "operation": plan.get("operation"),
            "prompt": plan.get("prompt"),
            "input_asset_ids": list(plan.get("input_asset_ids") or []),
            "parameters": dict(plan.get("parameters") or {}),
            "board_node_id": plan.get("board_node_id") or None,
            "storyboard_shot_id": plan.get("storyboard_shot_id") or None,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _import_video_chat_images(
    store: Any,
    project_id: str,
    attachments: list[dict[str, Any]],
    *,
    maximum: int,
) -> tuple[list[str], int]:
    """Copy server-resolved chat images into the current Video Studio project.

    Only inline/local attachment bytes and same-user Image Studio assets are
    accepted.  The Video Studio store performs MIME sniffing, image validation,
    and quota enforcement before returning an asset id.
    """

    from knorvia.services.image_studio.agent import decode_attachment
    from knorvia.services.image_studio.store import get_image_studio_store

    imported: list[str] = []
    rejected = 0
    allowed_mimes = {"image/png", "image/jpeg", "image/webp"}
    image_store = None
    for attachment in attachments:
        if len(imported) >= max(0, maximum):
            break
        data: bytes | None = None
        mime = str(attachment.get("mime_type") or "").split(";", 1)[0].strip().lower()
        filename = str(attachment.get("filename") or "reference.png")
        studio_asset_id = str(attachment.get("studio_asset_id") or "")
        try:
            if studio_asset_id:
                image_store = image_store or get_image_studio_store()
                source = image_store.get_asset(studio_asset_id)
                if source:
                    mime = str(source.get("mime") or mime).split(";", 1)[0].lower()
                    path = image_store.asset_path(studio_asset_id)
                    data = path.read_bytes()
                    filename = filename or path.name
            if data is None:
                decoded = decode_attachment(attachment)
                if decoded:
                    data, decoded_mime = decoded
                    if mime not in allowed_mimes:
                        mime = decoded_mime.split(";", 1)[0].strip().lower()
            if not data or mime not in allowed_mimes:
                rejected += 1
                continue
            asset = store.import_asset_bytes(project_id, data, mime, filename)
            asset_id = str(asset.get("id") or "")
            if not asset_id:
                rejected += 1
                continue
            imported.append(asset_id)
        except (KeyError, OSError, ValueError):
            logger.info("Could not import a chat image into Video Studio", exc_info=True)
            rejected += 1
    return imported, rejected


def _slug(prompt: str, fallback: str) -> str:
    """Short ascii filename stem from a prompt; ``fallback`` when none survives."""
    words = re.findall(r"[A-Za-z0-9]+", prompt.lower())
    stem = "_".join(words[:6])[:40]
    return stem or fallback


def _ext(content_type: str, default: str) -> str:
    return _EXT_BY_CONTENT_TYPE.get((content_type or "").split(";")[0].strip(), default)


def _run_dir(injected: str | None, kind: str) -> Path:
    """A fresh per-call dir under the public outputs root.

    Uses the pipeline-injected workspace when present; falls back to the same
    public chat media workspace for direct/tool-test calls. Per-call subdir
    keeps ``collect_public_artifacts`` scoped to this call's files only.
    """
    if injected:
        base = Path(injected)
    else:
        from knorvia.services.path_service import get_path_service

        base = get_path_service().get_task_workspace("chat", "media_gen") / "media"
    run = base / f"{kind}_{uuid.uuid4().hex[:12]}"
    run.mkdir(parents=True, exist_ok=True)
    return run


def _write_media(
    run_dir: Path,
    media: list[tuple[bytes, str]],
    *,
    stem: str,
    default_ext: str,
) -> list[SandboxArtifact]:
    """Write generated bytes to ``run_dir`` and return their public artifacts."""
    from knorvia.services.sandbox.artifacts import collect_public_artifacts

    multiple = len(media) > 1
    for index, (data, content_type) in enumerate(media, start=1):
        suffix = f"_{index}" if multiple else ""
        filename = f"{stem}{suffix}.{_ext(content_type, default_ext)}"
        (run_dir / filename).write_bytes(data)
    return collect_public_artifacts(str(run_dir))


def _artifact_result(
    artifacts: list[SandboxArtifact], *, empty_message: str, **meta: Any
) -> ToolResult:
    from knorvia.services.sandbox.artifacts import render_artifacts_for_tool

    if not artifacts:
        return ToolResult(content=empty_message, success=False)
    rows = [artifact.to_dict() for artifact in artifacts]
    return ToolResult(
        content=render_artifacts_for_tool(artifacts),
        sources=[
            {
                "type": "artifact",
                "filename": row["filename"],
                "url": row["url"],
                "path": row["path"],
                "mime_type": row["mime_type"],
                "size_bytes": row["size_bytes"],
            }
            for row in rows
        ],
        metadata={"artifacts": rows, **meta},
    )


class ImagegenTool(BaseTool):
    """Create or revise images through Image Studio (never the raw provider)."""

    def get_prompt_hints(self, language: str = "en"):
        from knorvia.tools.prompting import load_prompt_hints

        return load_prompt_hints(self.name, language=language)

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="imagegen",
            description=(
                "Create or revise images through Image Studio using an assigned "
                "image model. Choose generate, edit, inpaint (local redraw), or "
                "enhance (1K/2K/4K). Results land on the session's Image Studio "
                "canvas. Use board_node_id to fill a specific card, iterate_from "
                "to branch a new generate card from an existing image, or "
                "template=three-view (also product-set, picture-book) to stamp "
                "that graph. list_board=true lists current cards and ids. The "
                "tool picks a capable configured model and shows the files in "
                "chat. After calling, refer to each image by its exact filename. "
                "For 2K/4K, multiple outputs, inpaint, or a multi-card template, "
                "the tool pauses for the user's confirmation and then resumes. "
                "To stop a running job, pass cancel_job_id. For later edits, pass "
                "input_asset_ids, parent_job_id, board_node_id, or iterate_from."
            ),
            parameters=[
                ToolParameter(
                    name="prompt",
                    type="string",
                    description="What to create or how to change the image.",
                    required=False,
                ),
                ToolParameter(
                    name="operation",
                    type="string",
                    description="generate | edit | inpaint | enhance. Default generate.",
                    required=False,
                    default="generate",
                    enum=["generate", "edit", "inpaint", "enhance"],
                ),
                ToolParameter(
                    name="size",
                    type="string",
                    description="Optional WxH like '1024x1024'. Omit for the model default.",
                    required=False,
                ),
                ToolParameter(
                    name="aspect_ratio",
                    type="string",
                    description="Optional ratio like '16:9' when the model supports it.",
                    required=False,
                ),
                ToolParameter(
                    name="target_resolution",
                    type="string",
                    description="Native omit, or 1K / 2K / 4K for Image Studio upscale.",
                    required=False,
                ),
                ToolParameter(
                    name="n",
                    type="integer",
                    description="How many images to generate (1-4). Default 1.",
                    required=False,
                    default=1,
                ),
                ToolParameter(
                    name="input_asset_ids",
                    type="string",
                    description="Comma-separated Image Studio asset ids to edit or use as references.",
                    required=False,
                ),
                ToolParameter(
                    name="mask_asset_id",
                    type="string",
                    description="Image Studio mask asset id for inpaint / local redraw.",
                    required=False,
                ),
                ToolParameter(
                    name="parent_job_id",
                    type="string",
                    description="Previous Image Studio job id to generate variations from.",
                    required=False,
                ),
                ToolParameter(
                    name="image_profile_id",
                    type="string",
                    description="Optional Image Studio profile id. Omit to auto-select.",
                    required=False,
                ),
                ToolParameter(
                    name="model_id",
                    type="string",
                    description="Optional catalog model id. Omit to auto-select a capable model.",
                    required=False,
                ),
                ToolParameter(
                    name="cancel_job_id",
                    type="string",
                    description="Cancel this Image Studio job id instead of creating a new one.",
                    required=False,
                ),
                ToolParameter(
                    name="board_node_id",
                    type="string",
                    description="Place this job onto this Image Studio canvas node id (or unique title).",
                    required=False,
                ),
                ToolParameter(
                    name="iterate_from",
                    type="string",
                    description="Node id, unique title, or asset id to iterate from. Creates a linked generate card and edits that image.",
                    required=False,
                ),
                ToolParameter(
                    name="template",
                    type="string",
                    description="Stamp a canvas graph: three-view, product-set, or picture-book. With a prompt, also fill its generate cards.",
                    required=False,
                    enum=["three-view", "product-set", "picture-book"],
                ),
                ToolParameter(
                    name="list_board",
                    type="boolean",
                    description="If true, return the current canvas node ids without generating.",
                    required=False,
                ),
            ],
        )

    async def execute(self, **kwargs: Any) -> ToolResult:
        from knorvia.services.image_studio.agent import (
            cancel_studio_job,
            citation_lines,
            collect_input_asset_ids,
            plan_studio_job,
            project_for_session,
            run_studio_image_job,
        )
        from knorvia.services.image_studio.board import prepare_board_for_job, summarize_board
        from knorvia.services.image_studio.store import get_image_studio_store

        cancel_id = str(kwargs.get("cancel_job_id") or "").strip()
        if cancel_id:
            stopped = await cancel_studio_job(cancel_id)
            return ToolResult(
                content=(
                    f"Cancelled Image Studio job {cancel_id}."
                    if stopped
                    else f"Image Studio job {cancel_id} was already finished."
                ),
                success=True,
                metadata={"cancelled": stopped, "studio_job_id": cancel_id},
            )

        prompt = str(kwargs.get("prompt") or "").strip()
        try:
            count = int(kwargs.get("n") or 1)
        except (TypeError, ValueError):
            count = 1
        inputs = [
            part.strip()
            for part in str(kwargs.get("input_asset_ids") or "").split(",")
            if part.strip()
        ]
        mask_id = str(kwargs.get("mask_asset_id") or "").strip() or None
        operation = str(kwargs.get("operation") or "generate").strip().lower()
        attachments = [
            item for item in (kwargs.get("_chat_attachments") or []) if isinstance(item, dict)
        ]
        store = get_image_studio_store()
        session_id = str(kwargs.get("_session_id") or "") or None
        language = str(kwargs.get("_language") or "en")
        parent_job_id = str(kwargs.get("parent_job_id") or "") or None
        list_raw = kwargs.get("list_board")
        if isinstance(list_raw, str):
            list_board = list_raw.strip().lower() in {"1", "true", "yes"}
        else:
            list_board = bool(list_raw)
        template = str(kwargs.get("template") or "").strip()
        board_node_id = str(kwargs.get("board_node_id") or "").strip()
        iterate_from = str(kwargs.get("iterate_from") or "").strip()
        project = project_for_session(store, session_id)
        if not inputs:
            inputs = collect_input_asset_ids(
                store,
                project["id"],
                attachments=attachments,
                parent_job_id=parent_job_id,
                reuse_recent=operation in {"edit", "inpaint", "enhance"} or bool(iterate_from),
            )

        prepared: dict[str, Any] = {}
        if template or board_node_id or iterate_from or list_board:
            try:
                prepared = prepare_board_for_job(
                    store,
                    project["id"],
                    board_node_id=board_node_id,
                    iterate_from=iterate_from,
                    template=template,
                    prompt=prompt,
                    input_asset_ids=inputs,
                )
            except ValueError as exc:
                return ToolResult(content=str(exc), success=False)
            prompt = prompt or str(prepared.get("prompt") or "")
            inputs = list(prepared.get("input_asset_ids") or inputs)
            board_node_id = str(prepared.get("target_node_id") or board_node_id)

        if list_board and not prompt and not template and not iterate_from and not board_node_id:
            summary = prepared.get("summary") or summarize_board(store.get_board(project["id"]))
            return ToolResult(
                content=_board_list_text(summary, project["id"]),
                success=True,
                metadata={"studio_project_id": project["id"], "studio_board": summary},
            )

        if template and not prompt and not iterate_from:
            summary = prepared["summary"]
            notes = " ".join(prepared.get("notes") or [])
            return ToolResult(
                content=f"{notes} {_board_list_text(summary, project['id'])}".strip(),
                success=True,
                metadata={
                    "studio_project_id": project["id"],
                    "studio_board": summary,
                    "generate_ids": prepared.get("generate_ids") or [],
                    "template": prepared.get("template_id"),
                },
            )

        if not prompt:
            return ToolResult(content="imagegen requires a non-empty 'prompt'.", success=False)

        targets = list(prepared.get("generate_ids") or [])
        if template and prompt and targets:
            pass
        elif board_node_id:
            targets = [board_node_id]
        else:
            targets = [None]

        planned: list[tuple[str | None, dict[str, Any]]] = []
        try:
            for node_id in targets:
                node_prompt = prompt
                if node_id:
                    node = next(
                        (
                            item
                            for item in store.get_board(project["id"]).get("nodes") or []
                            if item.get("id") == node_id
                        ),
                        None,
                    )
                    if node and node.get("prompt"):
                        node_prompt = str(node["prompt"])
                planned.append(
                    (
                        node_id,
                        plan_studio_job(
                            prompt=node_prompt,
                            operation=operation,
                            n=count,
                            size=str(kwargs.get("size") or ""),
                            aspect_ratio=str(kwargs.get("aspect_ratio") or ""),
                            target_resolution=str(kwargs.get("target_resolution") or ""),
                            quality=str(kwargs.get("quality") or ""),
                            style=str(kwargs.get("style") or ""),
                            output_format=str(kwargs.get("output_format") or ""),
                            profile_id=str(kwargs.get("image_profile_id") or ""),
                            model_id=str(kwargs.get("model_id") or ""),
                            input_asset_ids=inputs,
                            mask_asset_id=mask_id,
                            parent_job_id=parent_job_id,
                            language=language,
                        ),
                    )
                )
        except ValueError as exc:
            return ToolResult(content=str(exc), success=False)

        first_plan = planned[0][1]
        first_plan["target_node_id"] = planned[0][0]
        first_plan["generate_ids"] = [node_id for node_id, _ in planned if node_id]
        multi = len(planned) > 1
        confirmation_fingerprint = _studio_confirmation_fingerprint(planned)
        server_confirmation = str(kwargs.get("_studio_confirmation_fingerprint") or "")
        if (first_plan["needs_confirmation"] or multi) and not hmac.compare_digest(
            confirmation_fingerprint, server_confirmation
        ):
            if multi:
                first_plan["cost_hint"] = (
                    f"{len(planned)} canvas cards. {first_plan['cost_hint']}"
                    if not str(language).startswith("zh")
                    else f"{len(planned)} 张画布卡片。{first_plan['cost_hint']}"
                )
                first_plan["needs_confirmation"] = True
            return _confirmation_result(first_plan, confirmation_fingerprint)

        results: list[dict[str, Any]] = []
        try:
            for node_id, plan in planned:
                result = await run_studio_image_job(
                    plan,
                    session_id=session_id,
                    workspace_dir=None,
                    attachments=attachments,
                    event_sink=kwargs.get("event_sink"),
                    store=store,
                    target_node_id=node_id,
                )
                result["target_node_id"] = node_id
                result["generate_ids"] = first_plan.get("generate_ids") or []
                results.append(result)
        except asyncio.CancelledError:
            logger.info("Image Studio wait cancelled for session %s", session_id)
            raise
        except ValueError as exc:
            return ToolResult(content=str(exc), success=False)
        except Exception as exc:
            logger.warning("Image Studio job failed: %s", exc)
            return ToolResult(content=f"Image Studio job failed: {exc}", success=False)

        result = results[-1]
        plan = result.get("plan") or first_plan
        job = result["job"]
        if job.get("status") in {"failed", "cancelled", "interrupted"}:
            return ToolResult(
                content=job.get("error_message") or f"Image Studio job {job.get('status')}.",
                success=False,
                metadata={
                    "studio_job_id": job.get("id"),
                    "studio_project_id": result["project"]["id"],
                    "status": job.get("status"),
                    "studio_board": summarize_board(store.get_board(project["id"])),
                },
            )

        run_dir = _run_dir(kwargs.get("_workspace_dir"), "imagegen")
        media = []
        copied: list[dict[str, Any]] = []
        job_ids: list[str] = []
        for item in results:
            current_job = item.get("job") or {}
            if current_job.get("id"):
                job_ids.append(str(current_job["id"]))
            for output in current_job.get("outputs") or []:
                asset = store.get_asset(output["asset_id"])
                if not asset:
                    continue
                data = store.asset_path(asset["id"]).read_bytes()
                media.append((data, asset.get("mime") or "image/png"))
                copied.append(asset)
        if not media:
            return ToolResult(
                content=job.get("error_message") or "Image Studio produced no saved files.",
                success=False,
                metadata={"studio_job_id": job.get("id")},
            )
        artifacts = _write_media(run_dir, media, stem=_slug(prompt, "image"), default_ext="png")
        extra = {
            "prompt": prompt,
            "count": len(media),
            "kind": "image",
            "studio_job_id": job.get("id"),
            "studio_job_ids": job_ids,
            "studio_project_id": result["project"]["id"],
            "studio_operation": job.get("operation"),
            "studio_board": summarize_board(store.get_board(project["id"])),
            "board_node_id": board_node_id or None,
            "generate_ids": first_plan.get("generate_ids") or [],
            "model_name": plan["model_name"],
            "warnings": result.get("warnings") or [],
            "usage": result.get("usage") or {},
            "cost_hint": plan["cost_hint"],
            "fallback_used": bool(result.get("fallback_used")),
        }
        tool_result = _artifact_result(
            artifacts, empty_message="Image generation produced no saved files.", **extra
        )
        citations = citation_lines(plan, result)
        notes = " ".join(prepared.get("notes") or [])
        if notes:
            tool_result.content = f"{notes}\n{tool_result.content}"
        if citations:
            tool_result.content = f"{tool_result.content}\n\n" + "\n".join(citations)
        if extra["warnings"]:
            tool_result.content += "\n" + "\n".join(str(item) for item in extra["warnings"])
        for source, asset in zip(tool_result.sources, copied):
            if isinstance(source, dict):
                source["studio_asset_id"] = asset.get("id")
                source["studio_job_id"] = job.get("id")
                source["studio_project_id"] = result["project"]["id"]
        for row, asset in zip(tool_result.metadata.get("artifacts") or [], copied):
            if isinstance(row, dict):
                row["studio_asset_id"] = asset.get("id")
                row["studio_job_id"] = job.get("id")
                row["studio_project_id"] = result["project"]["id"]
        return tool_result


def _board_list_text(summary: dict[str, Any], project_id: str) -> str:
    nodes = summary.get("nodes") or []
    if not nodes:
        return f"Image Studio canvas is empty for project {project_id}."
    lines = [
        f"Image Studio canvas ({project_id}), {summary.get('node_count') or len(nodes)} cards:"
    ]
    for node in nodes:
        label = node.get("title") or node.get("kind")
        asset = f" asset={node['asset_id']}" if node.get("asset_id") else ""
        lines.append(f"- {node.get('id')} · {node.get('kind')} · {label}{asset}")
    lines.append("Use board_node_id or iterate_from with one of these ids.")
    return "\n".join(lines)


def _confirmation_result(plan: dict[str, Any], confirmation_fingerprint: str) -> ToolResult:
    """Pause the turn so the user can confirm or cancel a costly Image Studio job."""
    from knorvia.tools.ask_user import build_ask_user_payload

    zh = str(plan.get("language") or "en").startswith("zh")
    if zh:
        intro = f"{plan['cost_hint']} 模型：{plan['profile_name']} · {plan['model_name']}。"
        prompt = "视觉创作已准备好执行这次出图。是否继续？"
        proceed = "继续（推荐）"
        cancel = "取消"
        proceed_desc = "现在用已分配的模型出图。"
        cancel_desc = "这次不要出图。"
        header = "出图"
    else:
        intro = f"{plan['cost_hint']} Model: {plan['profile_name']} · {plan['model_name']}."
        prompt = "Image Studio is ready to run this job. Proceed?"
        proceed = "Proceed"
        cancel = "Cancel"
        proceed_desc = "Run this Image Studio job now."
        cancel_desc = "Do not generate this image."
        header = "Create"
    payload, err = build_ask_user_payload(
        intro=intro,
        questions=[
            {
                "id": "studio_confirm",
                "header": header,
                "prompt": prompt,
                "allow_free_text": False,
                "options": [
                    {
                        "label": proceed if zh else f"{proceed} (Recommended)",
                        "description": proceed_desc,
                    },
                    {"label": cancel, "description": cancel_desc},
                ],
            }
        ],
    )
    if payload is None:
        return ToolResult(content=err or "Could not ask for confirmation.", success=False)
    payload_dict = payload.to_dict()
    resume = "Wait for the user's choice. The server will authorize an unchanged plan once."
    return ToolResult(
        content=(f"[awaiting user confirmation] {intro} {resume}"),
        success=True,
        metadata={
            "ask_user": payload_dict,
            "needs_confirmation": True,
            "plan": plan,
            "confirmation_fingerprint": confirmation_fingerprint,
        },
        pause_for_user=payload_dict,
    )


class VideogenTool(BaseTool):
    """Create one authorized, durable Video Studio job after user confirmation."""

    def get_prompt_hints(self, language: str = "en"):
        from knorvia.tools.prompting import load_prompt_hints

        return load_prompt_hints(self.name, language=language)

    def get_definition(self) -> ToolDefinition:
        return ToolDefinition(
            name="videogen",
            description=(
                "Create one asynchronous Video Studio job with an assigned video model. "
                "The first call always pauses for explicit cost confirmation; after the "
                "user approves, call once more with exactly the same public arguments. "
                "The server supplies a one-shot idempotency key, rechecks model access, "
                "and archives the eventual output in the project. Pass the user's prompt "
                "verbatim — never rewrite, translate, or embellish it. At most ONE paid "
                "job per user message. For multi-shot work use the free planning tools "
                "first: template=shot-i2v|first-last|storyboard-6|character-episode|"
                "extend-chain|character-card places canvas cards at no cost (with a "
                "prompt it still starts only one job, on the first card), and "
                "action=plan_episode with "
                'shots=\'[{"title","prompt","duration","characters"}]\' writes the '
                "storyboard and canvas without any provider call (list_characters=true "
                "reads the character library first so shots reference real ids); the "
                "user then confirms each shot in its own message with "
                "storyboard_shot_id set to that shot id or 1-based index "
                "('1', 'shot 2', '第3镜'). New chat sessions bind to the Video "
                "Studio project the user currently has open; already-bound "
                "sessions stay on that project. action=analyze_script writes "
                "the prompt (or the stored production script) into the "
                "project's Script→Review stage at no cost; action="
                "apply_production writes a confirmed review onto the "
                "storyboard (fails until the user confirms in Video Studio). "
                "list_board=true "
                "lists the current canvas "
                "cards and ids without generating. board_node_id fills that canvas "
                "generate card; iterate_from branches a new card from a video asset "
                "(continue-from) or image asset (first-frame). input_roles labels "
                "input_asset_ids (reference|first-frame|last-frame|audio|continue-from). "
                "character_ids=comma-separated character library ids merges each "
                "character's reference images (three-view sheet first) into the job "
                "inputs as reference — free asset assembly, no provider call. Never "
                "claim that a video is finished from the queued response. Storyboard "
                "extras: keyframe_for_shot generates one shot's first-frame image "
                "(paid, confirmation), voiceover_shot synthesizes one shot's TTS "
                "narration (paid, confirmation), and compose_project stitches the "
                "storyboard into one MP4 locally (free, runs immediately — no "
                "provider cost, no confirmation needed)."
            ),
            parameters=[
                ToolParameter(
                    name="prompt",
                    type="string",
                    description=(
                        "A detailed description of the video to generate, verbatim from "
                        "the user. Omit only for free actions (list_board, template "
                        "placement, plan_episode)."
                    ),
                    required=False,
                ),
                ToolParameter(
                    name="action",
                    type="string",
                    description=(
                        "generate (default) creates one job after confirmation; "
                        "plan_episode writes a shot list to the storyboard and canvas "
                        "with zero provider calls; analyze_script parses a script "
                        "into the production review stage; apply_production writes "
                        "a confirmed review onto the storyboard."
                    ),
                    required=False,
                    default="generate",
                    enum=[
                        "generate",
                        "plan_episode",
                        "analyze_script",
                        "apply_production",
                    ],
                ),
                ToolParameter(
                    name="shots",
                    type="string",
                    description=(
                        "For action=plan_episode: JSON array of shots, each "
                        '{"title": str, "prompt": str, "duration": number, '
                        '"camera": str (optional, short camera motion like '
                        '"push" or "pan-left" shown as the card\'s camera '
                        'badge), "keyframe_prompt": str (optional, stored '
                        "only — generate later with keyframe_for_shot), "
                        '"characters": [character_id] '
                        "(optional, assigns library characters to the shot)}. List the "
                        "project characters first with GET "
                        "/api/v1/video-studio/projects/{id}/characters before planning."
                    ),
                    required=False,
                ),
                ToolParameter(
                    name="operation",
                    type="string",
                    description="Video operation supported by the selected model.",
                    required=False,
                    default="text_to_video",
                    enum=[
                        "text_to_video",
                        "image_to_video",
                        "video_to_video",
                        "extend",
                        "remix",
                        "edit",
                    ],
                ),
                ToolParameter(
                    name="project_id",
                    type="string",
                    description="Optional Video Studio project id. Omit to use the current project.",
                    required=False,
                ),
                ToolParameter(
                    name="profile_id",
                    type="string",
                    description="Optional assigned video profile id; use together with model_id.",
                    required=False,
                ),
                ToolParameter(
                    name="model_id",
                    type="string",
                    description="Optional assigned catalog model id; use together with profile_id.",
                    required=False,
                ),
                ToolParameter(
                    name="input_asset_ids",
                    type="string",
                    description="Comma-separated Video Studio asset ids for image/video/edit operations.",
                    required=False,
                ),
                ToolParameter(
                    name="input_roles",
                    type="string",
                    description=(
                        "Optional comma-separated roles parallel to input_asset_ids: "
                        "reference|first-frame|last-frame|audio|continue-from."
                    ),
                    required=False,
                ),
                ToolParameter(
                    name="reference_mode",
                    type="string",
                    description="How references are packed: auto|first-frame|first-last|multi|universal.",
                    required=False,
                    enum=["auto", "first-frame", "first-last", "multi", "universal"],
                ),
                ToolParameter(
                    name="audio_mode",
                    type="string",
                    description="Audio handling: none|generate|input.",
                    required=False,
                    enum=["none", "generate", "input"],
                ),
                ToolParameter(
                    name="aspect_ratio",
                    type="string",
                    description="Optional aspect ratio like '16:9' or '9:16'. Omit for the default.",
                    required=False,
                ),
                ToolParameter(
                    name="duration",
                    type="string",
                    description="Optional duration in seconds (e.g. '5'). Omit for the default.",
                    required=False,
                ),
                ToolParameter(
                    name="resolution",
                    type="string",
                    description="Optional provider-supported output resolution.",
                    required=False,
                ),
                ToolParameter(
                    name="seed",
                    type="integer",
                    description="Optional deterministic seed when the selected model supports it.",
                    required=False,
                ),
                ToolParameter(
                    name="board_node_id",
                    type="string",
                    description=(
                        "Video Studio canvas generate card id to fill with this job "
                        "(see list_board)."
                    ),
                    required=False,
                ),
                ToolParameter(
                    name="storyboard_shot_id",
                    type="string",
                    description=(
                        "Storyboard shot to fill: exact shot id, 1-based index "
                        "('1', 'shot 2', '第3镜'), or the shot title. When set, "
                        "an omitted prompt uses the stored shot prompt and the "
                        "matching canvas generate card is filled automatically."
                    ),
                    required=False,
                ),
                ToolParameter(
                    name="iterate_from",
                    type="string",
                    description=(
                        "Video/image asset id or canvas node id to iterate from: creates "
                        "a new generate card linked continue-from (video) or first-frame "
                        "(image)."
                    ),
                    required=False,
                ),
                ToolParameter(
                    name="template",
                    type="string",
                    description=(
                        "Stamp a canvas pipeline for free: shot-i2v, first-last, "
                        "storyboard-6, character-episode, extend-chain, or "
                        "character-card. With a "
                        "prompt, still only one job (the first card); each further shot "
                        "needs its own confirmed message."
                    ),
                    required=False,
                    enum=[
                        "shot-i2v",
                        "first-last",
                        "storyboard-6",
                        "character-episode",
                        "extend-chain",
                        "character-card",
                    ],
                ),
                ToolParameter(
                    name="list_board",
                    type="boolean",
                    description="If true, return the current canvas cards and ids without generating.",
                    required=False,
                ),
                ToolParameter(
                    name="list_characters",
                    type="boolean",
                    description=(
                        "If true, return the project's character library (ids, names, "
                        "voice hints, three-view status) without generating. Call this "
                        "before plan_episode so shots can reference real character ids."
                    ),
                    required=False,
                ),
                ToolParameter(
                    name="cancel_job_id",
                    type="string",
                    description="Cancel this Video Studio job instead of creating a new one.",
                    required=False,
                ),
                ToolParameter(
                    name="keyframe_for_shot",
                    type="string",
                    description=(
                        "Storyboard shot id (see plan_episode output) to generate a "
                        "first-frame keyframe image for. Paid image call: pauses for "
                        "cost confirmation first, then call again with the same "
                        "arguments."
                    ),
                    required=False,
                ),
                ToolParameter(
                    name="keyframe_prompt",
                    type="string",
                    description=(
                        "Optional prompt for keyframe_for_shot; defaults to the shot's "
                        "stored keyframe prompt or its video prompt."
                    ),
                    required=False,
                ),
                ToolParameter(
                    name="voiceover_shot",
                    type="string",
                    description=(
                        "Storyboard shot id to synthesize TTS narration for. Paid "
                        "voice call: pauses for cost confirmation first, then call "
                        "again with the same arguments."
                    ),
                    required=False,
                ),
                ToolParameter(
                    name="voiceover_text",
                    type="string",
                    description=(
                        "Narration text for voiceover_shot; defaults to the shot's "
                        "stored voiceover text."
                    ),
                    required=False,
                ),
                ToolParameter(
                    name="voiceover_voice",
                    type="string",
                    description="Optional TTS voice name for voiceover_shot.",
                    required=False,
                ),
                ToolParameter(
                    name="compose_project",
                    type="boolean",
                    description=(
                        "If true, compose the project's storyboard shots into one MP4 "
                        "locally with ffmpeg. Free local work — no provider cost, no "
                        "confirmation needed; runs immediately and returns the compose "
                        "job id."
                    ),
                    required=False,
                ),
                ToolParameter(
                    name="compose_subtitle",
                    type="string",
                    description="Subtitle burn-in for compose_project: off | from_notes.",
                    required=False,
                    enum=["off", "from_notes"],
                ),
                ToolParameter(
                    name="compose_resolution",
                    type="string",
                    description="Output resolution for compose_project: 480p | 720p | 1080p.",
                    required=False,
                    enum=["480p", "720p", "1080p"],
                ),
                ToolParameter(
                    name="character_ids",
                    type="string",
                    description=(
                        "Comma-separated character library ids whose reference images "
                        "(three-view sheet first, then the stored references) are merged "
                        "into this job's inputs as reference. Free asset assembly — no "
                        "provider call, no confirmation beyond the job itself."
                    ),
                    required=False,
                ),
            ],
        )

    async def execute(self, **kwargs: Any) -> ToolResult:
        from knorvia.multi_user.model_access import allowed_videogen_options
        from knorvia.services.video_studio.board import (
            summarize_board as summarize_video_board,
        )
        from knorvia.services.video_studio.engine import cancel_video_job
        from knorvia.services.video_studio.service import (
            create_agent_video_job,
            validate_video_job_plan,
        )
        from knorvia.services.video_studio.store import (
            VideoStudioQueueFullError,
            get_video_studio_store,
        )

        store = get_video_studio_store()
        cancel_id = str(kwargs.get("cancel_job_id") or "").strip()
        if cancel_id:
            job = store.get_job(cancel_id)
            if not job:
                return ToolResult(content="Video Studio job not found.", success=False)
            cancelled = cancel_video_job(store, cancel_id)
            return ToolResult(
                content=(
                    f"Cancelled Video Studio job {cancel_id}."
                    if cancelled
                    else f"Video Studio job {cancel_id} was already finished."
                ),
                success=True,
                metadata={"video_studio_job_id": cancel_id, "cancelled": cancelled},
            )
        action = str(kwargs.get("action") or "generate").strip().lower().replace("-", "_")
        session_id = str(kwargs.get("_session_id") or "") or None
        language = str(kwargs.get("_language") or "en")
        compose_raw = kwargs.get("compose_project")
        if isinstance(compose_raw, str):
            compose_project = compose_raw.strip().lower() in {"1", "true", "yes"}
        else:
            compose_project = bool(compose_raw)
        if compose_project:
            return await _compose_project_result(
                store, kwargs, session_id=session_id, language=language
            )
        keyframe_shot = str(kwargs.get("keyframe_for_shot") or "").strip()
        voiceover_shot = str(kwargs.get("voiceover_shot") or "").strip()
        if keyframe_shot and voiceover_shot:
            return ToolResult(
                content=(
                    "One paid action per call: pass either keyframe_for_shot or "
                    "voiceover_shot, not both."
                ),
                success=False,
            )
        if keyframe_shot:
            return await _keyframe_for_shot_result(
                store, kwargs, session_id=session_id, language=language
            )
        if voiceover_shot:
            return await _voiceover_shot_result(
                store, kwargs, session_id=session_id, language=language
            )
        if action == "plan_episode":
            # Phase 4: planning only — storyboard + canvas writes, zero jobs.
            return _plan_episode_result(store, kwargs, session_id=session_id, language=language)
        if action == "analyze_script":
            return _analyze_script_result(store, kwargs, session_id=session_id, language=language)
        if action == "apply_production":
            return _apply_production_result(store, kwargs, session_id=session_id, language=language)
        if action not in {"generate", ""}:
            return ToolResult(
                content=(
                    "videogen action must be 'generate', 'plan_episode', "
                    "'analyze_script', or 'apply_production'."
                ),
                success=False,
            )
        prompt = str(kwargs.get("prompt") or "").strip()
        operation_explicit = bool(str(kwargs.get("operation") or "").strip())
        operation = str(kwargs.get("operation") or "text_to_video").replace("-", "_")
        list_raw = kwargs.get("list_board")
        if isinstance(list_raw, str):
            list_board = list_raw.strip().lower() in {"1", "true", "yes"}
        else:
            list_board = bool(list_raw)
        template = str(kwargs.get("template") or "").strip()
        board_node_id = str(kwargs.get("board_node_id") or "").strip()
        iterate_from = str(kwargs.get("iterate_from") or "").strip()

        raw_inputs = [
            part.strip()
            for part in str(kwargs.get("input_asset_ids") or "").split(",")
            if part.strip()
        ]
        raw_roles = [
            part.strip() for part in str(kwargs.get("input_roles") or "").split(",") if part.strip()
        ]
        if raw_roles:
            if len(raw_roles) != len(raw_inputs):
                return ToolResult(
                    content="input_roles must parallel input_asset_ids (same count).",
                    success=False,
                )
            unknown = [role for role in raw_roles if role not in _VIDEO_INPUT_ROLES]
            if unknown:
                return ToolResult(
                    content=(
                        "Unknown input role "
                        f"{unknown[0]!r}. Use reference, first-frame, last-frame, audio, "
                        "or continue-from."
                    ),
                    success=False,
                )
        input_specs: list[dict[str, str]] = []
        for position, asset_id in enumerate(dict.fromkeys(raw_inputs)):
            input_specs.append(
                {
                    "asset_id": asset_id,
                    "role": raw_roles[position] if position < len(raw_roles) else "reference",
                }
            )

        project_id = str(kwargs.get("project_id") or "").strip()
        if project_id:
            project = store.get_project(project_id)
            if not project:
                return ToolResult(content="Video Studio project not found.", success=False)
        else:
            project = _video_project_for_call(store, session_id)
        project_id = str(project["id"])

        storyboard_shot_id = str(kwargs.get("storyboard_shot_id") or "").strip()
        resolved_shot: dict[str, Any] | None = None
        if storyboard_shot_id:
            resolved_shot = _resolve_storyboard_shot(store, project_id, storyboard_shot_id)
            if resolved_shot is None:
                return ToolResult(
                    content=(
                        f"Storyboard shot {storyboard_shot_id!r} was not found "
                        f"in project {project_id}."
                    ),
                    success=False,
                )
            storyboard_shot_id = str(resolved_shot.get("id") or "")
            if not prompt:
                prompt = str(resolved_shot.get("prompt") or "").strip()
            if not board_node_id:
                board_node_id = (
                    _board_generate_node_for_shot(store, project_id, resolved_shot) or ""
                )
            if not input_specs:
                keyframe_asset = str(resolved_shot.get("keyframe_asset_id") or "").strip()
                if keyframe_asset:
                    input_specs.append({"asset_id": keyframe_asset, "role": "first-frame"})
                    if not operation_explicit:
                        operation = "image_to_video"
                else:
                    for asset_id in resolved_shot.get("input_asset_ids") or []:
                        asset_id = str(asset_id or "").strip()
                        if asset_id:
                            input_specs.append({"asset_id": asset_id, "role": "reference"})
            if kwargs.get("duration") in (None, "") and resolved_shot.get("duration"):
                kwargs = {**kwargs, "duration": resolved_shot["duration"]}

        characters_raw = kwargs.get("list_characters")
        if isinstance(characters_raw, str):
            list_characters = characters_raw.strip().lower() in {"1", "true", "yes"}
        else:
            list_characters = bool(characters_raw)
        if (
            list_characters
            and not prompt
            and not template
            and not iterate_from
            and not board_node_id
        ):
            characters = store.list_characters(project_id)
            return ToolResult(
                content=_video_character_list_text(characters, project_id),
                success=True,
                metadata={
                    "video_studio_project_id": project_id,
                    "video_studio_characters": characters,
                    "jobs_created": 0,
                },
            )

        prepared: dict[str, Any] = {}
        if template or board_node_id or iterate_from or list_board:
            from knorvia.services.video_studio.board import prepare_board_for_video_job

            try:
                prepared = prepare_board_for_video_job(
                    store,
                    project_id,
                    board_node_id=board_node_id,
                    iterate_from=iterate_from,
                    template=template,
                    prompt=prompt,
                    input_specs=input_specs,
                )
            except ValueError as exc:
                return ToolResult(content=str(exc), success=False)
            prompt = prompt or str(prepared.get("prompt") or "")
            board_node_id = str(prepared.get("target_node_id") or board_node_id)
            input_specs = list(prepared.get("input_specs") or input_specs)
            if not operation_explicit:
                hinted = str(prepared.get("operation_hint") or "").replace("-", "_")
                if hinted:
                    operation = hinted

        if list_board and not prompt and not template and not iterate_from and not board_node_id:
            summary = prepared.get("summary") or summarize_video_board(store.get_board(project_id))
            storyboard_text = _video_storyboard_list_text(store, project_id)
            content = _video_board_list_text(summary, project_id)
            if storyboard_text:
                content = f"{content}\n\n{storyboard_text}"
            return ToolResult(
                content=content,
                success=True,
                metadata={
                    "video_studio_project_id": project_id,
                    "video_studio_board": summary,
                    "jobs_created": 0,
                },
            )

        if template and not prompt and not iterate_from:
            # Free canvas placement: nodes exist, nothing is queued or billed.
            summary = prepared.get("summary") or {}
            notes = " ".join(prepared.get("notes") or [])
            return ToolResult(
                content=f"{notes} {_video_board_list_text(summary, project_id)}".strip(),
                success=True,
                metadata={
                    "video_studio_project_id": project_id,
                    "video_studio_board": summary,
                    "template": prepared.get("template_id") or template,
                    "generate_ids": prepared.get("generate_ids") or [],
                    "jobs_created": 0,
                },
            )

        if not prompt:
            return ToolResult(
                content=(
                    "videogen requires a non-empty 'prompt' (or a free action: "
                    "list_board=true, list_characters=true, template placement, "
                    "storyboard_shot_id of a stored shot, action=plan_episode, "
                    "action=analyze_script, or action=apply_production)."
                ),
                success=False,
            )
        profile_id = str(kwargs.get("profile_id") or "").strip()
        model_id = str(kwargs.get("model_id") or "").strip()
        if bool(profile_id) != bool(model_id):
            return ToolResult(
                content="profile_id and model_id must be supplied together.", success=False
            )
        options = list(allowed_videogen_options().get("options") or [])
        if profile_id:
            selected = next(
                (
                    option
                    for option in options
                    if option.get("profile_id") == profile_id and option.get("model_id") == model_id
                ),
                None,
            )
        else:
            selected = next((option for option in options if option.get("is_active_default")), None)
            selected = selected or (options[0] if options else None)
        if not selected:
            return ToolResult(
                content="No assigned video-generation model is available for this account.",
                success=False,
            )
        profile_id = str(selected["profile_id"])
        model_id = str(selected["model_id"])
        hidden_inputs = kwargs.get("_video_input_asset_ids")
        import_failures = 0
        if isinstance(hidden_inputs, list):
            input_specs = _merge_video_input_specs(
                input_specs,
                [
                    item
                    for item in hidden_inputs
                    if isinstance(item, str) and item.startswith("video_asset_")
                ],
            )
        elif operation in {"image_to_video", "edit"}:
            capabilities = dict(selected.get("capabilities") or {})
            limits = capabilities.get("max_inputs") or {}
            try:
                if isinstance(limits, dict):
                    max_images = max(0, int(limits.get("image") or 0))
                else:
                    max_images = max(0, int(limits or 0))
            except (TypeError, ValueError):
                max_images = 0
            imported, import_failures = _import_video_chat_images(
                store,
                project_id,
                [
                    item
                    for item in (kwargs.get("_chat_attachments") or [])
                    if isinstance(item, dict)
                ],
                maximum=max_images,
            )
            input_specs = _merge_video_input_specs(input_specs, imported)
        character_ids_raw = [
            part.strip()
            for part in str(kwargs.get("character_ids") or "").split(",")
            if part.strip()
        ]
        if not character_ids_raw and resolved_shot:
            character_ids_raw = [
                str(item).strip()
                for item in (resolved_shot.get("character_ids") or [])
                if str(item).strip()
            ]
        if character_ids_raw:
            character_assets, character_error = _collect_character_reference_assets(
                store, project_id, character_ids_raw, selected
            )
            if character_error:
                return ToolResult(content=character_error, success=False)
            input_specs = _merge_video_input_specs(input_specs, character_assets)
        inputs = [spec["asset_id"] for spec in input_specs]
        if operation == "image_to_video" and not inputs:
            detail = " The attached image could not be imported safely." if import_failures else ""
            return ToolResult(
                content=(
                    "Image-to-video requires an image reference."
                    f"{detail} Upload it in Video Studio first and try again."
                ),
                success=False,
            )
        if operation in {"video_to_video", "extend", "remix"} and not inputs:
            return ToolResult(
                content=(
                    "This operation requires a Video Studio video asset id. "
                    "Upload the video in Video Studio first and try again."
                ),
                success=False,
            )
        parameters = {
            key: value
            for key in (
                "aspect_ratio",
                "duration",
                "resolution",
                "seed",
                "reference_mode",
                "audio_mode",
            )
            if (value := kwargs.get(key)) is not None and value != ""
        }
        input_roles = [spec["role"] for spec in input_specs] or None
        if input_roles and set(input_roles) == {"reference"}:
            input_roles = None
        try:
            validated = validate_video_job_plan(
                store,
                project_id=project_id,
                profile_id=profile_id,
                model_id=model_id,
                operation=operation,
                prompt=prompt,
                input_asset_ids=inputs,
                parameters=parameters,
                board_node_id=board_node_id or None,
                storyboard_shot_id=storyboard_shot_id or None,
                input_roles=input_roles,
            )
        except (ValueError, PermissionError) as exc:
            return ToolResult(content=str(exc), success=False)
        plan = {
            "project_id": project_id,
            "profile_id": profile_id,
            "model_id": model_id,
            "profile_name": selected.get("profile_name") or profile_id,
            "model_name": selected.get("model_name") or selected.get("model") or model_id,
            "operation": validated["operation"],
            "prompt": validated["prompt"],
            "input_asset_ids": validated["input_asset_ids"],
            "inputs": validated["inputs"],
            "parameters": validated["parameters"],
            "board_node_id": board_node_id or None,
            "storyboard_shot_id": storyboard_shot_id or None,
            "language": language,
        }
        fingerprint = _video_confirmation_fingerprint(plan)
        approved = str(kwargs.get("_video_confirmation_fingerprint") or "")
        request_id = str(kwargs.get("_video_client_request_id") or "")
        if not request_id or not hmac.compare_digest(fingerprint, approved):
            return _video_confirmation_result(plan, fingerprint)
        try:
            job = create_agent_video_job(
                store=store,
                project_id=project_id,
                profile_id=profile_id,
                model_id=model_id,
                operation=plan["operation"],
                prompt=plan["prompt"],
                input_asset_ids=plan["input_asset_ids"],
                input_roles=input_roles,
                parameters=plan["parameters"],
                board_node_id=board_node_id or None,
                storyboard_shot_id=storyboard_shot_id or None,
                client_request_id=request_id,
                confirmed_cost=True,
            )
        except (ValueError, PermissionError) as exc:
            return ToolResult(content=str(exc), success=False)
        except VideoStudioQueueFullError as exc:
            return ToolResult(content=str(exc), success=False)
        board_summary = None
        try:
            board_summary = summarize_video_board(store.get_board(project_id))
        except (AttributeError, KeyError, TypeError, ValueError, OSError):
            board_summary = None
        metadata = {
            "video_studio_job_id": job["id"],
            "video_studio_project_id": project_id,
            "status": job.get("status") or "queued",
            "open_url": _video_studio_open_url(
                project_id,
                job_id=job["id"],
                shot_id=storyboard_shot_id or None,
            ),
            "model_name": plan["model_name"],
            "board_node_id": board_node_id or None,
            "storyboard_shot_id": storyboard_shot_id or None,
        }
        if template:
            metadata["template"] = template
        if prepared.get("generate_ids"):
            metadata["generate_ids"] = prepared.get("generate_ids") or []
        if board_summary:
            metadata["video_studio_board"] = board_summary
        return ToolResult(
            content=(
                f"Queued Video Studio job {job['id']} in project {project_id}. "
                "Rendering continues asynchronously; open Video Studio to follow progress."
            ),
            success=True,
            metadata=metadata,
        )


def _video_confirmation_result(plan: dict[str, Any], fingerprint: str) -> ToolResult:
    from knorvia.tools.ask_user import build_ask_user_payload

    zh = str(plan.get("language") or "en").startswith("zh")
    model = f"{plan['profile_name']} · {plan['model_name']}"
    prompt_preview = " ".join(str(plan.get("prompt") or "").split())
    if len(prompt_preview) > 160:
        prompt_preview = prompt_preview[:159].rstrip() + "…"
    parameter_preview = json.dumps(
        plan.get("parameters") or {}, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    )
    if len(parameter_preview) > 100:
        parameter_preview = parameter_preview[:99].rstrip() + "…"
    reference_count = len(plan.get("input_asset_ids") or [])
    if zh:
        intro = (
            f"将提交 1 个可能产生费用的视频任务。模型：{model}；操作：{plan['operation']}；"
            f"提示词：“{prompt_preview}”；参考素材：{reference_count}；参数：{parameter_preview}。"
        )
        prompt = "是否按当前提示词与参数提交到视频创作工作台？"
        labels = ("提交（推荐）", "取消")
        descriptions = ("仅提交这一个已展示的任务。", "不调用视频模型。")
    else:
        intro = (
            f"This will submit one potentially billable video job. Model: {model}; "
            f"operation: {plan['operation']}; prompt: “{prompt_preview}”; "
            f"references: {reference_count}; parameters: {parameter_preview}."
        )
        prompt = "Submit this exact prompt and parameter set to Video Studio?"
        labels = ("Submit (Recommended)", "Cancel")
        descriptions = ("Submit only this one displayed job.", "Do not call the video model.")
    payload, error = build_ask_user_payload(
        intro=intro,
        questions=[
            {
                "id": "video_studio_confirm",
                "header": "视频" if zh else "Video",
                "prompt": prompt,
                "allow_free_text": False,
                "options": [
                    {"label": labels[0], "description": descriptions[0]},
                    {"label": labels[1], "description": descriptions[1]},
                ],
            }
        ],
    )
    if payload is None:
        return ToolResult(content=error or "Could not ask for confirmation.", success=False)
    request_id = f"agent-video-{uuid.uuid4().hex}"
    payload_dict = payload.to_dict()
    return ToolResult(
        content=f"[awaiting user confirmation] {intro}",
        success=True,
        metadata={
            "ask_user": payload_dict,
            "needs_confirmation": True,
            "plan": plan,
            "confirmation_fingerprint": fingerprint,
            "confirmation_request_id": request_id,
            "video_input_asset_ids": list(plan.get("input_asset_ids") or []),
        },
        pause_for_user=payload_dict,
    )


def _storyboard_paid_fingerprint(kind: str, payload: dict[str, Any]) -> str:
    """Bind a one-shot approval to one exact paid storyboard action."""

    canonical = json.dumps(
        {"kind": kind, **payload},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _resolve_video_project_for_kwargs(
    store: Any, kwargs: dict[str, Any], session_id: str | None
) -> dict[str, Any] | None:
    project_id = str(kwargs.get("project_id") or "").strip()
    if project_id:
        return store.get_project(project_id)
    return _video_project_for_call(store, session_id)


_SHOT_INDEX_RE = re.compile(
    r"^(?:shot\s*|第\s*)?(\d{1,3})\s*(?:镜|shot)?$",
    re.IGNORECASE,
)


def _resolve_storyboard_shot(store: Any, project_id: str, raw: str) -> dict[str, Any] | None:
    """Resolve a shot by id, 1-based index ('1', 'shot 2', '第3镜'), or title."""

    token = str(raw or "").strip()
    if not token:
        return None
    try:
        storyboard = store.get_storyboard(project_id)
    except (AttributeError, KeyError, TypeError, ValueError, OSError):
        return None
    shots = [item for item in (storyboard.get("shots") or []) if isinstance(item, dict)]
    for shot in shots:
        if str(shot.get("id") or "") == token:
            return shot
    index_match = _SHOT_INDEX_RE.fullmatch(token)
    if index_match:
        index = int(index_match.group(1))
        if 1 <= index <= len(shots):
            return shots[index - 1]
    folded = token.casefold()
    titled = [shot for shot in shots if str(shot.get("title") or "").strip().casefold() == folded]
    if len(titled) == 1:
        return titled[0]
    return None


def _find_storyboard_shot(store: Any, project_id: str, shot_id: str) -> dict[str, Any] | None:
    return _resolve_storyboard_shot(store, project_id, shot_id)


def _board_generate_node_for_shot(store: Any, project_id: str, shot: dict[str, Any]) -> str | None:
    """Find the canvas generate card imported from this storyboard shot."""

    try:
        board = store.get_board(project_id)
    except (AttributeError, KeyError, TypeError, ValueError, OSError):
        return None
    shot_id = str(shot.get("id") or "")
    title = str(shot.get("title") or "")
    prompt = str(shot.get("prompt") or "")
    nodes = [
        node
        for node in (board.get("nodes") or [])
        if isinstance(node, dict) and node.get("kind") == "generate"
    ]
    if shot_id:
        for node in nodes:
            if str(node.get("storyboardShotId") or "") == shot_id:
                node_id = str(node.get("id") or "").strip()
                if node_id:
                    return node_id
    if title or prompt:
        for node in nodes:
            if str(node.get("title") or "") == title and str(node.get("prompt") or "") == prompt:
                node_id = str(node.get("id") or "").strip()
                if node_id:
                    return node_id
    return None


def _storyboard_action_confirmation_result(
    *,
    kind: str,
    payload: dict[str, Any],
    fingerprint: str,
    language: str,
) -> ToolResult:
    """Pause the turn so the user can confirm one paid storyboard action."""

    from knorvia.tools.ask_user import build_ask_user_payload

    zh = str(language or "en").startswith("zh")
    preview = " ".join(str(payload.get("detail") or "").split())
    if len(preview) > 160:
        preview = preview[:159].rstrip() + "…"
    if kind == "keyframe":
        if zh:
            intro = (
                f"将为分镜“{payload.get('shot_title')}”生成 1 张首帧图（付费图像生成）。"
                f"提示词：“{preview}”。"
            )
            question = "是否生成该分镜的首帧图？"
        else:
            intro = (
                f"This will generate one first-frame keyframe image (a paid image "
                f"call) for shot “{payload.get('shot_title')}”. Prompt: “{preview}”."
            )
            question = "Generate this shot's keyframe image?"
    else:
        if zh:
            intro = (
                f"将为分镜“{payload.get('shot_title')}”合成 1 段配音（付费语音合成）。"
                f"文案：“{preview}”。"
            )
            question = "是否合成该分镜的配音？"
        else:
            intro = (
                f"This will synthesize one TTS narration (a paid voice call) for shot "
                f"“{payload.get('shot_title')}”. Text: “{preview}”."
            )
            question = "Synthesize this shot's narration?"
    if zh:
        labels = ("生成（推荐）", "取消")
        descriptions = ("仅执行这一个已展示的付费操作。", "不调用模型。")
        header = "首帧" if kind == "keyframe" else "配音"
    else:
        labels = ("Proceed (Recommended)", "Cancel")
        descriptions = ("Run only this one displayed paid action.", "Do not call the model.")
        header = "Keyframe" if kind == "keyframe" else "Voice"
    ask_payload, error = build_ask_user_payload(
        intro=intro,
        questions=[
            {
                "id": f"video_studio_{kind}_confirm",
                "header": header,
                "prompt": question,
                "allow_free_text": False,
                "options": [
                    {"label": labels[0], "description": descriptions[0]},
                    {"label": labels[1], "description": descriptions[1]},
                ],
            }
        ],
    )
    if ask_payload is None:
        return ToolResult(content=error or "Could not ask for confirmation.", success=False)
    request_id = f"agent-video-{uuid.uuid4().hex}"
    payload_dict = ask_payload.to_dict()
    return ToolResult(
        content=f"[awaiting user confirmation] {intro}",
        success=True,
        metadata={
            "ask_user": payload_dict,
            "needs_confirmation": True,
            "plan": payload,
            "confirmation_fingerprint": fingerprint,
            "confirmation_request_id": request_id,
            "video_input_asset_ids": [],
        },
        pause_for_user=payload_dict,
    )


async def _keyframe_for_shot_result(
    store: Any,
    kwargs: dict[str, Any],
    *,
    session_id: str | None,
    language: str,
) -> ToolResult:
    """Generate one shot's first-frame image after explicit cost confirmation."""

    from knorvia.services.video_studio.service import create_shot_keyframe

    shot_token = str(kwargs.get("keyframe_for_shot") or "").strip()
    prompt_override = str(kwargs.get("keyframe_prompt") or "").strip()
    project = _resolve_video_project_for_kwargs(store, kwargs, session_id)
    if not project:
        return ToolResult(content="Video Studio project not found.", success=False)
    project_id = str(project["id"])
    shot = _resolve_storyboard_shot(store, project_id, shot_token)
    if shot is None:
        return ToolResult(
            content=f"Storyboard shot {shot_token} was not found in project {project_id}.",
            success=False,
        )
    shot_id = str(shot.get("id") or shot_token)
    effective_prompt = (
        prompt_override
        or str(shot.get("keyframe_prompt") or "").strip()
        or str(shot.get("prompt") or "").strip()
    )
    if not effective_prompt:
        return ToolResult(
            content="The shot has no prompt or stored keyframe prompt to draw from.",
            success=False,
        )
    shot_title = str(shot.get("title") or shot_id)
    payload = {
        "kind": "keyframe",
        "project_id": project_id,
        "shot_id": shot_id,
        "prompt": effective_prompt,
        "shot_title": shot_title,
        "detail": effective_prompt,
    }
    fingerprint = _storyboard_paid_fingerprint("keyframe", payload)
    approved = str(kwargs.get("_video_confirmation_fingerprint") or "")
    request_id = str(kwargs.get("_video_client_request_id") or "")
    if not request_id or not hmac.compare_digest(fingerprint, approved):
        return _storyboard_action_confirmation_result(
            kind="keyframe",
            payload=payload,
            fingerprint=fingerprint,
            language=language,
        )
    try:
        result = await create_shot_keyframe(
            store,
            project_id=project_id,
            shot_id=shot_id,
            prompt=prompt_override,
            confirmed_cost=True,
        )
    except (ValueError, PermissionError, RuntimeError) as exc:
        return ToolResult(content=str(exc), success=False)
    asset = result.get("asset") or {}
    zh = str(language).startswith("zh")
    if zh:
        content = (
            f"已为分镜“{shot_title}”生成首帧图并绑定（资产 {asset.get('id')}）。"
            "它现在会作为该镜 image-to-video 的 first-frame 候选。"
        )
    else:
        content = (
            f"Generated and bound the keyframe image for shot “{shot_title}” "
            f"(asset {asset.get('id')}). It is now the first-frame candidate for "
            "this shot's image-to-video generation."
        )
    return ToolResult(
        content=content,
        success=True,
        metadata={
            "action": "keyframe_for_shot",
            "video_studio_project_id": project_id,
            "shot_id": shot_id,
            "keyframe_asset_id": asset.get("id"),
            "image_job_id": result.get("image_job_id"),
            "open_url": _video_studio_open_url(project_id, shot_id=shot_id, view="storyboard"),
        },
    )


async def _voiceover_shot_result(
    store: Any,
    kwargs: dict[str, Any],
    *,
    session_id: str | None,
    language: str,
) -> ToolResult:
    """Synthesize one shot's narration after explicit cost confirmation."""

    from knorvia.services.video_studio.service import create_shot_voiceover

    shot_token = str(kwargs.get("voiceover_shot") or "").strip()
    text = str(kwargs.get("voiceover_text") or "").strip()
    voice = str(kwargs.get("voiceover_voice") or "").strip()
    project = _resolve_video_project_for_kwargs(store, kwargs, session_id)
    if not project:
        return ToolResult(content="Video Studio project not found.", success=False)
    project_id = str(project["id"])
    shot = _resolve_storyboard_shot(store, project_id, shot_token)
    if shot is None:
        return ToolResult(
            content=f"Storyboard shot {shot_token} was not found in project {project_id}.",
            success=False,
        )
    shot_id = str(shot.get("id") or shot_token)
    if not text:
        text = str(shot.get("voiceover_text") or "").strip()
    if not text:
        return ToolResult(
            content=(
                "voiceover_shot needs narration text: pass voiceover_text or store "
                "voiceover text on the shot first."
            ),
            success=False,
        )
    shot_title = str(shot.get("title") or shot_id)
    payload = {
        "kind": "voiceover",
        "project_id": project_id,
        "shot_id": shot_id,
        "text": text,
        "voice": voice,
        "shot_title": shot_title,
        "detail": text,
    }
    fingerprint = _storyboard_paid_fingerprint("voiceover", payload)
    approved = str(kwargs.get("_video_confirmation_fingerprint") or "")
    request_id = str(kwargs.get("_video_client_request_id") or "")
    if not request_id or not hmac.compare_digest(fingerprint, approved):
        return _storyboard_action_confirmation_result(
            kind="voiceover",
            payload=payload,
            fingerprint=fingerprint,
            language=language,
        )
    try:
        result = await create_shot_voiceover(
            store,
            project_id=project_id,
            shot_id=shot_id,
            text=text,
            voice=voice,
            confirmed_cost=True,
        )
    except (ValueError, PermissionError, RuntimeError) as exc:
        return ToolResult(content=str(exc), success=False)
    asset = result.get("asset") or {}
    duration = result.get("duration")
    zh = str(language).startswith("zh")
    seconds = f"{duration:.1f}s" if isinstance(duration, (int, float)) else "unknown"
    if zh:
        content = (
            f"已为分镜“{shot_title}”合成配音并绑定（资产 {asset.get('id')}，"
            f"时长约 {seconds}）。合成成片时配音会自动对齐该镜时间段。"
        )
    else:
        content = (
            f"Synthesized and bound the narration for shot “{shot_title}” "
            f"(asset {asset.get('id')}, about {seconds}). Compositions will align "
            "it to this shot's time range automatically."
        )
    return ToolResult(
        content=content,
        success=True,
        metadata={
            "action": "voiceover_shot",
            "video_studio_project_id": project_id,
            "shot_id": shot_id,
            "voiceover_asset_id": asset.get("id"),
            "voiceover_duration": duration,
            "open_url": _video_studio_open_url(project_id, shot_id=shot_id, view="storyboard"),
        },
    )


async def _compose_project_result(
    store: Any,
    kwargs: dict[str, Any],
    *,
    session_id: str | None,
    language: str,
) -> ToolResult:
    """Compose the storyboard into one local MP4. Free — no confirmation."""

    from knorvia.services.video_studio.composition import ComposeInvalidError
    from knorvia.services.video_studio.composition import compose_project as submit_compose

    project = _resolve_video_project_for_kwargs(store, kwargs, session_id)
    if not project:
        return ToolResult(content="Video Studio project not found.", success=False)
    project_id = str(project["id"])
    request: dict[str, Any] = {}
    subtitle_mode = str(kwargs.get("compose_subtitle") or "").strip().lower()
    if subtitle_mode:
        if subtitle_mode not in {"off", "from_notes"}:
            return ToolResult(
                content="compose_subtitle must be 'off' or 'from_notes'.", success=False
            )
        request["subtitle"] = {"mode": subtitle_mode}
    resolution = str(kwargs.get("compose_resolution") or "").strip().lower()
    if resolution:
        if resolution not in {"480p", "720p", "1080p"}:
            return ToolResult(
                content="compose_resolution must be 480p, 720p, or 1080p.", success=False
            )
        request["output"] = {"resolution": resolution}
    client_request_id = (
        str(kwargs.get("_video_client_request_id") or "").strip()
        or f"agent-compose-{uuid.uuid4().hex}"
    )
    try:
        job = await asyncio.to_thread(
            submit_compose,
            store,
            project_id=project_id,
            request=request or None,
            client_request_id=client_request_id,
        )
    except KeyError:
        return ToolResult(content="Video Studio project not found.", success=False)
    except ComposeInvalidError as exc:
        return ToolResult(content=str(exc), success=False)
    except ValueError as exc:
        return ToolResult(content=str(exc), success=False)
    zh = str(language).startswith("zh")
    if zh:
        content = (
            f"已排队本地成片合成任务 {job.get('id')}（项目 {project_id}）。"
            "合成由本机 ffmpeg 完成，不产生任何模型费用；进度见视频工作台。"
        )
    else:
        content = (
            f"Queued local composition job {job.get('id')} for project {project_id}. "
            "Composition runs on the local ffmpeg runtime with zero provider cost; "
            "follow the progress in Video Studio."
        )
    return ToolResult(
        content=content,
        success=True,
        metadata={
            "action": "compose_project",
            "video_studio_job_id": job.get("id"),
            "video_studio_project_id": project_id,
            "status": job.get("status") or "queued",
            "open_url": _video_studio_open_url(project_id, job_id=job.get("id")),
            "jobs_created": 1,
            "provider_cost": 0,
        },
    )


_VIDEO_INPUT_ROLES = frozenset({"reference", "first-frame", "last-frame", "audio", "continue-from"})
_PLAN_EPISODE_MAX_SHOTS = 20


def _video_studio_open_url(
    project_id: str,
    *,
    job_id: str | None = None,
    shot_id: str | None = None,
    view: str | None = None,
) -> str:
    """Same-origin Video Studio deep link the chat cards already know how to open."""

    query = [f"project={project_id}"]
    if view:
        query.append(f"view={view}")
    if job_id:
        query.append(f"job={job_id}")
    if shot_id:
        query.append(f"shot={shot_id}")
    return "/video-studio?" + "&".join(query)


def _video_project_for_call(store: Any, session_id: str | None) -> dict[str, Any]:
    """Resolve the Video Studio project this chat turn should write into.

    Order: an already-bound session keeps that project; a new session binds
    to the workspace's currently open Video Studio project; otherwise a
    durable ``Chat · {session}`` project is created. Calls without a session
    use the active project, then the default.
    """

    resolver = getattr(store, "resolve_workspace_project", None)
    if callable(resolver):
        try:
            return resolver(
                session_id,
                title=f"Chat · {(session_id or '')[:48]}" if session_id else "Untitled Project",
                legacy_title=f"Chat · {(session_id or '')[:16]}" if session_id else None,
            )
        except ValueError:
            logger.info(
                "Could not resolve the session video project; using the default.",
                exc_info=True,
            )
        return store.ensure_default_project()

    if session_id:
        existing = None
        getter = getattr(store, "get_session_project", None)
        if callable(getter):
            try:
                existing = getter(session_id)
            except (TypeError, ValueError):
                existing = None
        if existing:
            return existing
        active = None
        active_getter = getattr(store, "get_active_project", None)
        if callable(active_getter):
            try:
                active = active_getter()
            except (TypeError, ValueError):
                active = None
        binder = getattr(store, "bind_session_project", None)
        if active and callable(binder):
            try:
                return binder(session_id, active["id"])
            except (KeyError, TypeError, ValueError):
                logger.info(
                    "Could not bind the chat session to the open Video Studio project.",
                    exc_info=True,
                )
        session_resolver = getattr(store, "project_for_session", None)
        if callable(session_resolver):
            try:
                return session_resolver(
                    session_id,
                    title=f"Chat · {session_id[:48]}",
                    legacy_title=f"Chat · {session_id[:16]}",
                )
            except ValueError:
                logger.info(
                    "Could not resolve the session video project; using the default.",
                    exc_info=True,
                )
    else:
        active_getter = getattr(store, "get_active_project", None)
        if callable(active_getter):
            try:
                active = active_getter()
            except (TypeError, ValueError):
                active = None
            if active:
                return active
    return store.ensure_default_project()


def _merge_video_input_specs(
    specs: list[dict[str, str]], bare_ids: list[str]
) -> list[dict[str, str]]:
    """Append plain asset ids as reference inputs, keeping explicit roles.

    Role-rich specs (board edges, ``input_roles``, iterate links) win over the
    same asset arriving again as a bare id (e.g. resume-injected imports).
    """

    merged = [dict(item) for item in specs if item.get("asset_id")]
    seen = {item["asset_id"] for item in merged}
    for asset_id in bare_ids:
        asset_id = str(asset_id or "").strip()
        if not asset_id or asset_id in seen:
            continue
        merged.append({"asset_id": asset_id, "role": "reference"})
        seen.add(asset_id)
    return merged


def _collect_character_reference_assets(
    store: Any,
    project_id: str,
    character_ids: list[str],
    selected_option: dict[str, Any],
) -> tuple[list[str], str]:
    """Resolve library characters into reference asset ids (three-view first).

    Returns ``(asset_ids, "")`` on success or ``([], error_message)`` when an id
    is unknown or the merged image references exceed the model's input budget.
    Pure asset assembly — never contacts a provider.
    """

    capabilities = dict((selected_option or {}).get("capabilities") or {})
    limits = capabilities.get("max_inputs") or {}
    try:
        if isinstance(limits, dict):
            max_images = max(0, int(limits.get("image") or 0))
        else:
            max_images = max(0, int(limits or 0))
    except (TypeError, ValueError):
        max_images = 0
    assets: list[str] = []
    for character_id in character_ids:
        character = store.get_character(project_id, character_id)
        if character is None:
            return [], f"Character {character_id} was not found in this project's library."
        three_view = str(character.get("three_view_asset_id") or "").strip()
        if three_view:
            assets.append(three_view)
        assets.extend(
            str(asset_id)
            for asset_id in (character.get("reference_asset_ids") or [])
            if str(asset_id or "").strip()
        )
    if not assets:
        return [], "The selected characters have no reference images yet."
    if max_images and len(assets) > max_images:
        return [], (
            f"The selected characters provide {len(assets)} reference images, but this "
            f"model accepts at most {max_images} image input(s). Drop characters or "
            "clear some reference images first."
        )
    return assets, ""


def _video_board_list_text(summary: dict[str, Any], project_id: str) -> str:
    nodes = (summary or {}).get("nodes") or []
    if not nodes:
        return f"The Video Studio canvas is empty for project {project_id}."
    lines = [
        f"Video Studio canvas ({project_id}), "
        f"{summary.get('node_count') or len(nodes)} nodes, "
        f"{summary.get('edge_count') or 0} edges:"
    ]
    for node in nodes:
        label = node.get("title") or node.get("kind") or ""
        status = f" status={node['status']}" if node.get("status") else ""
        job = f" job={node['jobId']}" if node.get("jobId") else ""
        asset = f" asset={node['assetId']}" if node.get("assetId") else ""
        shot = f" shot={node['storyboardShotId']}" if node.get("storyboardShotId") else ""
        lines.append(f"- {node.get('id')} · {node.get('kind')} · {label}{status}{job}{asset}{shot}")
    lines.append(
        "Use board_node_id or iterate_from with one of these ids. "
        "Template placement and this listing are free; each video job still needs "
        "its own confirmed message."
    )
    return "\n".join(lines)


def _video_storyboard_list_text(store: Any, project_id: str) -> str:
    try:
        storyboard = store.get_storyboard(project_id)
    except (AttributeError, KeyError, TypeError, ValueError, OSError):
        return ""
    shots = [item for item in (storyboard.get("shots") or []) if isinstance(item, dict)]
    if not shots:
        return f"The storyboard strip is empty for project {project_id}."
    lines = [f"Storyboard ({project_id}), {len(shots)} shot(s):"]
    for index, shot in enumerate(shots, start=1):
        title = shot.get("title") or "untitled"
        job = f" job={shot['job_id']}" if shot.get("job_id") else ""
        lines.append(f"- {index} · {shot.get('id')} · {title}{job}")
    lines.append(
        "Generate one shot with storyboard_shot_id set to its id or 1-based "
        "index ('1', 'shot 2', '第3镜')."
    )
    return "\n".join(lines)


def _video_character_list_text(characters: list[dict[str, Any]], project_id: str) -> str:
    if not characters:
        return (
            f"The character library is empty for video project {project_id}. "
            "Characters are created in the Video Studio panel (or via the "
            "characters API); plan_episode can then attach them per shot."
        )
    lines = [f"Character library ({project_id}), {len(characters)} character(s):"]
    for character in characters:
        three_view = " three-view=ready" if character.get("three_view_asset_id") else ""
        voice = f" voice={character['voice_hint']}" if character.get("voice_hint") else ""
        refs = len(character.get("reference_asset_ids") or [])
        lines.append(
            f"- {character['id']} · {character.get('name') or 'unnamed'} · "
            f"refs={refs}{three_view}{voice}"
        )
    lines.append(
        "Pass these ids as character_ids (comma-separated) on a generate call, or "
        "as shots[].characters in plan_episode — both are free asset assembly."
    )
    return "\n".join(lines)


def _parse_episode_shots(raw: Any) -> list[dict[str, Any]]:
    """Parse the LLM-authored ``shots`` JSON array for plan_episode."""

    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(
                "shots must be a JSON array like "
                '[{"title": "...", "prompt": "...", "duration": 5}].'
            ) from exc
    else:
        parsed = raw
    if not isinstance(parsed, list) or not parsed:
        raise ValueError(
            "plan_episode requires a non-empty shots JSON array: "
            '[{"title": "...", "prompt": "...", "duration": 5}].'
        )
    if len(parsed) > _PLAN_EPISODE_MAX_SHOTS:
        raise ValueError(f"plan_episode accepts at most {_PLAN_EPISODE_MAX_SHOTS} shots per call.")
    shots: list[dict[str, Any]] = []
    for index, item in enumerate(parsed, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"Shot {index} must be an object with title and prompt.")
        prompt = str(item.get("prompt") or "").strip()
        if not prompt:
            raise ValueError(f"Shot {index} is missing a prompt.")
        title = str(item.get("title") or "").strip()[:160] or f"Shot {index}"
        keyframe_prompt = str(item.get("keyframe_prompt") or "").strip()[:20_000]
        raw_characters = item.get("characters")
        if raw_characters is None:
            raw_characters = item.get("character_ids")
        if isinstance(raw_characters, str):
            raw_characters = [part.strip() for part in raw_characters.split(",") if part.strip()]
        if raw_characters is not None and not isinstance(raw_characters, list):
            raise ValueError(f"Shot {index} characters must be an array of character ids.")
        character_ids = [
            str(entry or "").strip() for entry in (raw_characters or []) if str(entry or "").strip()
        ][:10]
        duration: float | None = None
        raw_duration = item.get("duration")
        if raw_duration not in (None, ""):
            try:
                duration = float(raw_duration)
            except (TypeError, ValueError) as exc:
                raise ValueError(f"Shot {index} duration must be numeric.") from exc
            if not 0 < duration <= 3600:
                raise ValueError(f"Shot {index} duration is out of range.")
        # C4 camera control: a free-form short motion label ("push", "pan-left").
        # Trimmed like the storyboard normalizer; empty stays unset.
        camera = str(item.get("camera") or "").strip()[:64]
        shots.append(
            {
                "title": title,
                "prompt": prompt[:20_000],
                "keyframe_prompt": keyframe_prompt,
                "duration": duration,
                "camera": camera,
                "character_ids": character_ids,
            }
        )
    return shots


def _plan_episode_result(
    store: Any,
    kwargs: dict[str, Any],
    *,
    session_id: str | None,
    language: str,
) -> ToolResult:
    """Write an LLM-authored shot list to storyboard + canvas. Zero jobs.

    This is the planning half of “一句话短剧”: the storyboard strip and the
    canvas generate cards are filled in, but no provider is contacted and no
    job is queued. Rendering stays one confirmed job per shot per message.
    """

    from knorvia.services.video_studio.board import import_storyboard_shots

    try:
        shots = _parse_episode_shots(kwargs.get("shots"))
    except ValueError as exc:
        return ToolResult(content=str(exc), success=False)
    project_id = str(kwargs.get("project_id") or "").strip()
    if project_id:
        project = store.get_project(project_id)
        if not project:
            return ToolResult(content="Video Studio project not found.", success=False)
    else:
        project = _video_project_for_call(store, session_id)
    project_id = str(project["id"])

    shot_ids: list[str] = []
    authored: list[dict[str, Any]] = []

    def append_shots(document: dict[str, Any]) -> None:
        rows = document.get("shots") or []
        for offset, shot in enumerate(shots):
            shot_id = f"shot_{uuid.uuid4().hex}"
            row = {
                "id": shot_id,
                "order": len(rows),
                "title": shot["title"],
                "prompt": shot["prompt"],
                "keyframe_prompt": shot.get("keyframe_prompt") or "",
                "character_ids": list(shot.get("character_ids") or []),
                "input_asset_ids": [],
                "job_id": None,
                "output_asset_id": None,
                "duration": shot["duration"],
                "camera": shot.get("camera") or "",
                "notes": "",
                "transition": "",
            }
            rows.append(row)
            shot_ids.append(shot_id)
            authored.append({**shot, "id": shot_id})
        document["shots"] = rows

    try:
        store.update_storyboard(project_id, append_shots)
    except (KeyError, ValueError) as exc:
        return ToolResult(content=f"Could not write the storyboard: {exc}", success=False)

    placed = {"imported": 0, "skipped": 0}

    def place_cards(document: dict[str, Any]) -> None:
        placed["imported"], placed["skipped"] = import_storyboard_shots(document, authored)

    try:
        store.update_board(project_id, place_cards)
    except (KeyError, ValueError) as exc:
        return ToolResult(
            content=(
                f"Storyboard shots written ({len(shot_ids)}), but the canvas update failed: {exc}"
            ),
            success=False,
            metadata={"video_studio_project_id": project_id, "shot_ids": shot_ids},
        )

    zh = str(language).startswith("zh")
    listing = "\n".join(
        f"- {index} · {shot_id} · {shot['title']}"
        for index, (shot_id, shot) in enumerate(zip(shot_ids, shots), start=1)
    )
    project_title = str(project.get("title") or project_id)
    open_url = _video_studio_open_url(project_id, view="storyboard")
    if zh:
        content = (
            f"已写入项目「{project_title}」的 {len(shot_ids)} 个分镜"
            f"（storyboard），并在画布放置 {placed['imported']} 张生成卡。"
            f"未创建任何视频任务、未调用任何模型。\n"
            f"{listing}\n"
            "请逐条消息对每个分镜说“生成第 1 镜”来确认（会落在当前视频工作台"
            "项目），一次只提交一个任务。"
        )
    else:
        content = (
            f"Wrote {len(shot_ids)} storyboard shots into project "
            f"“{project_title}” and placed {placed['imported']} canvas generate "
            "cards. No video jobs were created and no provider was called.\n"
            f"{listing}\n"
            "Ask for each shot in its own message ('generate shot 1') — one paid "
            "job per confirmed message, on this same Video Studio project."
        )
    return ToolResult(
        content=content,
        success=True,
        metadata={
            "action": "plan_episode",
            "video_studio_project_id": project_id,
            "shot_ids": shot_ids,
            "board_nodes_placed": placed["imported"],
            "board_nodes_skipped": placed["skipped"],
            "jobs_created": 0,
            "open_url": open_url,
        },
    )


def _analyze_script_result(
    store: Any,
    kwargs: dict[str, Any],
    *,
    session_id: str | None,
    language: str,
) -> ToolResult:
    """Parse a script into the project's production review stage. Zero jobs."""

    from knorvia.services.video_studio.production import (
        MAX_SCRIPT_CHARS,
        analyze_script,
        detect_script_language,
        normalize_production,
    )

    project = _resolve_video_project_for_kwargs(store, kwargs, session_id)
    if not project:
        return ToolResult(content="Video Studio project not found.", success=False)
    project_id = str(project["id"])
    try:
        production = store.get_production(project_id)["production"]
    except (AttributeError, KeyError, TypeError, ValueError) as exc:
        return ToolResult(content=f"Could not load production: {exc}", success=False)
    supplied = str(kwargs.get("prompt") or "").strip()
    text = supplied or str((production.get("script") or {}).get("text") or "").strip()
    if not text:
        return ToolResult(
            content=(
                "analyze_script needs a script in 'prompt', or a production "
                "script already stored on this Video Studio project."
            ),
            success=False,
        )
    title = str(kwargs.get("title") or (production.get("script") or {}).get("title") or "").strip()
    if not title:
        title = text.splitlines()[0].strip()[:160]
    stored_language = str((production.get("script") or {}).get("language") or "")
    if supplied:
        lang = detect_script_language(text)
        production["script"]["source"] = "agent"
    elif stored_language in {"zh", "en"}:
        lang = stored_language
    else:
        lang = detect_script_language(text)
    try:
        analysis = analyze_script(text, title=title, language=lang)
    except ValueError as exc:
        return ToolResult(content=str(exc), success=False)
    production["script"]["text"] = text[:MAX_SCRIPT_CHARS]
    production["script"]["title"] = title
    production["script"]["language"] = lang
    production["analysis"] = analysis
    production["stage"] = "review"
    production["review"]["status"] = "draft"
    production["review"]["confirmed_at"] = None
    try:
        store.save_production(project_id, normalize_production(production))
    except (KeyError, ValueError) as exc:
        return ToolResult(content=f"Could not save the production: {exc}", success=False)
    shot_count = len(analysis.get("shots") or [])
    scene_count = len(analysis.get("scenes") or [])
    cast_count = len(analysis.get("characters") or [])
    zh = str(language).startswith("zh")
    project_title = str(project.get("title") or project_id)
    if zh:
        content = (
            f"已把剧本写入项目「{project_title}」的制作台（审阅阶段）："
            f"{scene_count} 场、{cast_count} 个角色、{shot_count} 个分镜草稿。"
            "未改写分镜条、未创建任务。请在视频工作台确认后再 apply_production，"
            "或直接在工作台点应用。"
        )
    else:
        content = (
            f"Wrote the script into project “{project_title}” at the production "
            f"review stage: {scene_count} scene(s), {cast_count} character(s), "
            f"{shot_count} draft shot(s). The storyboard was not changed and no "
            "jobs were created. Confirm the review in Video Studio, then call "
            "apply_production (or apply it there)."
        )
    return ToolResult(
        content=content,
        success=True,
        metadata={
            "action": "analyze_script",
            "video_studio_project_id": project_id,
            "shot_count": shot_count,
            "scene_count": scene_count,
            "character_count": cast_count,
            "jobs_created": 0,
            "open_url": _video_studio_open_url(project_id, view="production"),
        },
    )


def _apply_production_result(
    store: Any,
    kwargs: dict[str, Any],
    *,
    session_id: str | None,
    language: str,
) -> ToolResult:
    """Write a confirmed production review onto the storyboard. Free."""

    from knorvia.services.video_studio.production import apply_production

    project = _resolve_video_project_for_kwargs(store, kwargs, session_id)
    if not project:
        return ToolResult(content="Video Studio project not found.", success=False)
    project_id = str(project["id"])
    try:
        result = apply_production(store, project_id, replace=False, place_on_board=True)
    except ValueError as exc:
        return ToolResult(content=str(exc), success=False)
    except KeyError:
        return ToolResult(content="Video Studio project not found.", success=False)
    shots = (result.get("storyboard") or {}).get("shots") or []
    shot_ids = [str(shot.get("id") or "") for shot in shots if shot.get("id")]
    placed = result.get("board") or {}
    zh = str(language).startswith("zh")
    project_title = str(project.get("title") or project_id)
    if zh:
        content = (
            f"已把已确认的剧本应用到项目「{project_title}」：写入 "
            f"{len(shot_ids)} 个分镜，画布新增 {placed.get('imported') or 0} 张"
            "生成卡。未创建任何视频任务。"
        )
    else:
        content = (
            f"Applied the confirmed script to project “{project_title}”: "
            f"wrote {len(shot_ids)} storyboard shot(s) and placed "
            f"{placed.get('imported') or 0} canvas card(s). No video jobs "
            "were created."
        )
    return ToolResult(
        content=content,
        success=True,
        metadata={
            "action": "apply_production",
            "video_studio_project_id": project_id,
            "shot_ids": shot_ids,
            "board_nodes_placed": placed.get("imported") or 0,
            "board_nodes_skipped": placed.get("skipped") or 0,
            "jobs_created": 0,
            "open_url": _video_studio_open_url(project_id, view="storyboard"),
        },
    )


__all__ = ["ImagegenTool", "VideogenTool"]
