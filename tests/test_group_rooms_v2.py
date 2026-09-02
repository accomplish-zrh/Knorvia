# -*- coding: utf-8 -*-
"""Redesigned group rooms: CLI-backed members + room-anchored sessions."""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
import tempfile

os.environ.setdefault("KNORVIA_HOME", tempfile.mkdtemp(prefix="grp_v2_"))

import pytest  # noqa: E402

from knorvia.services.partners import group_chat  # noqa: E402
from knorvia.services.partners.group_chat import GroupChatEngine  # noqa: E402
from knorvia.services.partners.group_rooms import GroupRoomStore  # noqa: E402


class FakeBackend:
    """Records consults; hands back distinct session ids per resume state."""

    kind = "codex"

    def __init__(self, reply: str) -> None:
        self.reply = reply
        self.consults: list[dict] = []

    async def consult(
        self,
        question,
        *,
        on_event,
        cwd=None,
        session_id=None,
        config=None,
        images=None,
        partner_id=None,
    ):  # noqa: ANN001, ANN003
        self.consults.append({"question": question[:60], "session_id": session_id})
        from knorvia.services.subagent.types import ConsultResult

        new_sid = f"sess-{len(self.consults)}"
        return ConsultResult(final_text=self.reply, session_id=new_sid)


@pytest.fixture()
def harness(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict:
    backend = FakeBackend("done")
    monkeypatch.setattr("knorvia.services.subagent.get_backend", lambda kind: backend)
    monkeypatch.setattr(
        "knorvia.services.subagent.list_backend_kinds",
        lambda: ["codex", "claude_code"],
    )
    settings = type("S", (), {"backend": lambda self, kind: object()})()
    monkeypatch.setattr("knorvia.services.subagent.load_subagent_settings", lambda: settings)

    # Session registry: real module but pointed at a temp file via path service?
    # Simpler: wrap remember/get with an in-memory dict through monkeypatching
    # the functions the engine imports lazily.
    import knorvia.services.subagent.sessions as sess

    store: dict[str, str] = {}
    monkeypatch.setattr(sess, "get_session", lambda key: store.get(key))
    monkeypatch.setattr(
        sess,
        "remember_session",
        lambda key, sid, **kw: store.__setitem__(key, sid),
    )

    engine = GroupChatEngine(GroupRoomStore(tmp_path / "_g"))
    return {"engine": engine, "backend": backend, "sessions": store}


def test_room_starts_empty(harness: dict) -> None:
    room = harness["engine"].create_room("空房间")
    assert room.members == []
    rooms = harness["engine"].list_rooms()
    assert rooms[0]["members"] == []


def test_add_member_requires_known_backend(harness: dict) -> None:
    engine = harness["engine"]
    room = engine.create_room("r")
    with pytest.raises(ValueError):
        engine.add_member(room.id, backend="nonexistent", connection="c1")
    seated = engine.add_member(
        room.id,
        backend="codex",
        connection="my-codex",
        display_name="研究员",
        persona="严谨、简洁",
    )
    assert seated is not None and len(seated.members) == 1
    assert seated.members[0].display_name == "研究员"
    assert seated.members[0].persona == "严谨、简洁"


def test_member_cap_and_duplicates(harness: dict) -> None:
    engine = harness["engine"]
    room = engine.create_room("r")
    for i in range(6):
        engine.add_member(room.id, backend="codex", connection=f"c{i}")
    with pytest.raises(ValueError):
        engine.add_member(room.id, backend="codex", connection="c7")
    with pytest.raises(ValueError):
        engine.add_member(room.id, backend="codex", connection="c0")


def test_update_member_is_room_local(harness: dict) -> None:
    engine = harness["engine"]
    room = engine.create_room("r")
    engine.add_member(room.id, backend="codex", connection="my-codex", display_name="旧名")
    updated = engine.update_member(room.id, "my-codex", display_name="新名", persona="幽默")
    assert updated is not None
    assert updated.members[0].display_name == "新名"
    assert updated.members[0].persona == "幽默"


def test_remove_member(harness: dict) -> None:
    engine = harness["engine"]
    room = engine.create_room("r")
    engine.add_member(room.id, backend="codex", connection="a")
    engine.add_member(room.id, backend="claude_code", connection="b")
    after = engine.remove_member(room.id, "a")
    assert [m.connection for m in after.members] == ["b"]
    assert engine.remove_member(room.id, "ghost") is None


@pytest.mark.asyncio
async def test_say_consults_backends_and_anchors_sessions(
    harness: dict,
) -> None:
    engine: GroupChatEngine = harness["engine"]
    backend = harness["backend"]
    sessions = harness["sessions"]

    room = engine.create_room("r")
    engine.add_member(room.id, backend="codex", connection="my-codex", display_name="研究员")
    await engine.send_user_message(room.id, "第一个问题")

    anchor = f"room:{room.id}::my-codex"
    # First beat: no session yet; its id got anchored to this room+member.
    assert backend.consults[0]["session_id"] is None
    first_anchored = sessions[anchor]
    assert first_anchored  # something was remembered
    # Hermes: up to 3 rounds while the member keeps speaking.
    assert len(backend.consults) == 3

    await engine.send_user_message(room.id, "第二个问题")
    assert len(backend.consults) == 6
    # Next user message resumed exactly the anchored session from beat one.
    assert backend.consults[3]["session_id"] == first_anchored


@pytest.mark.asyncio
async def test_two_rooms_never_share_sessions(harness: dict, tmp_path: Path) -> None:
    engine: GroupChatEngine = harness["engine"]

    room_a = engine.create_room("A")
    room_b = engine.create_room("B")
    engine.add_member(room_a.id, backend="codex", connection="shared-cli")
    engine.add_member(room_b.id, backend="codex", connection="shared-cli")

    await engine.send_user_message(room_a.id, "A 的问题")
    await engine.send_user_message(room_b.id, "B 的问题")

    keys = set(harness["sessions"].keys())
    assert f"room:{room_a.id}::shared-cli" in keys
    assert f"room:{room_b.id}::shared-cli" in keys
    assert len(keys) == 2, "each room must own its own CLI session"


@pytest.mark.asyncio
async def test_empty_room_rejects_say(harness: dict) -> None:
    engine = harness["engine"]
    room = engine.create_room("无人")
    with pytest.raises(ValueError):
        await engine.send_user_message(room.id, "hello?")


@pytest.mark.asyncio
async def test_mention_routes_by_display_name(harness: dict) -> None:
    engine = harness["engine"]
    backend = harness["backend"]
    room = engine.create_room("r")
    engine.add_member(room.id, backend="codex", connection="c1", display_name="研究员")
    engine.add_member(room.id, backend="claude_code", connection="c2", display_name="作家")

    result = await engine.send_user_message(room.id, "@作家 你来写")
    members_asked = [r["member"] for r in result["replies"] if r["status"] == "ok"]
    assert members_asked
    assert set(members_asked) == {"作家"}
    assert result["rounds"] == 3


@pytest.mark.asyncio
async def test_pass_settles_the_room_on_a_silent_round(harness: dict) -> None:
    engine: GroupChatEngine = harness["engine"]
    backend = harness["backend"]
    backend.reply = "PASS"
    room = engine.create_room("r")
    engine.add_member(room.id, backend="codex", connection="c1", display_name="研究员")
    result = await engine.send_user_message(room.id, "anyone?")
    assert result["settled"] == "silent"
    assert result["rounds"] == 1
    assert result["replies"][0]["status"] == "pass"
    assert all(m["sender"] == "user" for m in result["transcript"])


@pytest.mark.asyncio
async def test_at_user_sets_needs_you_and_clears_on_next_say(harness: dict) -> None:
    engine: GroupChatEngine = harness["engine"]
    backend = harness["backend"]
    backend.reply = "This needs a call @user"
    room = engine.create_room("r")
    engine.add_member(room.id, backend="codex", connection="c1", display_name="研究员")
    result = await engine.send_user_message(room.id, "ship it?")
    assert result["needs_you"] is True
    listed = engine.list_rooms()
    assert listed[0]["needs_you"] is True
    backend.reply = "PASS"
    again = await engine.send_user_message(room.id, "ship it, I confirm")
    assert again["needs_you"] is False


@pytest.mark.asyncio
async def test_member_can_pull_a_teammate_into_the_next_round(
    harness: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    from knorvia.services.subagent.types import ConsultResult

    class Scripted:
        kind = "codex"
        consults: list[str] = []

        async def consult(self, question, *, on_event, **kwargs):  # noqa: ANN003
            Scripted.consults.append(question)
            if "You are 研究员" in question:
                return ConsultResult(final_text="@作家 please draft", session_id="a")
            return ConsultResult(final_text="drafting now", session_id="b")

    monkeypatch.setattr("knorvia.services.subagent.get_backend", lambda kind: Scripted())
    engine: GroupChatEngine = harness["engine"]
    room = engine.create_room("r")
    engine.add_member(room.id, backend="codex", connection="c1", display_name="研究员")
    engine.add_member(room.id, backend="claude_code", connection="c2", display_name="作家")
    result = await engine.send_user_message(room.id, "@研究员 look")
    names = [r["member"] for r in result["replies"] if r["status"] == "ok"]
    assert "研究员" in names
    assert "作家" in names


@pytest.mark.asyncio
async def test_hard_cap_stops_a_runaway_room(harness: dict, monkeypatch: pytest.MonkeyPatch) -> None:
    from knorvia.services.partners import group_chat as gc

    monkeypatch.setattr(gc, "MAX_MESSAGES_PER_SEND", 2)
    engine: GroupChatEngine = harness["engine"]
    room = engine.create_room("r")
    engine.add_member(room.id, backend="codex", connection="c1", display_name="A")
    engine.add_member(room.id, backend="claude_code", connection="c2", display_name="B")
    result = await engine.send_user_message(room.id, "go")
    spoken = [r for r in result["replies"] if r["status"] == "ok"]
    assert len(spoken) == 2
    assert result["settled"] == "cap"
