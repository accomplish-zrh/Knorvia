from __future__ import annotations

from abc import ABC, abstractmethod
import asyncio
import base64
from dataclasses import dataclass
import ipaddress
import json
from pathlib import Path
import socket
import time
from typing import Any
from urllib.parse import quote, urljoin, urlparse

import httpx
import jwt

from knorvia.services.generation_http import (
    GenerationProviderError,
    build_auth_headers,
    join_api_path,
    raise_for_provider,
)
from knorvia.services.videogen.config import VideogenConfig

from .store import MAX_OUTPUT_BYTES


@dataclass(frozen=True, slots=True)
class VideoInput:
    path: Path
    mime_type: str
    kind: str
    role: str = "reference"


# Wire roles follow the Volcengine / Ark content convention (snake_case).
_PROVIDER_ROLES = {"first-frame": "first_frame", "last-frame": "last_frame"}


@dataclass(frozen=True, slots=True)
class VideoPollResult:
    state: str
    progress: float = 0.0
    output_url: str = ""
    error: str = ""


class BaseVideoStudioAdapter(ABC):
    @abstractmethod
    async def submit(
        self,
        prompt: str,
        config: VideogenConfig,
        *,
        inputs: list[VideoInput],
        parameters: dict[str, Any],
        idempotency_key: str,
    ) -> str: ...

    @abstractmethod
    async def poll(self, task_id: str, config: VideogenConfig) -> VideoPollResult: ...

    @abstractmethod
    async def cancel(self, task_id: str, config: VideogenConfig) -> bool: ...

    @abstractmethod
    async def download(self, url: str, config: VideogenConfig, target: Path) -> str: ...


def _headers(config: VideogenConfig) -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        **build_auth_headers(config.auth_style, config.api_key),
        **(config.extra_headers or {}),
    }


def _task_path(task_id: str) -> str:
    return f"contents/generations/tasks/{quote(task_id, safe='')}"


async def _public_host(hostname: str) -> bool:
    try:
        records = await asyncio.to_thread(socket.getaddrinfo, hostname, None)
    except OSError:
        return False
    if not records:
        return False
    for record in records:
        try:
            address = ipaddress.ip_address(record[4][0])
        except ValueError:
            return False
        if not address.is_global:
            return False
    return True


def _origin(url: str) -> tuple[str, str, int]:
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.hostname:
        raise ValueError("invalid origin")
    port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    return parsed.scheme.lower(), parsed.hostname.lower(), port


async def validate_download_url(url: str, trusted_base_url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise GenerationProviderError("Video provider returned an unsafe output URL.")
    try:
        port = parsed.port
    except ValueError as exc:
        raise GenerationProviderError("Video provider returned an unsafe output URL.") from exc
    if parsed.username or parsed.password or port in {0, 22, 25, 445}:
        raise GenerationProviderError("Video provider returned an unsafe output URL.")
    try:
        trusted_origin = _origin(trusted_base_url)
    except ValueError as exc:
        raise GenerationProviderError("The configured video endpoint URL is invalid.") from exc
    if _origin(url) == trusted_origin:
        return
    if not await _public_host(parsed.hostname):
        raise GenerationProviderError("Video provider output URL resolves to a private address.")


class GenericAsyncVideoAdapter(BaseVideoStudioAdapter):
    """Common submit/poll/cancel/download bridge for task-style providers.

    The wire shape follows the configured Knorvia ``async_task`` provider.
    Reference media travels as base64 data-URI content parts with optional
    ``role`` markers for first/last frames; providers requiring another upload
    protocol get their own adapter instead of receiving a local filesystem path.
    """

    def __init__(self, *, transport: httpx.AsyncBaseTransport | None = None):
        self._transport = transport

    def _client(self, config: VideogenConfig, **kwargs: Any) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            timeout=config.request_timeout,
            transport=self._transport,
            follow_redirects=False,
            **kwargs,
        )

    @staticmethod
    def _content(prompt: str, inputs: list[VideoInput]) -> list[dict[str, Any]]:
        content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
        for item in inputs:
            if item.kind not in {"image", "video", "audio"}:
                raise GenerationProviderError(
                    f"The video adapter cannot send a {item.kind} reference."
                )
            # Task providers differ on reference upload protocols. A data URI is
            # explicit and self-contained; models that do not support it must
            # declare another adapter instead of receiving a local filesystem path.
            encoded = base64.b64encode(item.path.read_bytes()).decode("ascii")
            part: dict[str, Any] = {
                "type": f"{item.kind}_url",
                f"{item.kind}_url": {"url": f"data:{item.mime_type};base64,{encoded}"},
            }
            wire_role = _PROVIDER_ROLES.get(item.role)
            if wire_role:
                part["role"] = wire_role
            content.append(part)
        return content

    @classmethod
    def _payload(
        cls,
        prompt: str,
        config: VideogenConfig,
        inputs: list[VideoInput],
        parameters: dict[str, Any],
    ) -> dict[str, Any]:
        content = cls._content(prompt, inputs)
        payload: dict[str, Any] = {"model": config.model, "content": content}
        mapping = {
            "aspect_ratio": config.aspect_ratio,
            "duration": config.duration,
            "resolution": config.resolution,
            "fps": parameters.get("fps"),
            "seed": parameters.get("seed"),
            "audio_mode": parameters.get("audio_mode"),
            "reference_mode": parameters.get("reference_mode"),
        }
        # Custom async providers declare these fields through parameter_schema.
        # Preserve them on the wire, while preventing a caller from replacing
        # protocol-owned model/content or the normalized standard controls.
        reserved = {"model", "content", *mapping}
        for key, value in parameters.items():
            if key not in reserved and value is not None and value != "":
                payload[key] = value
        for key, value in mapping.items():
            if value not in {None, ""}:
                payload[key] = value
        return payload

    async def submit(
        self,
        prompt: str,
        config: VideogenConfig,
        *,
        inputs: list[VideoInput],
        parameters: dict[str, Any],
        idempotency_key: str,
    ) -> str:
        if not config.base_url:
            raise GenerationProviderError("No endpoint URL configured for video generation.")
        url = join_api_path(config.base_url, "contents/generations/tasks")
        headers = {**_headers(config), "Idempotency-Key": idempotency_key}
        try:
            async with self._client(config) as client:
                response = await client.post(
                    url,
                    headers=headers,
                    json=self._payload(prompt, config, inputs, parameters),
                )
                raise_for_provider(response, "Video task submission")
                data = response.json()
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise GenerationProviderError(f"Video task submission error: {exc}") from exc
        if isinstance(data, dict):
            for container in (data, data.get("data")):
                if isinstance(container, dict):
                    value = container.get("id") or container.get("task_id")
                    if isinstance(value, str) and value:
                        return value
        raise GenerationProviderError("Video task submission returned no task id.")

    async def poll(self, task_id: str, config: VideogenConfig) -> VideoPollResult:
        url = join_api_path(config.base_url, _task_path(task_id))
        try:
            async with self._client(config) as client:
                response = await client.get(url, headers=_headers(config))
                raise_for_provider(response, "Video task status")
                data = response.json()
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise GenerationProviderError(f"Video task status error: {exc}") from exc
        if not isinstance(data, dict):
            raise GenerationProviderError("Malformed video task status response.")
        nested = data.get("data") if isinstance(data.get("data"), dict) else {}
        raw_state = str(
            data.get("status")
            or data.get("state")
            or nested.get("status")
            or nested.get("state")
            or ""
        ).lower()
        state_map = {
            "success": "succeeded",
            "completed": "succeeded",
            "done": "succeeded",
            "succeeded": "succeeded",
            "pending": "running",
            "created": "running",
            "submitted": "running",
            "waiting": "running",
            "processing": "running",
            "queued": "running",
            "running": "running",
            "in_progress": "running",
            "canceled": "cancelled",
            "cancelled": "cancelled",
            "error": "failed",
            "failed": "failed",
            "rejected": "failed",
            "moderated": "failed",
            "blocked": "failed",
            "expired": "failed",
            "denied": "failed",
            "safety_rejected": "failed",
            "content_policy_violation": "failed",
        }
        state = state_map.get(raw_state)
        if state is None:
            raise GenerationProviderError(
                f"Video task returned an unsupported status: {raw_state or '[missing]'}"
            )
        output_url = ""
        for container in (data.get("content"), data.get("data"), data):
            if isinstance(container, dict):
                output_url = str(container.get("video_url") or container.get("url") or "")
                if output_url:
                    break
        raw_progress = data.get("progress", nested.get("progress", 0))
        try:
            progress = float(raw_progress)
        except (TypeError, ValueError):
            progress = 0.0
        if progress > 1:
            progress /= 100
        error = data.get("error", nested.get("error"))
        if isinstance(error, dict):
            error = error.get("message")
        return VideoPollResult(state, max(0.0, min(progress, 1.0)), output_url, str(error or ""))

    async def cancel(self, task_id: str, config: VideogenConfig) -> bool:
        url = join_api_path(config.base_url, _task_path(task_id))
        try:
            async with self._client(config) as client:
                response = await client.delete(url, headers=_headers(config))
        except httpx.HTTPError:
            return False
        return response.status_code in {200, 202, 204, 404, 409}

    async def download(self, url: str, config: VideogenConfig, target: Path) -> str:
        current = url
        trusted_origin = _origin(config.base_url)
        for _ in range(4):
            await validate_download_url(current, config.base_url)
            try:
                same_origin = _origin(current) == trusted_origin
            except ValueError:
                same_origin = False
            headers = _headers(config) if same_origin else {}
            headers.pop("Content-Type", None)
            try:
                async with self._client(config) as client:
                    async with client.stream("GET", current, headers=headers) as response:
                        if response.status_code in {301, 302, 303, 307, 308}:
                            location = response.headers.get("location")
                            if not location:
                                raise GenerationProviderError(
                                    "Video download redirect has no destination."
                                )
                            current = urljoin(current, location)
                            continue
                        raise_for_provider(response, "Video download")
                        length = response.headers.get("content-length")
                        if length and int(length) > MAX_OUTPUT_BYTES:
                            raise GenerationProviderError("Video output exceeds the storage limit.")
                        target.parent.mkdir(parents=True, exist_ok=True)
                        size = 0
                        with target.open("xb") as handle:
                            async for chunk in response.aiter_bytes(1024 * 1024):
                                size += len(chunk)
                                if size > MAX_OUTPUT_BYTES:
                                    raise GenerationProviderError(
                                        "Video output exceeds the storage limit."
                                    )
                                handle.write(chunk)
                        if size <= 0:
                            raise GenerationProviderError("Video provider returned an empty file.")
                        content_type = response.headers.get("content-type", "").split(";", 1)[0]
                        return content_type if content_type.startswith("video/") else "video/mp4"
            except Exception:
                target.unlink(missing_ok=True)
                raise
        raise GenerationProviderError("Video download followed too many redirects.")


class VolcengineAsyncVideoAdapter(GenericAsyncVideoAdapter):
    """Volcengine Ark task adapter with Seedance prompt command shaping.

    Ark's task lifecycle matches the generic bridge, but Seedance reads the
    core generation controls from commands appended to the text content. It is
    intentionally a separate adapter so a custom async endpoint never receives
    provider-specific prompt mutations.
    """

    # Ark's only camera switch is ``camerafixed`` (``--cf``): fixed locks the
    # viewpoint, anything else lets the camera move. Motion vocabulary that
    # names a locked viewpoint maps to fixed; every other motion (push, pull,
    # orbit, ...) unlocks it — the movement itself stays in the user prompt,
    # which this adapter never rewrites.
    _CAMERA_FIXED_VALUES = frozenset({"none", "fixed", "static", "lock", "locked", "hold"})

    @classmethod
    def _camera_fixed(cls, parameters: dict[str, Any]) -> bool | None:
        """Map ``camera*`` parameters onto the Ark ``camerafixed`` switch.

        Returns ``None`` when no camera parameter was supplied so the command
        tail stays untouched for jobs without camera intent.
        """
        explicit = parameters.get("camera_fixed")
        if isinstance(explicit, bool):
            return explicit
        for key in ("camera_control", "camera_motion"):
            value = parameters.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip().lower() in cls._CAMERA_FIXED_VALUES
        return None

    @classmethod
    def _payload(
        cls,
        prompt: str,
        config: VideogenConfig,
        inputs: list[VideoInput],
        parameters: dict[str, Any],
    ) -> dict[str, Any]:
        commands: list[str] = []
        if config.aspect_ratio:
            commands.append(f"--ratio {config.aspect_ratio}")
        if config.resolution:
            commands.append(f"--resolution {config.resolution}")
        if config.duration:
            commands.append(f"--duration {config.duration}")
        camera_fixed = cls._camera_fixed(parameters)
        if camera_fixed is not None:
            commands.append(f"--camerafixed {str(camera_fixed).lower()}")
        text = f"{prompt} {' '.join(commands)}".strip() if commands else prompt
        return {"model": config.model, "content": cls._content(text, inputs)}


def _data_uri(item: VideoInput) -> str:
    """Encode one reference as a self-contained base64 data URI."""
    encoded = base64.b64encode(item.path.read_bytes()).decode("ascii")
    return f"data:{item.mime_type};base64,{encoded}"


def _task_id_from(*containers: Any) -> str:
    """Pull the first usable task id out of provider response containers."""
    for container in containers:
        if not isinstance(container, dict):
            continue
        for key in ("task_id", "id"):
            value = container.get(key)
            if isinstance(value, str) and value:
                return value
    return ""


# Keys the async-task family owns on the wire; schema-validated custom
# parameters may replace anything else but never these.
_RESERVED_PARAMETERS = frozenset(
    {
        "model",
        "prompt",
        "content",
        "operation",
        "aspect_ratio",
        "duration",
        "resolution",
        "fps",
        "seed",
        "audio_mode",
        "reference_mode",
    }
)


def _extra_parameters(parameters: dict[str, Any], extra_reserved: set[str]) -> dict[str, Any]:
    """Select passthrough parameters, skipping protocol-owned keys."""
    reserved = _RESERVED_PARAMETERS | extra_reserved
    return {
        key: value
        for key, value in parameters.items()
        if key not in reserved and value is not None and value != ""
    }


class KlingAsyncVideoAdapter(GenericAsyncVideoAdapter):
    """Kling AI open-platform task adapter (create task → query → video URL).

    Every call carries a short-lived HS256 JWT signed with the AccessKey /
    SecretKey pair (``iss`` = ak, ``exp`` = now + 1800, ``nbf`` = now - 5). The
    pair travels in ``config.api_key`` as ``ak:sk``; a colon-free key is sent
    as a plain bearer token so a proxying gateway keeps working. Task creation
    splits by operation: ``text2video``, ``image2video`` (``image`` +
    ``image_tail`` for first/last frame) and native ``video-extend`` when the
    job carries a video input.
    """

    # Engine dispatch contract: extend is delegated to the provider's native
    # video-extend endpoint instead of the local last-frame i2v fallback.
    native_extend = True

    _QUERY_SUFFIX = "v1/videos/image2video/{}"
    # Status tokens are compared with underscores stripped so wire spellings
    # like "PrepareFail" and "prepare_fail" normalize to the same token.
    _RUNNING_STATES = frozenset(
        {"submitted", "queued", "created", "pending", "processing", "running"}
    )
    _SUCCEEDED_STATES = frozenset({"succeed", "succeeded", "success", "completed"})
    _FAILED_STATES = frozenset({"failed", "fail", "error"})

    @staticmethod
    def _token(config: VideogenConfig) -> str:
        key = config.api_key or ""
        if ":" not in key:
            return ""
        access_key, secret_key = key.split(":", 1)
        now = int(time.time())
        return jwt.encode(
            {"iss": access_key, "exp": now + 1800, "nbf": now - 5},
            secret_key,
            algorithm="HS256",
        )

    @classmethod
    def _request_headers(cls, config: VideogenConfig) -> dict[str, str]:
        headers = {"Content-Type": "application/json", **(config.extra_headers or {})}
        token = cls._token(config)
        if token:
            headers["Authorization"] = f"Bearer {token}"
        else:
            headers.update(build_auth_headers(config.auth_style, config.api_key))
        return headers

    @staticmethod
    def _duration(config: VideogenConfig) -> int | str:
        value = str(config.duration or "")
        return int(value) if value.isdigit() else value

    @staticmethod
    def _camera_control(parameters: dict[str, Any]) -> dict[str, Any] | None:
        control = parameters.get("camera_control")
        if isinstance(control, dict):
            return control
        if isinstance(control, str) and control:
            # Kling's camera_control.type only accepts simple/custom; the
            # preset enum's "none" means "no camera control", which is the
            # field's absence on the wire rather than a type value.
            if control.strip().lower() == "none":
                return None
            return {"type": control}
        motion = parameters.get("camera_motion")
        if isinstance(motion, str) and motion:
            return {"type": "simple", "config": {"movement": motion}}
        return None

    @classmethod
    def _payload(
        cls,
        prompt: str,
        config: VideogenConfig,
        inputs: list[VideoInput],
        parameters: dict[str, Any],
    ) -> dict[str, Any]:
        images = [item for item in inputs if item.kind == "image"]
        videos = [item for item in inputs if item.kind == "video"]
        if any(item.kind not in {"image", "video"} for item in inputs):
            raise GenerationProviderError(
                "The Kling adapter cannot send audio or unknown reference kinds."
            )
        payload: dict[str, Any] = {"model": config.model, "prompt": prompt}
        if videos:
            if images or len(videos) > 1:
                raise GenerationProviderError(
                    "Kling native extend accepts exactly one source video."
                )
            payload["video"] = _data_uri(videos[0])
        else:
            first = next(
                (item for item in images if item.role == "first-frame"),
                images[0] if images else None,
            )
            last = next((item for item in images if item.role == "last-frame"), None)
            if len(images) > 2 or (len(images) == 2 and not (first and last)):
                raise GenerationProviderError(
                    "The Kling adapter accepts at most first/last frame image references."
                )
            if first:
                payload["image"] = _data_uri(first)
            if last:
                payload["image_tail"] = _data_uri(last)
            if config.aspect_ratio:
                payload["aspect_ratio"] = config.aspect_ratio
            duration = cls._duration(config)
            if duration:
                payload["duration"] = duration
            # Kling has no resolution knob: mode pro renders the 1080p tier.
            mode = str(parameters.get("mode") or "")
            if not mode and config.resolution:
                mode = {"1080p": "pro", "720p": "std"}.get(str(config.resolution).lower(), "")
            if mode:
                payload["mode"] = mode
        camera = cls._camera_control(parameters)
        if camera is not None:
            payload["camera_control"] = camera
        payload.update(
            _extra_parameters(
                parameters,
                {"mode", "camera_control", "camera_motion", "image", "image_tail", "video"},
            )
        )
        return payload

    def _submit_suffix(self, inputs: list[VideoInput], parameters: dict[str, Any]) -> str:
        if str(parameters.get("operation") or "") == "extend" or any(
            item.kind == "video" for item in inputs
        ):
            return "v1/videos/video-extend"
        if any(item.kind == "image" for item in inputs):
            return "v1/videos/image2video"
        return "v1/videos/text2video"

    async def submit(
        self,
        prompt: str,
        config: VideogenConfig,
        *,
        inputs: list[VideoInput],
        parameters: dict[str, Any],
        idempotency_key: str,
    ) -> str:
        if not config.base_url:
            raise GenerationProviderError("No endpoint URL configured for video generation.")
        url = join_api_path(config.base_url, self._submit_suffix(inputs, parameters))
        headers = {**self._request_headers(config), "Idempotency-Key": idempotency_key}
        try:
            async with self._client(config) as client:
                response = await client.post(
                    url,
                    headers=headers,
                    json=self._payload(prompt, config, inputs, parameters),
                )
                raise_for_provider(response, "Kling video task submission")
                data = response.json()
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise GenerationProviderError(f"Kling video task submission error: {exc}") from exc
        task_id = _task_id_from(data, data.get("data") if isinstance(data, dict) else None)
        if not task_id:
            raise GenerationProviderError("Kling video task submission returned no task id.")
        return task_id

    async def poll(self, task_id: str, config: VideogenConfig) -> VideoPollResult:
        url = join_api_path(config.base_url, self._QUERY_SUFFIX.format(quote(task_id, safe="")))
        try:
            async with self._client(config) as client:
                response = await client.get(url, headers=self._request_headers(config))
                raise_for_provider(response, "Kling video task status")
                data = response.json()
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise GenerationProviderError(f"Kling video task status error: {exc}") from exc
        if not isinstance(data, dict):
            raise GenerationProviderError("Malformed Kling video task status response.")
        nested = data.get("data") if isinstance(data.get("data"), dict) else {}
        raw_state = str(nested.get("task_status") or nested.get("status") or "").lower()
        token = raw_state.replace("_", "")
        if token in self._RUNNING_STATES:
            state = "running"
        elif token in self._SUCCEEDED_STATES:
            state = "succeeded"
        elif token in self._FAILED_STATES:
            state = "failed"
        else:
            raise GenerationProviderError(
                f"Kling video task returned an unsupported status: {raw_state or '[missing]'}"
            )
        output_url = ""
        task_result = nested.get("task_result")
        videos = task_result.get("videos") if isinstance(task_result, dict) else None
        if isinstance(videos, list):
            for video in videos:
                if isinstance(video, dict) and video.get("url"):
                    output_url = str(video["url"])
                    break
        error = nested.get("task_status_msg") or data.get("message") or ""
        progress = 1.0 if state == "succeeded" else 0.0
        return VideoPollResult(state, progress, output_url, str(error))

    async def cancel(self, task_id: str, config: VideogenConfig) -> bool:
        url = join_api_path(config.base_url, self._QUERY_SUFFIX.format(quote(task_id, safe="")))
        try:
            async with self._client(config) as client:
                response = await client.delete(url, headers=self._request_headers(config))
        except httpx.HTTPError:
            return False
        return response.status_code in {200, 202, 204, 404, 409}


class WanAsyncVideoAdapter(GenericAsyncVideoAdapter):
    """Alibaba DashScope Wan video-synthesis task adapter.

    Submit posts to ``services/aigc/video-generation/video-synthesis`` with the
    ``X-DashScope-Async: enable`` switch and polls ``tasks/{task_id}`` until
    ``output.video_url`` appears. Bearer auth from ``config.api_key``.
    """

    _SUBMIT_SUFFIX = "services/aigc/video-generation/video-synthesis"
    _STATE_MAP = {
        "pending": "running",
        "running": "running",
        "succeeded": "succeeded",
        "partial_success": "succeeded",
        "failed": "failed",
        "unknown": "failed",
        "canceled": "cancelled",
        "cancelled": "cancelled",
    }

    @staticmethod
    def _size(config: VideogenConfig) -> str:
        resolution = str(config.resolution or "").lower()
        ratio = str(config.aspect_ratio or "").replace(" ", "")
        mapped = {
            ("720p", "16:9"): "1280*720",
            ("720p", "9:16"): "720*1280",
            ("1080p", "16:9"): "1920*1080",
            ("1080p", "9:16"): "1080*1920",
        }.get((resolution, ratio))
        if mapped:
            return mapped
        return resolution.replace("x", "*") if "x" in resolution else ""

    @classmethod
    def _payload(
        cls,
        prompt: str,
        config: VideogenConfig,
        inputs: list[VideoInput],
        parameters: dict[str, Any],
    ) -> dict[str, Any]:
        if any(item.kind not in {"image", "audio"} for item in inputs):
            raise GenerationProviderError(
                "The Wan adapter cannot send video or unknown reference kinds."
            )
        images = [item for item in inputs if item.kind == "image"]
        audios = [item for item in inputs if item.kind == "audio"]
        if len(images) > 1 or len(audios) > 1:
            raise GenerationProviderError(
                "The Wan adapter accepts at most one image and one audio reference."
            )
        input_block: dict[str, Any] = {"prompt": prompt}
        if images:
            input_block["img_url"] = _data_uri(images[0])
        if audios:
            input_block["audio_url"] = _data_uri(audios[0])
        settings: dict[str, Any] = {}
        if size := cls._size(config):
            settings["size"] = size
        if str(config.duration or "").isdigit():
            settings["duration"] = int(config.duration)
        audio_mode = str(parameters.get("audio_mode") or "")
        if audio_mode == "generate":
            settings["audio"] = True
        elif audio_mode == "none":
            settings["audio"] = False
        settings.update(_extra_parameters(parameters, set()))
        return {"model": config.model, "input": input_block, "parameters": settings}

    async def submit(
        self,
        prompt: str,
        config: VideogenConfig,
        *,
        inputs: list[VideoInput],
        parameters: dict[str, Any],
        idempotency_key: str,
    ) -> str:
        if not config.base_url:
            raise GenerationProviderError("No endpoint URL configured for video generation.")
        url = join_api_path(config.base_url, self._SUBMIT_SUFFIX)
        headers = {
            **_headers(config),
            "X-DashScope-Async": "enable",
            "Idempotency-Key": idempotency_key,
        }
        try:
            async with self._client(config) as client:
                response = await client.post(
                    url,
                    headers=headers,
                    json=self._payload(prompt, config, inputs, parameters),
                )
                raise_for_provider(response, "Wan video task submission")
                data = response.json()
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise GenerationProviderError(f"Wan video task submission error: {exc}") from exc
        task_id = _task_id_from(data, data.get("output") if isinstance(data, dict) else None)
        if not task_id:
            raise GenerationProviderError("Wan video task submission returned no task id.")
        return task_id

    async def poll(self, task_id: str, config: VideogenConfig) -> VideoPollResult:
        url = join_api_path(config.base_url, f"tasks/{quote(task_id, safe='')}")
        try:
            async with self._client(config) as client:
                response = await client.get(url, headers=_headers(config))
                raise_for_provider(response, "Wan video task status")
                data = response.json()
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise GenerationProviderError(f"Wan video task status error: {exc}") from exc
        if not isinstance(data, dict):
            raise GenerationProviderError("Malformed Wan video task status response.")
        output = data.get("output") if isinstance(data.get("output"), dict) else {}
        raw_state = str(output.get("task_status") or "").lower()
        state = self._STATE_MAP.get(raw_state)
        if state is None:
            raise GenerationProviderError(
                f"Wan video task returned an unsupported status: {raw_state or '[missing]'}"
            )
        output_url = str(output.get("video_url") or "")
        if state == "succeeded" and not output_url:
            # partial_success without a render is still a failure for the caller.
            state = "failed" if raw_state == "partial_success" else state
        error = output.get("message") or output.get("code") or ""
        progress = 1.0 if state == "succeeded" else 0.0
        return VideoPollResult(state, progress, output_url, str(error))

    async def cancel(self, task_id: str, config: VideogenConfig) -> bool:
        url = join_api_path(config.base_url, f"tasks/{quote(task_id, safe='')}")
        try:
            async with self._client(config) as client:
                response = await client.delete(url, headers=_headers(config))
        except httpx.HTTPError:
            return False
        return response.status_code in {200, 202, 204, 404, 409}


class HailuoAsyncVideoAdapter(GenericAsyncVideoAdapter):
    """MiniMax Hailuo video-generation task adapter.

    Submit posts one ``video_generation`` task carrying the prompt plus
    per-kind reference lists (first-frame image, subject images, videos,
    audio); ``query/video_generation`` is polled until ``file.download_addr``
    (or ``video_url``) appears. Bearer auth from ``config.api_key``.
    """

    _RUNNING_STATES = frozenset(
        {"queueing", "queued", "preparing", "processing", "generating", "running"}
    )
    _SUCCEEDED_STATES = frozenset({"success", "succeed", "succeeded", "completed"})
    _FAILED_STATES = frozenset({"fail", "failed", "preparefail", "generatefail", "error"})

    @staticmethod
    def _payload(
        prompt: str,
        config: VideogenConfig,
        inputs: list[VideoInput],
        parameters: dict[str, Any],
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"model": config.model, "prompt": prompt}
        first_frame: str | None = None
        subject_refs: list[str] = []
        video_refs: list[str] = []
        audio_refs: list[str] = []
        for item in inputs:
            if item.kind not in {"image", "video", "audio"}:
                raise GenerationProviderError(
                    f"The Hailuo adapter cannot send a {item.kind} reference."
                )
            data = _data_uri(item)
            if item.kind == "image":
                if item.role == "first-frame" and first_frame is None:
                    first_frame = data
                else:
                    subject_refs.append(data)
            elif item.kind == "video":
                video_refs.append(data)
            else:
                audio_refs.append(data)
        if first_frame:
            payload["first_frame_image"] = first_frame
        if subject_refs:
            payload["subject_refs"] = subject_refs
        if video_refs:
            payload["video_refs"] = video_refs
        if audio_refs:
            payload["audio_refs"] = audio_refs
        if str(config.duration or "").isdigit():
            payload["duration"] = int(config.duration)
        if config.resolution:
            payload["resolution"] = config.resolution
        payload.update(
            _extra_parameters(
                parameters, {"first_frame_image", "subject_refs", "video_refs", "audio_refs"}
            )
        )
        return payload

    async def submit(
        self,
        prompt: str,
        config: VideogenConfig,
        *,
        inputs: list[VideoInput],
        parameters: dict[str, Any],
        idempotency_key: str,
    ) -> str:
        if not config.base_url:
            raise GenerationProviderError("No endpoint URL configured for video generation.")
        url = join_api_path(config.base_url, "video_generation")
        headers = {**_headers(config), "Idempotency-Key": idempotency_key}
        try:
            async with self._client(config) as client:
                response = await client.post(
                    url,
                    headers=headers,
                    json=self._payload(prompt, config, inputs, parameters),
                )
                raise_for_provider(response, "Hailuo video task submission")
                data = response.json()
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise GenerationProviderError(f"Hailuo video task submission error: {exc}") from exc
        task_id = _task_id_from(data, data.get("data") if isinstance(data, dict) else None)
        if not task_id:
            raise GenerationProviderError("Hailuo video task submission returned no task id.")
        return task_id

    async def poll(self, task_id: str, config: VideogenConfig) -> VideoPollResult:
        url = join_api_path(config.base_url, "query/video_generation")
        url = f"{url}{'&' if '?' in url else '?'}task_id={quote(task_id, safe='')}"
        try:
            async with self._client(config) as client:
                response = await client.get(url, headers=_headers(config))
                raise_for_provider(response, "Hailuo video task status")
                data = response.json()
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise GenerationProviderError(f"Hailuo video task status error: {exc}") from exc
        if not isinstance(data, dict):
            raise GenerationProviderError("Malformed Hailuo video task status response.")
        raw_state = str(data.get("status") or data.get("task_status") or "").lower()
        token = raw_state.replace("_", "")
        if token in self._RUNNING_STATES:
            state = "running"
        elif token in self._SUCCEEDED_STATES:
            state = "succeeded"
        elif token in self._FAILED_STATES:
            state = "failed"
        else:
            raise GenerationProviderError(
                f"Hailuo video task returned an unsupported status: {raw_state or '[missing]'}"
            )
        file_block = data.get("file") if isinstance(data.get("file"), dict) else {}
        output_url = str(file_block.get("download_addr") or data.get("video_url") or "")
        error = data.get("message") or file_block.get("message") or ""
        progress = 1.0 if state == "succeeded" else 0.0
        return VideoPollResult(state, progress, output_url, str(error))

    async def cancel(self, task_id: str, config: VideogenConfig) -> bool:
        url = join_api_path(config.base_url, f"video_generation/{quote(task_id, safe='')}")
        try:
            async with self._client(config) as client:
                response = await client.delete(url, headers=_headers(config))
        except httpx.HTTPError:
            return False
        return response.status_code in {200, 202, 204, 404, 409}


class OpenAIVideosAdapter(BaseVideoStudioAdapter):
    """OpenAI Videos API adapter (multipart create, poll, content, delete).

    The official OpenAI guide marks this API deprecated with a September 24,
    2026 shutdown date. Keeping it isolated prevents its contract from being
    mistaken for a generic or future OpenAI-compatible video standard.
    """

    def __init__(self, *, transport: httpx.AsyncBaseTransport | None = None):
        self._transport = transport

    def _client(self, config: VideogenConfig) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            timeout=config.request_timeout,
            transport=self._transport,
            follow_redirects=False,
        )

    @staticmethod
    def _auth_headers(config: VideogenConfig) -> dict[str, str]:
        return {
            **build_auth_headers(config.auth_style, config.api_key),
            **(config.extra_headers or {}),
        }

    @staticmethod
    def _size(config: VideogenConfig) -> str:
        value = str(config.resolution or "").lower()
        if "x" in value:
            return value
        ratio = str(config.aspect_ratio or "").replace(" ", "")
        return {
            ("720p", "16:9"): "1280x720",
            ("720p", "9:16"): "720x1280",
        }.get((value, ratio), "")

    async def submit(
        self,
        prompt: str,
        config: VideogenConfig,
        *,
        inputs: list[VideoInput],
        parameters: dict[str, Any],
        idempotency_key: str,
    ) -> str:
        if len(inputs) > 1 or any(item.kind != "image" for item in inputs):
            raise GenerationProviderError(
                "OpenAI Videos accepts at most one image input reference."
            )
        form: list[tuple[str, tuple[Any, ...]]] = [
            ("prompt", (None, prompt)),
            ("model", (None, config.model)),
        ]
        if config.duration:
            form.append(("seconds", (None, str(config.duration))))
        if size := self._size(config):
            form.append(("size", (None, size)))
        handle = None
        try:
            if inputs:
                item = inputs[0]
                handle = item.path.open("rb")
                form.append(("input_reference", (item.path.name, handle, item.mime_type)))
            headers = {**self._auth_headers(config), "Idempotency-Key": idempotency_key}
            for name in list(headers):
                if name.lower() == "content-type":
                    headers.pop(name)
            async with self._client(config) as client:
                response = await client.post(
                    join_api_path(config.base_url, "videos"), headers=headers, files=form
                )
                raise_for_provider(response, "OpenAI video submission")
                data = response.json()
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise GenerationProviderError(f"OpenAI video submission error: {exc}") from exc
        finally:
            if handle is not None:
                handle.close()
        task_id = data.get("id") if isinstance(data, dict) else None
        if not isinstance(task_id, str) or not task_id:
            raise GenerationProviderError("OpenAI video submission returned no task id.")
        return task_id

    async def poll(self, task_id: str, config: VideogenConfig) -> VideoPollResult:
        url = join_api_path(config.base_url, f"videos/{quote(task_id, safe='')}")
        try:
            async with self._client(config) as client:
                response = await client.get(url, headers=self._auth_headers(config))
                raise_for_provider(response, "OpenAI video status")
                data = response.json()
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise GenerationProviderError(f"OpenAI video status error: {exc}") from exc
        if not isinstance(data, dict):
            raise GenerationProviderError("Malformed OpenAI video status response.")
        raw_state = str(data.get("status") or "").lower()
        state = {
            "queued": "running",
            "in_progress": "running",
            "completed": "succeeded",
            "failed": "failed",
            "rejected": "failed",
            "moderated": "failed",
            "blocked": "failed",
            "expired": "failed",
            "cancelled": "cancelled",
            "canceled": "cancelled",
        }.get(raw_state)
        if state is None:
            raise GenerationProviderError(
                f"OpenAI video returned an unsupported status: {raw_state or '[missing]'}"
            )
        try:
            progress = float(data.get("progress") or 0) / 100
        except (TypeError, ValueError):
            progress = 0.0
        error = data.get("error")
        if isinstance(error, dict):
            error = error.get("message") or error.get("code")
        output = f"openai-video://{quote(task_id, safe='')}" if state == "succeeded" else ""
        return VideoPollResult(state, max(0.0, min(progress, 1.0)), output, str(error or ""))

    async def cancel(self, task_id: str, config: VideogenConfig) -> bool:
        # OpenAI documents DELETE as stored-asset deletion, not a guaranteed
        # in-flight cancellation. Local cancellation therefore never waits for it.
        url = join_api_path(config.base_url, f"videos/{quote(task_id, safe='')}")
        try:
            async with self._client(config) as client:
                response = await client.delete(url, headers=self._auth_headers(config))
        except httpx.HTTPError:
            return False
        return response.status_code in {200, 202, 204, 404, 409}

    async def download(self, url: str, config: VideogenConfig, target: Path) -> str:
        parsed = urlparse(url)
        if parsed.scheme != "openai-video" or not parsed.netloc or parsed.path:
            raise GenerationProviderError("Invalid OpenAI video content reference.")
        task_id = quote(parsed.netloc, safe="")
        endpoint = join_api_path(config.base_url, f"videos/{task_id}/content")
        try:
            async with self._client(config) as client:
                async with client.stream(
                    "GET",
                    endpoint,
                    headers={**self._auth_headers(config), "Accept": "video/mp4"},
                ) as response:
                    raise_for_provider(response, "OpenAI video content")
                    length = response.headers.get("content-length")
                    if length and int(length) > MAX_OUTPUT_BYTES:
                        raise GenerationProviderError("Video output exceeds the storage limit.")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    size = 0
                    with target.open("xb") as handle:
                        async for chunk in response.aiter_bytes(1024 * 1024):
                            size += len(chunk)
                            if size > MAX_OUTPUT_BYTES:
                                raise GenerationProviderError(
                                    "Video output exceeds the storage limit."
                                )
                            handle.write(chunk)
            if size <= 0:
                raise GenerationProviderError("OpenAI returned an empty video file.")
            return "video/mp4"
        except Exception:
            target.unlink(missing_ok=True)
            raise


class FakeVideoStudioAdapter(BaseVideoStudioAdapter):
    """Deterministic in-process adapter for tests and local contract probes."""

    def __init__(self) -> None:
        self.tasks: dict[str, int] = {}
        self.submit_count = 0
        self.cancelled: set[str] = set()

    async def submit(
        self,
        prompt: str,
        config: VideogenConfig,
        *,
        inputs: list[VideoInput],
        parameters: dict[str, Any],
        idempotency_key: str,
    ) -> str:
        self.submit_count += 1
        task_id = f"fake-{idempotency_key}"
        self.tasks.setdefault(task_id, 0)
        return task_id

    async def poll(self, task_id: str, config: VideogenConfig) -> VideoPollResult:
        if task_id in self.cancelled:
            return VideoPollResult("cancelled")
        count = self.tasks.get(task_id, 0) + 1
        self.tasks[task_id] = count
        if count < 2:
            return VideoPollResult("running", 0.5)
        return VideoPollResult("succeeded", 1.0, f"fake://{quote(task_id)}")

    async def cancel(self, task_id: str, config: VideogenConfig) -> bool:
        self.cancelled.add(task_id)
        return True

    async def download(self, url: str, config: VideogenConfig, target: Path) -> str:
        target.parent.mkdir(parents=True, exist_ok=True)
        # ISO BMFF header sufficient for the store's format gate.
        target.write_bytes(b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isomfake-video")
        return "video/mp4"


VIDEO_STUDIO_ADAPTERS: dict[str, BaseVideoStudioAdapter] = {
    "async_task": GenericAsyncVideoAdapter(),
    "openai_videos": OpenAIVideosAdapter(),
    "volcengine_async_task": VolcengineAsyncVideoAdapter(),
    "kling_async_task": KlingAsyncVideoAdapter(),
    "wan_async_task": WanAsyncVideoAdapter(),
    "hailuo_async_task": HailuoAsyncVideoAdapter(),
}


def get_video_studio_adapter(name: str) -> BaseVideoStudioAdapter:
    adapter = VIDEO_STUDIO_ADAPTERS.get(str(name or "async_task"))
    if adapter is None:
        raise GenerationProviderError(f"Unsupported Video Studio adapter: {name!r}")
    return adapter


__all__ = [
    "BaseVideoStudioAdapter",
    "FakeVideoStudioAdapter",
    "GenericAsyncVideoAdapter",
    "HailuoAsyncVideoAdapter",
    "KlingAsyncVideoAdapter",
    "OpenAIVideosAdapter",
    "VIDEO_STUDIO_ADAPTERS",
    "VideoInput",
    "VideoPollResult",
    "VolcengineAsyncVideoAdapter",
    "WanAsyncVideoAdapter",
    "get_video_studio_adapter",
    "validate_download_url",
]
