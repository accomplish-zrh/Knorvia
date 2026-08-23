"""Kling / Wan / Hailuo video gateway adapter contracts.

Each case pins the wire shape (method, path, payload, auth) with an
``httpx.MockTransport`` so no provider is ever called. OpenAI Videos
retirement (default presets) is asserted here too.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
import time
from typing import TYPE_CHECKING

import httpx
import jwt
import pytest

from knorvia.services.video_studio.provider import (
    VIDEO_STUDIO_ADAPTERS,
    HailuoAsyncVideoAdapter,
    KlingAsyncVideoAdapter,
    VideoInput,
    WanAsyncVideoAdapter,
    get_video_studio_adapter,
)

if TYPE_CHECKING:
    from knorvia.services.videogen.config import VideogenConfig

MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isomadapter-test-video"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
WAV = b"RIFF\x10\x00\x00\x00WAVEfmt " + b"\x00" * 16

KLING_BASE = "https://api.klingai.test"
WAN_BASE = "https://dashscope.test/api/v1"
HAILUO_BASE = "https://api.minimax.test/v1"
AK, SK = "kling-ak", "kling-sk"


class Recorder:
    """MockTransport handler that records calls and replies from a route map."""

    def __init__(self, routes: list[tuple[str, str, httpx.Response]]):
        self._routes = routes
        self.calls: list[dict[str, object]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(
            {
                "method": request.method,
                "path": request.url.path,
                "params": dict(request.url.params),
                "headers": dict(request.headers),
                "json": json.loads(request.read() or b"{}"),
            }
        )
        for index, (method, path, response) in enumerate(self._routes):
            if request.method == method and request.url.path == path:
                self._routes.pop(index)
                return response
        return httpx.Response(
            404, json={"message": f"unexpected {request.method} {request.url.path}"}
        )


def _input(
    tmp_path: Path, name: str, data: bytes, mime: str, kind: str, role: str = "reference"
) -> VideoInput:
    target = tmp_path / name
    target.write_bytes(data)
    return VideoInput(target, mime, kind, role=role)


def _videogen_config(**overrides: object) -> "VideogenConfig":
    from knorvia.services.videogen.config import VideogenConfig

    return VideogenConfig(**overrides)  # type: ignore[arg-type]


def _kling_config(**overrides: object) -> "VideogenConfig":
    values: dict[str, object] = {
        "model": "kling-v2-master",
        "adapter": "kling_async_task",
        "api_key": f"{AK}:{SK}",
        "base_url": KLING_BASE,
        "aspect_ratio": "16:9",
        "duration": "5",
        "resolution": "720p",
    }
    values.update(overrides)
    return _videogen_config(**values)


def _wan_config(**overrides: object) -> "VideogenConfig":
    values: dict[str, object] = {
        "model": "wan2.2-t2v-plus",
        "adapter": "wan_async_task",
        "api_key": "dashscope-key",
        "base_url": WAN_BASE,
        "aspect_ratio": "16:9",
        "duration": "5",
        "resolution": "720p",
    }
    values.update(overrides)
    return _videogen_config(**values)


def _hailuo_config(**overrides: object) -> "VideogenConfig":
    values: dict[str, object] = {
        "model": "MiniMax-Hailuo-02",
        "adapter": "hailuo_async_task",
        "api_key": "minimax-key",
        "base_url": HAILUO_BASE,
        "duration": "6",
        "resolution": "768p",
    }
    values.update(overrides)
    return _videogen_config(**values)


# ── Kling ───────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_kling_text2video_submit_signs_hs256_jwt(tmp_path: Path) -> None:
    recorder = Recorder(
        [
            (
                "POST",
                "/v1/videos/text2video",
                httpx.Response(200, json={"code": 0, "data": {"task_id": "kling-1"}}),
            )
        ]
    )
    adapter = KlingAsyncVideoAdapter(transport=httpx.MockTransport(recorder.handler))
    task_id = await adapter.submit(
        "a quiet lake",
        _kling_config(),
        inputs=[],
        parameters={"camera_control": "simple", "negative_prompt": "flicker"},
        idempotency_key="kling-probe",
    )
    assert task_id == "kling-1"
    call = recorder.calls[0]
    assert call["method"] == "POST"
    assert call["path"] == "/v1/videos/text2video"

    token = str(call["headers"].get("authorization", "")).removeprefix("Bearer ")
    assert token.count(".") == 2  # header.payload.signature
    header = json.loads(base64.urlsafe_b64decode(f"{token.split('.')[0]}=="))
    assert header == {"typ": "JWT", "alg": "HS256"}
    claims = jwt.decode(token, SK, algorithms=["HS256"])
    assert claims["iss"] == AK
    assert 1700 <= claims["exp"] - int(time.time()) <= 1800
    assert claims["nbf"] <= int(time.time()) + 1

    payload = call["json"]
    assert payload["model"] == "kling-v2-master"
    assert payload["prompt"] == "a quiet lake"
    assert payload["aspect_ratio"] == "16:9"
    assert payload["duration"] == 5
    assert payload["mode"] == "std"
    assert payload["camera_control"] == {"type": "simple"}
    assert payload["negative_prompt"] == "flicker"


@pytest.mark.asyncio
async def test_kling_bearer_passthrough_without_ak_sk_pair() -> None:
    recorder = Recorder(
        [("POST", "/v1/videos/text2video", httpx.Response(200, json={"data": {"task_id": "k1"}}))]
    )
    adapter = KlingAsyncVideoAdapter(transport=httpx.MockTransport(recorder.handler))
    await adapter.submit(
        "p",
        _kling_config(api_key="plain-gateway-key"),
        inputs=[],
        parameters={},
        idempotency_key="x",
    )
    assert recorder.calls[0]["headers"].get("authorization") == "Bearer plain-gateway-key"


@pytest.mark.asyncio
async def test_kling_image2video_sends_first_and_tail_frames(tmp_path: Path) -> None:
    recorder = Recorder(
        [
            (
                "POST",
                "/v1/videos/image2video",
                httpx.Response(200, json={"data": {"task_id": "kling-i2v"}}),
            )
        ]
    )
    adapter = KlingAsyncVideoAdapter(transport=httpx.MockTransport(recorder.handler))
    inputs = [
        _input(tmp_path, "first.png", PNG, "image/png", "image", role="first-frame"),
        _input(tmp_path, "tail.png", PNG + b"2", "image/png", "image", role="last-frame"),
    ]
    task_id = await adapter.submit(
        "animate", _kling_config(), inputs=inputs, parameters={}, idempotency_key="i2v"
    )
    assert task_id == "kling-i2v"
    assert recorder.calls[0]["path"] == "/v1/videos/image2video"
    payload = recorder.calls[0]["json"]
    assert payload["image"] == f"data:image/png;base64,{base64.b64encode(PNG).decode()}"
    assert payload["image_tail"] == f"data:image/png;base64,{base64.b64encode(PNG + b'2').decode()}"
    assert "video" not in payload


@pytest.mark.asyncio
async def test_kling_camera_motion_maps_to_camera_control_object(tmp_path: Path) -> None:
    recorder = Recorder(
        [("POST", "/v1/videos/text2video", httpx.Response(200, json={"data": {"task_id": "k"}}))]
    )
    adapter = KlingAsyncVideoAdapter(transport=httpx.MockTransport(recorder.handler))
    await adapter.submit(
        "orbit",
        _kling_config(),
        inputs=[],
        parameters={"camera_motion": "orbit"},
        idempotency_key="cam",
    )
    assert recorder.calls[0]["json"]["camera_control"] == {
        "type": "simple",
        "config": {"movement": "orbit"},
    }


@pytest.mark.asyncio
async def test_kling_camera_control_none_omits_the_field() -> None:
    # The preset enum's "none" means "no camera control": the field must be
    # absent on the wire, never {"type": "none"}.
    recorder = Recorder(
        [("POST", "/v1/videos/text2video", httpx.Response(200, json={"data": {"task_id": "k"}}))]
    )
    adapter = KlingAsyncVideoAdapter(transport=httpx.MockTransport(recorder.handler))
    await adapter.submit(
        "handheld chase",
        _kling_config(),
        inputs=[],
        parameters={"camera_control": "none"},
        idempotency_key="cam-none",
    )
    payload = recorder.calls[0]["json"]
    assert "camera_control" not in payload
    # Camera intent rides the dedicated field only; the prompt stays verbatim.
    assert payload["prompt"] == "handheld chase"
    assert "none" not in str(payload["prompt"])


@pytest.mark.asyncio
async def test_kling_camera_control_dict_and_string_passthrough() -> None:
    recorder = Recorder(
        [
            (
                "POST",
                "/v1/videos/text2video",
                httpx.Response(200, json={"data": {"task_id": "k1"}}),
            ),
            (
                "POST",
                "/v1/videos/text2video",
                httpx.Response(200, json={"data": {"task_id": "k2"}}),
            ),
        ]
    )
    adapter = KlingAsyncVideoAdapter(transport=httpx.MockTransport(recorder.handler))
    custom = {"type": "custom", "config": {"horizontal": -5, "vertical": 2}}
    await adapter.submit(
        "pan left",
        _kling_config(),
        inputs=[],
        parameters={"camera_control": custom},
        idempotency_key="cam-dict",
    )
    await adapter.submit(
        "pan right",
        _kling_config(),
        inputs=[],
        parameters={"camera_control": "simple"},
        idempotency_key="cam-str",
    )
    assert recorder.calls[0]["json"]["camera_control"] == custom
    assert recorder.calls[1]["json"]["camera_control"] == {"type": "simple"}
    # Custom camera payloads must not leak into the verbatim prompt channel.
    assert recorder.calls[0]["json"]["prompt"] == "pan left"


@pytest.mark.asyncio
async def test_kling_extend_posts_native_video_extend_endpoint(tmp_path: Path) -> None:
    recorder = Recorder(
        [
            (
                "POST",
                "/v1/videos/video-extend",
                httpx.Response(200, json={"data": {"task_id": "kling-ext"}}),
            )
        ]
    )
    adapter = KlingAsyncVideoAdapter(transport=httpx.MockTransport(recorder.handler))
    clip = _input(tmp_path, "clip.mp4", MP4, "video/mp4", "video", role="continue-from")
    task_id = await adapter.submit(
        "continue",
        _kling_config(duration="10"),
        inputs=[clip],
        parameters={},
        idempotency_key="ext",
    )
    assert task_id == "kling-ext"
    assert KlingAsyncVideoAdapter.native_extend is True
    call = recorder.calls[0]
    assert (call["method"], call["path"]) == ("POST", "/v1/videos/video-extend")
    payload = call["json"]
    assert payload["video"] == f"data:video/mp4;base64,{base64.b64encode(MP4).decode()}"
    assert "image" not in payload and "duration" not in payload


@pytest.mark.asyncio
async def test_kling_rejects_conflicting_reference_shapes(tmp_path: Path) -> None:
    adapter = KlingAsyncVideoAdapter(transport=httpx.MockTransport(lambda _r: httpx.Response(500)))
    audio = _input(tmp_path, "a.wav", WAV, "audio/wav", "audio")
    with pytest.raises(Exception, match="cannot send audio"):
        await adapter.submit(
            "p", _kling_config(), inputs=[audio], parameters={}, idempotency_key="x"
        )
    crowded = [
        _input(tmp_path, "1.png", PNG, "image/png", "image", role="first-frame"),
        _input(tmp_path, "2.png", PNG, "image/png", "image", role="last-frame"),
        _input(tmp_path, "3.png", PNG, "image/png", "image"),
    ]
    with pytest.raises(Exception, match="at most first/last frame"):
        await adapter.submit(
            "p", _kling_config(), inputs=crowded, parameters={}, idempotency_key="x"
        )


@pytest.mark.asyncio
async def test_kling_poll_normalizes_states_and_extracts_video_url() -> None:
    states = iter(
        [
            {"code": 0, "data": {"task_id": "k1", "task_status": "submitted"}},
            {"code": 0, "data": {"task_id": "k1", "task_status": "processing"}},
            {
                "code": 0,
                "data": {
                    "task_id": "k1",
                    "task_status": "succeed",
                    "task_result": {"videos": [{"id": "v", "url": f"{KLING_BASE}/files/v.mp4"}]},
                },
            },
        ]
    )
    seen_paths: list[str] = []
    adapter = KlingAsyncVideoAdapter(
        transport=httpx.MockTransport(
            lambda request: (
                seen_paths.append(request.url.path) or httpx.Response(200, json=next(states))
            )
        )
    )
    config = _kling_config()
    first = await adapter.poll("k1", config)
    assert (first.state, first.progress, first.output_url) == ("running", 0.0, "")
    second = await adapter.poll("k1", config)
    assert second.state == "running"
    third = await adapter.poll("k1", config)
    assert third.state == "succeeded"
    assert third.progress == 1.0
    assert third.output_url == f"{KLING_BASE}/files/v.mp4"
    assert seen_paths == ["/v1/videos/image2video/k1"] * 3


@pytest.mark.asyncio
async def test_kling_poll_failed_and_unknown_states() -> None:
    config = _kling_config()
    failed = KlingAsyncVideoAdapter(
        transport=httpx.MockTransport(
            lambda _r: httpx.Response(
                200,
                json={
                    "code": 1000,
                    "message": "content blocked",
                    "data": {"task_status": "failed"},
                },
            )
        )
    )
    result = await failed.poll("k1", config)
    assert result.state == "failed"
    assert result.error == "content blocked"

    unknown = KlingAsyncVideoAdapter(
        transport=httpx.MockTransport(
            lambda _r: httpx.Response(200, json={"data": {"task_status": "mystery"}})
        )
    )
    with pytest.raises(Exception, match="unsupported status: mystery"):
        await unknown.poll("k1", config)


@pytest.mark.asyncio
async def test_kling_cancel_uses_delete_on_query_path() -> None:
    recorder = Recorder(
        [("DELETE", "/v1/videos/image2video/k1", httpx.Response(200, json={"code": 0}))]
    )
    adapter = KlingAsyncVideoAdapter(transport=httpx.MockTransport(recorder.handler))
    assert await adapter.cancel("k1", _kling_config()) is True
    assert (recorder.calls[0]["method"], recorder.calls[0]["path"]) == (
        "DELETE",
        "/v1/videos/image2video/k1",
    )


@pytest.mark.asyncio
async def test_kling_poll_then_download_streams_output(tmp_path: Path) -> None:
    recorder = Recorder(
        [
            (
                "GET",
                "/v1/videos/image2video/k1",
                httpx.Response(
                    200,
                    json={
                        "data": {
                            "task_status": "succeed",
                            "task_result": {"videos": [{"url": f"{KLING_BASE}/files/v.mp4"}]},
                        }
                    },
                ),
            ),
            (
                "GET",
                "/files/v.mp4",
                httpx.Response(200, headers={"content-type": "video/mp4"}, content=MP4),
            ),
        ]
    )
    adapter = KlingAsyncVideoAdapter(transport=httpx.MockTransport(recorder.handler))
    result = await adapter.poll("k1", _kling_config())
    target = tmp_path / "out.mp4"
    assert await adapter.download(result.output_url, _kling_config(), target) == "video/mp4"
    assert target.read_bytes() == MP4


# ── Wan (DashScope) ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_wan_submit_payload_headers_and_async_switch() -> None:
    recorder = Recorder(
        [
            (
                "POST",
                "/api/v1/services/aigc/video-generation/video-synthesis",
                httpx.Response(
                    200,
                    json={
                        "output": {"task_id": "wan-1", "task_status": "PENDING"},
                        "request_id": "r",
                    },
                ),
            )
        ]
    )
    adapter = WanAsyncVideoAdapter(transport=httpx.MockTransport(recorder.handler))
    task_id = await adapter.submit(
        "a lantern festival",
        _wan_config(),
        inputs=[],
        parameters={"audio_mode": "generate", "prompt_extend": True, "seed": 7},
        idempotency_key="wan-probe",
    )
    assert task_id == "wan-1"
    call = recorder.calls[0]
    assert call["headers"].get("x-dashscope-async") == "enable"
    assert call["headers"].get("authorization") == "Bearer dashscope-key"
    payload = call["json"]
    assert payload["model"] == "wan2.2-t2v-plus"
    assert payload["input"]["prompt"] == "a lantern festival"
    assert payload["parameters"]["size"] == "1280*720"
    assert payload["parameters"]["duration"] == 5
    assert payload["parameters"]["audio"] is True
    assert payload["parameters"]["prompt_extend"] is True
    assert "seed" not in payload["parameters"] and "audio_mode" not in payload["parameters"]


@pytest.mark.asyncio
async def test_wan_image_to_video_maps_img_url_data_uri(tmp_path: Path) -> None:
    submit = (
        "POST",
        "/api/v1/services/aigc/video-generation/video-synthesis",
    )
    image_recorder = Recorder(
        [(*submit, httpx.Response(200, json={"output": {"task_id": "wan-i2v"}}))]
    )
    adapter = WanAsyncVideoAdapter(transport=httpx.MockTransport(image_recorder.handler))
    image = _input(tmp_path, "frame.png", PNG, "image/png", "image", role="first-frame")
    assert (
        await adapter.submit(
            "animate", _wan_config(), inputs=[image], parameters={}, idempotency_key="i2v"
        )
        == "wan-i2v"
    )
    payload = image_recorder.calls[0]["json"]
    assert payload["input"]["img_url"] == f"data:image/png;base64,{base64.b64encode(PNG).decode()}"

    audio_recorder = Recorder(
        [(*submit, httpx.Response(200, json={"output": {"task_id": "wan-a"}}))]
    )
    audio_adapter = WanAsyncVideoAdapter(transport=httpx.MockTransport(audio_recorder.handler))
    audio = _input(tmp_path, "line.wav", WAV, "audio/wav", "audio")
    await audio_adapter.submit(
        "voice", _wan_config(), inputs=[audio], parameters={}, idempotency_key="a"
    )
    assert audio_recorder.calls[0]["json"]["input"]["audio_url"].startswith(
        "data:audio/wav;base64,"
    )


@pytest.mark.asyncio
async def test_wan_rejects_video_and_extra_image_references(tmp_path: Path) -> None:
    adapter = WanAsyncVideoAdapter(transport=httpx.MockTransport(lambda _r: httpx.Response(500)))
    clip = _input(tmp_path, "c.mp4", MP4, "video/mp4", "video")
    with pytest.raises(Exception, match="cannot send video"):
        await adapter.submit("p", _wan_config(), inputs=[clip], parameters={}, idempotency_key="x")
    two_images = [
        _input(tmp_path, "1.png", PNG, "image/png", "image"),
        _input(tmp_path, "2.png", PNG, "image/png", "image"),
    ]
    with pytest.raises(Exception, match="at most one image"):
        await adapter.submit(
            "p", _wan_config(), inputs=two_images, parameters={}, idempotency_key="x"
        )


@pytest.mark.asyncio
async def test_wan_poll_normalizes_states() -> None:
    config = _wan_config()
    pending = WanAsyncVideoAdapter(
        transport=httpx.MockTransport(
            lambda _r: httpx.Response(200, json={"output": {"task_status": "PENDING"}})
        )
    )
    assert (await pending.poll("wan-1", config)).state == "running"
    running = WanAsyncVideoAdapter(
        transport=httpx.MockTransport(
            lambda _r: httpx.Response(200, json={"output": {"task_status": "RUNNING"}})
        )
    )
    assert (await running.poll("wan-1", config)).state == "running"
    succeeded = WanAsyncVideoAdapter(
        transport=httpx.MockTransport(
            lambda _r: httpx.Response(
                200,
                json={
                    "output": {"task_status": "SUCCEEDED", "video_url": f"{WAN_BASE}/outputs/v.mp4"}
                },
            )
        )
    )
    result = await succeeded.poll("wan-1", config)
    assert result.state == "succeeded"
    assert result.output_url == f"{WAN_BASE}/outputs/v.mp4"


@pytest.mark.asyncio
async def test_wan_poll_failed_and_unknown_states() -> None:
    config = _wan_config()
    failed = WanAsyncVideoAdapter(
        transport=httpx.MockTransport(
            lambda _r: httpx.Response(
                200,
                json={
                    "output": {
                        "task_status": "FAILED",
                        "code": "InvalidParameter",
                        "message": "bad size",
                    }
                },
            )
        )
    )
    result = await failed.poll("wan-1", config)
    assert result.state == "failed"
    assert result.error == "bad size"
    unknown = WanAsyncVideoAdapter(
        transport=httpx.MockTransport(
            lambda _r: httpx.Response(200, json={"output": {"task_status": "mystery"}})
        )
    )
    with pytest.raises(Exception, match="unsupported status: mystery"):
        await unknown.poll("wan-1", config)


@pytest.mark.asyncio
async def test_wan_cancel_and_download(tmp_path: Path) -> None:
    recorder = Recorder(
        [
            ("DELETE", "/api/v1/tasks/wan-1", httpx.Response(200, json={})),
            (
                "GET",
                "/api/v1/outputs/v.mp4",
                httpx.Response(200, headers={"content-type": "video/mp4"}, content=MP4),
            ),
        ]
    )
    adapter = WanAsyncVideoAdapter(transport=httpx.MockTransport(recorder.handler))
    assert await adapter.cancel("wan-1", _wan_config()) is True
    target = tmp_path / "wan.mp4"
    assert await adapter.download(f"{WAN_BASE}/outputs/v.mp4", _wan_config(), target) == "video/mp4"
    assert target.read_bytes() == MP4


# ── Hailuo (MiniMax) ────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_hailuo_submit_payload_and_task_id(tmp_path: Path) -> None:
    recorder = Recorder(
        [
            (
                "POST",
                "/v1/video_generation",
                httpx.Response(200, json={"task_id": "hailuo-1", "base_resp": {"status_code": 0}}),
            )
        ]
    )
    adapter = HailuoAsyncVideoAdapter(transport=httpx.MockTransport(recorder.handler))
    task_id = await adapter.submit(
        "a dragon over the city",
        _hailuo_config(),
        inputs=[],
        parameters={"prompt_engineering": True},
        idempotency_key="hailuo-probe",
    )
    assert task_id == "hailuo-1"
    call = recorder.calls[0]
    assert call["headers"].get("authorization") == "Bearer minimax-key"
    payload = call["json"]
    assert payload["model"] == "MiniMax-Hailuo-02"
    assert payload["prompt"] == "a dragon over the city"
    assert payload["duration"] == 6
    assert payload["resolution"] == "768p"
    assert payload["prompt_engineering"] is True
    for key in ("first_frame_image", "subject_refs", "video_refs", "audio_refs"):
        assert key not in payload


@pytest.mark.asyncio
async def test_hailuo_splits_references_by_kind(tmp_path: Path) -> None:
    recorder = Recorder(
        [("POST", "/v1/video_generation", httpx.Response(200, json={"task_id": "hailuo-mm"}))]
    )
    adapter = HailuoAsyncVideoAdapter(transport=httpx.MockTransport(recorder.handler))
    inputs = [
        _input(tmp_path, "first.png", PNG, "image/png", "image", role="first-frame"),
        _input(tmp_path, "ref.png", PNG + b"r", "image/png", "image"),
        _input(tmp_path, "clip.mp4", MP4, "video/mp4", "video"),
        _input(tmp_path, "line.wav", WAV, "audio/wav", "audio"),
    ]
    await adapter.submit(
        "multi", _hailuo_config(), inputs=inputs, parameters={}, idempotency_key="mm"
    )
    payload = recorder.calls[0]["json"]
    assert payload["first_frame_image"] == f"data:image/png;base64,{base64.b64encode(PNG).decode()}"
    assert payload["subject_refs"] == [
        f"data:image/png;base64,{base64.b64encode(PNG + b'r').decode()}"
    ]
    assert payload["video_refs"] == [f"data:video/mp4;base64,{base64.b64encode(MP4).decode()}"]
    assert payload["audio_refs"] == [f"data:audio/wav;base64,{base64.b64encode(WAV).decode()}"]


@pytest.mark.asyncio
async def test_hailuo_rejects_unknown_reference_kind(tmp_path: Path) -> None:
    adapter = HailuoAsyncVideoAdapter(transport=httpx.MockTransport(lambda _r: httpx.Response(500)))
    bogus = VideoInput(Path("x.bin"), "application/octet-stream", "document")
    with pytest.raises(Exception, match="cannot send a document reference"):
        await adapter.submit(
            "p", _hailuo_config(), inputs=[bogus], parameters={}, idempotency_key="x"
        )


@pytest.mark.asyncio
async def test_hailuo_poll_normalizes_states_and_uses_query_endpoint() -> None:
    config = _hailuo_config()
    states = iter(["Queueing", "Processing", "Success"])
    seen_params: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen_params.update(dict(request.url.params))
        return httpx.Response(200, json={"status": next(states)})

    adapter = HailuoAsyncVideoAdapter(transport=httpx.MockTransport(handler))
    assert (await adapter.poll("hailuo-1", config)).state == "running"
    assert (await adapter.poll("hailuo-1", config)).state == "running"
    assert (await adapter.poll("hailuo-1", config)).state == "succeeded"
    assert seen_params == {"task_id": "hailuo-1"}


@pytest.mark.asyncio
async def test_hailuo_poll_success_returns_download_address(tmp_path: Path) -> None:
    adapter = HailuoAsyncVideoAdapter(
        transport=httpx.MockTransport(
            lambda _r: httpx.Response(
                200,
                json={
                    "status": "Success",
                    "file": {"file_id": "f1", "download_addr": f"{HAILUO_BASE}/files/f1.mp4"},
                },
            )
        )
    )
    result = await adapter.poll("hailuo-1", _hailuo_config())
    assert result.state == "succeeded"
    assert result.output_url == f"{HAILUO_BASE}/files/f1.mp4"
    target = tmp_path / "hailuo.mp4"
    recorder = Recorder(
        [
            (
                "GET",
                "/v1/files/f1.mp4",
                httpx.Response(200, headers={"content-type": "video/mp4"}, content=MP4),
            )
        ]
    )
    downloader = HailuoAsyncVideoAdapter(transport=httpx.MockTransport(recorder.handler))
    assert await downloader.download(result.output_url, _hailuo_config(), target) == "video/mp4"
    assert target.read_bytes() == MP4


@pytest.mark.asyncio
async def test_hailuo_poll_failed_and_unknown_states() -> None:
    config = _hailuo_config()
    for status in ("Fail", "PrepareFail", "GenerateFail"):
        adapter = HailuoAsyncVideoAdapter(
            transport=httpx.MockTransport(
                lambda _r, s=status: httpx.Response(
                    200, json={"status": s, "message": "moderation"}
                )
            )
        )
        result = await adapter.poll("h1", config)
        assert result.state == "failed"
        assert result.error == "moderation"
    unknown = HailuoAsyncVideoAdapter(
        transport=httpx.MockTransport(lambda _r: httpx.Response(200, json={"status": "Paused"}))
    )
    with pytest.raises(Exception, match="unsupported status: paused"):
        await unknown.poll("h1", config)


@pytest.mark.asyncio
async def test_hailuo_cancel_uses_delete_on_task_path() -> None:
    recorder = Recorder([("DELETE", "/v1/video_generation/hailuo-1", httpx.Response(200, json={}))])
    adapter = HailuoAsyncVideoAdapter(transport=httpx.MockTransport(recorder.handler))
    assert await adapter.cancel("hailuo-1", _hailuo_config()) is True
    assert (recorder.calls[0]["method"], recorder.calls[0]["path"]) == (
        "DELETE",
        "/v1/video_generation/hailuo-1",
    )


# ── capability presets ──────────────────────────────────────────────────────


def test_new_gateway_presets_exist_with_expected_fields() -> None:
    from knorvia.services.video_studio.capability_presets import get_capability_preset

    kling = get_capability_preset("kling-2.x-like")
    assert kling is not None
    caps = kling["capabilities"]
    assert caps["operations"] == ["text_to_video", "image_to_video", "extend"]
    assert caps["durations"] == [5, 10]
    assert caps["resolutions"] == ["720p", "1080p"]
    assert caps["reference_modes"] == ["first-frame", "first-last"]
    assert caps["supports_cancel"] is True
    properties = caps["parameter_schema"]["properties"]
    assert properties["camera_control"]["enum"] == ["none", "simple", "custom"]
    assert "orbit" in properties["camera_motion"]["enum"]

    wan = get_capability_preset("wan-2.x-like")
    assert wan is not None
    assert wan["capabilities"]["audio_modes"] == ["none", "generate"]
    assert wan["capabilities"]["durations"] == [5, 10]
    assert wan["capabilities"]["operations"] == ["text_to_video", "image_to_video"]

    hailuo = get_capability_preset("hailuo-h3-like")
    assert hailuo is not None
    assert hailuo["capabilities"]["max_inputs"] == {"image": 9, "video": 3, "audio": 3, "total": 15}
    assert hailuo["capabilities"]["reference_modes"] == ["multi"]


# ── provider runtime presets / OpenAI Videos retirement ─────────────────────


def test_registry_maps_new_adapter_names() -> None:
    for name, cls in (
        ("kling_async_task", KlingAsyncVideoAdapter),
        ("wan_async_task", WanAsyncVideoAdapter),
        ("hailuo_async_task", HailuoAsyncVideoAdapter),
    ):
        adapter = VIDEO_STUDIO_ADAPTERS.get(name)
        assert isinstance(adapter, cls)
        assert get_video_studio_adapter(name) is adapter


def test_openai_videos_left_default_presets_but_stays_resolvable() -> None:
    from knorvia.services.config import provider_runtime
    from knorvia.services.videogen.config import VideogenConfig

    assert "openai" not in provider_runtime.VIDEOGEN_PROVIDERS
    assert {"kling", "wan", "hailuo"} <= set(provider_runtime.VIDEOGEN_PROVIDERS)
    assert (
        provider_runtime.VIDEOGEN_PROVIDERS["kling"].default_api_base == "https://api.klingai.com"
    )
    assert (
        provider_runtime.VIDEOGEN_PROVIDERS["wan"].default_api_base
        == "https://dashscope.aliyuncs.com/api/v1"
    )
    assert (
        provider_runtime.VIDEOGEN_PROVIDERS["hailuo"].default_api_base
        == "https://api.minimax.chat/v1"
    )
    assert {"kling_async_task", "wan_async_task", "hailuo_async_task"} <= set(
        provider_runtime.VIDEOGEN_ADAPTERS
    )
    # The adapter itself stays registered until the next major version.
    assert "openai_videos" in provider_runtime.VIDEOGEN_ADAPTERS

    def catalog(binding: str) -> dict[str, object]:
        return {
            "services": {
                "videogen": {
                    "active_profile_id": "p",
                    "active_model_id": "m",
                    "profiles": [
                        {
                            "id": "p",
                            "binding": binding,
                            "api_key": "secret",
                            "models": [
                                {
                                    "id": "m",
                                    "model": "sora-2" if binding == "openai" else "kling-v2-master",
                                }
                            ],
                        }
                    ],
                }
            }
        }

    # Existing user configs with binding=openai keep resolving as before.
    legacy = provider_runtime.resolve_videogen_runtime_config(catalog=catalog("openai"))
    assert legacy.provider_name == "openai"
    assert legacy.adapter == "openai_videos"
    assert legacy.base_url == "https://api.openai.com/v1"
    assert isinstance(legacy, VideogenConfig)

    kling = provider_runtime.resolve_videogen_runtime_config(catalog=catalog("kling"))
    assert kling.provider_name == "kling"
    assert kling.adapter == "kling_async_task"
    assert kling.base_url == "https://api.klingai.com"
    assert kling.api_key == "secret"


def test_settings_dropdown_no_longer_offers_openai_videos() -> None:
    from knorvia.api.routers.settings import _provider_choices

    videogen = _provider_choices()["videogen"]
    values = {item["value"] for item in videogen}
    assert "openai" not in values
    assert {"kling", "wan", "hailuo"} <= values
