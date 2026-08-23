from __future__ import annotations

import base64
from pathlib import Path
import threading
import time

from fastapi import FastAPI
from fastapi.responses import FileResponse, StreamingResponse

from knorvia.desktop.ipc_bridge import handle_http_stream


def _stream(
    app: FastAPI,
    *,
    method: str = "GET",
    range_header: str = "",
    path: str = "/video.mp4",
):
    messages: list[dict] = []
    headers = {"range": range_header} if range_header else {}
    handle_http_stream(
        app,
        {
            "id": "range-probe",
            "method": method,
            "path": path,
            "headers": headers,
        },
        threading.Event(),
        messages.append,
    )
    return messages


def _body(messages: list[dict]) -> bytes:
    return b"".join(
        base64.b64decode(message["body"])
        for message in messages
        if message["kind"] == "http_stream_chunk"
    )


def test_video_range_head_and_unsatisfied_range_are_streamed(tmp_path: Path) -> None:
    video = tmp_path / "video.mp4"
    payload = b"\x00\x00\x00\x18ftypmp42" + bytes(range(64))
    video.write_bytes(payload)
    app = FastAPI()

    @app.api_route("/video.mp4", methods=["GET", "HEAD"])
    def content() -> FileResponse:
        return FileResponse(video, media_type="video/mp4")

    partial = _stream(app, range_header="bytes=4-15")
    start = next(message for message in partial if message["kind"] == "http_stream_start")
    assert start["status"] == 206
    assert start["headers"]["content-range"] == f"bytes 4-15/{len(payload)}"
    assert _body(partial) == payload[4:16]

    head = _stream(app, method="HEAD")
    assert (
        next(message for message in head if message["kind"] == "http_stream_start")["status"] == 200
    )
    assert _body(head) == b""

    unsatisfied = _stream(app, range_header="bytes=999-1000")
    start = next(message for message in unsatisfied if message["kind"] == "http_stream_start")
    assert start["status"] == 416
    assert start["headers"]["content-range"] == f"bytes */{len(payload)}"
    assert _body(unsatisfied) == b""


def test_python_stream_stops_emitting_chunks_after_cancellation() -> None:
    cancelled = threading.Event()
    messages: list[dict] = []

    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        cancelled.set()
        await send({"type": "http.response.body", "body": b"must-not-arrive"})

    handle_http_stream(
        app,
        {"id": "cancel-probe", "method": "GET", "path": "/video.mp4", "headers": {}},
        cancelled,
        messages.append,
    )
    assert [message["kind"] for message in messages] == ["http_stream_start"]


def test_project_export_keeps_zip_disposition_and_all_chunks() -> None:
    app = FastAPI()

    @app.api_route("/projects/p/export", methods=["GET", "HEAD"])
    def export() -> StreamingResponse:
        return StreamingResponse(
            iter((b"PK-", b"archive")),
            media_type="application/zip",
            headers={"Content-Disposition": 'attachment; filename="project.zip"'},
        )

    messages = _stream(app, path="/projects/p/export")
    start = next(message for message in messages if message["kind"] == "http_stream_start")
    assert start["status"] == 200
    assert start["headers"]["content-disposition"] == 'attachment; filename="project.zip"'
    assert _body(messages) == b"PK-archive"


def test_python_stream_waits_for_consumer_credit_before_third_chunk() -> None:
    cancelled = threading.Event()
    credits = threading.BoundedSemaphore(2)
    messages: list[dict] = []

    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        for value in (b"one", b"two", b"three"):
            await send({"type": "http.response.body", "body": value, "more_body": True})
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    worker = threading.Thread(
        target=handle_http_stream,
        args=(
            app,
            {"id": "flow-probe", "method": "GET", "path": "/video.mp4", "headers": {}},
            cancelled,
            messages.append,
            credits,
        ),
    )
    worker.start()
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        if sum(message["kind"] == "http_stream_chunk" for message in messages) >= 2:
            break
        time.sleep(0.01)
    assert sum(message["kind"] == "http_stream_chunk" for message in messages) == 2
    assert worker.is_alive()

    credits.release()
    worker.join(timeout=1)
    assert not worker.is_alive()
    assert _body(messages) == b"onetwothree"
    assert messages[-1]["kind"] == "http_stream_end"
