"""ChatOrchestrator must not be importable as a production runtime."""

from __future__ import annotations

import pytest


def test_chat_orchestrator_symbol_is_gone():
    with pytest.raises(ImportError, match="knorvia-daemon"):
        from knorvia.runtime.orchestrator import ChatOrchestrator  # noqa: F401


def test_runtime_package_does_not_export_orchestrator():
    import knorvia.runtime as runtime

    assert "ChatOrchestrator" not in getattr(runtime, "__all__", [])
    assert not hasattr(runtime, "ChatOrchestrator")
