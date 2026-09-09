"""Real async-control regression against daemon + App Server + a slow local SSE model.

The model endpoint is deliberately local and holds each response open.  This
means a passing test proves the daemon can accept control requests while real
App Server generation is in progress; it is not a mocked daemon test and does
not contact a paid provider or the public network.
"""

from __future__ import annotations

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import threading
import time
from typing import Any

import pytest

from knorvia.runtime.kernel_client import (
    DaemonSession,
    KernelClientError,
    resolve_daemon_bin,
)


MODEL = "gpt-5.2"
CONTROL_BUDGET_SECONDS = 0.5
_TOKENS = ("alpha-token", "beta-token", "cancel-token", "restart-token")


def _sse(events: list[dict[str, Any]]) -> bytes:
    return b"".join(
        (
            f"event: {event['type']}\n"
            f"data: {json.dumps(event, separators=(',', ':'))}\n\n"
        ).encode("utf-8")
        for event in events
    )


def _created(response_id: str) -> dict[str, Any]:
    return {"type": "response.created", "response": {"id": response_id}}


def _completed(response_id: str) -> dict[str, Any]:
    return {
        "type": "response.completed",
        "response": {
            "id": response_id,
            "usage": {
                "input_tokens": 0,
                "input_tokens_details": None,
                "output_tokens": 0,
                "output_tokens_details": None,
                "total_tokens": 0,
            },
        },
    }


def _message_tail(response_id: str, text: str) -> bytes:
    return _sse(
        [
            {
                "type": "response.output_item.done",
                "item": {
                    "type": "message",
                    "role": "assistant",
                    "id": f"msg_{response_id}",
                    "content": [{"type": "output_text", "text": text}],
                },
            },
            _completed(response_id),
        ]
    )


class _SlowProviderState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._started = {token: threading.Event() for token in _TOKENS}
        self._release = {token: threading.Event() for token in _TOKENS}
        self.bodies: dict[str, list[str]] = {token: [] for token in _TOKENS}
        self.unknown_bodies: list[str] = []

    def record(self, body: str) -> str:
        token = next((value for value in _TOKENS if value in body), "")
        with self._lock:
            if token:
                self.bodies[token].append(body)
                self._started[token].set()
            else:
                self.unknown_bodies.append(body)
        return token

    def wait_started(self, token: str, timeout: float = 10.0) -> None:
        assert self._started[token].wait(timeout), (
            f"local provider never received {token}; bodies={self.bodies!r}; "
            f"unknown={self.unknown_bodies!r}"
        )

    def wait_release(self, token: str) -> bool:
        return self._release[token].wait(30.0)

    def release(self, token: str) -> None:
        self._release[token].set()

    def release_all(self) -> None:
        for gate in self._release.values():
            gate.set()


class _SlowSSEHandler(BaseHTTPRequestHandler):
    state: _SlowProviderState

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        token = type(self).state.record(raw.decode("utf-8", "replace"))
        response_id = f"resp_{token or 'unknown'}"
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            # Give the App Server a valid started response, then keep real
            # generation blocked until the test explicitly releases this turn.
            self.wfile.write(_sse([_created(response_id)]))
            self.wfile.flush()
            if token:
                type(self).state.wait_release(token)
            self.wfile.write(_message_tail(response_id, f"reply:{token or 'unknown'}"))
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            # Expected when the restart/interrupt scenario closes the daemon's
            # App Server request before this local endpoint is released.
            return

    def log_message(self, *args: object) -> None:  # silence http.server logs
        return


@pytest.fixture()
def slow_provider(monkeypatch: pytest.MonkeyPatch):
    state = _SlowProviderState()
    _SlowSSEHandler.state = state
    server = ThreadingHTTPServer(("127.0.0.1", 0), _SlowSSEHandler)
    server.daemon_threads = True
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("KNORVIA_PROVIDER_MODEL", MODEL)
    monkeypatch.setenv("KNORVIA_PROVIDER_BASE_URL", f"http://127.0.0.1:{port}/v1")
    monkeypatch.setenv("KNORVIA_PROVIDER_API_KEY", "test-key-knorvia")
    monkeypatch.setenv("KNORVIA_KERNEL_TURN_TIMEOUT_SECS", "90")
    try:
        yield state
    finally:
        state.release_all()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _start_slow_turn(session: DaemonSession, thread_id: str, token: str) -> dict[str, Any]:
    started = time.monotonic()
    result = session.rpc(
        "turn/start",
        {
            "threadId": thread_id,
            "input": token,
            "tools": {"readOnly": True},
        },
    )
    elapsed = time.monotonic() - started
    assert elapsed < CONTROL_BUDGET_SECONDS, (
        f"turn/start blocked for {elapsed:.3f}s instead of acknowledging the running turn"
    )
    assert result["turn"]["status"] == "running", result
    assert result["pendingApprovalId"] is None, result
    assert [item.get("kind") for item in result["items"]] == ["userMessage"], result
    assert {
        str(item.get("turnId") or "") for item in result["items"]
    } == {str(result["turn"]["id"])}, result
    return result


def _agent_texts(turn: dict[str, Any]) -> list[str]:
    return [
        str((item.get("payload") or {}).get("text") or "")
        for item in turn.get("items") or []
        if item.get("kind") == "agentMessage"
    ]


def test_async_daemon_control_plane_with_slow_real_app_server(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    slow_provider: _SlowProviderState,
):
    daemon_bin = resolve_daemon_bin()
    if not daemon_bin.is_file():
        pytest.skip("knorvia-daemon binary missing")
    monkeypatch.setenv("KNORVIA_DAEMON_BIN", str(daemon_bin))
    home = tmp_path / "knorvia-home"

    session = DaemonSession(home)
    try:
        workspace = session.rpc("workspace/create", {"title": "async-control"})
        alpha_thread = session.rpc(
            "thread/start", {"workspaceId": workspace["id"], "title": "alpha"}
        )
        beta_thread = session.rpc(
            "thread/start", {"workspaceId": workspace["id"], "title": "beta"}
        )
        cancel_thread = session.rpc(
            "thread/start", {"workspaceId": workspace["id"], "title": "cancel"}
        )
        restart_thread = session.rpc(
            "thread/start", {"workspaceId": workspace["id"], "title": "restart"}
        )

        alpha_started = _start_slow_turn(session, alpha_thread["id"], "alpha-token")
        alpha_id = alpha_started["turn"]["id"]
        slow_provider.wait_started("alpha-token")

        # A second daemon must not open the same home, recover this owner's
        # live turn, or otherwise reinterpret it as an abandoned process.
        with pytest.raises(KernelClientError):
            DaemonSession(home, rpc_timeout=2)
        alpha_after_competing_start = session.rpc("turn/read", {"id": alpha_id})
        assert alpha_after_competing_start["status"] == "running"

        # A held model stream must not monopolize the stdio control plane.
        control_started = time.monotonic()
        workspaces = session.rpc("workspace/list")
        assert time.monotonic() - control_started < CONTROL_BUDGET_SECONDS
        assert any(item["id"] == workspace["id"] for item in workspaces)
        control_started = time.monotonic()
        alpha_live = session.rpc("turn/read", {"id": alpha_id})
        assert time.monotonic() - control_started < CONTROL_BUDGET_SECONDS
        assert alpha_live["status"] == "running", alpha_live
        assert [item["kind"] for item in alpha_live["items"]] == ["userMessage"]

        beta_started = _start_slow_turn(session, beta_thread["id"], "beta-token")
        beta_id = beta_started["turn"]["id"]
        slow_provider.wait_started("beta-token")

        cancel_started = _start_slow_turn(session, cancel_thread["id"], "cancel-token")
        cancel_id = cancel_started["turn"]["id"]
        slow_provider.wait_started("cancel-token")
        interrupted = session.rpc("turn/interrupt", {"turnId": cancel_id})
        assert interrupted["status"] in {"running", "cancelling", "cancelled"}, interrupted

        # Let the held model responses settle. The cancel request was sent
        # before its model stream was allowed to complete.
        slow_provider.release("alpha-token")
        slow_provider.release("beta-token")
        slow_provider.release("cancel-token")
        alpha_done = session.wait_for_turn(alpha_id, timeout=30)
        beta_done = session.wait_for_turn(beta_id, timeout=30)
        cancel_done = session.wait_for_turn(cancel_id, timeout=30)
        assert alpha_done["status"] == "completed", alpha_done
        assert beta_done["status"] == "completed", beta_done
        assert cancel_done["status"] == "cancelled", cancel_done

        # Current-turn snapshots must not contain another Thread's output.
        assert "reply:alpha-token" in _agent_texts(alpha_done)
        assert "reply:beta-token" not in _agent_texts(alpha_done)
        assert "reply:beta-token" in _agent_texts(beta_done)
        assert "reply:alpha-token" not in _agent_texts(beta_done)

        restart_started = _start_slow_turn(
            session, restart_thread["id"], "restart-token"
        )
        restart_id = restart_started["turn"]["id"]
        slow_provider.wait_started("restart-token")
    finally:
        # The runner is intentionally killed while its local SSE response is
        # still held. Startup recovery must not infer a completed answer.
        session.close()

    slow_provider.release("restart-token")
    with DaemonSession(home) as recovered_session:
        recovered = recovered_session.rpc("turn/read", {"id": restart_id})
        assert recovered["status"] == "interrupted", recovered
        assert recovered["status"] != "completed"
        assert not _agent_texts(recovered)
