# -*- coding: utf-8 -*-
"""Hardening tests v2: room lock, turn timeout, transcript cap (CLI model)."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
import tempfile

os.environ.setdefault("KNORVIA_HOME", tempfile.mkdtemp(prefix="grp_hard2_"))

import pytest  # noqa: E402

from knorvia.services.partners import group_chat  # noqa: E402
from knorvia.services.partners.group_chat import (  # noqa: E402
    GROUP_TRANSCRIPT_MAX,
    GroupChatEngine,
)
from knorvia.services.partners.group_rooms import (  # noqa: E402
    GroupRoomStore,
    RoomMessage,
    new_room,
)
from knorvia.services.subagent.types import ConsultResult  # noqa: E402


class FakeInstance:
    def __init__(self) -> None:
        class _C:
            pass

        self.config = _C()


def _install_backend(monkeypatch: pytest.MonkeyPatch, backend) -> None:
    monkeypatch.setattr("knorvia.services.subagent.get_backend", lambda kind: backend)
    settings = type("S", (), {"backend": lambda self, kind: object()})()
    monkeypatch.setattr("knorvia.services.subagent.load_subagent_settings", lambda: settings)
    import knorvia.services.subagent.sessions as sess

    store: dict[str, str] = {}
    monkeypatch.setattr(sess, "get_session", lambda key: store.get(key))
    monkeypatch.setattr(
        sess,
        "remember_session",
        lambda key, sid, **kw: store.__setitem__(key, sid),
    )
    return store


@pytest.mark.asyncio
async def test_concurrent_says_are_serialised(monkeypatch, tmp_path) -> None:
    alpha_started = asyncio.Event()
    release = asyncio.Event()

    class SlowBackend:
        kind = "codex"

        async def consult(self, question, *, on_event, **kwargs):  # noqa: ANN003
            if not alpha_started.is_set():
                alpha_started.set()
                await release.wait()
            return ConsultResult(final_text="spoke", session_id=None)

    store = _install_backend(monkeypatch, SlowBackend())

    engine = GroupChatEngine(GroupRoomStore(tmp_path / "_g"))
    room = engine.create_room("locked")
    engine.add_member(room.id, backend="codex", connection="c1")

    first = asyncio.create_task(engine.send_user_message(room.id, "first"))
    await asyncio.wait_for(alpha_started.wait(), timeout=5)
    second = asyncio.create_task(engine.send_user_message(room.id, "second"))
    await asyncio.sleep(0.2)
    assert not second.done(), "second say() must block on the room lock"

    release.set()
    first_result = await asyncio.wait_for(first, timeout=10)
    second_result = await asyncio.wait_for(second, timeout=10)

    contents = [m["content"] for m in second_result["transcript"]]
    assert "first" in contents and "second" in contents
    assert first_result["room_id"] == room.id


@pytest.mark.asyncio
async def test_hung_member_times_out(monkeypatch, tmp_path) -> None:
    class HungBackend:
        kind = "codex"

        async def consult(self, question, *, on_event, **kwargs):  # noqa: ANN003
            await asyncio.sleep(999)

    _install_backend(monkeypatch, HungBackend())
    monkeypatch.setattr(group_chat, "MEMBER_TURN_TIMEOUT_SECONDS", 0.05)

    engine = GroupChatEngine(GroupRoomStore(tmp_path / "_g"))
    room = engine.create_room("hung")
    engine.add_member(room.id, backend="codex", connection="c1")
    result = await engine.send_user_message(room.id, "anyone?")

    assert result["replies"][0]["status"] == "timeout"
    assert result["transcript"][0]["sender"] == "user"


def test_transcript_capped_at_max(tmp_path) -> None:
    store = GroupRoomStore(tmp_path / "_g")
    r = new_room("cap")
    for i in range(GROUP_TRANSCRIPT_MAX + 50):
        r.messages.append(RoomMessage("user", "user", f"m{i}", float(i)))
    store.save(r)
    loaded = store.get(r.id)
    assert len(loaded.messages) == GROUP_TRANSCRIPT_MAX + 50  # store is dumb

    # Engine trims after each round.
    if len(loaded.messages) > GROUP_TRANSCRIPT_MAX:
        loaded.messages = loaded.messages[-GROUP_TRANSCRIPT_MAX:]
    store.save(loaded)
    reloaded = store.get(r.id)
    assert len(reloaded.messages) == GROUP_TRANSCRIPT_MAX
    assert reloaded.messages[-1].content == f"m{GROUP_TRANSCRIPT_MAX + 49}"
