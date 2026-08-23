"""Tests for the image/video generation service layer.

Covers the shared HTTP helpers, the OpenAI-compatible imagegen adapter (both
``b64_json`` and ``url`` response shapes), the async-task videogen adapter
(submit → poll → download, plus failure + payload shaping), catalog-driven
config resolution, and the public facades.
"""

from __future__ import annotations

import base64
import json
from typing import Any

import httpx
import pytest

from knorvia.services.config.provider_runtime import (
    resolve_imagegen_runtime_config,
    resolve_videogen_runtime_config,
)
from knorvia.services.generation_http import (
    GenerationProviderError,
    build_auth_headers,
    join_api_path,
    sanitize_provider_detail,
)
from knorvia.services.imagegen import generate_image
from knorvia.services.imagegen.adapters.chat_completions import ChatCompletionsImagegenAdapter
from knorvia.services.imagegen.adapters.gemini_interactions import GeminiInteractionsImagegenAdapter
from knorvia.services.imagegen.adapters.openai_compat import OpenAICompatImagegenAdapter
from knorvia.services.imagegen.adapters.openai_responses import OpenAIResponsesImagegenAdapter
from knorvia.services.imagegen.config import ImagegenConfig
from knorvia.services.videogen import generate_video, probe_video
from knorvia.services.videogen.adapters.async_task import AsyncTaskVideogenAdapter
from knorvia.services.videogen.config import VideogenConfig


def _patch_http(
    monkeypatch: pytest.MonkeyPatch,
    *,
    post: Any = None,
    get: Any = None,
) -> dict[str, Any]:
    """Patch ``httpx.AsyncClient`` post/get with url-routed fakes."""
    captured: dict[str, Any] = {"posts": [], "gets": []}

    async def fake_post(self: httpx.AsyncClient, url: str, **kwargs: Any) -> httpx.Response:
        captured["posts"].append(
            {"url": url, "json": kwargs.get("json"), "headers": kwargs.get("headers")}
        )
        resp = post(url, kwargs) if callable(post) else post
        resp.request = httpx.Request("POST", url)
        return resp

    async def fake_get(self: httpx.AsyncClient, url: str, **kwargs: Any) -> httpx.Response:
        captured["gets"].append({"url": url})
        resp = get(url, kwargs) if callable(get) else get
        resp.request = httpx.Request("GET", url)
        return resp

    if post is not None:
        monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    if get is not None:
        monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    return captured


# ── shared HTTP helpers ─────────────────────────────────────────────────────


def test_build_auth_headers_styles() -> None:
    assert build_auth_headers("bearer", "k") == {"Authorization": "Bearer k"}
    assert build_auth_headers("api_key_header", "k") == {"api-key": "k"}
    assert build_auth_headers("bearer", "") == {}


def test_join_api_path_appends_and_preserves_full_url() -> None:
    assert (
        join_api_path("https://api.openai.com/v1", "images/generations")
        == "https://api.openai.com/v1/images/generations"
    )
    full = "https://ark.cn-beijing.volces.com/api/v3/images/generations"
    assert join_api_path(full, "images/generations") == full


# ── imagegen adapter ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_imagegen_adapter_b64_json(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = base64.b64encode(b"PNGDATA").decode("ascii")
    resp = httpx.Response(200, json={"data": [{"b64_json": payload}]})
    captured = _patch_http(monkeypatch, post=resp)
    config = ImagegenConfig(
        model="gpt-image-1",
        base_url="https://api.openai.com/v1",
        api_key="sk-test",
        size="1024x1024",
    )
    images = await OpenAICompatImagegenAdapter().generate("a cat", config, n=2)
    assert images == [(b"PNGDATA", "image/png")]
    post = captured["posts"][0]
    assert post["url"] == "https://api.openai.com/v1/images/generations"
    assert post["json"] == {"model": "gpt-image-1", "prompt": "a cat", "n": 2, "size": "1024x1024"}
    assert post["headers"]["Authorization"] == "Bearer sk-test"


@pytest.mark.asyncio
async def test_imagegen_adapter_url_is_downloaded(monkeypatch: pytest.MonkeyPatch) -> None:
    post_resp = httpx.Response(200, json={"data": [{"url": "https://cdn/x.png"}]})
    get_resp = httpx.Response(200, content=b"DOWNLOADED", headers={"content-type": "image/png"})
    captured = _patch_http(monkeypatch, post=post_resp, get=get_resp)

    async def allow_test_url(_src: str) -> None:
        return None

    monkeypatch.setattr(
        OpenAICompatImagegenAdapter, "_validate_download_url", staticmethod(allow_test_url)
    )
    config = ImagegenConfig(model="seedream", base_url="https://ark/api/v3", api_key="k")
    images = await OpenAICompatImagegenAdapter().generate("dog", config)
    assert images == [(b"DOWNLOADED", "image/png")]
    assert captured["gets"][0]["url"] == "https://cdn/x.png"


def test_provider_diagnostics_redact_credentials() -> None:
    value = 'request https://example.test/x?api_key=secret&x=1 {"access_token":"abc"} Bearer xyz'
    safe = sanitize_provider_detail(value)
    assert "secret" not in safe and '"abc"' not in safe and "Bearer xyz" not in safe
    assert safe.count("[REDACTED]") == 3


@pytest.mark.asyncio
async def test_imagegen_edit_uses_multipart(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = base64.b64encode(b"EDITED").decode("ascii")
    captured: dict[str, Any] = {}

    async def fake_post(self: httpx.AsyncClient, url: str, **kwargs: Any) -> httpx.Response:
        captured.update({"url": url, **kwargs})
        response = httpx.Response(200, json={"data": [{"b64_json": payload}]})
        response.request = httpx.Request("POST", url)
        return response

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    config = ImagegenConfig(model="gpt-image-1", base_url="https://api.openai.com/v1", api_key="k")
    output = await OpenAICompatImagegenAdapter().edit(
        "make it blue", config, images=[(b"PNG", "image/png")], mask=(b"MASK", "image/png"), n=2
    )
    assert output == [(b"EDITED", "image/png")]
    assert captured["url"].endswith("/images/edits")
    assert captured["data"]["n"] == "2"
    assert [name for name, _file in captured["files"]] == ["image", "mask"]


@pytest.mark.asyncio
async def test_responses_adapter_preserves_parent_context_and_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    encoded = base64.b64encode(b"RESPONSE-IMAGE").decode("ascii")
    calls: list[dict[str, Any]] = []

    async def fake_post(self: httpx.AsyncClient, url: str, **kwargs: Any) -> httpx.Response:
        calls.append(kwargs["json"])
        response = httpx.Response(
            200,
            json={
                "id": f"response-{len(calls)}",
                "output": [
                    {"type": "image_generation_call", "result": encoded, "revised_prompt": "better"}
                ],
                "usage": {"total_tokens": 12},
            },
        )
        response.request = httpx.Request("POST", url)
        return response

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    result = await OpenAIResponsesImagegenAdapter().edit_with_metadata(
        "change color",
        ImagegenConfig(model="gpt-4.1-mini", base_url="https://api.openai.com/v1", api_key="k"),
        images=[(b"INPUT", "image/png")],
        n=2,
        parent_context_id="response-parent",
    )
    assert result.images == [(b"RESPONSE-IMAGE", "image/png")] * 2
    assert result.provider_context_id == "response-2"
    assert result.revised_prompt == "better"
    assert result.usage == {"total_tokens": 12}
    assert [call["previous_response_id"] for call in calls] == [
        "response-parent",
        "response-parent",
    ]
    assert calls[0]["input"][0]["content"][1]["type"] == "input_image"


@pytest.mark.asyncio
async def test_gemini_interactions_adapter_extracts_inline_image(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    encoded = base64.b64encode(b"GEMINI-IMAGE").decode("ascii")
    captured: dict[str, Any] = {}

    async def fake_post(self: httpx.AsyncClient, url: str, **kwargs: Any) -> httpx.Response:
        captured.update({"url": url, **kwargs})
        response = httpx.Response(
            200,
            json={
                "interaction_id": "interaction-2",
                "outputs": [
                    {"content": [{"inline_data": {"data": encoded, "mime_type": "image/webp"}}]}
                ],
            },
        )
        response.request = httpx.Request("POST", url)
        return response

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    result = await GeminiInteractionsImagegenAdapter().edit_with_metadata(
        "add clouds",
        ImagegenConfig(
            model="gemini-2.5-flash-image",
            base_url="https://generativelanguage.googleapis.com/v1beta",
            api_key="gem-key",
            aspect_ratio="16:9",
        ),
        images=[(b"INPUT", "image/png")],
        parent_context_id="interaction-1",
    )
    assert result.images == [(b"GEMINI-IMAGE", "image/webp")]
    assert result.provider_context_id == "interaction-2"
    assert captured["headers"]["x-goog-api-key"] == "gem-key"
    assert captured["json"]["previous_interaction_id"] == "interaction-1"
    assert captured["json"]["response_format"]["aspect_ratio"] == "16:9"


@pytest.mark.asyncio
async def test_imagegen_chat_completions_adapter_data_uri(monkeypatch: pytest.MonkeyPatch) -> None:
    data_uri = "data:image/png;base64," + base64.b64encode(b"PNGBYTES").decode("ascii")
    resp = httpx.Response(
        200,
        json={
            "choices": [
                {"message": {"content": "here", "images": [{"image_url": {"url": data_uri}}]}}
            ]
        },
    )
    captured = _patch_http(monkeypatch, post=resp)
    config = ImagegenConfig(
        model="google/gemini-2.5-flash-image-preview",
        adapter="chat_completions",
        base_url="https://openrouter.ai/api/v1",
        api_key="or-key",
    )
    images = await ChatCompletionsImagegenAdapter().generate("a fox", config)
    assert images == [(b"PNGBYTES", "image/png")]
    post = captured["posts"][0]
    assert post["url"] == "https://openrouter.ai/api/v1/chat/completions"
    assert post["json"]["modalities"] == ["image", "text"]
    assert post["json"]["messages"][0]["content"] == "a fox"


@pytest.mark.asyncio
async def test_imagegen_adapter_raises_on_http_error(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_http(monkeypatch, post=httpx.Response(404, text="not activated"))
    config = ImagegenConfig(model="m", base_url="https://x/v1", api_key="k")
    with pytest.raises(GenerationProviderError, match="404"):
        await OpenAICompatImagegenAdapter().generate("x", config)


# ── videogen adapter ────────────────────────────────────────────────────────


def test_videogen_submit_payload_seedance_shape() -> None:
    config = VideogenConfig(
        model="seedance",
        base_url="https://ark/api/v3",
        aspect_ratio="16:9",
        resolution="720p",
        duration="5",
    )
    payload = AsyncTaskVideogenAdapter._build_submit_payload("a wave", config)
    assert payload["model"] == "seedance"
    text = payload["content"][0]["text"]
    assert text.startswith("a wave")
    assert "--ratio 16:9" in text and "--resolution 720p" in text and "--duration 5" in text


@pytest.mark.asyncio
async def test_videogen_adapter_submit_poll_download(monkeypatch: pytest.MonkeyPatch) -> None:
    submit = httpx.Response(200, json={"id": "task-1"})

    def get_router(url: str, _kwargs: Any) -> httpx.Response:
        if url.endswith("/contents/generations/tasks/task-1"):
            return httpx.Response(
                200, json={"status": "succeeded", "content": {"video_url": "https://cdn/v.mp4"}}
            )
        return httpx.Response(200, content=b"MP4DATA", headers={"content-type": "video/mp4"})

    _patch_http(monkeypatch, post=submit, get=get_router)
    config = VideogenConfig(
        model="seedance",
        base_url="https://ark/api/v3",
        api_key="k",
        poll_interval=0.0,
    )
    video, content_type = await AsyncTaskVideogenAdapter().generate("a wave", config)
    assert video == b"MP4DATA"
    assert content_type == "video/mp4"


@pytest.mark.asyncio
async def test_videogen_adapter_raises_on_failed_task(monkeypatch: pytest.MonkeyPatch) -> None:
    submit = httpx.Response(200, json={"id": "t2"})
    fail = httpx.Response(200, json={"status": "failed", "error": {"message": "content blocked"}})
    _patch_http(monkeypatch, post=submit, get=fail)
    config = VideogenConfig(model="m", base_url="https://x/v3", api_key="k", poll_interval=0.0)
    with pytest.raises(GenerationProviderError, match="content blocked"):
        await AsyncTaskVideogenAdapter().generate("x", config)


# ── catalog resolution ──────────────────────────────────────────────────────


def _media_catalog() -> dict[str, Any]:
    return {
        "version": 1,
        "services": {
            "imagegen": {
                "active_profile_id": "p1",
                "active_model_id": "m1",
                "profiles": [
                    {
                        "id": "p1",
                        "binding": "volcengine",
                        "base_url": "",
                        "api_key": "ark-key",
                        "models": [{"id": "m1", "model": "doubao-seedream-3", "size": "1024x1024"}],
                    }
                ],
            },
            "videogen": {
                "active_profile_id": "p2",
                "active_model_id": "m2",
                "profiles": [
                    {
                        "id": "p2",
                        "binding": "volcengine",
                        "base_url": "",
                        "api_key": "ark-key",
                        "models": [
                            {"id": "m2", "model": "doubao-seedance-1", "aspect_ratio": "9:16"}
                        ],
                    }
                ],
            },
        },
    }


def test_resolve_imagegen_config_fills_provider_default_base() -> None:
    cfg = resolve_imagegen_runtime_config(catalog=_media_catalog())
    assert cfg.model == "doubao-seedream-3"
    assert cfg.provider_name == "volcengine"
    assert cfg.base_url == "https://ark.cn-beijing.volces.com/api/v3"
    assert cfg.size == "1024x1024"
    assert cfg.api_key == "ark-key"


def test_resolve_imagegen_openrouter_uses_chat_adapter() -> None:
    catalog = {
        "version": 1,
        "services": {
            "imagegen": {
                "active_profile_id": "p",
                "active_model_id": "m",
                "profiles": [
                    {
                        "id": "p",
                        "binding": "openrouter",
                        "base_url": "",
                        "api_key": "or-key",
                        "models": [{"id": "m", "model": "black-forest-labs/flux.2-pro"}],
                    }
                ],
            }
        },
    }
    cfg = resolve_imagegen_runtime_config(catalog=catalog)
    assert cfg.provider_name == "openrouter"
    assert cfg.adapter == "chat_completions"
    assert cfg.base_url == "https://openrouter.ai/api/v1"


def test_resolve_videogen_config_uses_volcengine_task_adapter() -> None:
    cfg = resolve_videogen_runtime_config(catalog=_media_catalog())
    assert cfg.provider_name == "volcengine"
    assert cfg.adapter == "volcengine_async_task"
    assert cfg.aspect_ratio == "9:16"


def test_legacy_videogen_facade_accepts_explicit_volcengine_adapter_name() -> None:
    from knorvia.services.videogen.adapters import get_videogen_adapter

    assert get_videogen_adapter("volcengine_async_task") is get_videogen_adapter("async_task")


def test_resolve_videogen_config_prefers_shared_connection_credentials() -> None:
    catalog = {
        "connections": [
            {
                "id": "shared-video",
                "provider": "custom",
                "base_url": "https://shared.video.test/v1",
                "api_key": "shared-secret",
                "api_version": "2026-08-01",
                "extra_headers": {"X-Tenant": "shared"},
            }
        ],
        "services": {
            "videogen": {
                "active_profile_id": "video-profile",
                "active_model_id": "video-model",
                "profiles": [
                    {
                        "id": "video-profile",
                        "binding": "custom",
                        "connection_id": "shared-video",
                        "base_url": "https://stale.inline.test/v1",
                        "api_key": "stale-inline-secret",
                        "models": [
                            {
                                "id": "video-model",
                                "model": "custom-video",
                                "adapter": "async_task",
                            }
                        ],
                    }
                ],
            }
        },
    }

    cfg = resolve_videogen_runtime_config(catalog=catalog)

    assert cfg.base_url == "https://shared.video.test/v1"
    assert cfg.api_key == "shared-secret"
    assert cfg.api_version == "2026-08-01"
    assert cfg.extra_headers == {"X-Tenant": "shared"}


def test_resolve_imagegen_config_raises_without_model() -> None:
    catalog = {"version": 1, "services": {"imagegen": {"profiles": []}}}
    with pytest.raises(ValueError, match="No active image-generation model"):
        resolve_imagegen_runtime_config(catalog=catalog)


# ── facades ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_generate_image_facade(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = base64.b64encode(b"IMG").decode("ascii")
    captured = _patch_http(
        monkeypatch, post=httpx.Response(200, json={"data": [{"b64_json": payload}]})
    )
    images = await generate_image("a tree", catalog=_media_catalog(), size="512x512")
    assert images == [(b"IMG", "image/png")]
    assert captured["posts"][0]["json"]["size"] == "512x512"


def _tiny_png() -> bytes:
    from io import BytesIO

    from PIL import Image

    buffer = BytesIO()
    Image.new("RGB", (8, 8), (20, 80, 160)).save(buffer, format="PNG")
    return buffer.getvalue()


def _studio_model(**overrides: Any) -> dict[str, Any]:
    row = {
        "profile_id": "p1",
        "model_id": "m1",
        "profile_name": "Studio",
        "model_name": "demo",
        "capabilities": {
            "operations": ["generate", "edit", "inpaint"],
            "parameters": ["n", "size", "target_resolution", "upscale_model"],
        },
        "is_active_default": True,
    }
    row.update(overrides)
    return row


def _finish_studio_job(store: Any, job_id: str, png: bytes) -> None:
    job = store.get_job(job_id)
    output = store.save_asset(job["project_id"], png, "image/png", kind="output")
    store.add_job_output(job_id, output["id"], 0)
    store.update_job(job_id, "succeeded", actual={"n": 1})


def _patch_studio(monkeypatch: pytest.MonkeyPatch, tmp_path: Any, png: bytes) -> Any:
    from knorvia.services.image_studio.store import ImageStudioStore

    store = ImageStudioStore(tmp_path / "image-studio")
    monkeypatch.setattr("knorvia.services.image_studio.store.get_image_studio_store", lambda: store)
    monkeypatch.setattr("knorvia.services.image_studio.agent.get_image_studio_store", lambda: store)
    monkeypatch.setattr(
        "knorvia.services.image_studio.agent.list_usable_models", lambda: [_studio_model()]
    )

    def fake_start(studio: Any, job_id: str) -> None:
        _finish_studio_job(studio, job_id, png)

    monkeypatch.setattr("knorvia.services.image_studio.agent.start_job", fake_start)
    return store


@pytest.mark.asyncio
async def test_imagegen_tool_saves_public_artifact(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    """The tool must write Image Studio bytes to a path /api/outputs can serve."""
    import shutil

    import knorvia.services.imagegen as imagegen_mod
    from knorvia.services.path_service import get_path_service
    from knorvia.tools.media_gen_tool import ImagegenTool

    called = {"generate_image": 0}

    async def fake_generate_image(prompt: str, **_kwargs: Any) -> list[tuple[bytes, str]]:
        called["generate_image"] += 1
        return [(b"bypass", "image/png")]

    monkeypatch.setattr(imagegen_mod, "generate_image", fake_generate_image)
    png = _tiny_png()
    _patch_studio(monkeypatch, tmp_path, png)

    workspace = get_path_service().get_task_workspace("chat", "test_imagegen_tool") / "media"
    workspace.mkdir(parents=True, exist_ok=True)
    try:
        result = await ImagegenTool().execute(
            prompt="a cat", _workspace_dir=str(workspace), _session_id="sess-tool"
        )
        assert result.success, result.content
        assert called["generate_image"] == 0
        artifacts = result.metadata.get("artifacts") or []
        assert artifacts, "tool produced no artifacts"
        assert artifacts[0]["url"].startswith("/api/outputs/")
        assert artifacts[0]["mime_type"] == "image/png"
        assert result.metadata.get("studio_job_id")
        assert result.metadata.get("studio_project_id")
        assert "Image Studio project:" in result.content
    finally:
        shutil.rmtree(
            get_path_service().get_task_workspace("chat", "test_imagegen_tool"),
            ignore_errors=True,
        )


@pytest.mark.asyncio
async def test_imagegen_tool_without_injected_workspace_uses_public_fallback(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    """Direct tool calls still need a real public workspace, not a phantom agent dir."""
    import shutil

    from knorvia.services.path_service import get_path_service
    from knorvia.tools.media_gen_tool import ImagegenTool

    _patch_studio(monkeypatch, tmp_path, _tiny_png())

    task_root = get_path_service().get_task_workspace("chat", "media_gen")
    try:
        result = await ImagegenTool().execute(prompt="fallback image")
        assert result.success, result.content
        artifacts = result.metadata.get("artifacts") or []
        assert artifacts, "tool produced no artifacts"
        assert artifacts[0]["url"].startswith("/api/outputs/")
        assert "/workspace/chat/chat/media_gen/media/" in artifacts[0]["url"]
    finally:
        shutil.rmtree(task_root, ignore_errors=True)


@pytest.mark.asyncio
async def test_imagegen_tool_pauses_for_costly_confirmation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    import shutil

    from knorvia.services.path_service import get_path_service
    from knorvia.tools.media_gen_tool import ImagegenTool

    _patch_studio(monkeypatch, tmp_path, _tiny_png())
    result = await ImagegenTool().execute(prompt="a mural", n=2, _language="en")
    assert result.success
    assert result.pause_for_user
    assert result.metadata["needs_confirmation"] is True
    assert result.metadata["ask_user"]["questions"][0]["id"] == "studio_confirm"
    fingerprint = result.metadata["confirmation_fingerprint"]

    # A model-provided legacy boolean has no authority.
    bypass = await ImagegenTool().execute(prompt="a mural", n=2, confirmed=True)
    assert bypass.pause_for_user

    # Only the hidden server value for this exact immutable plan proceeds.
    changed = await ImagegenTool().execute(
        prompt="a mural", n=3, _studio_confirmation_fingerprint=fingerprint
    )
    assert changed.pause_for_user

    task_root = get_path_service().get_task_workspace("chat", "test_imagegen_confirmation")
    try:
        approved = await ImagegenTool().execute(
            prompt="a mural",
            n=2,
            _workspace_dir=str(task_root / "media"),
            _studio_confirmation_fingerprint=fingerprint,
        )
        assert approved.success, approved.content
    finally:
        shutil.rmtree(task_root, ignore_errors=True)


def test_imagegen_definition_does_not_expose_confirmation_boolean() -> None:
    from knorvia.tools.media_gen_tool import ImagegenTool

    names = {parameter.name for parameter in ImagegenTool().get_definition().parameters}
    assert "confirmed" not in names


@pytest.mark.asyncio
async def test_imagegen_tool_cancel(monkeypatch: pytest.MonkeyPatch) -> None:
    from knorvia.tools.media_gen_tool import ImagegenTool

    async def fake_cancel(job_id: str, **_kwargs: Any) -> bool:
        assert job_id == "job_stop"
        return True

    monkeypatch.setattr("knorvia.services.image_studio.agent.cancel_studio_job", fake_cancel)
    result = await ImagegenTool().execute(cancel_job_id="job_stop")
    assert result.success
    assert result.metadata["cancelled"] is True


@pytest.mark.asyncio
async def test_imagegen_tool_list_board_and_template(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    from knorvia.tools.media_gen_tool import ImagegenTool

    store = _patch_studio(monkeypatch, tmp_path, _tiny_png())
    from knorvia.services.path_service import get_path_service

    workspace = get_path_service().get_task_workspace("chat", "test_imagegen_board") / "media"
    workspace.mkdir(parents=True, exist_ok=True)
    listed = await ImagegenTool().execute(list_board=True, _session_id="sess-board")
    assert listed.success
    assert listed.metadata["studio_board"]["node_count"] == 0

    stamped = await ImagegenTool().execute(template="three-view", _session_id="sess-board")
    assert stamped.success, stamped.content
    assert len(stamped.metadata["generate_ids"]) == 3
    assert stamped.metadata["studio_board"]["node_count"] == 5

    project_id = stamped.metadata["studio_project_id"]
    target = stamped.metadata["generate_ids"][0]
    filled = await ImagegenTool().execute(
        prompt="front view, red coat",
        board_node_id=target,
        _session_id="sess-board",
        _workspace_dir=str(workspace),
    )
    assert filled.success, filled.content
    board = store.get_board(project_id)
    node = next(item for item in board["nodes"] if item["id"] == target)
    assert node.get("assetId")
    assert node["kind"] == "image"


@pytest.mark.asyncio
async def test_imagegen_tool_iterate_from_asset(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    from knorvia.tools.media_gen_tool import ImagegenTool

    store = _patch_studio(monkeypatch, tmp_path, _tiny_png())
    from knorvia.services.image_studio.agent import project_for_session

    session_project = project_for_session(store, "sess-iterate-from")
    asset = store.save_asset(session_project["id"], _tiny_png(), "image/png", kind="output")
    from knorvia.services.path_service import get_path_service

    workspace = get_path_service().get_task_workspace("chat", "test_imagegen_iterate") / "media"
    workspace.mkdir(parents=True, exist_ok=True)
    result = await ImagegenTool().execute(
        iterate_from=asset["id"],
        prompt="make it dusk",
        _session_id="sess-iterate-from",
        _workspace_dir=str(workspace),
    )
    assert result.success, result.content
    board = store.get_board(session_project["id"])
    generate = [node for node in board["nodes"] if node.get("parentNodeId")]
    assert generate
    assert any(node.get("assetId") for node in generate) or any(
        node.get("kind") == "image" and node.get("parentNodeId") for node in board["nodes"]
    )


@pytest.mark.asyncio
async def test_videogen_tool_requires_exact_confirmation_and_queues_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Agent video creation never calls a provider directly or trusts a boolean."""
    import knorvia.multi_user.model_access as access_mod
    import knorvia.services.video_studio.service as service_mod
    import knorvia.services.video_studio.store as store_mod
    from knorvia.tools.media_gen_tool import VideogenTool

    class Store:
        def ensure_default_project(self) -> dict[str, Any]:
            return {"id": "video_project_test"}

        def get_project(self, project_id: str) -> dict[str, Any] | None:
            return {"id": project_id} if project_id == "video_project_test" else None

    store = Store()
    monkeypatch.setattr(store_mod, "get_video_studio_store", lambda: store)
    monkeypatch.setattr(
        access_mod,
        "allowed_videogen_options",
        lambda: {
            "options": [
                {
                    "profile_id": "profile-video",
                    "model_id": "model-video",
                    "profile_name": "Provider",
                    "model_name": "Video Model",
                    "is_active_default": True,
                }
            ]
        },
    )
    monkeypatch.setattr(
        service_mod, "allowed_videogen_options", access_mod.allowed_videogen_options
    )
    calls: list[dict[str, Any]] = []

    def create(**kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        return {"id": "video_job_1", "status": "queued"}

    monkeypatch.setattr(service_mod, "create_agent_video_job", create)
    tool = VideogenTool()
    planned = await tool.execute(prompt="an ocean wave", duration="5", _language="en")
    assert planned.success
    assert planned.pause_for_user
    assert calls == []
    confirmation_intro = planned.metadata["ask_user"]["intro"]
    assert "an ocean wave" in confirmation_intro
    assert '"duration":"5"' in confirmation_intro
    fingerprint = planned.metadata["confirmation_fingerprint"]
    request_id = planned.metadata["confirmation_request_id"]

    changed = await tool.execute(
        prompt="a changed wave",
        duration="5",
        _video_confirmation_fingerprint=fingerprint,
        _video_client_request_id=request_id,
    )
    assert changed.pause_for_user
    assert calls == []

    queued = await tool.execute(
        prompt="an ocean wave",
        duration="5",
        _video_confirmation_fingerprint=fingerprint,
        _video_client_request_id=request_id,
    )
    assert queued.success
    assert queued.metadata["video_studio_job_id"] == "video_job_1"
    assert queued.metadata["open_url"] == (
        "/video-studio?project=video_project_test&job=video_job_1"
    )
    assert calls[0]["confirmed_cost"] is True
    assert calls[0]["client_request_id"] == request_id


@pytest.mark.asyncio
async def test_videogen_tool_imports_server_side_chat_image_before_confirmation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
) -> None:
    import knorvia.multi_user.model_access as access_mod
    import knorvia.services.video_studio.service as service_mod
    import knorvia.services.video_studio.store as store_mod
    from knorvia.services.video_studio.store import VideoStudioStore
    from knorvia.tools.media_gen_tool import VideogenTool

    store = VideoStudioStore(tmp_path / "video-studio")
    monkeypatch.setattr(store_mod, "get_video_studio_store", lambda: store)
    monkeypatch.setattr(
        access_mod,
        "allowed_videogen_options",
        lambda: {
            "options": [
                {
                    "profile_id": "profile-video",
                    "model_id": "model-video",
                    "profile_name": "Provider",
                    "model_name": "Video Model",
                    "is_active_default": True,
                    "capabilities": {
                        "operations": ["image_to_video"],
                        "max_inputs": {"image": 1, "video": 0, "audio": 0, "total": 1},
                    },
                }
            ]
        },
    )
    monkeypatch.setattr(
        service_mod, "allowed_videogen_options", access_mod.allowed_videogen_options
    )
    calls: list[dict[str, Any]] = []

    def create(**kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        return {"id": "video_job_image", "status": "queued"}

    monkeypatch.setattr(service_mod, "create_agent_video_job", create)
    attachment = {
        "base64": base64.b64encode(_tiny_png()).decode("ascii"),
        "mime_type": "image/png",
        "filename": "wave reference.png",
    }
    tool = VideogenTool()
    planned = await tool.execute(
        prompt="make the wave move",
        operation="image_to_video",
        _chat_attachments=[attachment],
    )

    assert planned.success and planned.pause_for_user
    imported_ids = planned.metadata["video_input_asset_ids"]
    assert len(imported_ids) == 1
    assert store.get_asset(imported_ids[0])["project_id"] == planned.metadata["plan"]["project_id"]
    assert calls == []

    queued = await tool.execute(
        prompt="make the wave move",
        operation="image_to_video",
        _video_input_asset_ids=imported_ids,
        _video_confirmation_fingerprint=planned.metadata["confirmation_fingerprint"],
        _video_client_request_id=planned.metadata["confirmation_request_id"],
    )
    assert queued.success
    assert calls[0]["input_asset_ids"] == imported_ids


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("kwargs", "message"),
    [
        ({"operation": "edit"}, "does not support this video operation"),
        ({"duration": "10"}, "Unsupported duration"),
        (
            {"operation": "video_to_video", "input_asset_ids": "video_asset_image"},
            "requires a video",
        ),
        ({"seed": 123}, "does not support seed"),
    ],
)
async def test_videogen_tool_rejects_invalid_plan_before_confirmation(
    monkeypatch: pytest.MonkeyPatch,
    kwargs: dict[str, Any],
    message: str,
) -> None:
    import knorvia.multi_user.model_access as access_mod
    import knorvia.services.video_studio.service as service_mod
    import knorvia.services.video_studio.store as store_mod
    from knorvia.tools.media_gen_tool import VideogenTool

    class Store:
        def ensure_default_project(self) -> dict[str, Any]:
            return {"id": "video_project_validation"}

        def get_project(self, project_id: str) -> dict[str, Any] | None:
            return {"id": project_id} if project_id == "video_project_validation" else None

        def get_asset(self, asset_id: str) -> dict[str, Any] | None:
            if asset_id != "video_asset_image":
                return None
            return {
                "id": asset_id,
                "project_id": "video_project_validation",
                "kind": "image",
                "size_bytes": 1024,
            }

        def get_assets_by_ids(self, asset_ids: Any) -> dict[str, dict[str, Any]]:
            found: dict[str, dict[str, Any]] = {}
            for asset_id in asset_ids:
                asset = self.get_asset(str(asset_id))
                if asset is not None:
                    found[str(asset_id)] = asset
            return found

    def options() -> dict[str, Any]:
        return {
            "options": [
                {
                    "profile_id": "profile-video",
                    "model_id": "model-video",
                    "profile_name": "Provider",
                    "model_name": "Video Model",
                    "is_active_default": True,
                    "capabilities": {
                        "operations": ["text_to_video", "video_to_video"],
                        "durations": [5],
                        "max_inputs": {"image": 2, "video": 2, "audio": 0, "total": 2},
                        "supports_seed": False,
                    },
                }
            ]
        }

    monkeypatch.setattr(store_mod, "get_video_studio_store", lambda: Store())
    monkeypatch.setattr(access_mod, "allowed_videogen_options", options)
    monkeypatch.setattr(service_mod, "allowed_videogen_options", options)

    result = await VideogenTool().execute(prompt="a validation probe", **kwargs)

    assert not result.success
    assert result.pause_for_user is None
    assert message in result.content


@pytest.mark.asyncio
async def test_videogen_tool_rejects_unsafe_image_attachment_before_cost_confirmation(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
) -> None:
    import knorvia.multi_user.model_access as access_mod
    import knorvia.services.video_studio.store as store_mod
    from knorvia.services.video_studio.store import VideoStudioStore
    from knorvia.tools.media_gen_tool import VideogenTool

    store = VideoStudioStore(tmp_path / "video-studio")
    monkeypatch.setattr(store_mod, "get_video_studio_store", lambda: store)
    monkeypatch.setattr(
        access_mod,
        "allowed_videogen_options",
        lambda: {
            "options": [
                {
                    "profile_id": "profile-video",
                    "model_id": "model-video",
                    "is_active_default": True,
                    "capabilities": {
                        "operations": ["image_to_video"],
                        "max_inputs": {"image": 1, "video": 0, "audio": 0, "total": 1},
                    },
                }
            ]
        },
    )

    result = await VideogenTool().execute(
        prompt="animate it",
        operation="image_to_video",
        _chat_attachments=[
            {
                "base64": base64.b64encode(b"not an image").decode("ascii"),
                "mime_type": "image/png",
                "filename": "bad.png",
            }
        ],
    )

    assert not result.success
    assert result.pause_for_user is None
    assert "Upload it in Video Studio first" in result.content


def _patch_video_studio(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Any,
) -> tuple[Any, list[dict[str, Any]]]:
    """Real Video Studio store + granted catalog + recorded job creations."""
    import knorvia.multi_user.model_access as access_mod
    import knorvia.services.video_studio.service as service_mod
    import knorvia.services.video_studio.store as store_mod
    from knorvia.services.video_studio.store import VideoStudioStore

    store = VideoStudioStore(tmp_path / "video-studio")
    monkeypatch.setattr(store_mod, "get_video_studio_store", lambda: store)

    def options() -> dict[str, Any]:
        return {
            "options": [
                {
                    "profile_id": "profile-video",
                    "model_id": "model-video",
                    "profile_name": "Provider",
                    "model_name": "Video Model",
                    "is_active_default": True,
                    "capabilities": {
                        "operations": [
                            "text_to_video",
                            "image_to_video",
                            "video_to_video",
                            "extend",
                        ],
                        "durations": [5, 10],
                        "aspect_ratios": ["16:9", "9:16"],
                        "reference_modes": [
                            "auto",
                            "first-frame",
                            "first-last",
                            "multi",
                            "universal",
                        ],
                        "audio_modes": ["none", "generate", "input"],
                        "max_inputs": {"image": 4, "video": 2, "audio": 2, "total": 6},
                    },
                }
            ]
        }

    monkeypatch.setattr(access_mod, "allowed_videogen_options", options)
    monkeypatch.setattr(service_mod, "allowed_videogen_options", options)
    calls: list[dict[str, Any]] = []

    def create(**kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        return {"id": f"video_job_{len(calls)}", "status": "queued"}

    monkeypatch.setattr(service_mod, "create_agent_video_job", create)
    return store, calls


def _fake_mp4() -> bytes:
    # Sniffs as video/mp4 (offset 4 holds "ftyp") without a real decoder.
    return b"\x00\x00\x00\x18ftypisom" + b"\x00movi" * 8


@pytest.mark.asyncio
async def test_videogen_list_board_does_not_generate(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    from knorvia.tools.media_gen_tool import VideogenTool

    tool = VideogenTool()
    empty = await tool.execute(list_board=True, _session_id="sess-video-board")
    assert empty.success, empty.content
    assert empty.pause_for_user is None
    assert calls == []
    assert empty.metadata["video_studio_board"]["node_count"] == 0

    stamped = await tool.execute(template="storyboard-6", _session_id="sess-video-board")
    assert stamped.success, stamped.content

    listed = await tool.execute(list_board=True, _session_id="sess-video-board")
    assert listed.success
    assert listed.pause_for_user is None
    assert calls == []
    node_ids = [node["id"] for node in listed.metadata["video_studio_board"]["nodes"]]
    assert any(node_id.startswith("generate_") for node_id in node_ids)
    for node_id in node_ids:
        assert node_id in listed.content


@pytest.mark.asyncio
async def test_videogen_template_places_nodes_without_jobs(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    from knorvia.tools.media_gen_tool import VideogenTool

    result = await VideogenTool().execute(template="shot-i2v", _session_id="sess-video-template")
    assert result.success, result.content
    assert result.pause_for_user is None
    assert calls == []
    assert result.metadata["jobs_created"] == 0
    assert result.metadata["template"] == "shot-i2v"
    generate_ids = result.metadata["generate_ids"]
    assert generate_ids

    project_id = result.metadata["video_studio_project_id"]
    board = store.get_board(project_id)
    generate_nodes = [node for node in board["nodes"] if node["kind"] == "generate"]
    assert len(generate_nodes) == len(generate_ids)
    assert store.list_jobs(project_id) == []

    # Repeating a template reuses the unbound cards instead of stacking rows.
    again = await VideogenTool().execute(template="shot-i2v", _session_id="sess-video-template")
    assert again.success, again.content
    assert calls == []
    assert again.metadata["jobs_created"] == 0
    assert sorted(again.metadata["generate_ids"]) == sorted(generate_ids)
    assert len(store.get_board(project_id)["nodes"]) == len(board["nodes"])


@pytest.mark.asyncio
async def test_videogen_board_node_id_targets_existing_card(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    from knorvia.tools.media_gen_tool import VideogenTool

    tool = VideogenTool()
    stamped = await tool.execute(template="storyboard-6", _session_id="sess-video-target")
    assert stamped.success, stamped.content
    target = stamped.metadata["generate_ids"][0]

    planned = await tool.execute(
        prompt="twin frames of a lighthouse",
        operation="text_to_video",
        board_node_id=target,
        _session_id="sess-video-target",
    )
    assert planned.success, planned.content
    assert planned.pause_for_user
    assert calls == []
    assert planned.metadata["plan"]["board_node_id"] == target

    queued = await tool.execute(
        prompt="twin frames of a lighthouse",
        operation="text_to_video",
        board_node_id=target,
        _session_id="sess-video-target",
        _video_confirmation_fingerprint=planned.metadata["confirmation_fingerprint"],
        _video_client_request_id=planned.metadata["confirmation_request_id"],
    )
    assert queued.success, queued.content
    assert calls[0]["board_node_id"] == target
    assert queued.metadata["board_node_id"] == target

    missing = await tool.execute(
        prompt="no such card",
        operation="text_to_video",
        board_node_id="generate_missing",
        _session_id="sess-video-target",
    )
    assert not missing.success
    assert missing.pause_for_user is None
    assert "was not found" in missing.content


@pytest.mark.asyncio
async def test_videogen_iterate_from_video_asset_links_continue_from(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    from knorvia.tools.media_gen_tool import VideogenTool

    project = store.project_for_session("sess-video-iterate", title="Chat · sess-video-iterate")
    asset = store.import_asset_bytes(project["id"], _fake_mp4(), "video/mp4", "previous-clip.mp4")

    tool = VideogenTool()
    planned = await tool.execute(
        prompt="continue the chase downhill",
        iterate_from=asset["id"],
        _session_id="sess-video-iterate",
    )
    assert planned.success, planned.content
    assert planned.pause_for_user
    assert calls == []
    assert planned.metadata["plan"]["operation"] == "extend"

    board = store.get_board(project["id"])
    edges = [edge for edge in board["edges"] if edge["role"] == "continue-from"]
    assert edges
    continue_edges = [
        edge
        for edge in edges
        if any(node["id"] == edge["to"] and node["kind"] == "generate" for node in board["nodes"])
    ]
    assert continue_edges

    queued = await tool.execute(
        prompt="continue the chase downhill",
        iterate_from=asset["id"],
        _session_id="sess-video-iterate",
        _video_confirmation_fingerprint=planned.metadata["confirmation_fingerprint"],
        _video_client_request_id=planned.metadata["confirmation_request_id"],
    )
    assert queued.success, queued.content
    assert calls[0]["input_roles"] == ["continue-from"]
    assert calls[0]["input_asset_ids"] == [asset["id"]]


@pytest.mark.asyncio
async def test_videogen_iterate_from_extend_runs_local_last_frame_pipeline(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    """iterate_from end to end: queued extend job reaches the §C1 path-one rewrite.

    Drives the real VideogenTool → create_video_job → engine chain, so the
    continue-from input recorded at queue time is the exact payload the local
    last-frame derivation consumes at run time.
    """
    store, _calls = _patch_video_studio(monkeypatch, tmp_path)
    from knorvia.multi_user.models import LOCAL_ADMIN_ID
    import knorvia.services.video_studio.engine as engine_mod
    from knorvia.services.video_studio.provider import (
        FakeVideoStudioAdapter,
        VideoInput,
    )
    import knorvia.services.video_studio.service as service_mod
    from knorvia.services.videogen.config import VideogenConfig
    from knorvia.tools.media_gen_tool import VideogenTool

    class _RecordingAdapter(FakeVideoStudioAdapter):
        def __init__(self) -> None:
            super().__init__()
            self.submits: list[dict[str, Any]] = []

        async def submit(
            self,
            prompt: str,
            config: Any,
            *,
            inputs: list[VideoInput],
            parameters: dict[str, Any],
            idempotency_key: str,
        ) -> str:
            self.submits.append(
                {"prompt": prompt, "inputs": list(inputs), "parameters": dict(parameters)}
            )
            return await super().submit(
                prompt,
                config,
                inputs=inputs,
                parameters=parameters,
                idempotency_key=idempotency_key,
            )

    class _FakeFFmpeg:
        def __init__(self) -> None:
            self.calls: list[Any] = []

        async def extract_last_frame(self, video: Any, output: Any) -> Any:
            self.calls.append(video)
            output.write_bytes(_tiny_png())
            return output

    adapter = _RecordingAdapter()
    ffmpeg = _FakeFFmpeg()
    monkeypatch.setattr(engine_mod, "_authorized_catalog", lambda _job: {})
    monkeypatch.setattr(
        engine_mod,
        "resolve_videogen_runtime_config",
        lambda **_: VideogenConfig(
            model="fake", adapter="fake", base_url="https://fake.test", poll_interval=0.001
        ),
    )
    monkeypatch.setattr(engine_mod, "get_video_studio_adapter", lambda _name: adapter)
    monkeypatch.setattr(engine_mod, "get_ffmpeg_tool", lambda: ffmpeg)
    # Real job creation (validation + persistence), runner kept idle so the
    # engine run is driven deterministically below.
    monkeypatch.setattr(
        service_mod,
        "capture_video_authorization",
        lambda *_: {"owner_user_id": LOCAL_ADMIN_ID, "config_revision": "revision"},
    )
    monkeypatch.setattr(service_mod, "start_video_job", lambda *_: None)
    monkeypatch.setattr(
        service_mod,
        "create_agent_video_job",
        lambda **kwargs: service_mod.create_video_job(**kwargs),
    )

    project = store.project_for_session(
        "sess-video-extend-run", title="Chat · sess-video-extend-run"
    )
    asset = store.import_asset_bytes(project["id"], _fake_mp4(), "video/mp4", "previous-clip.mp4")

    tool = VideogenTool()
    planned = await tool.execute(
        prompt="keep the lantern lit",
        iterate_from=asset["id"],
        _session_id="sess-video-extend-run",
    )
    assert planned.success, planned.content
    assert planned.pause_for_user
    assert planned.metadata["plan"]["operation"] == "extend"

    queued = await tool.execute(
        prompt="keep the lantern lit",
        iterate_from=asset["id"],
        _session_id="sess-video-extend-run",
        _video_confirmation_fingerprint=planned.metadata["confirmation_fingerprint"],
        _video_client_request_id=planned.metadata["confirmation_request_id"],
    )
    assert queued.success, queued.content
    job_id = str(queued.metadata["video_studio_job_id"])

    await engine_mod._run_in_owner_context(store, job_id)

    finished = store.get_job(job_id)
    assert finished["status"] == "succeeded"
    assert finished["operation"] == "extend"  # user-facing semantics preserved
    assert ffmpeg.calls == [store.asset_path(asset["id"])]

    submitted = adapter.submits[0]
    assert submitted["prompt"] == "keep the lantern lit"  # verbatim, no rewrite
    assert [(item.kind, item.role) for item in submitted["inputs"]] == [("image", "first-frame")]
    derived_event = next(
        item for item in store.events_after(job_id) if item["type"] == "job.extend_derived"
    )
    assert derived_event["extend_mode"] == "local_last_frame"
    assert derived_event["source_video_asset_id"] == asset["id"]
    assert submitted["inputs"][0].path == store.asset_path(
        derived_event["derived_first_frame_asset_id"]
    )


@pytest.mark.asyncio
async def test_videogen_input_roles_parallel_mapping_and_rejection(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    from knorvia.tools.media_gen_tool import VideogenTool

    project = store.project_for_session("sess-video-roles", title="Chat · sess-video-roles")
    first = store.import_asset_bytes(project["id"], _tiny_png(), "image/png", "first.png")
    last = store.import_asset_bytes(project["id"], _tiny_png(), "image/png", "last.png")

    tool = VideogenTool()
    mismatch = await tool.execute(
        prompt="blend two frames",
        operation="image_to_video",
        input_asset_ids=f"{first['id']}",
        input_roles="first-frame,last-frame",
        _session_id="sess-video-roles",
    )
    assert not mismatch.success
    assert mismatch.pause_for_user is None
    assert "parallel" in mismatch.content

    unknown = await tool.execute(
        prompt="blend two frames",
        operation="image_to_video",
        input_asset_ids=f"{first['id']},{last['id']}",
        input_roles="magic,reference",
        _session_id="sess-video-roles",
    )
    assert not unknown.success
    assert "Unknown input role" in unknown.content

    planned = await tool.execute(
        prompt="blend two frames",
        operation="image_to_video",
        input_asset_ids=f"{first['id']},{last['id']}",
        input_roles="first-frame,last-frame",
        _session_id="sess-video-roles",
    )
    assert planned.success, planned.content
    assert planned.pause_for_user
    assert calls == []
    roles = [item["role"] for item in planned.metadata["plan"]["inputs"]]
    assert roles == ["first-frame", "last-frame"]

    queued = await tool.execute(
        prompt="blend two frames",
        operation="image_to_video",
        input_asset_ids=f"{first['id']},{last['id']}",
        input_roles="first-frame,last-frame",
        _session_id="sess-video-roles",
        _video_confirmation_fingerprint=planned.metadata["confirmation_fingerprint"],
        _video_client_request_id=planned.metadata["confirmation_request_id"],
    )
    assert queued.success, queued.content
    assert calls[0]["input_roles"] == ["first-frame", "last-frame"]


@pytest.mark.asyncio
async def test_videogen_plan_episode_writes_storyboard_and_board_without_jobs(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    from knorvia.tools.media_gen_tool import VideogenTool

    shots = json.dumps(
        [
            {"title": "开场", "prompt": "city rooftop at dusk, drone shot", "duration": 5},
            {"title": "相遇", "prompt": "two strangers collide in a market"},
            {"title": "结尾", "prompt": "they share an umbrella in the rain", "duration": 10},
        ],
        ensure_ascii=False,
    )
    result = await VideogenTool().execute(
        action="plan_episode", shots=shots, _session_id="sess-video-plan", _language="zh"
    )
    assert result.success, result.content
    assert result.pause_for_user is None
    assert calls == []
    assert result.metadata["jobs_created"] == 0

    project_id = result.metadata["video_studio_project_id"]
    shot_ids = result.metadata["shot_ids"]
    assert len(shot_ids) == 3
    storyboard = store.get_storyboard(project_id)
    stored = [shot for shot in storyboard["shots"] if shot["id"] in set(shot_ids)]
    assert [shot["prompt"] for shot in stored] == [
        "city rooftop at dusk, drone shot",
        "two strangers collide in a market",
        "they share an umbrella in the rain",
    ]
    board = store.get_board(project_id)
    generate_nodes = [node for node in board["nodes"] if node["kind"] == "generate"]
    assert len(generate_nodes) == 3
    assert result.metadata["board_nodes_placed"] == 3
    assert store.list_jobs(project_id) == []

    # The zh reply must steer the user to confirm each shot separately.
    assert "生成第 1 镜" in result.content
    assert "一次只提交一个任务" in result.content

    # Re-planning the same episode dedupes canvas cards (import is idempotent).
    repeat = await VideogenTool().execute(
        action="plan_episode", shots=shots, _session_id="sess-video-plan", _language="zh"
    )
    assert repeat.success, repeat.content
    assert repeat.metadata["board_nodes_placed"] == 0
    assert repeat.metadata["board_nodes_skipped"] == 3
    assert len(store.get_board(project_id)["nodes"]) == len(board["nodes"])
    assert calls == []


@pytest.mark.asyncio
async def test_videogen_plan_episode_stores_camera_motion_without_provider_calls(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    from knorvia.tools.media_gen_tool import VideogenTool

    shots = json.dumps(
        [
            {"title": "开场", "prompt": "rooftop at dusk", "camera": " push "},
            {"title": "相遇", "prompt": "market collision", "camera": "pan-left"},
            {"title": "结尾", "prompt": "umbrella in the rain", "duration": 10},
        ],
        ensure_ascii=False,
    )
    result = await VideogenTool().execute(
        action="plan_episode", shots=shots, _session_id="sess-video-plan-cam", _language="zh"
    )
    assert result.success, result.content
    # Free planning keeps the zero-provider-call guardrail.
    assert calls == []
    assert result.metadata["jobs_created"] == 0

    project_id = result.metadata["video_studio_project_id"]
    shot_ids = result.metadata["shot_ids"]
    stored = {shot["id"]: shot for shot in store.get_storyboard(project_id)["shots"]}
    # Trimmed on parse, empty stays unset — camera survives the round trip.
    assert [stored[shot_id].get("camera") for shot_id in shot_ids] == [
        "push",
        "pan-left",
        None,
    ]
    # The canvas generate card carries the motion for the C4 badge.
    board = store.get_board(project_id)
    generates = {node["prompt"]: node for node in board["nodes"] if node["kind"] == "generate"}
    assert generates["rooftop at dusk"]["camera"] == "push"
    assert generates["market collision"]["camera"] == "pan-left"
    assert "camera" not in generates["umbrella in the rain"]
    assert store.list_jobs(project_id) == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "shots",
    [
        "not json at all",
        "[]",
        json.dumps([{"title": "no prompt"}]),
        json.dumps([{"title": f"s{i}", "prompt": "p"} for i in range(21)]),
    ],
)
async def test_videogen_plan_episode_rejects_invalid_shots(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any, shots: str
) -> None:
    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    from knorvia.tools.media_gen_tool import VideogenTool

    result = await VideogenTool().execute(
        action="plan_episode", shots=shots, _session_id="sess-video-plan-bad"
    )
    assert not result.success
    assert result.pause_for_user is None
    assert calls == []
    project_id = result.metadata.get("video_studio_project_id") if result.metadata else None
    if project_id:
        assert store.get_storyboard(project_id)["shots"] == []
        assert store.get_board(project_id)["nodes"] == []
    else:
        # The shot list was rejected before any project resolution happened.
        assert "sess-video-plan-bad" not in {
            str(row.get("id") or "") for row in store.list_projects()
        }


@pytest.mark.asyncio
async def test_videogen_does_not_rewrite_prompt(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    from knorvia.tools.media_gen_tool import VideogenTool

    exact = '  A  wave!! (keep "as-is") — 逐字  '
    stripped = exact.strip()
    assert stripped != " ".join(stripped.split())  # inner spacing must survive

    tool = VideogenTool()
    planned = await tool.execute(prompt=exact, _session_id="sess-video-fidelity")
    assert planned.success, planned.content
    assert planned.pause_for_user
    assert planned.metadata["plan"]["prompt"] == stripped

    queued = await tool.execute(
        prompt=exact,
        _session_id="sess-video-fidelity",
        _video_confirmation_fingerprint=planned.metadata["confirmation_fingerprint"],
        _video_client_request_id=planned.metadata["confirmation_request_id"],
    )
    assert queued.success, queued.content
    assert calls[0]["prompt"] == stripped


@pytest.mark.asyncio
async def test_videogen_one_job_per_execute(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    from knorvia.tools.media_gen_tool import VideogenTool

    tool = VideogenTool()
    planned = await tool.execute(
        prompt="one template, one job",
        template="storyboard-6",
        _session_id="sess-video-single",
    )
    assert planned.success, planned.content
    assert planned.pause_for_user
    assert calls == []

    queued = await tool.execute(
        prompt="one template, one job",
        template="storyboard-6",
        _session_id="sess-video-single",
        _video_confirmation_fingerprint=planned.metadata["confirmation_fingerprint"],
        _video_client_request_id=planned.metadata["confirmation_request_id"],
    )
    assert queued.success, queued.content
    assert len(calls) == 1
    assert queued.metadata["video_studio_job_id"] == "video_job_1"


@pytest.mark.asyncio
async def test_no_generate_video_import(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    """The chat tool must never reach the raw provider facade (§10/§14)."""
    import inspect

    import knorvia.services.videogen as videogen_mod
    from knorvia.tools import media_gen_tool

    source = inspect.getsource(media_gen_tool)
    assert "services.videogen" not in source
    assert "generate_video" not in source

    def explode(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("videogen must route through Video Studio, not generate_video")

    monkeypatch.setattr(videogen_mod, "generate_video", explode)
    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    from knorvia.tools.media_gen_tool import VideogenTool

    tool = VideogenTool()
    planned = await tool.execute(prompt="safe routing", _session_id="sess-video-raw")
    assert planned.pause_for_user
    queued = await tool.execute(
        prompt="safe routing",
        _session_id="sess-video-raw",
        _video_confirmation_fingerprint=planned.metadata["confirmation_fingerprint"],
        _video_client_request_id=planned.metadata["confirmation_request_id"],
    )
    assert queued.success, queued.content
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_videogen_list_characters_does_not_generate(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    from knorvia.tools.media_gen_tool import VideogenTool

    tool = VideogenTool()
    empty = await tool.execute(list_characters=True, _session_id="sess-video-chars")
    assert empty.success, empty.content
    assert empty.pause_for_user is None
    assert calls == []
    assert "empty" in empty.content

    project = store.project_for_session("sess-video-chars", title="Chat · sess-video-chars")
    reference = store.import_asset_bytes(project["id"], _tiny_png(), "image/png", "hero.png")
    store.create_character(
        project["id"],
        name="阿澈",
        description="蓝发少年侦探",
        reference_asset_ids=[reference["id"]],
        voice_hint="bright young male",
    )

    listed = await tool.execute(list_characters=True, _session_id="sess-video-chars")
    assert listed.success
    assert listed.pause_for_user is None
    assert calls == []
    characters = listed.metadata["video_studio_characters"]
    assert len(characters) == 1
    assert characters[0]["name"] == "阿澈"
    assert listed.metadata["jobs_created"] == 0
    assert "阿澈" in listed.content
    assert characters[0]["id"] in listed.content


@pytest.mark.asyncio
async def test_videogen_character_ids_merges_references_and_rejects_overload(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    from knorvia.tools.media_gen_tool import VideogenTool

    project = store.project_for_session("sess-video-charrefs", title="Chat · sess-video-charrefs")
    three_view = store.import_asset_bytes(project["id"], _tiny_png(), "image/png", "three-view.png")
    portrait = store.import_asset_bytes(project["id"], _tiny_png(), "image/png", "portrait.png")
    character = store.create_character(
        project["id"],
        name="阿澈",
        reference_asset_ids=[portrait["id"]],
    )
    store.set_character_three_view(project["id"], character["id"], three_view["id"])

    tool = VideogenTool()
    planned = await tool.execute(
        prompt="the detective walks into the rainy alley",
        operation="image_to_video",
        character_ids=character["id"],
        _session_id="sess-video-charrefs",
    )
    assert planned.success, planned.content
    assert planned.pause_for_user
    assert calls == []
    # Three-view sheet leads, stored reference follows, both tagged reference.
    assert planned.metadata["plan"]["inputs"] == [
        {"asset_id": three_view["id"], "role": "reference"},
        {"asset_id": portrait["id"], "role": "reference"},
    ]

    queued = await tool.execute(
        prompt="the detective walks into the rainy alley",
        operation="image_to_video",
        character_ids=character["id"],
        _session_id="sess-video-charrefs",
        _video_confirmation_fingerprint=planned.metadata["confirmation_fingerprint"],
        _video_client_request_id=planned.metadata["confirmation_request_id"],
    )
    assert queued.success, queued.content
    assert calls[0]["input_asset_ids"] == [three_view["id"], portrait["id"]]
    # All-reference roles collapse to the default (None) on the service call.
    assert calls[0]["input_roles"] is None

    missing = await tool.execute(
        prompt="unknown identity",
        operation="image_to_video",
        character_ids="character_missing",
        _session_id="sess-video-charrefs",
    )
    assert not missing.success
    assert missing.pause_for_user is None
    assert "was not found" in missing.content

    # max_inputs.image=4: five references across two characters must be refused
    # before any provider call.
    extra_ids = [
        store.import_asset_bytes(project["id"], _tiny_png(), "image/png", f"extra-{index}.png")[
            "id"
        ]
        for index in range(4)
    ]
    second = store.create_character(project["id"], name="小满", reference_asset_ids=extra_ids[:3])
    overload = await tool.execute(
        prompt="two heroes on the bridge",
        operation="image_to_video",
        character_ids=f"{character['id']},{second['id']}",
        _session_id="sess-video-charrefs",
    )
    assert not overload.success
    assert overload.pause_for_user is None
    assert "at most 4" in overload.content
    assert len(calls) == 1

    empty_character = store.create_character(project["id"], name="影子")
    no_assets = await tool.execute(
        prompt="a silhouette",
        operation="image_to_video",
        character_ids=empty_character["id"],
        _session_id="sess-video-charrefs",
    )
    assert not no_assets.success
    assert "no reference images" in no_assets.content


@pytest.mark.asyncio
async def test_videogen_plan_episode_attaches_and_validates_characters(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    from knorvia.tools.media_gen_tool import VideogenTool

    project = store.project_for_session("sess-video-planchars", title="Chat · sess-video-planchars")
    reference = store.import_asset_bytes(project["id"], _tiny_png(), "image/png", "hero.png")
    character = store.create_character(
        project["id"], name="阿澈", reference_asset_ids=[reference["id"]]
    )

    shots = json.dumps(
        [
            {
                "title": "开场",
                "prompt": "the detective surveys the rooftop",
                "duration": 5,
                "characters": [character["id"]],
            },
            {"title": "转场", "prompt": "neon streets below", "duration": 5},
        ],
        ensure_ascii=False,
    )
    result = await VideogenTool().execute(
        action="plan_episode",
        shots=shots,
        _session_id="sess-video-planchars",
        _language="zh",
    )
    assert result.success, result.content
    assert result.pause_for_user is None
    assert calls == []
    project_id = result.metadata["video_studio_project_id"]
    assert project_id == project["id"]
    storyboard = store.get_storyboard(project_id)
    assert storyboard["shots"][0]["character_ids"] == [character["id"]]
    assert storyboard["shots"][1]["character_ids"] == []

    bogus = json.dumps(
        [{"title": "x", "prompt": "y", "characters": ["character_ghost"]}],
        ensure_ascii=False,
    )
    rejected = await VideogenTool().execute(
        action="plan_episode",
        shots=bogus,
        _session_id="sess-video-planchars",
        _language="zh",
    )
    assert not rejected.success
    assert rejected.pause_for_user is None
    assert "character" in rejected.content.lower()


@pytest.mark.asyncio
async def test_generate_image_facade_rejects_empty_prompt() -> None:
    with pytest.raises(GenerationProviderError, match="empty prompt"):
        await generate_image("   ", catalog=_media_catalog())


@pytest.mark.asyncio
async def test_probe_video_returns_task_id(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _patch_http(monkeypatch, post=httpx.Response(200, json={"id": "probe-1"}))
    task_id = await probe_video("test clip", catalog=_media_catalog())
    assert task_id == "probe-1"
    # Probe submits only — no polling GET.
    assert captured["gets"] == []


@pytest.mark.asyncio
async def test_generate_video_facade(monkeypatch: pytest.MonkeyPatch) -> None:
    submit = httpx.Response(200, json={"id": "task-9"})

    def get_router(url: str, _kwargs: Any) -> httpx.Response:
        if "tasks/task-9" in url:
            return httpx.Response(
                200, json={"status": "succeeded", "content": {"video_url": "https://cdn/v.mp4"}}
            )
        return httpx.Response(200, content=b"VID", headers={"content-type": "video/mp4"})

    _patch_http(monkeypatch, post=submit, get=get_router)
    # Default poll_interval would sleep, but the first poll succeeds so no sleep.
    video, content_type = await generate_video("ocean", catalog=_media_catalog())
    assert video == b"VID"
    assert content_type == "video/mp4"


@pytest.mark.asyncio
async def test_videogen_plan_episode_stores_keyframe_prompt(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    from knorvia.tools.media_gen_tool import VideogenTool

    shots = json.dumps(
        [
            {
                "title": "开场",
                "prompt": "city rooftop at dusk, drone shot",
                "duration": 5,
                "keyframe_prompt": "rooftop skyline, golden hour, cinematic still",
            },
            {"title": "相遇", "prompt": "two strangers collide in a market"},
        ],
        ensure_ascii=False,
    )
    result = await VideogenTool().execute(
        action="plan_episode", shots=shots, _session_id="sess-video-kf-store"
    )
    assert result.success, result.content
    assert calls == []
    project_id = result.metadata["video_studio_project_id"]
    storyboard = store.get_storyboard(project_id)
    by_title = {shot["title"]: shot for shot in storyboard["shots"]}
    assert by_title["开场"]["keyframe_prompt"] == ("rooftop skyline, golden hour, cinematic still")
    assert by_title["相遇"]["keyframe_prompt"] == ""


@pytest.mark.asyncio
async def test_videogen_keyframe_for_shot_confirmation_flow(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    import knorvia.services.video_studio.service as service_mod
    from knorvia.tools.media_gen_tool import VideogenTool

    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    shots = json.dumps([{"title": "开场", "prompt": "city rooftop at dusk"}])
    planned_episode = await VideogenTool().execute(
        action="plan_episode", shots=shots, _session_id="sess-video-kf"
    )
    assert planned_episode.success, planned_episode.content
    project_id = planned_episode.metadata["video_studio_project_id"]
    shot_id = planned_episode.metadata["shot_ids"][0]

    executed: list[dict[str, Any]] = []

    async def fake_keyframe(_store: Any, **kwargs: Any) -> dict[str, Any]:
        executed.append(kwargs)
        return {
            "asset": {"id": "video_asset_kf1", "mime_type": "image/png"},
            "image_job_id": "img_job_1",
            "shot_prompt": kwargs.get("prompt") or "fallback",
            "storyboard": {},
        }

    monkeypatch.setattr(service_mod, "create_shot_keyframe", fake_keyframe)

    tool = VideogenTool()
    confirm = await tool.execute(
        keyframe_for_shot=shot_id, _session_id="sess-video-kf", _language="zh"
    )
    assert confirm.success, confirm.content
    assert confirm.pause_for_user
    assert executed == []
    assert confirm.metadata["confirmation_request_id"].startswith("agent-video-")

    approved = await tool.execute(
        keyframe_for_shot=shot_id,
        _session_id="sess-video-kf",
        _video_confirmation_fingerprint=confirm.metadata["confirmation_fingerprint"],
        _video_client_request_id=confirm.metadata["confirmation_request_id"],
    )
    assert approved.success, approved.content
    assert approved.pause_for_user is None
    assert len(executed) == 1
    assert executed[0]["shot_id"] == shot_id
    assert executed[0]["confirmed_cost"] is True
    assert approved.metadata["keyframe_asset_id"] == "video_asset_kf1"
    assert calls == []  # no video jobs

    # A changed prompt no longer matches the approved plan: pause again.
    changed = await tool.execute(
        keyframe_for_shot=shot_id,
        keyframe_prompt="a totally different still",
        _session_id="sess-video-kf",
        _video_confirmation_fingerprint=confirm.metadata["confirmation_fingerprint"],
        _video_client_request_id=confirm.metadata["confirmation_request_id"],
    )
    assert changed.pause_for_user
    assert len(executed) == 1

    missing = await tool.execute(
        keyframe_for_shot="shot_missing",
        _session_id="sess-video-kf",
    )
    assert not missing.success
    assert executed == [executed[0]]

    both = await tool.execute(
        keyframe_for_shot=shot_id,
        voiceover_shot=shot_id,
        _session_id="sess-video-kf",
    )
    assert not both.success
    assert "One paid action per call" in both.content


@pytest.mark.asyncio
async def test_videogen_voiceover_shot_confirmation_flow(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    import knorvia.services.video_studio.service as service_mod
    from knorvia.tools.media_gen_tool import VideogenTool

    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    planned_episode = await VideogenTool().execute(
        action="plan_episode",
        shots=json.dumps([{"title": "Opening", "prompt": "a quiet lake"}]),
        _session_id="sess-video-vo",
    )
    project_id = planned_episode.metadata["video_studio_project_id"]
    shot_id = planned_episode.metadata["shot_ids"][0]

    executed: list[dict[str, Any]] = []

    async def fake_voiceover(_store: Any, **kwargs: Any) -> dict[str, Any]:
        executed.append(kwargs)
        return {
            "asset": {"id": "video_asset_vo1", "mime_type": "audio/mpeg"},
            "duration": 4.2,
            "storyboard": {},
        }

    monkeypatch.setattr(service_mod, "create_shot_voiceover", fake_voiceover)

    tool = VideogenTool()
    no_text = await tool.execute(voiceover_shot=shot_id, _session_id="sess-video-vo")
    assert not no_text.success
    assert executed == []

    confirm = await tool.execute(
        voiceover_shot=shot_id,
        voiceover_text="The lake sleeps under a pale moon.",
        voiceover_voice="alloy",
        _session_id="sess-video-vo",
    )
    assert confirm.success, confirm.content
    assert confirm.pause_for_user
    assert executed == []

    approved = await tool.execute(
        voiceover_shot=shot_id,
        voiceover_text="The lake sleeps under a pale moon.",
        voiceover_voice="alloy",
        _session_id="sess-video-vo",
        _video_confirmation_fingerprint=confirm.metadata["confirmation_fingerprint"],
        _video_client_request_id=confirm.metadata["confirmation_request_id"],
    )
    assert approved.success, approved.content
    assert approved.metadata["voiceover_asset_id"] == "video_asset_vo1"
    assert approved.metadata["voiceover_duration"] == 4.2
    assert len(executed) == 1
    assert executed[0]["text"] == "The lake sleeps under a pale moon."
    assert executed[0]["voice"] == "alloy"
    assert executed[0]["confirmed_cost"] is True
    assert calls == []

    # Without an explicit text, the shot's stored voiceover text is used.
    store.update_storyboard(
        project_id,
        lambda document: document["shots"][0].update(voiceover_text="Stored line."),
    )
    stored_confirm = await tool.execute(voiceover_shot=shot_id, _session_id="sess-video-vo")
    assert stored_confirm.pause_for_user
    assert "Stored line." in json.dumps(stored_confirm.metadata["plan"], ensure_ascii=False)


@pytest.mark.asyncio
async def test_videogen_compose_project_runs_free_without_confirmation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    import knorvia.services.video_studio.composition as composition_mod
    from knorvia.tools.media_gen_tool import VideogenTool

    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    planned_episode = await VideogenTool().execute(
        action="plan_episode",
        shots=json.dumps([{"title": "Opening", "prompt": "a quiet lake"}]),
        _session_id="sess-video-compose",
    )
    assert planned_episode.success, planned_episode.content

    submitted: list[dict[str, Any]] = []

    def fake_compose(_store: Any, **kwargs: Any) -> dict[str, Any]:
        submitted.append(kwargs)
        return {"id": "video_job_compose_1", "status": "queued"}

    monkeypatch.setattr(composition_mod, "compose_project", fake_compose)

    result = await VideogenTool().execute(
        compose_project=True,
        compose_subtitle="from_notes",
        compose_resolution="1080p",
        _session_id="sess-video-compose",
        _language="zh",
    )
    assert result.success, result.content
    assert result.pause_for_user is None  # free local work — no confirmation
    assert result.metadata["action"] == "compose_project"
    assert result.metadata["provider_cost"] == 0
    assert len(submitted) == 1
    assert submitted[0]["request"] == {
        "subtitle": {"mode": "from_notes"},
        "output": {"resolution": "1080p"},
    }
    assert submitted[0]["client_request_id"].startswith("agent-compose-")
    assert calls == []  # no provider jobs

    invalid = await VideogenTool().execute(
        compose_project=True,
        compose_resolution="4k",
        _session_id="sess-video-compose",
    )
    assert not invalid.success

    def fake_invalid(_store: Any, **_kwargs: Any) -> dict[str, Any]:
        raise composition_mod.ComposeInvalidError("Shot 1 has no material to compose")

    monkeypatch.setattr(composition_mod, "compose_project", fake_invalid)
    rejected = await VideogenTool().execute(compose_project=True, _session_id="sess-video-compose")
    assert not rejected.success
    assert "no material" in rejected.content


@pytest.mark.asyncio
async def test_videogen_new_session_binds_to_active_studio_project(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    from knorvia.tools.media_gen_tool import VideogenTool

    desk = store.create_project("Desk Feature")
    store.set_active_project(desk["id"])
    result = await VideogenTool().execute(list_board=True, _session_id="sess-bind-active")
    assert result.success, result.content
    assert result.metadata["video_studio_project_id"] == desk["id"]
    assert store.get_session_project("sess-bind-active")["id"] == desk["id"]
    assert calls == []


@pytest.mark.asyncio
async def test_videogen_keeps_existing_session_project_when_active_changes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    from knorvia.tools.media_gen_tool import VideogenTool

    first = await VideogenTool().execute(list_board=True, _session_id="sess-keep-bound")
    assert first.success, first.content
    chat_project = first.metadata["video_studio_project_id"]
    desk = store.create_project("Later Desk")
    store.set_active_project(desk["id"])
    again = await VideogenTool().execute(list_board=True, _session_id="sess-keep-bound")
    assert again.metadata["video_studio_project_id"] == chat_project
    assert again.metadata["video_studio_project_id"] != desk["id"]
    assert calls == []


@pytest.mark.asyncio
async def test_videogen_generate_binds_storyboard_shot_by_index(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    from knorvia.tools.media_gen_tool import VideogenTool

    planned = await VideogenTool().execute(
        action="plan_episode",
        shots=json.dumps(
            [
                {"title": "开场", "prompt": "rooftop dusk"},
                {"title": "相遇", "prompt": "market collision"},
            ],
            ensure_ascii=False,
        ),
        _session_id="sess-shot-bind",
        _language="zh",
    )
    assert planned.success, planned.content
    assert planned.metadata["open_url"].startswith("/video-studio?project=")
    assert "view=storyboard" in planned.metadata["open_url"]
    shot_ids = planned.metadata["shot_ids"]
    board = store.get_board(planned.metadata["video_studio_project_id"])
    generate = next(node for node in board["nodes"] if node["kind"] == "generate")
    assert generate["storyboardShotId"] == shot_ids[0]
    listed = await VideogenTool().execute(list_board=True, _session_id="sess-shot-bind")
    assert listed.success, listed.content
    assert shot_ids[0] in listed.content
    assert "1 · " in listed.content

    tool = VideogenTool()
    confirm = await tool.execute(
        storyboard_shot_id="第1镜", _session_id="sess-shot-bind", _language="zh"
    )
    assert confirm.success, confirm.content
    assert confirm.pause_for_user
    assert confirm.metadata["plan"]["storyboard_shot_id"] == shot_ids[0]
    assert confirm.metadata["plan"]["prompt"] == "rooftop dusk"
    assert confirm.metadata["plan"]["board_node_id"] == generate["id"]

    queued = await tool.execute(
        storyboard_shot_id="第1镜",
        _session_id="sess-shot-bind",
        _language="zh",
        _video_confirmation_fingerprint=confirm.metadata["confirmation_fingerprint"],
        _video_client_request_id=confirm.metadata["confirmation_request_id"],
    )
    assert queued.success, queued.content
    assert calls[0]["storyboard_shot_id"] == shot_ids[0]
    assert calls[0]["board_node_id"] == generate["id"]
    assert queued.metadata["storyboard_shot_id"] == shot_ids[0]
    assert f"shot={shot_ids[0]}" in queued.metadata["open_url"]
    missing = await tool.execute(storyboard_shot_id="99", _session_id="sess-shot-bind")
    assert not missing.success


@pytest.mark.asyncio
async def test_videogen_analyze_script_and_apply_after_review(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    store, calls = _patch_video_studio(monkeypatch, tmp_path)
    from knorvia.services.video_studio.production import confirm_review
    from knorvia.tools.media_gen_tool import VideogenTool

    script = (
        "INT. KITCHEN - NIGHT\n\n"
        "LINA\nDon't wait up.\n\n"
        "She closes the window. Rain on the glass.\n\n"
        "INT. ALLEY - NIGHT\n\n"
        "ARCHER\nYou still have the key.\n"
    )
    analyzed = await VideogenTool().execute(
        action="analyze_script",
        prompt=script,
        _session_id="sess-prod-bind",
        _language="en",
    )
    assert analyzed.success, analyzed.content
    assert analyzed.pause_for_user is None
    assert analyzed.metadata["action"] == "analyze_script"
    assert analyzed.metadata["jobs_created"] == 0
    assert "view=production" in analyzed.metadata["open_url"]
    project_id = analyzed.metadata["video_studio_project_id"]
    production = store.get_production(project_id)["production"]
    assert production["stage"] == "review"
    assert production["script"]["text"].startswith("INT. KITCHEN")
    assert production["analysis"]["shots"]

    blocked = await VideogenTool().execute(action="apply_production", _session_id="sess-prod-bind")
    assert not blocked.success
    assert "Confirm" in blocked.content

    store.save_production(project_id, confirm_review(production, notes="ok", now=1.0))
    applied = await VideogenTool().execute(
        action="apply_production", _session_id="sess-prod-bind", _language="en"
    )
    assert applied.success, applied.content
    assert applied.metadata["action"] == "apply_production"
    assert applied.metadata["shot_ids"]
    assert "view=storyboard" in applied.metadata["open_url"]
    assert calls == []
    storyboard = store.get_storyboard(project_id)
    assert storyboard["shots"]
    board = store.get_board(project_id)
    assert any(
        node.get("kind") == "generate" and node.get("storyboardShotId") for node in board["nodes"]
    )
