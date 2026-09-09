"""Old Agent Runtime is not the public control plane."""

from __future__ import annotations

import pytest

from knorvia.api.main import app


def test_chat_orchestrator_import_fails():
    with pytest.raises(ImportError, match="knorvia-daemon"):
        from knorvia.runtime.orchestrator import ChatOrchestrator  # noqa: F401


def test_fastapi_does_not_mount_thread_turn_or_sessions():
    paths = {getattr(route, "path", "") for route in app.routes}
    assert "/api/v1/ws" not in paths
    assert not any(p.startswith("/api/v1/chat") for p in paths)
    assert "/api/v1/sessions" not in paths


def test_core_package_does_not_export_streambus_as_public_protocol():
    import knorvia.core as core

    assert "StreamBus" not in core.__all__
    assert "StreamEvent" not in core.__all__


def test_runtime_topology_is_knorvia_daemon():
    import inspect

    from knorvia.api.routers.system import get_runtime_topology

    src = inspect.getsource(get_runtime_topology)
    assert "knorvia-daemon" in src
    assert "ChatOrchestrator" not in src
