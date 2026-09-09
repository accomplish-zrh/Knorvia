"""The legacy SQLite export produces a dump the daemon migrator imports."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from knorvia.services.session.legacy_export import export_legacy_dump
from knorvia.services.session.sqlite_store import SQLiteSessionStore


@pytest.mark.asyncio
async def test_export_writes_sessions_and_messages(tmp_path: Path) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    session = await store.create_session(title="Math chat")
    await store.add_message(
        session_id=session["id"],
        role="user",
        content="What is 2+2?",
    )
    await store.add_message(
        session_id=session["id"],
        role="assistant",
        content="It is 4.",
        capability="chat",
        metadata={"call_id": "c1", "call_kind": "llm_final_response"},
    )

    out = await export_legacy_dump(store, tmp_path / "dump")
    assert out.name == "legacy.json"
    dump = json.loads(out.read_text(encoding="utf-8"))
    assert len(dump["sessions"]) == 1
    exported = dump["sessions"][0]
    assert exported["title"] == "Math chat"
    roles = [m["role"] for m in exported["messages"]]
    assert roles[0] == "user"
    assert "What is 2+2?" in exported["messages"][0]["content"]
    assistant = [m for m in exported["messages"] if m["role"] == "assistant"]
    assert any("It is 4." in m["content"] for m in assistant)
    # The metadata the web UI renders survives the export.
    flat_meta = [m["metadata"] for m in exported["messages"] if m["metadata"]]
    assert any("call_id" in m for m in flat_meta)


@pytest.mark.asyncio
async def test_export_is_read_only_and_idempotent(tmp_path: Path) -> None:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    session = await store.create_session(title="Hello chat")
    await store.add_message(
        session_id=session["id"],
        role="user",
        content="hello",
    )
    before = (tmp_path / "chat_history.db").stat().st_size
    out1 = await export_legacy_dump(store, tmp_path / "dump")
    out2 = await export_legacy_dump(store, tmp_path / "dump")
    after = (tmp_path / "chat_history.db").stat().st_size
    assert out1 == out2
    assert json.loads(out2.read_text(encoding="utf-8"))["sessions"]
    # The source DB is not modified by exporting.
    assert after == before
