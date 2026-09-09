"""Drive the shipped knorvia-daemon from the Python kernel client."""

from __future__ import annotations

from collections import deque
import io
import json
import os
from pathlib import Path
import threading
import time
from types import SimpleNamespace

import pytest

from knorvia.runtime.kernel_client import (
    DaemonSession,
    KernelClientRecoveryRequired,
    KernelClientTimeout,
    _FrameReader,
    _read_frame,
    iter_legacy_events,
    resolve_daemon_bin,
    start_turn_sync,
)


def test_resolve_daemon_bin_is_knorvia_not_codex():
    bin_path = resolve_daemon_bin()
    lowered = str(bin_path).lower()
    assert "knorvia-daemon" in lowered
    assert "node_modules" not in lowered


def test_frame_read_deadline_is_bounded_without_a_reader_thread():
    """An idle local pipe must time out, not leave a blocked helper behind."""
    read_fd, write_fd = os.pipe()
    reader = os.fdopen(read_fd, "rb", buffering=0)
    writer = os.fdopen(write_fd, "wb", buffering=0)
    try:
        started = time.monotonic()
        with pytest.raises(KernelClientTimeout):
            _read_frame(reader, timeout=0.05)
        assert time.monotonic() - started < 0.5
    finally:
        reader.close()
        writer.close()


def test_frame_reader_preserves_coalesced_frames():
    """A single pipe read may contain more than one protocol frame."""
    reader = _FrameReader(
        io.BytesIO(
            _frame({"jsonrpc": "2.0", "method": "turn/event", "params": {"seq": 1}})
            + _frame({"jsonrpc": "2.0", "id": "py-1", "result": {"ok": True}})
        )
    )
    deadline = time.monotonic() + 0.5
    assert reader.read_frame(deadline)["method"] == "turn/event"
    assert reader.read_frame(deadline) == {
        "jsonrpc": "2.0",
        "id": "py-1",
        "result": {"ok": True},
    }


def _frame(value: dict) -> bytes:
    raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
    return f"Content-Length: {len(raw)}\r\n\r\n".encode("ascii") + raw


def _bare_session(stdout) -> DaemonSession:
    """Build only the in-memory pieces needed to exercise wire routing."""
    session = object.__new__(DaemonSession)
    session._io_lock = threading.RLock()
    session._notifications = deque()
    session._notification_bytes = 0
    session._responses = {}
    session._late_response_bytes = 0
    session._late_response_sizes = {}
    session._timed_out_requests = {}
    session._max_notification_count = 512
    session._max_notification_bytes = 8 * 1024 * 1024
    session._max_timed_out_request_count = 128
    session._max_late_response_count = 128
    session._max_late_response_bytes = 8 * 1024 * 1024
    session._recovery_required = False
    session._recovery_reason = None
    session._closed = False
    session._n = 0
    session._rpc_timeout = 0.1
    session.proc = SimpleNamespace(stdin=io.BytesIO(), poll=lambda: None)
    session._reader = _FrameReader(stdout)
    return session


def test_notify_before_response_is_retained_for_approval_wait():
    """An approval emitted before the start response must not be skipped."""
    wire = io.BytesIO(
        _frame(
            {
                "jsonrpc": "2.0",
                "method": "approval/request",
                "params": {
                    "approvalId": "appr_1",
                    "threadId": "thr_1",
                    "turnId": "turn_1",
                    "action": "kernel.commandExecution",
                },
            }
        )
        + _frame({"jsonrpc": "2.0", "id": "py-1", "result": {"ok": True}})
    )
    session = _bare_session(wire)
    assert session.rpc("turn/start") == {"ok": True}
    approval = session.wait_for_approval("turn_1", thread_id="thr_1", timeout=0.1)
    assert approval is not None
    assert approval["id"] == "appr_1"


def test_timed_out_request_is_explicitly_uncertain_and_recoverable():
    read_fd, write_fd = os.pipe()
    reader = os.fdopen(read_fd, "rb", buffering=0)
    writer = os.fdopen(write_fd, "wb", buffering=0)
    try:
        session = _bare_session(reader)
        with pytest.raises(KernelClientTimeout) as raised:
            session.rpc("turn/start", timeout=0.05)
        uncertain = raised.value
        assert uncertain.uncertain is True
        assert uncertain.request_id == "py-1"
        # The client does not retry or kill the session. A late answer stays
        # available by the original request id for explicit recovery.
        writer.write(_frame({"jsonrpc": "2.0", "id": "py-1", "result": {"accepted": True}}))
        writer.flush()
        assert session.resolve_timed_out_request(uncertain.request_id, timeout=0.5) == {
            "accepted": True
        }
    finally:
        reader.close()
        writer.close()


def test_notification_backlog_cap_requires_recovery_without_evicting_evidence():
    session = _bare_session(io.BytesIO())
    session._max_notification_count = 1
    first = {
        "jsonrpc": "2.0",
        "method": "approval/request",
        "params": {"id": "appr_1", "turnId": "turn_1"},
    }
    second = {
        "jsonrpc": "2.0",
        "method": "turn/event",
        "params": {"turnId": "turn_1", "kind": "item"},
    }
    session._route_message_locked(first)

    with pytest.raises(KernelClientRecoveryRequired) as raised:
        session._route_message_locked(second)

    assert raised.value.recovery_required is True
    assert raised.value.uncertain is True
    assert "notification backlog" in str(raised.value)
    # The earlier approval was not silently evicted. The overflowing event
    # forces durable recovery instead of pretending either outcome is known.
    assert session.drain_notifications() == [first]
    with pytest.raises(KernelClientRecoveryRequired):
        session.rpc("workspace/list")


def test_late_response_cap_and_unknown_response_require_recovery_not_caching():
    session = _bare_session(io.BytesIO())
    session._timed_out_requests["py-late"] = "turn/start"
    session._max_late_response_bytes = 1

    with pytest.raises(KernelClientRecoveryRequired) as raised:
        session._route_message_locked(
            {"jsonrpc": "2.0", "id": "py-late", "result": {"accepted": True}}
        )

    assert raised.value.request_id == "py-late"
    assert raised.value.recovery_required is True
    assert session._responses == {}
    assert "py-late" in session._timed_out_requests

    unknown = _bare_session(io.BytesIO())
    with pytest.raises(KernelClientRecoveryRequired) as unknown_raised:
        unknown._route_message_locked(
            {"jsonrpc": "2.0", "id": "py-untracked", "result": {"ok": True}}
        )
    assert unknown_raised.value.request_id == "py-untracked"
    assert unknown._responses == {}


def test_duplicate_late_response_requires_recovery_without_overwriting_first():
    session = _bare_session(io.BytesIO())
    session._timed_out_requests["py-late"] = "turn/start"
    first = {"jsonrpc": "2.0", "id": "py-late", "result": {"accepted": True}}
    session._route_message_locked(first)

    with pytest.raises(KernelClientRecoveryRequired) as raised:
        session._route_message_locked(
            {"jsonrpc": "2.0", "id": "py-late", "result": {"accepted": False}}
        )

    assert raised.value.request_id == "py-late"
    assert session._responses["py-late"] == first


def test_interrupted_kernel_turn_projects_to_legacy_failure_not_success():
    events = list(
        iter_legacy_events(
            {
                "thread": {"id": "thr_1"},
                "turn": {
                    "turn": {"id": "turn_1", "status": "interrupted"},
                    "items": [
                        {
                            "kind": "userMessage",
                            "turnId": "turn_1",
                            "payload": {"text": "keep this honest"},
                        }
                    ],
                },
            }
        )
    )
    done = next(event for event in events if event["type"] == "done")
    error = next(event for event in events if event["type"] == "error")
    assert done["metadata"]["status"] == "failed"
    assert done["metadata"]["remoteStatus"] == "interrupted"
    assert error["metadata"]["turn_terminal"] is True
    assert error["metadata"]["remoteStatus"] == "interrupted"
    assert not any(event["type"] == "result" for event in events)


def test_start_turn_sync_without_provider_fails_typed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """No provider configured → honest typed failure, never a fabricated ack,
    and no upstream `codex` internals in any surfaced item."""
    monkeypatch.setenv(
        "KNORVIA_DAEMON_BIN",
        str(Path(r"D:\tools\knorvia-kernel\knorvia-rs\target\debug\knorvia-daemon.exe")),
    )
    if not Path(os.environ["KNORVIA_DAEMON_BIN"]).is_file():
        pytest.skip("knorvia-daemon binary missing")
    monkeypatch.delenv("KNORVIA_PROVIDER_MODEL", raising=False)
    monkeypatch.delenv("KNORVIA_PROVIDER_BASE_URL", raising=False)
    result = start_turn_sync("hello from pytest", home=tmp_path, turn_timeout=30)
    assert result["turn"]["turn"]["status"] == "failed"
    items = result["turn"]["items"]
    kinds = {item["kind"] for item in items}
    assert "userMessage" in kinds
    assert "error" in kinds
    # The kernel turn must not fabricate a successful reply.
    assert "agentMessage" not in kinds
    # No upstream `codex` internals leak through normalized items.
    assert not any("codex" in str(item).lower() for item in items)
