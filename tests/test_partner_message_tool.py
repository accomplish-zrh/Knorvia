"""send_partner_message: bot-to-bot DM end to end (Hermes bot-mode parity)."""

from __future__ import annotations

import json
import os
import tempfile
from typing import Any

os.environ.setdefault("KNORVIA_HOME", tempfile.mkdtemp(prefix="partner_dm_"))

import pytest  # noqa: E402

from knorvia.tools.partner_message import PartnerMessageTool  # noqa: E402


class FakeRunner:
    def __init__(self, partner_id: str, reply: str = "On it.") -> None:
        self.partner_id = partner_id
        self.reply = reply
        self.received: list[dict[str, Any]] = []

    async def process_message(self, msg, *, delivery_meta=None):  # noqa: ANN001, ANN003
        self.received.append(
            {
                "channel": msg.channel,
                "content": msg.content,
                "session_key": msg.session_key,
                "sender": msg.sender_id,
            }
        )
        return self.reply


class FakeInstance:
    def __init__(self, partner_id: str, runner: FakeRunner | None) -> None:
        self.partner_id = partner_id
        self.runner = runner
        self.running = runner is not None


class FakeManager:
    def __init__(self) -> None:
        self._partners = {
            "alpha": FakeInstance("alpha", FakeRunner("alpha", "research done")),
            "beta": FakeInstance("beta", None),  # stopped
        }

    def get_partner(self, partner_id: str):
        return self._partners.get(partner_id)

    def list_partners(self):
        return [{"id": pid} for pid in self._partners]


@pytest.fixture()
def tool(monkeypatch: pytest.MonkeyPatch) -> PartnerMessageTool:
    tool = PartnerMessageTool()
    monkeypatch.setattr(tool, "_sender_partner_id", "coordinator", raising=False)
    monkeypatch.setattr(
        "knorvia.services.partners.get_partner_manager", lambda: FakeManager()
    )
    return tool


def _payload(result) -> dict:
    return json.loads(result.content)


@pytest.mark.asyncio
async def test_dm_delivers_and_returns_reply(tool: PartnerMessageTool) -> None:
    result = await tool.execute(partner_id="alpha", message="gather sources on X")
    data = _payload(result)
    assert data["from"] == "alpha"
    assert data["reply"] == "research done"
    # The target got a dedicated botdm session, not a human thread.
    assert data["session_key"].startswith("botdm:coordinator:")


@pytest.mark.asyncio
async def test_stopped_partner_returns_typed_error(tool: PartnerMessageTool) -> None:
    result = await tool.execute(partner_id="beta", message="hello?")
    data = _payload(result)
    assert result.success is False
    assert "not running" in data["error"]


@pytest.mark.asyncio
async def test_unknown_partner_lists_known_ids(tool: PartnerMessageTool) -> None:
    result = await tool.execute(partner_id="ghost", message="hi")
    data = _payload(result)
    assert result.success is False
    assert sorted(data["known_partners"]) == ["alpha", "beta"]


@pytest.mark.asyncio
async def test_self_send_blocked(monkeypatch: pytest.MonkeyPatch) -> None:
    tool = PartnerMessageTool()
    monkeypatch.setattr(tool, "_sender_partner_id", "alpha", raising=False)
    monkeypatch.setattr(
        "knorvia.services.partners.get_partner_manager", lambda: FakeManager()
    )
    result = await tool.execute(partner_id="alpha", message="echo")
    assert result.success is False


@pytest.mark.asyncio
async def test_missing_args_rejected(tool: PartnerMessageTool) -> None:
    result = await tool.execute(partner_id="", message="")
    assert result.success is False
