from __future__ import annotations

import asyncio
from pathlib import Path

from knorvia.services.session.sqlite_store import SQLiteSessionStore
from knorvia.services.session.turn_runtime import _extract_continue_message_id


def test_extract_continue_message_id_pops_runtime_key() -> None:
    config = {"_continue_message_id": 42}
    assert _extract_continue_message_id(config) == 42
    assert "_continue_message_id" not in config
    assert _extract_continue_message_id({}) is None


def test_update_message_appends_content_in_place(tmp_path: Path) -> None:
    store = SQLiteSessionStore(db_path=tmp_path / "continue.db")
    session = asyncio.run(store.create_session())
    sid = session["id"]
    asyncio.run(store.add_message(sid, role="user", content="write a story"))
    aid = asyncio.run(store.add_message(sid, role="assistant", content="Once upon a time"))
    updated = asyncio.run(
        store.update_message(
            aid,
            content="Once upon a time, in a quiet town",
            events=[{"type": "content", "content": ", in a quiet town"}],
        )
    )
    assert updated is True
    last = asyncio.run(store.get_last_message(sid, role="assistant"))
    assert last is not None
    assert last["id"] == aid
    assert last["content"] == "Once upon a time, in a quiet town"
    messages = asyncio.run(store.get_messages(sid))
    assert [m["role"] for m in messages] == ["user", "assistant"]
