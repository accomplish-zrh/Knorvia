"""FastAPI no longer owns Thread/Turn public control."""

from __future__ import annotations

from knorvia.api.main import app


def _paths() -> set[str]:
    found: set[str] = set()
    for route in app.routes:
        path = getattr(route, "path", "") or ""
        found.add(path)
    return found


def test_unified_ws_and_chat_are_not_mounted():
    paths = _paths()
    assert "/api/v1/ws" not in paths
    assert not any(p.startswith("/api/v1/chat") for p in paths)
    assert not any(p.rstrip("/") == "/api/v1/sessions" for p in paths)


def test_runtime_topology_names_knorvia_daemon():
    from knorvia.api.routers.system import get_runtime_topology
    import inspect

    result = inspect.getsource(get_runtime_topology)
    assert "knorvia-daemon" in result
    assert "ChatOrchestrator" not in result
