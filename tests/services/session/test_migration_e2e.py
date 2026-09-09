"""End-to-end data migration: SQLite history → daemon migrator → Product Store.

Drives the REAL daemon: export a fixture chat history as a legacy dump,
invoke ``migration/run`` over the Knorvia Protocol, then read the migrated
workspace/thread back through the daemon and assert the conversation
replays. This is the cutover's data-migration slice exercised end to end.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from knorvia.runtime.kernel_client import DaemonSession
from knorvia.services.session.legacy_export import export_legacy_dump
from knorvia.services.session.sqlite_store import SQLiteSessionStore


def _daemon_bin() -> str | None:
    bin_path = os.environ.get("KNORVIA_DAEMON_BIN") or str(
        Path(r"D:\tools\knorvia-kernel\knorvia-rs\target\debug\knorvia-daemon.exe")
    )
    return bin_path if Path(bin_path).is_file() else None


@pytest.mark.asyncio
async def test_sqlite_history_migrates_through_the_daemon(tmp_path: Path) -> None:
    daemon_bin = _daemon_bin()
    if daemon_bin is None:
        pytest.skip("knorvia-daemon binary missing")

    # 1. A real legacy history: two sessions, one with a conversation.
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    chat = await store.create_session(title="Old math chat")
    await store.add_message(session_id=chat["id"], role="user", content="What is 2+2?")
    await store.add_message(
        session_id=chat["id"],
        role="assistant",
        content="It is 4.",
        capability="chat",
        metadata={"call_id": "c1", "call_kind": "llm_final_response"},
    )
    await store.create_session(title="Empty chat")

    # 2. Export the legacy dump (read-only, idempotent).
    dump_dir = tmp_path / "legacy-export"
    out = await export_legacy_dump(store, dump_dir)
    assert out.is_file()

    # 3. The daemon imports it into a fresh home.
    home = tmp_path / "knorvia-home"
    home.mkdir()
    os.environ["KNORVIA_DAEMON_BIN"] = daemon_bin
    session = DaemonSession(home)
    try:
        run = session.rpc("migration/run", {"source": str(dump_dir)})
        assert run["phase"] == "activated"
        assert run["imported"] == 2

        # 4. The migrated data is readable through the daemon.
        workspaces = session.rpc("workspace/list", None)
        titles = {w["title"] for w in workspaces}
        assert "Old math chat" in titles
        assert "Empty chat" in titles

        ws = next(w for w in workspaces if w["title"] == "Old math chat")
        threads = session.rpc("thread/list", {"workspaceId": ws["id"]})
        assert len(threads) == 1
        replay = session.rpc(
            "event/replay", {"streamId": threads[0]["id"], "afterSeq": 0}
        )
        events = replay["events"]
        message_events = [e for e in events if e["kind"] == "message"]
        assert len(message_events) == 2
        assert message_events[0]["payload"]["role"] == "user"
        assert message_events[0]["payload"]["content"] == "What is 2+2?"
        assert message_events[1]["payload"]["content"] == "It is 4."
        assert (
            message_events[1]["payload"]["metadata"]["call_id"] == "c1"
        )
        assert message_events[1]["payload"]["imported"] is True
    finally:
        session.close()
