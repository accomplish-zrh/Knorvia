"""Python media worker loop: initialize / render / cancel / shutdown contract."""

from __future__ import annotations

import base64
import io
import json

import pytest

from knorvia.workers import media_worker


def _encode_frame(frame: dict) -> bytes:
    raw = json.dumps(frame).encode()
    return f"Content-Length: {len(raw)}\r\n\r\n".encode() + raw


def _drive(frames: list[dict]) -> list[dict]:
    """Feed frames to serve() via fakes; return the emitted frames."""
    input_stream = io.BytesIO(b"".join(_encode_frame(f) for f in frames))
    output_stream = io.BytesIO()
    media_worker.serve(input_stream, output_stream)
    raw = output_stream.getvalue()
    out: list[dict] = []
    while raw:
        head, raw = raw.split(b"\r\n\r\n", 1)
        length = int(
            next(
                line.split(b":")[1].strip()
                for line in head.split(b"\r\n")
                if line.lower().startswith(b"content-length:")
            )
        )
        body, raw = raw[:length], raw[length:]
        out.append(json.loads(body))
    return out


def test_initialize_then_unknown_pack_typed_error() -> None:
    frames = _drive(
        [
            {"id": 1, "method": "initialize", "params": {"packs": ["media.visualize"]}},
            {"id": 2, "method": "render", "params": {"packId": "media.unknown", "input": {}}},
            {"id": 3, "method": "shutdown", "params": {}},
        ]
    )
    assert frames[0] == {"id": 1, "result": {"ok": True}}
    assert "does not host" in frames[1]["error"]["message"]
    assert frames[2]["result"]["ok"] is True


def test_cooperative_cancel_before_render() -> None:
    frames = _drive(
        [
            {"id": 1, "method": "initialize", "params": {"packs": ["media.visualize"]}},
            {"method": "cancel", "params": {}},
            {"id": 2, "method": "render", "params": {"packId": "media.visualize", "input": {}}},
            {"id": 3, "method": "shutdown", "params": {}},
        ]
    )
    errors = [f for f in frames if "error" in f]
    assert errors, frames
    assert errors[0]["error"]["message"] == "cancelled by user"
    # No fabricated success after cancel.
    assert not [f for f in frames if f.get("result", {}).get("contentBase64")]


def test_progress_notifications_during_render(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_visualize(input_payload, stream):
        import asyncio

        async def run():
            await stream.stage("analyzing", source="visualize")
            await stream.progress(message="halfway")

        asyncio.run(run())
        return {"render_type": "svg", "code": "<svg></svg>"}

    monkeypatch.setitem(media_worker.MEDIA_PACKS, "media.visualize", fake_visualize)
    frames = _drive(
        [
            {"id": 1, "method": "initialize", "params": {"packs": ["media.visualize"]}},
            {
                "id": 2,
                "method": "render",
                "params": {"packId": "media.visualize", "input": {"user_message": "draw"}},
            },
            {"id": 3, "method": "shutdown", "params": {}},
        ]
    )
    steps = [f["params"]["step"] for f in frames if f.get("method") == "progress"]
    assert "stage.analyzing.start" in steps
    assert "progress" in steps
    render = [f for f in frames if f.get("id") == 2][0]
    encoded = render["result"]
    assert base64.b64decode(encoded["code"]).decode() == "<svg></svg>"
