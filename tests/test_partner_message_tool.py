"""send_partner_message: async bot-to-bot DM (grok-bot SendToAgent parity).

Delivery is asynchronous: calling the tool returns an ack immediately, the
target processes the message on its own turn, and the reply is re-injected
into the sender's bus as a fresh ``[agent]``-framed wake. Caller identity is
stamped server-side into the call kwargs (``_sender_partner_id`` /
``_sender_name``), mirroring how the pipeline augments them.
"""

from __future__ import annotations

import asyncio
import json
import os
import tempfile
from typing import Any

os.environ.setdefault("KNORVIA_HOME", tempfile.mkdtemp(prefix="partner_dm_"))

import pytest  # noqa: E402

from knorvia.tools.partner_message import PartnerMessageTool  # noqa: E402


class FakeBus:
    """Stand-in for MessageBus: records every inbound published for a partner."""

    def __init__(self) -> None:
        self.published: list[Any] = []

    async def publish_inbound(self, msg) -> None:
        self.published.append(msg)


class FakeRunner:
    def __init__(self, partner_id: str, reply: str = "On it.") -> None:
        self.partner_id = partner_id
        self.reply = reply
        self.received: list[Any] = []
        self.bus = FakeBus()

    async def process_message(self, msg, *, delivery_meta=None):  # noqa: ANN001, ANN003
        self.received.append(msg)
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
            "coordinator": FakeInstance("coordinator", FakeRunner("coordinator")),
            "beta": FakeInstance("beta", None),  # stopped
        }

    def get_partner(self, partner_id: str):
        return self._partners.get(partner_id)

    def list_partners(self):
        return [
            {"id": "alpha", "name": "Alpha"},
            {"id": "coordinator", "name": "Coordinator"},
            {"id": "beta", "name": "Beta"},
        ]


@pytest.fixture()
def fake_manager(monkeypatch: pytest.MonkeyPatch) -> FakeManager:
    fake = FakeManager()
    monkeypatch.setattr("knorvia.services.partners.get_partner_manager", lambda: fake)
    return fake


@pytest.fixture()
def tool() -> PartnerMessageTool:
    return PartnerMessageTool()


def _payload(result) -> dict:
    return json.loads(result.content)


def _send(tool: PartnerMessageTool, *args, **kwargs):
    """Call execute with the server-stamped sender context (production path)."""
    kwargs.setdefault("_sender_partner_id", "coordinator")
    kwargs.setdefault("_sender_name", "Coordinator")
    return tool.execute(*args, **kwargs)


@pytest.mark.asyncio
async def test_send_acks_immediately_and_target_receives_botdm(
    tool: PartnerMessageTool, fake_manager: FakeManager
) -> None:
    alpha = fake_manager.get_partner("alpha")
    result = await _send(tool, partner_id="alpha", message="gather sources on X")
    data = _payload(result)
    assert result.success is True
    assert data["sent_to"] == "alpha"
    assert data["status"] == "sent"

    # Let the fire-and-forget delivery task run (several loop iterations —
    # the reply wake is a second nested task hop), then check the target got a
    # dedicated botdm session (a human thread, not an existing one).
    for _ in range(5):
        await asyncio.sleep(0)
    assert alpha.runner.received
    record = alpha.runner.received[0]
    assert record.channel == "botdm"
    assert record.content == "gather sources on X"
    assert record.sender_id == "coordinator"
    assert record.session_key.startswith("botdm:coordinator:")


@pytest.mark.asyncio
async def test_reply_comes_back_as_wake_to_sender(
    tool: PartnerMessageTool, fake_manager: FakeManager
) -> None:
    coordinator = fake_manager.get_partner("coordinator")
    await _send(tool, partner_id="alpha", message="gather sources on X")
    for _ in range(5):
        await asyncio.sleep(0)

    assert len(coordinator.runner.bus.published) == 1
    wake = coordinator.runner.bus.published[0]
    assert wake.channel == "botdm"
    assert wake.sender_id == "alpha"
    assert wake.content == "research done"
    assert wake.session_key.startswith("botdm:coordinator:")


@pytest.mark.asyncio
async def test_priority_and_images_are_carried(
    tool: PartnerMessageTool, fake_manager: FakeManager
) -> None:
    alpha = fake_manager.get_partner("alpha")
    await _send(
        tool,
        partner_id="alpha",
        message="STOP that",
        priority=True,
        images=[{"url": "https://example.com/high.png"}, "file:///tmp/plan.txt"],
    )
    for _ in range(5):
        await asyncio.sleep(0)
    record = alpha.runner.received[0]
    assert record.metadata.get("_bot_dm_priority") is True
    assert record.metadata.get("_bot_dm_images") == [
        "https://example.com/high.png",
        "file:///tmp/plan.txt",
    ]


@pytest.mark.asyncio
async def test_stopped_partner_returns_typed_error(
    tool: PartnerMessageTool, fake_manager: FakeManager
) -> None:
    result = await _send(tool, partner_id="beta", message="hello?")
    data = _payload(result)
    assert result.success is False
    assert "not running" in data["error"]


@pytest.mark.asyncio
async def test_unknown_partner_lists_known_ids(
    tool: PartnerMessageTool, fake_manager: FakeManager
) -> None:
    result = await _send(tool, partner_id="ghost", message="hi")
    data = _payload(result)
    assert result.success is False
    assert sorted(data["known_partners"]) == ["alpha", "beta", "coordinator"]


@pytest.mark.asyncio
async def test_self_send_blocked(tool: PartnerMessageTool, fake_manager: FakeManager) -> None:
    result = await _send(
        tool, partner_id="alpha", message="echo", _sender_partner_id="alpha", _sender_name="Alpha"
    )
    assert result.success is False


@pytest.mark.asyncio
async def test_missing_args_rejected(tool: PartnerMessageTool) -> None:
    result = await _send(tool, partner_id="", message="")
    assert result.success is False
