"""Expose the FastAPI application over JSON-lines stdio for the desktop shell.

This transport never opens a network socket. Electron owns the window and sends
requests through an anonymous child-process pipe; FastAPI is exercised in-process
through its ASGI test transport so existing routers remain the source of truth.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
import threading
import traceback
from typing import Any
from urllib.parse import unquote, urlsplit

_protocol_out = sys.stdout
sys.stdout = sys.stderr
_write_lock = threading.Lock()
_sockets: dict[str, Any] = {}
_stream_cancellations: dict[str, threading.Event] = {}
_stream_credits: dict[str, threading.BoundedSemaphore] = {}
_stream_lock = threading.Lock()
_STREAM_CHUNK_BYTES = 256 * 1024
_STREAM_WINDOW_CHUNKS = 2


class _StreamCancelled(Exception):
    pass


def emit(payload: dict[str, Any]) -> None:
    with _write_lock:
        _protocol_out.write(json.dumps(payload, ensure_ascii=False) + "\n")
        _protocol_out.flush()


def decode_body(value: str | None) -> bytes | None:
    return base64.b64decode(value) if value else None


def handle_http(client: Any, message: dict[str, Any]) -> None:
    request_id = str(message["id"])
    try:
        response = client.request(
            method=str(message.get("method") or "GET"),
            url=str(message.get("path") or "/"),
            headers=message.get("headers") or {},
            content=decode_body(message.get("body")),
        )
        emit(
            {
                "kind": "http_response",
                "id": request_id,
                "status": response.status_code,
                "headers": dict(response.headers),
                "body": base64.b64encode(response.content).decode("ascii"),
            }
        )
    except Exception as exc:
        emit({"kind": "error", "id": request_id, "error": str(exc)})


def _stream_headers(raw: list[tuple[bytes, bytes]]) -> dict[str, str]:
    headers: dict[str, str] = {}
    for raw_name, raw_value in raw:
        name = raw_name.decode("latin-1")
        value = raw_value.decode("latin-1")
        headers[name] = f"{headers[name]}, {value}" if name in headers else value
    return headers


async def _run_http_stream(
    app: Any,
    message: dict[str, Any],
    cancelled: threading.Event,
    emit_message: Any,
    credits: threading.BoundedSemaphore | None = None,
) -> None:
    request_id = str(message["id"])
    target = urlsplit(str(message.get("path") or "/"))
    method = str(message.get("method") or "GET").upper()
    headers = [
        (str(name).lower().encode("latin-1"), str(value).encode("latin-1"))
        for name, value in dict(message.get("headers") or {}).items()
    ]
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": unquote(target.path),
        "raw_path": target.path.encode("ascii", errors="surrogateescape"),
        "query_string": target.query.encode("ascii", errors="surrogateescape"),
        "root_path": "",
        "headers": headers,
        "client": ("desktop", 0),
        "server": ("knorvia", 0),
        "state": {},
    }
    received = False
    ended = False

    async def receive() -> dict[str, Any]:
        nonlocal received
        if not received:
            received = True
            return {"type": "http.request", "body": b"", "more_body": False}
        while not cancelled.is_set():
            await asyncio.sleep(0.025)
        return {"type": "http.disconnect"}

    async def send(event: dict[str, Any]) -> None:
        nonlocal ended
        if cancelled.is_set():
            raise _StreamCancelled
        event_type = event.get("type")
        if event_type == "http.response.start":
            emit_message(
                {
                    "kind": "http_stream_start",
                    "id": request_id,
                    "status": int(event.get("status") or 500),
                    "headers": _stream_headers(list(event.get("headers") or [])),
                }
            )
            return
        if event_type != "http.response.body":
            return
        body = bytes(event.get("body") or b"")
        if body and method != "HEAD":
            for offset in range(0, len(body), _STREAM_CHUNK_BYTES):
                if credits is not None:
                    acquired = await asyncio.to_thread(_acquire_stream_credit, credits, cancelled)
                    if not acquired:
                        raise _StreamCancelled
                chunk = body[offset : offset + _STREAM_CHUNK_BYTES]
                emit_message(
                    {
                        "kind": "http_stream_chunk",
                        "id": request_id,
                        "body": base64.b64encode(chunk).decode("ascii"),
                    }
                )
        if not event.get("more_body", False) and not ended:
            ended = True
            emit_message({"kind": "http_stream_end", "id": request_id})

    await app(scope, receive, send)
    if not ended and not cancelled.is_set():
        emit_message({"kind": "http_stream_end", "id": request_id})


def handle_http_stream(
    app: Any,
    message: dict[str, Any],
    cancelled: threading.Event,
    emit_message: Any = emit,
    credits: threading.BoundedSemaphore | None = None,
) -> None:
    request_id = str(message["id"])
    try:
        asyncio.run(_run_http_stream(app, message, cancelled, emit_message, credits))
    except _StreamCancelled:
        pass
    except Exception as exc:
        if not cancelled.is_set():
            emit_message({"kind": "http_stream_error", "id": request_id, "error": str(exc)})
    finally:
        with _stream_lock:
            _stream_cancellations.pop(request_id, None)
            _stream_credits.pop(request_id, None)


def _acquire_stream_credit(credits: threading.BoundedSemaphore, cancelled: threading.Event) -> bool:
    while not cancelled.is_set():
        if credits.acquire(timeout=0.1):
            return True
    return False


def receive_socket(socket_id: str, websocket: Any) -> None:
    try:
        while True:
            emit({"kind": "ws_message", "id": socket_id, "data": websocket.receive_text()})
    except Exception:
        pass
    finally:
        _sockets.pop(socket_id, None)
        emit({"kind": "ws_close", "id": socket_id})


def main() -> None:
    os.environ["KNORVIA_DESKTOP"] = "1"
    from fastapi.testclient import TestClient

    from knorvia.api.main import app

    with TestClient(app) as client:
        emit({"kind": "ready"})
        for raw in sys.stdin:
            try:
                message = json.loads(raw)
                kind = message.get("kind")
                if kind == "http":
                    threading.Thread(
                        target=handle_http, args=(client, message), daemon=True
                    ).start()
                elif kind == "http_stream":
                    request_id = str(message["id"])
                    cancelled = threading.Event()
                    credits = threading.BoundedSemaphore(_STREAM_WINDOW_CHUNKS)
                    with _stream_lock:
                        _stream_cancellations[request_id] = cancelled
                        _stream_credits[request_id] = credits
                    threading.Thread(
                        target=handle_http_stream,
                        args=(app, message, cancelled, emit, credits),
                        daemon=True,
                    ).start()
                elif kind == "http_stream_cancel":
                    with _stream_lock:
                        cancelled = _stream_cancellations.get(str(message.get("id") or ""))
                    if cancelled is not None:
                        cancelled.set()
                elif kind == "http_stream_ack":
                    with _stream_lock:
                        credits = _stream_credits.get(str(message.get("id") or ""))
                    if credits is not None:
                        try:
                            credits.release()
                        except ValueError:
                            pass
                elif kind == "ws_open":
                    socket_id = str(message["id"])
                    websocket = client.websocket_connect(str(message.get("path") or "/api/v1/ws"))
                    websocket.__enter__()
                    _sockets[socket_id] = websocket
                    emit({"kind": "ws_open", "id": socket_id})
                    threading.Thread(
                        target=receive_socket, args=(socket_id, websocket), daemon=True
                    ).start()
                elif kind == "ws_send":
                    socket = _sockets.get(str(message["id"]))
                    if socket is not None:
                        socket.send_text(str(message.get("data") or ""))
                elif kind == "ws_close":
                    socket = _sockets.pop(str(message["id"]), None)
                    if socket is not None:
                        socket.__exit__(None, None, None)
                elif kind == "shutdown":
                    with _stream_lock:
                        for cancelled in _stream_cancellations.values():
                            cancelled.set()
                    for socket in list(_sockets.values()):
                        try:
                            socket.__exit__(None, None, None)
                        except Exception:
                            pass
                    _sockets.clear()
                    break
            except Exception as exc:
                emit(
                    {
                        "kind": "error",
                        "id": str(message.get("id", "")) if "message" in locals() else "",
                        "error": str(exc),
                        "traceback": traceback.format_exc(),
                    }
                )


if __name__ == "__main__":
    main()
