"""create_partner / update_partner: grok-bot CreateAgent / UpdateAgent parity."""

from __future__ import annotations

import json
import os
import tempfile
from typing import Any

os.environ.setdefault("KNORVIA_HOME", tempfile.mkdtemp(prefix="partner_mgmt_"))

import pytest  # noqa: E402

from knorvia.services.partners.manager import PartnerConfig  # noqa: E402
from knorvia.tools.partner_management import (  # noqa: E402
    CreatePartnerTool,
    UpdatePartnerTool,
)


class FakeRunner:
    def __init__(self) -> None:
        self.received = []
        self.bus = type("B", (), {"published": []})()

    async def process_message(self, msg, *, delivery_meta=None):  # noqa: ANN001, ANN003
        self.received.append(msg)
        return "hi"


class FakeInstance:
    def __init__(self, pid: str, config: PartnerConfig | None = None, running: bool = True) -> None:
        self.partner_id = pid
        self.config = config or PartnerConfig(name=pid)
        self.runner = FakeRunner() if running else None
        self.running = running or self.runner is not None


class FakeManager:
    def __init__(self) -> None:
        self._partners = {
            "coordinator": FakeInstance(
                "coordinator", PartnerConfig(name="Coordinator", llm_selection="claude-sonnet")
            ),
            "luna": FakeInstance("luna", PartnerConfig(name="Luna", description="old")),
        }
        self.saved: dict[str, PartnerConfig] = {}

    def partner_exists(self, pid: str) -> bool:
        return pid in self._partners or pid in self.saved

    def get_partner(self, pid: str):
        return self._partners.get(pid)

    def load_config(self, pid: str) -> PartnerConfig | None:
        inst = self._partners.get(pid)
        return inst.config if inst else None

    def save_config(self, pid: str, config: PartnerConfig, *, auto_start=None) -> None:
        self.saved[pid] = config

    async def start_partner(self, pid: str, config=None):  # noqa: ANN001
        inst = FakeInstance(pid, config or self.load_config(pid))
        self._partners[pid] = inst
        return inst


@pytest.fixture()
def manager(monkeypatch: pytest.MonkeyPatch, tmp_path) -> FakeManager:  # noqa: ANN001
    fake = FakeManager()
    monkeypatch.setattr("knorvia.services.partners.get_partner_manager", lambda: fake)

    def _slug(name: str) -> str:
        safe = "".join(c for c in name.lower() if c.isalnum()) or "partner"
        return safe

    monkeypatch.setattr("knorvia.services.partners.slugify_partner_id", _slug)
    fake._tmp = tmp_path
    return fake


def _payload(result) -> dict:
    return json.loads(result.content)


@pytest.mark.asyncio
async def test_create_happy_path_inherits_creator_model(manager: FakeManager) -> None:
    tool = CreatePartnerTool()
    result = await tool.execute(
        name="Nova", description="finance specialist", _sender_partner_id="coordinator"
    )
    assert result.success is True
    data = _payload(result)
    assert data["id"] == "nova"

    saved = manager.saved["nova"]
    assert saved.name == "Nova"
    assert saved.description == "finance specialist"
    # Brand-new teammate inherits the creator's model so it can respond now.
    assert saved.llm_selection == "claude-sonnet"
    # Started so it can be messaged immediately.
    assert manager.get_partner("nova") is not None


@pytest.mark.asyncio
async def test_create_rejects_collision(manager: FakeManager) -> None:
    tool = CreatePartnerTool()
    result = await tool.execute(name="Coordinator", _sender_partner_id="coordinator")
    assert result.success is False
    assert "already exists" in _payload(result)["error"]


@pytest.mark.asyncio
async def test_create_requires_name(manager: FakeManager) -> None:
    result = await CreatePartnerTool().execute(name="  ", _sender_partner_id="coordinator")
    assert result.success is False


@pytest.mark.asyncio
async def test_update_merges_safely_and_refreshes_instance(manager: FakeManager) -> None:
    tool = UpdatePartnerTool()
    result = await tool.execute(
        partner_id="luna", description="senior research lead", _sender_partner_id="coordinator"
    )
    assert result.success is True
    assert _payload(result)["id"] == "luna"

    saved = manager.saved["luna"]
    assert saved.name == "Luna"  # unchanged
    assert saved.description == "senior research lead"  # only the provided field
    # Running instance sees the refresh immediately.
    assert manager.get_partner("luna").config.description == "senior research lead"


@pytest.mark.asyncio
async def test_update_requires_something(manager: FakeManager) -> None:
    result = await UpdatePartnerTool().execute(partner_id="luna", _sender_partner_id="coordinator")
    assert result.success is False


@pytest.mark.asyncio
async def test_update_unknown_partner(manager: FakeManager) -> None:
    result = await UpdatePartnerTool().execute(
        partner_id="ghost", name="X", _sender_partner_id="coordinator"
    )
    assert result.success is False
    assert "No partner found" in _payload(result)["error"]
