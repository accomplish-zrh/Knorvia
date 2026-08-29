"""Teammates roster: protocol section injected only when peers exist."""

from __future__ import annotations

import os
import tempfile
from unittest.mock import patch

os.environ.setdefault("KNORVIA_HOME", tempfile.mkdtemp(prefix="roster_"))

from knorvia.services.partners.runtime import PartnerRunner as PartnerRuntime  # noqa: E402


def _runtime(partner_id: str = "alpha") -> PartnerRuntime:
    # Build without starting engines: __new__ + the attrs _teammates_context reads.
    rt = PartnerRuntime.__new__(PartnerRuntime)
    rt.partner_id = partner_id
    return rt


def test_no_teammates_returns_empty() -> None:
    class EmptyManager:
        def list_partners(self):
            return [{"id": "alpha", "name": "Alpha", "running": True}]

    with patch("knorvia.services.partners.manager.get_partner_manager") as getter:
        getter.return_value = EmptyManager()
        assert _runtime("alpha")._teammates_context() == ""


def test_roster_lists_others_with_state_and_role() -> None:
    class Manager:
        def list_partners(self):
            return [
                {"id": "alpha", "name": "Alpha", "running": True},
                {
                    "id": "beta",
                    "name": "Beta",
                    "running": False,
                    "description": "research assistant",
                },
            ]

    with patch("knorvia.services.partners.manager.get_partner_manager") as getter:
        getter.return_value = Manager()
        ctx = _runtime("alpha")._teammates_context()

    assert "## Teammates" in ctx
    assert "send_partner_message" in ctx
    assert "(id: beta, stopped)" in ctx
    assert "research assistant" in ctx
    # Self is excluded.
    assert "(id: alpha" not in ctx


def test_manager_failure_degrades_to_empty() -> None:
    def boom():
        raise RuntimeError("manager down")

    with patch("knorvia.services.partners.manager.get_partner_manager", boom):
        assert _runtime("alpha")._teammates_context() == ""
