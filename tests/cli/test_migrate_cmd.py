"""``knorvia migrate`` cuts the legacy chat history over with a typed report."""

from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

from knorvia.runtime.kernel_client import DaemonSession
from knorvia.services.session.sqlite_store import SQLiteSessionStore
from knorvia_cli.main import app


@pytest.fixture
def daemon_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    bin_path = Path(
        r"D:\tools\knorvia-kernel\knorvia-rs\target\debug\knorvia-daemon.exe"
    )
    if not bin_path.is_file():
        pytest.skip("knorvia-daemon binary missing")
    monkeypatch.setenv("KNORVIA_DAEMON_BIN", str(bin_path))
    home = tmp_path / "knorvia-home"
    home.mkdir()
    monkeypatch.setenv("KNORVIA_HOME", str(home))
    monkeypatch.setenv(
        "KNORVIA_DAEMON_STDERR_FILE", str(tmp_path / "daemon-stderr.log")
    )
    return home


def _seed_history(tmp_path: Path) -> Path:
    """A real legacy history: one conversation + one empty session."""
    store = SQLiteSessionStore(tmp_path / "chat_history.db")
    import asyncio

    async def seed() -> None:
        chat = await store.create_session(title="Old math chat")
        await store.add_message(
            session_id=chat["id"], role="user", content="What is 2+2?"
        )
        await store.add_message(
            session_id=chat["id"],
            role="assistant",
            content="It is 4.",
            capability="chat",
            metadata={"call_id": "c1"},
        )
        await store.create_session(title="Empty chat")

    asyncio.run(seed())
    return tmp_path / "chat_history.db"


def test_migrate_reports_typed_result(
    daemon_env: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db = _seed_history(tmp_path)
    monkeypatch.chdir(tmp_path)

    runner = CliRunner()
    result = runner.invoke(
        app,
        [
            "migrate",
            "--history-db",
            str(db),
            "--home",
            str(daemon_env),
            "--dump-dir",
            str(tmp_path / "dump"),
        ],
    )
    assert result.exit_code == 0, result.output
    assert "Migration complete." in result.output
    assert "2 sessions / 2 messages" in result.output
    assert "2 workspaces / 2 messages" in result.output

    # The migrated data is readable through the daemon.
    session = DaemonSession(daemon_env)
    try:
        workspaces = session.rpc("workspace/list", None) or []
        titles = {w["title"] for w in workspaces}
        assert "Old math chat" in titles
        assert "Empty chat" in titles
        ws = next(w for w in workspaces if w["title"] == "Old math chat")
        threads = session.rpc("thread/list", {"workspaceId": ws["id"]}) or []
        assert len(threads) == 1
        replay = session.rpc(
            "event/replay", {"streamId": threads[0]["id"], "afterSeq": 0}
        )
        message_events = [
            e for e in replay.get("events") or [] if e.get("kind") == "message"
        ]
        assert message_events[0]["payload"]["content"] == "What is 2+2?"
        assert message_events[1]["payload"]["content"] == "It is 4."
        assert message_events[1]["payload"]["metadata"]["call_id"] == "c1"
    finally:
        session.close()


def test_migrate_without_history_fails_typed(
    daemon_env: Path, tmp_path: Path
) -> None:
    runner = CliRunner()
    result = runner.invoke(
        app,
        [
            "migrate",
            "--history-db",
            str(tmp_path / "missing.db"),
            "--home",
            str(daemon_env),
            "--dump-dir",
            str(tmp_path / "dump"),
        ],
    )
    assert result.exit_code == 1
    assert "No legacy chat history found" in result.output
