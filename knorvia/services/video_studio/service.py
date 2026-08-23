from __future__ import annotations

import json
import math
import random
from typing import Any

from knorvia.multi_user.model_access import allowed_videogen_options

from .engine import capture_video_authorization, start_video_job
from .store import INPUT_ROLES, MAX_PROVIDER_INPUT_BYTES, VideoStudioStore

OPERATIONS = frozenset(
    {"text_to_video", "image_to_video", "video_to_video", "extend", "remix", "edit"}
)
BASE_PARAMETERS = frozenset(
    {"duration", "aspect_ratio", "resolution", "fps", "audio_mode", "reference_mode", "seed"}
)
ROLE_KINDS = {
    "reference": None,
    "first-frame": "image",
    "last-frame": "image",
    "audio": "audio",
    "continue-from": "video",
}
FRAME_ROLES = {"first-frame", "last-frame"}


def find_video_option(profile_id: str, model_id: str) -> dict[str, Any]:
    option = next(
        (
            item
            for item in allowed_videogen_options().get("options", [])
            if str(item.get("profile_id") or "") == profile_id
            and str(item.get("model_id") or "") == model_id
        ),
        None,
    )
    if option is None:
        raise PermissionError("This video model is not assigned to your account.")
    return option


def _matches_type(value: Any, expected: str) -> bool:
    if expected == "string":
        return isinstance(value, str)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "array":
        return isinstance(value, list)
    if expected == "object":
        return isinstance(value, dict)
    if expected == "null":
        return value is None
    return False


def _validate_schema_value(
    value: Any,
    schema: dict[str, Any],
    field: str,
    depth: int = 0,
    *,
    allow_implicit_additional: bool = False,
) -> None:
    if depth > 4 or "$ref" in schema:
        raise ValueError(f"Unsupported parameter schema for {field}")
    for keyword in ("anyOf", "oneOf"):
        if keyword not in schema:
            continue
        branches = schema[keyword]
        if (
            not isinstance(branches, list)
            or not 1 <= len(branches) <= 8
            or not all(isinstance(branch, dict) for branch in branches)
        ):
            raise ValueError(f"Unsupported parameter schema for {field}")
        matches = 0
        for branch in branches:
            try:
                _validate_schema_value(
                    value,
                    branch,
                    field,
                    depth + 1,
                    allow_implicit_additional=allow_implicit_additional,
                )
            except ValueError:
                continue
            matches += 1
        if (keyword == "anyOf" and matches < 1) or (keyword == "oneOf" and matches != 1):
            raise ValueError(f"Video parameter does not match {keyword}: {field}")
    raw_types = schema.get("type")
    if raw_types is not None and not isinstance(raw_types, (str, list)):
        raise ValueError(f"Unsupported parameter schema for {field}")
    types = [raw_types] if isinstance(raw_types, str) else list(raw_types or [])
    if any(not isinstance(item, str) for item in types):
        raise ValueError(f"Unsupported parameter schema for {field}")
    if types and not any(_matches_type(value, str(item)) for item in types):
        raise ValueError(f"Invalid type for video parameter: {field}")
    if "enum" in schema:
        enum = schema.get("enum")
        if not isinstance(enum, list) or len(enum) > 100:
            raise ValueError(f"Unsupported parameter schema for {field}")
        if value not in enum:
            raise ValueError(f"Unsupported value for video parameter: {field}")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if not math.isfinite(value):
            raise ValueError(f"Video parameter must be finite: {field}")
        if "minimum" in schema and value < float(schema["minimum"]):
            raise ValueError(f"Video parameter is below minimum: {field}")
        if "maximum" in schema and value > float(schema["maximum"]):
            raise ValueError(f"Video parameter is above maximum: {field}")
    if isinstance(value, str):
        if len(value) < int(schema.get("minLength") or 0):
            raise ValueError(f"Video parameter is too short: {field}")
        if len(value) > min(int(schema.get("maxLength") or 10_000), 10_000):
            raise ValueError(f"Video parameter is too long: {field}")
    if isinstance(value, list):
        if len(value) > min(int(schema.get("maxItems") or 50), 50):
            raise ValueError(f"Video parameter has too many items: {field}")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                _validate_schema_value(item, item_schema, f"{field}[{index}]", depth + 1)
    if isinstance(value, dict):
        properties = schema.get("properties") or {}
        if not isinstance(properties, dict):
            raise ValueError(f"Unsupported parameter schema for {field}")
        required = schema.get("required") or []
        if (
            not isinstance(required, list)
            or len(required) > 50
            or not all(isinstance(item, str) for item in required)
        ):
            raise ValueError(f"Unsupported parameter schema for {field}")
        missing = [item for item in required if item not in value]
        if missing:
            raise ValueError(f"Required video parameter is missing: {field}.{missing[0]}")
        permits_additional = schema.get("additionalProperties") is True or (
            allow_implicit_additional and "additionalProperties" not in schema
        )
        if not permits_additional:
            unknown = sorted(set(value) - set(properties))
            if unknown:
                raise ValueError(f"Unsupported video parameter: {field}.{unknown[0]}")
        for key, child in value.items():
            child_schema = properties.get(key)
            if isinstance(child_schema, dict):
                _validate_schema_value(child, child_schema, f"{field}.{key}", depth + 1)


def _validate_parameters(parameters: dict[str, Any], capabilities: dict[str, Any]) -> None:
    if len(json.dumps(parameters, ensure_ascii=False).encode("utf-8")) > 32 * 1024:
        raise ValueError("Video parameters exceed the size limit")
    schema = capabilities.get("parameter_schema") or {}
    if not isinstance(schema, dict):
        raise ValueError("Invalid video parameter schema")
    if schema:
        # Validate the document itself, not only named properties. This makes a
        # root anyOf/oneOf contract enforceable. At that root boundary JSON
        # Schema's unspecified additionalProperties default remains permissive;
        # explicit false is still fail-closed, and the legacy non-union path
        # below continues to restrict undeclared fields to BASE_PARAMETERS.
        _validate_schema_value(
            parameters,
            schema,
            "parameters",
            allow_implicit_additional=True,
        )
    root_union = "anyOf" in schema or "oneOf" in schema
    properties = schema.get("properties")
    allowed = set(properties) if isinstance(properties, dict) else set(BASE_PARAMETERS)
    if not root_union and schema.get("additionalProperties") is not True:
        unsupported = sorted(set(parameters) - allowed)
        if unsupported:
            raise ValueError(f"Unsupported video parameter: {unsupported[0]}")
    if not root_union and isinstance(properties, dict):
        required = schema.get("required") or []
        if (
            not isinstance(required, list)
            or len(required) > 50
            or not all(isinstance(item, str) for item in required)
        ):
            raise ValueError("Invalid video parameter schema")
        missing = [item for item in required if item not in parameters]
        if missing:
            raise ValueError(f"Required video parameter is missing: {missing[0]}")
        for field, value in parameters.items():
            field_schema = properties.get(field)
            if isinstance(field_schema, dict):
                _validate_schema_value(value, field_schema, field)
    list_fields = {
        "duration": "durations",
        "aspect_ratio": "aspect_ratios",
        "resolution": "resolutions",
        "fps": "fps",
        "audio_mode": "audio_modes",
        "reference_mode": "reference_modes",
    }
    for field, capability in list_fields.items():
        value = parameters.get(field)
        supported = capabilities.get(capability) or []
        if value is None or value == "" or not supported:
            continue
        normalized = str(value).lower()
        if not any(str(item).lower() == normalized for item in supported):
            raise ValueError(f"Unsupported {field.replace('_', ' ')}")
    if "seed" in parameters:
        if capabilities.get("supports_seed") is not True:
            raise ValueError("The selected video model does not support seed")
        seed = parameters["seed"]
        if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed <= 2**32 - 1:
            raise ValueError("Video seed must be an integer between 0 and 4294967295")


def _input_specs(
    input_asset_ids: list[str] | None,
    inputs: list[dict[str, Any]] | None,
    input_roles: list[str] | None = None,
) -> list[dict[str, str]]:
    """Normalize the id list / role-aware inputs into [{asset_id, role}] pairs."""
    if input_asset_ids is not None and not isinstance(input_asset_ids, list):
        raise ValueError("Video input asset ids must be a list")
    ids = [str(item) for item in input_asset_ids or []]
    if inputs and ids:
        raise ValueError("Pass either input_asset_ids or inputs, not both")
    specs: list[dict[str, str]] = []
    if inputs is not None:
        if not isinstance(inputs, list):
            raise ValueError("Video inputs must be a list")
        for item in inputs:
            if not isinstance(item, dict):
                raise ValueError("Video inputs must be objects with asset_id and role")
            specs.append(
                {
                    "asset_id": str(item.get("asset_id") or ""),
                    "role": str(item.get("role") or "reference"),
                }
            )
    else:
        specs = [{"asset_id": item, "role": "reference"} for item in ids]
    if input_roles:
        if len(input_roles) != len(specs):
            raise ValueError("input_roles must parallel input_asset_ids")
        specs = [{**spec, "role": str(role)} for spec, role in zip(specs, input_roles)]
    for spec in specs:
        if spec["role"] not in INPUT_ROLES:
            raise ValueError("Invalid video input role")
    deduped: list[dict[str, str]] = []
    seen: set[str] = set()
    for spec in specs:
        if spec["asset_id"] in seen:
            continue
        seen.add(spec["asset_id"])
        deduped.append(spec)
    return deduped


def _derive_input_roles(
    specs: list[dict[str, str]], kinds: dict[str, str], parameters: dict[str, Any]
) -> list[dict[str, str]]:
    """Map reference images to frame roles following reference_mode.

    ``auto`` with exactly one image pins that image as the first frame;
    ``first-frame``/``first-last`` map positionally like the AIPAI toolbar
    (index 0 first frame, index 1 last frame). Extra images stay references.
    """
    mode = str(parameters.get("reference_mode") or "auto")
    image_indexes = [
        index for index, spec in enumerate(specs) if kinds[spec["asset_id"]] == "image"
    ]
    upgraded = [dict(spec) for spec in specs]
    if mode == "first-last":
        if len(image_indexes) < 2:
            raise ValueError("First-and-last-frame references require two images")
        upgraded[image_indexes[0]]["role"] = "first-frame"
        upgraded[image_indexes[1]]["role"] = "last-frame"
    elif (mode == "first-frame" and image_indexes) or (
        mode in {"auto", ""} and len(image_indexes) == 1
    ):
        upgraded[image_indexes[0]]["role"] = "first-frame"
    return upgraded


def _validate_inputs(
    store: VideoStudioStore,
    project_id: str,
    operation: str,
    specs: list[dict[str, str]],
    capabilities: dict[str, Any],
    parameters: dict[str, Any],
) -> list[dict[str, str]]:
    if len(specs) > 50 or any(
        not spec["asset_id"] or len(spec["asset_id"]) > 160 for spec in specs
    ):
        raise ValueError("Invalid video input asset list")
    counts = {"image": 0, "video": 0, "audio": 0}
    kinds: dict[str, str] = {}
    total_bytes = 0
    # One bulk load instead of one connection per input spec.
    loaded: dict[str, dict[str, Any]] = {}
    if specs:
        loaded = store.get_assets_by_ids([spec["asset_id"] for spec in specs])
    for spec in specs:
        asset = loaded.get(spec["asset_id"])
        if not asset or asset["project_id"] != project_id:
            raise ValueError("Input assets must belong to the video project")
        kind = str(asset.get("kind") or "")
        if kind not in counts:
            raise ValueError("Unsupported video input asset")
        kinds[spec["asset_id"]] = kind
        counts[kind] += 1
        total_bytes += int(asset.get("size_bytes") or 0)
        expected_kind = ROLE_KINDS.get(spec["role"])
        if expected_kind and kind != expected_kind:
            raise ValueError(f"A {spec['role']} input must be an {expected_kind}")
    if total_bytes > 0:
        try:
            configured_bytes = int(capabilities.get("max_input_bytes") or MAX_PROVIDER_INPUT_BYTES)
        except (TypeError, ValueError) as exc:
            raise ValueError("Invalid video input byte limit") from exc
        if configured_bytes <= 0:
            raise ValueError("Invalid video input byte limit")
        if total_bytes > min(configured_bytes, MAX_PROVIDER_INPUT_BYTES):
            raise ValueError("Video inputs exceed the provider transfer limit")
    limits = capabilities.get("max_inputs") or {}
    if isinstance(limits, int):
        limits = {"total": limits, "image": limits, "video": limits, "audio": limits}
    if not isinstance(limits, dict):
        raise ValueError("Invalid video input limits")
    try:
        parsed_limits = {
            key: max(0, int(limits.get(key) or 0)) for key in ("image", "video", "audio", "total")
        }
    except (TypeError, ValueError) as exc:
        raise ValueError("Invalid video input limits") from exc
    for kind, count in counts.items():
        if count > parsed_limits[kind]:
            raise ValueError(f"Too many {kind} inputs for this video model")
    if sum(counts.values()) > parsed_limits["total"]:
        raise ValueError("Too many input assets for this video model")
    if operation == "text_to_video":
        if counts["image"] or counts["video"]:
            raise ValueError("Text-to-video accepts only optional audio references")
        if counts["audio"] and str(parameters.get("audio_mode") or "") != "input":
            raise ValueError("Audio references require audio_mode=input")
    if operation == "image_to_video" and counts["image"] < 1:
        raise ValueError("Image-to-video requires an image")
    if operation in {"video_to_video", "remix"} and counts["video"] < 1:
        raise ValueError("This video operation requires a video")
    if operation == "extend" and counts["video"] < 1:
        # Extend continues from the source clip (its last frame is derived
        # locally, or the provider extends natively); both paths need the video.
        raise ValueError("Extending requires the source video to continue from")
    if operation == "edit" and not specs:
        raise ValueError("Video edit requires an input asset")
    return _derive_input_roles(specs, kinds, parameters)


def validate_video_job_plan(
    store: VideoStudioStore,
    *,
    project_id: str,
    profile_id: str,
    model_id: str,
    operation: str,
    prompt: str,
    input_asset_ids: list[str] | None,
    parameters: dict[str, Any] | None,
    storyboard_shot_id: str | None = None,
    board_node_id: str | None = None,
    inputs: list[dict[str, Any]] | None = None,
    input_roles: list[str] | None = None,
) -> dict[str, Any]:
    """Validate and normalize one plan without persisting or calling a provider.

    Both the UI submission path and the Agent's pre-confirmation preview call
    this function, so a user is never asked to approve a plan that the durable
    submission path already knows is invalid.  Callers must still validate
    again at submission time because grants, catalog data, assets and
    storyboards can change while the confirmation card is open.
    """

    operation = str(operation or "").replace("-", "_")
    if operation not in OPERATIONS:
        raise ValueError("Invalid video operation")
    option = find_video_option(profile_id, model_id)
    capabilities = dict(option.get("capabilities") or {})
    if operation not in set(capabilities.get("operations") or ["text_to_video"]):
        raise ValueError("The selected model does not support this video operation")
    prompt = str(prompt or "").strip()
    maximum = min(20_000, max(1, int(capabilities.get("max_prompt_length") or 20_000)))
    if not prompt or len(prompt) > maximum:
        raise ValueError("A valid video prompt is required")
    raw_defaults = option.get("defaults") or {}
    if not isinstance(raw_defaults, dict):
        raise ValueError("Invalid video model defaults")
    defaults = {key: value for key, value in raw_defaults.items() if value != ""}
    if parameters is not None and not isinstance(parameters, dict):
        raise ValueError("Video parameters must be an object")
    requested = {**defaults, **dict(parameters or {})}
    _validate_parameters(requested, capabilities)
    specs = _input_specs(input_asset_ids, inputs, input_roles)
    specs = _validate_inputs(store, project_id, operation, specs, capabilities, requested)
    if storyboard_shot_id:
        board = store.get_storyboard(project_id)
        if not any(shot.get("id") == storyboard_shot_id for shot in board["shots"]):
            raise ValueError("Storyboard shot not found")
    if board_node_id:
        document = store.get_board(project_id)
        node = next(
            (item for item in document.get("nodes") or [] if item.get("id") == board_node_id),
            None,
        )
        if not node or node.get("kind") != "generate":
            raise ValueError("Board generate node not found")
    return {
        "operation": operation,
        "prompt": prompt,
        "input_asset_ids": [spec["asset_id"] for spec in specs],
        "inputs": specs,
        "parameters": requested,
    }


def create_video_job(
    store: VideoStudioStore,
    *,
    project_id: str,
    profile_id: str,
    model_id: str,
    operation: str,
    prompt: str,
    input_asset_ids: list[str] | None,
    parameters: dict[str, Any] | None,
    client_request_id: str,
    confirmed_cost: bool,
    retry_of_job_id: str | None = None,
    storyboard_shot_id: str | None = None,
    board_node_id: str | None = None,
    inputs: list[dict[str, Any]] | None = None,
    input_roles: list[str] | None = None,
) -> dict[str, Any]:
    """Authorize, validate, persist and enqueue exactly one paid video task."""
    if confirmed_cost is not True:
        raise PermissionError("Video generation requires explicit cost confirmation.")
    plan = validate_video_job_plan(
        store,
        project_id=project_id,
        profile_id=profile_id,
        model_id=model_id,
        operation=operation,
        prompt=prompt,
        input_asset_ids=input_asset_ids,
        parameters=parameters,
        storyboard_shot_id=storyboard_shot_id,
        board_node_id=board_node_id,
        inputs=inputs,
        input_roles=input_roles,
    )
    authorization = capture_video_authorization(profile_id, model_id)
    job = store.create_job(
        project_id,
        {
            "operation": plan["operation"],
            "profile_id": profile_id,
            "model_id": model_id,
            "prompt": plan["prompt"],
            "inputs": plan["inputs"],
            "parameters": plan["parameters"],
            "client_request_id": client_request_id,
            "retry_of_job_id": retry_of_job_id,
            "storyboard_shot_id": storyboard_shot_id,
            "board_node_id": board_node_id,
            **authorization,
        },
    )
    if storyboard_shot_id:
        try:
            store.patch_storyboard_shot_job(project_id, storyboard_shot_id, job["id"])
        except Exception:
            store.transition_terminal(
                job["id"],
                "interrupted",
                error_code="storyboard_conflict",
                error_message="The storyboard changed before this video job could be linked.",
            )
            raise
    if board_node_id:
        try:
            store.patch_board_node_job(project_id, board_node_id, job["id"])
        except Exception:
            store.transition_terminal(
                job["id"],
                "interrupted",
                error_code="board_conflict",
                error_message="The canvas changed before this video job could be linked.",
            )
            raise
    start_video_job(store, job["id"])
    return job


def create_agent_video_job(**kwargs: Any) -> dict[str, Any]:
    """Stable Agent integration entry point; never bypasses grants or confirmation."""
    return create_video_job(**kwargs)


def reroll_parameters(
    parameters: dict[str, Any] | None, capabilities: dict[str, Any] | None
) -> dict[str, Any]:
    """§Phase C5: copy a finished job's parameters for a reroll.

    Everything — including the C4 ``camera*`` enum parameters — rides along
    verbatim; only the seed is refreshed, and only for models that declare
    ``supports_seed`` (seedless models resubmit with the seed dropped, since
    validation would reject it anyway).
    """
    params = dict(parameters or {})
    if (capabilities or {}).get("supports_seed") is True:
        params["seed"] = random.randint(0, 2**32 - 1)
    else:
        params.pop("seed", None)
    return params


MAX_KEYFRAME_PROMPT = 20_000
MAX_VOICEOVER_TEXT = 20_000
STORABLE_TTS_FORMATS = frozenset({"mp3", "wav"})
VOICEOVER_FORMAT_MIME = {"mp3": "audio/mpeg", "wav": "audio/wav"}


def _find_shot(store: VideoStudioStore, project_id: str, shot_id: str) -> dict[str, Any]:
    if not shot_id or len(shot_id) > 128:
        raise ValueError("Storyboard shot not found")
    board = store.get_storyboard(project_id)
    shot = next((item for item in board["shots"] if item.get("id") == shot_id), None)
    if shot is None:
        raise ValueError("Storyboard shot not found")
    return shot


async def _probe_audio_duration(store: VideoStudioStore, data: bytes) -> float | None:
    """Best-effort duration probe; missing ffmpeg leaves the column empty."""
    from uuid import uuid4

    from knorvia.services.video_studio.ffmpeg_tool import (
        FFmpegFailedError,
        FFmpegUnavailableError,
        get_ffmpeg_tool,
    )

    temporary = store.uploads_root / f"probe_{uuid4().hex}.tmp"
    try:
        temporary.write_bytes(data)
        probe = await get_ffmpeg_tool().probe_media(temporary)
    except (FFmpegUnavailableError, FFmpegFailedError):
        return None
    finally:
        temporary.unlink(missing_ok=True)
    duration = float(probe.duration or 0.0)
    return duration if duration > 0 else None


async def create_shot_voiceover(
    store: VideoStudioStore,
    *,
    project_id: str,
    shot_id: str,
    text: str,
    voice: str = "",
    response_format: str = "",
    confirmed_cost: bool = False,
) -> dict[str, Any]:
    """Synthesize one shot's narration through the shared TTS pipeline."""
    if confirmed_cost is not True:
        raise PermissionError("Voice synthesis requires explicit cost confirmation.")
    cleaned = str(text or "").strip()
    if not cleaned or len(cleaned) > MAX_VOICEOVER_TEXT:
        raise ValueError("A valid voiceover text is required")
    _find_shot(store, project_id, shot_id)
    requested = str(response_format or "").strip().lower()
    if requested not in STORABLE_TTS_FORMATS:
        requested = "mp3"

    from knorvia.services.voice import synthesize_speech
    from knorvia.services.voice.base import parse_pcm_content_type, pcm16_to_wav

    audio, content_type = await synthesize_speech(
        cleaned, voice=voice or None, response_format=requested
    )
    pcm_info = parse_pcm_content_type(content_type)
    if pcm_info:
        audio = pcm16_to_wav(audio, sample_rate=pcm_info[0], channels=pcm_info[1])
        content_type = "audio/wav"
    if content_type not in VOICEOVER_FORMAT_MIME.values():
        content_type = "audio/mpeg"
    duration = await _probe_audio_duration(store, audio)
    extension = ".wav" if content_type == "audio/wav" else ".mp3"
    asset = store.save_generated_audio(
        project_id,
        audio,
        content_type,
        filename=f"voiceover-{shot_id}{extension}",
        duration=duration,
    )

    def mutator(document: dict[str, Any]) -> None:
        for item in document["shots"]:
            if item.get("id") == shot_id:
                item["voiceover_text"] = cleaned
                item["voiceover_asset_id"] = asset["id"]
                item["voiceover_voice"] = str(voice or "")[:160]
                return
        raise ValueError("Storyboard shot not found")

    document = store.update_storyboard(project_id, mutator)
    return {"asset": asset, "duration": duration, "storyboard": document}


async def create_shot_keyframe(
    store: VideoStudioStore,
    *,
    project_id: str,
    shot_id: str,
    prompt: str,
    profile_id: str = "",
    model_id: str = "",
    size: str = "",
    aspect_ratio: str = "",
    confirmed_cost: bool = False,
) -> dict[str, Any]:
    """Generate a shot's first-frame image through the Image Studio channel."""
    if confirmed_cost is not True:
        raise PermissionError("Keyframe generation requires explicit cost confirmation.")
    shot = _find_shot(store, project_id, shot_id)
    base_prompt = str(shot.get("prompt") or "").strip()
    stored_keyframe_prompt = str(shot.get("keyframe_prompt") or "").strip()
    cleaned = str(prompt or "").strip() or stored_keyframe_prompt or base_prompt
    if not cleaned or len(cleaned) > MAX_KEYFRAME_PROMPT:
        raise ValueError("A valid keyframe prompt is required")

    from knorvia.services.image_studio.agent import plan_studio_job, run_studio_image_job
    from knorvia.services.image_studio.store import get_image_studio_store

    plan = plan_studio_job(
        prompt=cleaned,
        operation="generate",
        profile_id=profile_id,
        model_id=model_id,
        size=size,
        aspect_ratio=aspect_ratio,
    )
    # Keyframes are single native-resolution images; n>1 / upscaling would
    # multiply the paid call for no storyboard benefit.
    plan["parameters"]["n"] = 1
    plan["parameters"].pop("target_resolution", None)
    plan["parameters"].pop("upscale_model", None)
    result = await run_studio_image_job(plan)
    job = result.get("job") or {}
    outputs = [item for item in (job.get("outputs") or []) if item.get("asset_id")]
    if job.get("status") not in {"succeeded", "partial"} or not outputs:
        raise RuntimeError(
            str(job.get("error_message") or f"Keyframe job {job.get('status') or 'failed'}.")
        )
    image_store = get_image_studio_store()
    image_asset = image_store.get_asset(outputs[0]["asset_id"])
    if not image_asset:
        raise RuntimeError("The keyframe image is no longer available.")
    mime = str(image_asset.get("mime_type") or image_asset.get("mime") or "image/png")
    data = image_store.asset_path(image_asset["id"]).read_bytes()
    extension = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}.get(mime, ".png")
    asset = store.import_asset_bytes(
        project_id, data, mime, filename=f"keyframe-{shot_id}{extension}"
    )

    def mutator(document: dict[str, Any]) -> None:
        for item in document["shots"]:
            if item.get("id") == shot_id:
                item["keyframe_asset_id"] = asset["id"]
                return
        raise ValueError("Storyboard shot not found")

    document = store.update_storyboard(project_id, mutator)
    return {
        "asset": asset,
        "image_job_id": job.get("id"),
        "shot_prompt": base_prompt,
        "storyboard": document,
    }


THREE_VIEW_PROMPT_TEMPLATE = (
    "Character three-view reference sheet: front, side, and back full-body views "
    "of the same character in one image, consistent face, hairstyle, clothing, "
    "and color palette across all views, even studio light, clean light background."
)


async def create_character_three_view(
    store: VideoStudioStore,
    *,
    project_id: str,
    character_id: str,
    prompt: str = "",
    profile_id: str = "",
    model_id: str = "",
    size: str = "",
    aspect_ratio: str = "",
    confirmed_cost: bool = False,
) -> dict[str, Any]:
    """Generate a character's three-view sheet through the paid imagegen channel."""
    if confirmed_cost is not True:
        raise PermissionError("Three-view generation requires explicit cost confirmation.")
    character = store.get_character(project_id, character_id)
    if character is None:
        raise KeyError(character_id)
    name = str(character.get("name") or "").strip()
    description = str(character.get("description") or "").strip()
    override = str(prompt or "").strip()
    cleaned = override or " / ".join(part for part in (name, description) if part)
    cleaned = (
        f"{THREE_VIEW_PROMPT_TEMPLATE} {cleaned}".strip() if cleaned else THREE_VIEW_PROMPT_TEMPLATE
    )
    if len(cleaned) > MAX_KEYFRAME_PROMPT:
        raise ValueError("The three-view prompt is too long")
    reference_ids = list(character.get("reference_asset_ids") or [])
    if not reference_ids:
        raise ValueError("Add at least one reference image before generating a three-view sheet")

    from knorvia.services.image_studio.agent import plan_studio_job, run_studio_image_job
    from knorvia.services.image_studio.store import get_image_studio_store

    image_store = get_image_studio_store()
    image_project = image_store.ensure_default_project()
    bridged_ids: list[str] = []
    for asset_id in reference_ids[:3]:
        asset = store.get_asset(asset_id)
        if asset is None:
            raise ValueError(f"Unknown character reference asset: {asset_id}")
        data = store.asset_path(asset_id).read_bytes()
        imported = image_store.save_asset(
            image_project["id"], data, str(asset.get("mime_type") or "image/png"), kind="input"
        )
        bridged_ids.append(imported["id"])

    plan = plan_studio_job(
        prompt=cleaned,
        operation="edit",
        profile_id=profile_id,
        model_id=model_id,
        size=size,
        aspect_ratio=aspect_ratio,
        input_asset_ids=bridged_ids,
    )
    plan["parameters"]["n"] = 1
    plan["parameters"].pop("target_resolution", None)
    plan["parameters"].pop("upscale_model", None)
    result = await run_studio_image_job(plan)
    job = result.get("job") or {}
    outputs = [item for item in (job.get("outputs") or []) if item.get("asset_id")]
    if job.get("status") not in {"succeeded", "partial"} or not outputs:
        raise RuntimeError(
            str(job.get("error_message") or f"Three-view job {job.get('status') or 'failed'}.")
        )
    image_asset = image_store.get_asset(outputs[0]["asset_id"])
    if not image_asset:
        raise RuntimeError("The three-view image is no longer available.")
    mime = str(image_asset.get("mime_type") or image_asset.get("mime") or "image/png")
    data = image_store.asset_path(image_asset["id"]).read_bytes()
    extension = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}.get(mime, ".png")
    asset = store.import_asset_bytes(
        project_id, data, mime, filename=f"three-view-{character_id}{extension}"
    )
    updated = store.set_character_three_view(project_id, character_id, asset["id"])
    return {
        "asset": asset,
        "character": updated or character,
        "image_job_id": job.get("id"),
    }


__all__ = [
    "OPERATIONS",
    "create_agent_video_job",
    "create_character_three_view",
    "create_shot_keyframe",
    "create_shot_voiceover",
    "create_video_job",
    "find_video_option",
    "validate_video_job_plan",
]
