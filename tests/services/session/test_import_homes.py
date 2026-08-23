"""Discover and import default Claude Code / Codex homes without a folder picker."""

from __future__ import annotations

import asyncio
from pathlib import Path

from knorvia.services.session.import_homes import (
    discover_import_homes,
    import_home_async,
)
from knorvia.services.session.sqlite_store import SQLiteSessionStore


def _write_claude(root: Path) -> None:
    project = root / "projects" / "demo"
    project.mkdir(parents=True)
    (project / "sess-1.jsonl").write_text(
        "\n".join(
            [
                '{"type":"user","cwd":"/demo","timestamp":"2024-01-01T00:00:00Z","message":{"role":"user","content":"hello"}}',
                '{"type":"assistant","timestamp":"2024-01-01T00:00:01Z","message":{"role":"assistant","content":"hi"}}',
            ]
        )
        + "\n",
        encoding="utf-8",
    )


def _write_codex(root: Path) -> None:
    day = root / "sessions" / "2024" / "01" / "01"
    day.mkdir(parents=True)
    (day / "roll.jsonl").write_text(
        "\n".join(
            [
                '{"type":"session_meta","timestamp":"2024-01-01T00:00:00Z","payload":{"id":"codex-1","cwd":"/proj"}}',
                '{"type":"event_msg","timestamp":"2024-01-01T00:00:01Z","payload":{"type":"user_message","message":"build it"}}',
                '{"type":"event_msg","timestamp":"2024-01-01T00:00:02Z","payload":{"type":"agent_message","message":"done"}}',
            ]
        )
        + "\n",
        encoding="utf-8",
    )


def test_discover_import_homes_empty(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "missing-claude"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "missing-codex"))
    assert discover_import_homes() == []


def test_discover_import_homes_finds_claude_and_codex(tmp_path: Path, monkeypatch) -> None:
    claude = tmp_path / "claude"
    codex = tmp_path / "codex"
    _write_claude(claude)
    _write_codex(codex)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude))
    monkeypatch.setenv("CODEX_HOME", str(codex))

    homes = {item["source"]: item for item in discover_import_homes()}
    assert homes["claude_code"]["session_count"] == 1
    assert homes["claude_code"]["available"] is True
    assert homes["claude_code"]["path"] == str(claude)
    assert homes["codex"]["session_count"] == 1
    assert homes["codex"]["available"] is True


def test_import_home_async_parses_claude(tmp_path: Path, monkeypatch) -> None:
    claude = tmp_path / "claude"
    _write_claude(claude)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(claude))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "no-codex"))
    store = SQLiteSessionStore(db_path=tmp_path / "sessions.db")
    monkeypatch.setattr(
        "knorvia.services.session.get_sqlite_session_store",
        lambda: store,
    )

    result = asyncio.run(import_home_async("claude_code", agent_name="Claude Code"))
    assert result["imported"] == 1
    assert result["skipped"] == 0
    listed = asyncio.run(store.list_imported_sessions(limit=10, offset=0))
    assert listed[0]["preferences"]["import"]["source"] == "claude_code"
    assert listed[0]["preferences"]["import"]["agent_name"] == "Claude Code"
