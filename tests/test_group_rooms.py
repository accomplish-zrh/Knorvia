"""Group room CRUD + engine round-robin (mocked partner runners)."""

from __future__ import annotations

import os
import tempfile
from typing import Any

os.environ.setdefault("KNORVIA_HOME", tempfile.mkdtemp(prefix="grp_engine_"))

import pytest  # noqa: E402

from knorvia.services.partners.group_rooms import GroupRoomStore  # noqa: E402


def test_room_crud_roundtrip(tmp_path) -> None:
    store = GroupRoomStore(tmp_path / "_groups")
    from knorvia.services.partners.group_chat import GroupChatEngine

    engine = GroupChatEngine(store)
    room = engine.create_room("研究组", ["alpha", "beta", "ghost"])
    assert len(room.members) == 3

    rooms = engine.list_rooms()
    assert rooms[0]["name"] == "研究组"
    assert set(rooms[0]["members"]) == {"alpha", "beta", "ghost"}

    renamed = engine.rename_room(room.id, "深度组")
    assert renamed is not None and renamed.name == "深度组"

    trimmed = engine.set_members(room.id, ["alpha", "beta"])
    assert trimmed is not None and trimmed.members == ["alpha", "beta"]

    assert engine.delete_room(room.id) is True
    assert engine.get_room(room.id) is None


def test_member_count_validated() -> None:
    from knorvia.services.partners.group_chat import GroupChatEngine

    engine = GroupChatEngine(GroupRoomStore(__import__("pathlib").Path(tempfile.mkdtemp()) / "_g"))
    with pytest.raises(ValueError):
        engine.create_room("solo", ["only-one"])
    with pytest.raises(ValueError):
        engine.create_room("crowd", [f"p{i}" for i in range(7)])


@pytest.mark.asyncio
async def test_round_robin_skips_stopped_members(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    from knorvia.services.partners import group_chat
    from knorvia.services.partners.group_chat import GroupChatEngine

    class FakeRunner:
        def __init__(self, reply: str) -> None:
            self.reply = reply

        async def process_message(self, msg, **kwargs):  # noqa: ANN001, ANN003
            return self.reply

    class FakeInstance:
        def __init__(self, running: bool, reply: str = "") -> None:
            self.running = running
            self.runner = FakeRunner(reply) if running else None

            class _C:
                name = ""

            self.config = _C()

    class FakeManager:
        async def noop(self):  # pragma: no cover
            return None

        def get_partner(self, pid: str):
            return {
                "alpha": FakeInstance(True, "alpha here"),
                "beta": FakeInstance(True, "beta agrees"),
                "dead": FakeInstance(False),
            }.get(pid)

    manager = FakeManager()
    import knorvia.services.partners as partners_pkg

    monkeypatch.setattr(partners_pkg, "get_partner_manager", lambda: manager)

    engine = GroupChatEngine(GroupRoomStore(tmp_path / "_groups"))
    room = engine.create_room("warroom", ["alpha", "beta", "dead"])

    result = await engine.send_user_message(room.id, "status check")
    statuses = {r["partner"]: r["status"] for r in result["replies"]}
    assert statuses["alpha"] == "ok"
    assert statuses["beta"] == "ok"
    assert statuses["dead"] == "skipped"

    speakers = [m["sender"] for m in result["transcript"]]
    assert speakers[0] == "user"
    assert "alpha" in speakers and "beta" in speakers
