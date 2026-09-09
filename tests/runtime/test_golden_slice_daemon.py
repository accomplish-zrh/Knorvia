"""Golden Workspace/Thread/Turn slice against the shipped knorvia-daemon.

The read-only turn AND the write turns in this slice run on the REAL Knorvia
Kernel (`codex-app-server` spawned by the daemon) against a local scripted
mock Responses API. Write turns exercise the full approval bridge: the Kernel
surfaces an approval for a network probe, the daemon records it in the product
approval store with an action digest, the decision is forwarded onto the
Kernel wire, and a mid-turn interrupt cancels the turn cooperatively. Replay
after a daemon restart is stable and duplicate-free. No deterministic echo is
asserted anywhere.
"""

from __future__ import annotations

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from knorvia.runtime.kernel_client import DaemonSession, resolve_daemon_bin

MODEL = "gpt-5.2"
REPLY = "Hello from the Knorvia Kernel"
PROBE_COMMAND = (
    "Invoke-WebRequest -Uri https://example.invalid/knorvia-probe -UseBasicParsing"
)


def _sse(events: list[dict]) -> str:
    body = ""
    for event in events:
        body += f"event: {event['type']}\ndata: {json.dumps(event)}\n\n"
    return body


def _created(response_id: str) -> dict:
    return {"type": "response.created", "response": {"id": response_id}}


def _completed(response_id: str) -> dict:
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


def _function_call_sse() -> str:
    """A network probe the model asks to run: the workspace-write sandbox
    surfaces a Kernel approval request for it."""
    return _sse(
        [
            _created("resp_fn"),
            {
                "type": "response.output_item.done",
                "item": {
                    "type": "function_call",
                    "name": "exec_command",
                    "call_id": "call_knorvia",
                    # Responses wire: arguments is a JSON-encoded string.
                    "arguments": json.dumps({"cmd": PROBE_COMMAND}),
                },
            },
            _completed("resp_fn"),
        ]
    )


def _message_sse(text: str) -> str:
    return _sse(
        [
            _created("resp_msg"),
            {
                "type": "response.output_item.done",
                "item": {
                    "type": "message",
                    "role": "assistant",
                    "id": "msg_1",
                    "content": [{"type": "output_text", "text": text}],
                },
            },
            _completed("resp_msg"),
        ]
    )


class _SSEHandler(BaseHTTPRequestHandler):
    hits: list[str] = []
    # Scripted per-request responses; extra requests replay the last body.
    script: list[str] = []

    def do_POST(self) -> None:  # noqa: N802 - http.server API
        type(self).hits.append(self.path)
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        script = type(self).script
        if script:
            index = min(len(type(self).hits) - 1, len(script) - 1)
            body = script[index]
        else:
            body = _message_sse(REPLY)
        payload = body.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args: object) -> None:  # silence request logs
        return


@pytest.fixture()
def mock_provider(monkeypatch: pytest.MonkeyPatch):
    server = ThreadingHTTPServer(("127.0.0.1", 0), _SSEHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    monkeypatch.setenv("KNORVIA_PROVIDER_MODEL", MODEL)
    monkeypatch.setenv("KNORVIA_PROVIDER_BASE_URL", f"http://127.0.0.1:{port}/v1")
    monkeypatch.setenv("KNORVIA_PROVIDER_API_KEY", "test-key-knorvia")
    monkeypatch.setenv("KNORVIA_KERNEL_TURN_TIMEOUT_SECS", "90")
    yield server
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


def _wait_terminal(session: DaemonSession, turn_id: str, timeout: float = 120.0) -> dict:
    """Use the consumer's bounded terminal wait, never a start acknowledgement."""
    return session.wait_for_turn(turn_id, timeout=timeout)


def test_golden_workspace_thread_turn_approval_artifact_replay(
    tmp_path: Path, mock_provider
):
    os.environ.setdefault("KNORVIA_DAEMON_BIN", str(resolve_daemon_bin()))
    if not Path(os.environ["KNORVIA_DAEMON_BIN"]).is_file():
        pytest.skip("knorvia-daemon binary missing")
    # Scripted provider: read-only turn gets a plain message; every write turn
    # asks for the network probe (Kernel approval), then a follow-up message.
    _SSEHandler.script = [
        _message_sse(REPLY),
        _function_call_sse(),
        _message_sse("Understood: the probe was declined."),
        _function_call_sse(),
        _message_sse("Probe ran inside the sandbox; blocked as expected."),
        _function_call_sse(),
        _message_sse("still here"),
        _message_sse("still here"),
    ]

    home = tmp_path / "knorvia-home"
    with DaemonSession(home) as session:
        ws = session.rpc("workspace/create", {"title": "Golden", "idempotencyKey": "golden-ws"})
        assert str(ws["id"]).startswith("ws_")
        thread = session.rpc("thread/start", {"workspaceId": ws["id"], "title": "slice"})
        assert str(thread["id"]).startswith("thr_")

        # REAL kernel turn: read-only, runs on the in-tree Kernel App Server.
        real_started = session.rpc(
            "turn/start",
            {
                "threadId": thread["id"],
                "input": "Say hello to Knorvia",
                "tools": {"readOnly": True},
            },
        )
        assert real_started["turn"]["status"] == "running", real_started
        assert real_started["pendingApprovalId"] is None, real_started
        real = _wait_terminal(session, real_started["turn"]["id"])
        assert real["status"] == "completed", real
        agent = [i for i in real["items"] if i["kind"] == "agentMessage"]
        assert agent, [i["kind"] for i in real["items"]]
        assert agent[-1]["payload"]["text"] == REPLY

        # Turn 1 (write): the Kernel surfaces an approval for the network
        # probe; the user denies it; the Kernel turn completes honestly.
        turn = session.rpc(
            "turn/start",
            {
                "threadId": thread["id"],
                "input": "probe the network then write",
                "tools": {"readOnly": True, "write": True},
            },
        )
        turn_id = turn["turn"]["id"]
        assert turn["turn"]["status"] == "running", turn
        assert turn["pendingApprovalId"] is None, turn
        approval = session.wait_for_approval(
            turn_id, thread_id=thread["id"], timeout=30
        )
        assert approval, turn
        denied = session.rpc("approval/respond", {"id": approval["id"], "decision": "deny"})
        assert denied["status"] == "denied"
        done1 = _wait_terminal(session, turn_id)
        assert done1["status"] == "completed", done1
        kinds1 = {item["kind"] for item in done1["items"]}
        assert "commandExecution" in kinds1, kinds1

        # Turn 2 (write): the user allows the probe; the Kernel runs it inside
        # the workspace-write sandbox (network blocked, harmless) and completes.
        turn2 = session.rpc(
            "turn/start",
            {
                "threadId": thread["id"],
                "input": "run the probe this time",
                "tools": {"readOnly": True, "write": True},
            },
        )
        assert turn2["turn"]["status"] == "running", turn2
        assert turn2["pendingApprovalId"] is None, turn2
        approval2 = session.wait_for_approval(
            turn2["turn"]["id"], thread_id=thread["id"], timeout=30
        )
        assert approval2, turn2
        allowed = session.rpc(
            "approval/respond", {"id": approval2["id"], "decision": "allow"}
        )
        assert allowed["status"] == "allowed"
        done2 = _wait_terminal(session, turn2["turn"]["id"])
        assert done2["status"] == "completed", done2

        art = session.rpc(
            "artifact/create",
            {"workspaceId": ws["id"], "title": "notes.md", "type": "text/markdown"},
        )
        session.rpc("artifact/stage", {"id": art["id"], "content": "# hello\n"})
        published = session.rpc("artifact/commit", {"id": art["id"]})
        assert published["lifecycle"] == "published"
        replay1 = session.rpc("event/replay", {"streamId": thread["id"], "afterSeq": 0})
        ids1 = [e["eventId"] for e in replay1["events"]]
        assert ids1
        assert len(ids1) == len(set(ids1))

    with DaemonSession(home) as session2:
        replay2 = session2.rpc("event/replay", {"streamId": thread["id"], "afterSeq": 0})
        ids2 = [e["eventId"] for e in replay2["events"]]
        assert ids1 == ids2
        waiting = session2.rpc(
            "turn/start",
            {
                "threadId": thread["id"],
                "input": "write then cancel",
                "tools": {"readOnly": True, "write": True},
            },
        )
        assert waiting["turn"]["status"] == "running"
        assert waiting["pendingApprovalId"] is None, waiting
        waiting_approval = session2.wait_for_approval(
            waiting["turn"]["id"], thread_id=thread["id"], timeout=30
        )
        assert waiting_approval, waiting
        interrupted = session2.rpc("turn/interrupt", {"turnId": waiting["turn"]["id"]})
        assert interrupted["status"] in {"running", "cancelling", "cancelled"}, interrupted
        cancelled = _wait_terminal(session2, waiting["turn"]["id"])
        assert cancelled["status"] == "cancelled", cancelled

        # Kernel thread/resume bridge: the restarted daemon resumed the SAME
        # Kernel thread (rollout continues, no second rollout file).
        kernel_store = home / "state" / "kernel"
        rollouts = list(kernel_store.glob("sessions/**/rollout-*.jsonl"))
        assert len(rollouts) == 1, [str(p) for p in rollouts]
