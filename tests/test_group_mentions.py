# -*- coding: utf-8 -*-
"""@mention routing: named members answer, others stay silent."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path
import tempfile

os.environ.setdefault("KNORVIA_HOME", tempfile.mkdtemp(prefix="grp_at_"))

import pytest  # noqa: E402

from knorvia.services.partners import group_chat  # noqa: E402
from knorvia.services.partners.group_chat import GroupChatEngine  # noqa: E402
from knorvia.services.partners.group_rooms import GroupRoomStore  # noqa: E402


class FakeRunner:
    def __init__(self, reply: str) -> None:
        self.reply = reply
        self.prompts: list[str] = []

    async def process_message(self, msg, **kwargs):  # noqa: ANN001, ANN003
        self.prompts.append(msg.content)
        return self.reply


class FakeInstance:
    def __init__(self, name: str, reply: str) -> None:
        self.running = True

        class _C:
            pass

        self.config = _C()
        self.config.name = name
        self.runner = FakeRunner(reply)


def _manager() -> object:
    instances = {
        "alpha": FakeInstance("研究员", "research done"),
        "beta": FakeInstance("写作助手", "draft ready"),
    }

    class M:
        def get_partner(self, pid: str):
            return instances.get(pid)

    return M()


@pytest.fixture()
def engine(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> GroupChatEngine:
    import knorvia.services.partners as partners_pkg

    monkeypatch.setattr(partners_pkg, "get_partner_manager", lambda: _manager())
    return GroupChatEngine(GroupRoomStore(tmp_path / "_g"))


@pytest.mark.asyncio
async def test_mention_by_display_name_routes_only_named(
    engine: GroupChatEngine,
) -> None:
    room = engine.create_room("room", ["alpha", "beta"])
    result = await engine.send_user_message(room.id, "@研究员 帮我查一下X")

    # Unnamed members are not asked at all — silence, not a skipped row.
    statuses = {r["partner"]: r["status"] for r in result["replies"]}
    assert statuses == {"alpha": "ok"}
    speakers = [m["sender"] for m in result["transcript"]]
    assert speakers == ["user", "alpha"]


@pytest.mark.asyncio
async def test_mention_by_id_also_works(engine: GroupChatEngine) -> None:
    room = engine.create_room("room", ["alpha", "beta"])
    result = await engine.send_user_message(room.id, "@beta 你来写")

    statuses = {r["partner"]: r["status"] for r in result["replies"]}
    assert statuses == {"beta": "ok"}


@pytest.mark.asyncio
async def test_two_mentions_route_both(engine: GroupChatEngine) -> None:
    room = engine.create_room("room", ["alpha", "beta"])
    result = await engine.send_user_message(room.id, "@研究员 @beta 各自准备")
    statuses = {r["partner"]: r["status"] for r in result["replies"]}
    assert statuses == {"alpha": "ok", "beta": "ok"}


@pytest.mark.asyncio
async def test_unknown_mention_falls_back_to_full_round(
    engine: GroupChatEngine,
) -> None:
    room = engine.create_room("room", ["alpha", "beta"])
    result = await engine.send_user_message(room.id, "@ghost 谁在?")
    statuses = {r["partner"]: r["status"] for r in result["replies"]}
    assert statuses == {"alpha": "ok", "beta": "ok"}


@pytest.mark.asyncio
async def test_addressed_member_gets_directive_prompt(monkeypatch, tmp_path) -> None:
    import knorvia.services.partners as partners_pkg

    manager = _manager()
    monkeypatch.setattr(partners_pkg, "get_partner_manager", lambda: manager)
    engine = GroupChatEngine(GroupRoomStore(tmp_path / "_g"))
    room = engine.create_room("room", ["alpha", "beta"])
    await engine.send_user_message(room.id, "@研究员 查X")
    alpha_prompt = manager.get_partner("alpha").runner.prompts[-1]
    assert "@addressed by name" in alpha_prompt


@pytest.mark.asyncio
async def test_no_mention_keeps_round_robin(engine: GroupChatEngine) -> None:
    room = engine.create_room("room", ["alpha", "beta"])
    result = await engine.send_user_message(room.id, "普通问题")
    statuses = {r["partner"]: r["status"] for r in result["replies"]}
    assert statuses == {"alpha": "ok", "beta": "ok"}
