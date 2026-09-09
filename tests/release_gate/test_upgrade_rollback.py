"""REL-001 upgrade/rollback gate: a broken migration restores the prior state.

The daemon-side data-safety path: ``migration/run`` snapshots the Product
Store before importing; ``migration/rollback`` restores that snapshot. The
gate drives both through the real daemon against a layout that already
holds data, proving an upgrade whose import goes wrong (or is rolled back
deliberately) leaves the store exactly as it was before the upgrade.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

import pytest
from typer.testing import CliRunner

from knorvia.runtime.kernel_client import DaemonSession
from knorvia.services.session.legacy_export import export_legacy_dump
from knorvia.services.session.sqlite_store import SQLiteSessionStore
from knorvia_cli.main import app


@pytest.fixture
def daemon_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    bin_path = Path(
        os.environ.get(
            "KNORVIA_DAEMON_BIN",
            str(
                Path(r"D:\tools\knorvia-kernel\knorvia-rs\target\debug\knorvia-daemon.exe")
            ),
        )
    )
    if not bin_path.is_file():
        pytest.skip("knorvia-daemon binary missing")
    monkeypatch.setenv("KNORVIA_DAEMON_BIN", str(bin_path))
    home = tmp_path / "knorvia-home"
    home.mkdir()
    monkeypatch.setenv("KNORVIA_HOME", str(home))
    return home


def _seed_history(tmp_path: Path) -> Path:
    store = SQLiteSessionStore(tmp_path / "chat_history.db")

    async def seed() -> None:
        chat = await store.create_session(title="Before upgrade")
        await store.add_message(
            session_id=chat["id"], role="user", content="pre-upgrade turn"
        )
        await store.create_session(title="Second session")

    asyncio.run(seed())
    return tmp_path / "chat_history.db"


def _workspace_titles(session: DaemonSession) -> set[str]:
    return {
        w["title"]
        for w in (session.rpc("workspace/list", None) or [])
    }


def _message_events(session: DaemonSession, title: str) -> int:
    workspaces = session.rpc("workspace/list", None) or []
    ws = next(w for w in workspaces if w["title"] == title)
    threads = session.rpc("thread/list", {"workspaceId": ws["id"]}) or []
    count = 0
    for thread in threads:
        replay = session.rpc(
            "event/replay", {"streamId": thread["id"], "afterSeq": 0}
        )
        count += sum(
            1 for e in replay.get("events") or [] if e.get("kind") == "message"
        )
    return count


def test_rollback_restores_the_pre_upgrade_store(
    daemon_env: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 1. A home that already holds migrated data (the "previous install").
    db = _seed_history(tmp_path)
    monkeypatch.chdir(tmp_path)
    runner = CliRunner()
    first = runner.invoke(
        app,
        [
            "migrate",
            "--history-db",
            str(db),
            "--home",
            str(daemon_env),
            "--dump-dir",
            str(tmp_path / "dump-1"),
        ],
    )
    assert first.exit_code == 0, first.output
    first_run_id = None
    for line in first.output.splitlines():
        if "run id:" in line:
            first_run_id = line.split("run id:")[1].strip()
    assert first_run_id

    session = DaemonSession(daemon_env)
    try:
        titles_before = _workspace_titles(session)
        messages_before = _message_events(session, "Before upgrade")
        assert "Before upgrade" in titles_before
        assert messages_before >= 1

        # 2. An upgrade-style second import (a different dump with a new
        # session) — the daemon snapshots the store before touching it.
        store2 = SQLiteSessionStore(tmp_path / "history2.db")

        async def seed2() -> None:
            upgraded = await store2.create_session(title="After upgrade")
            await store2.add_message(
                session_id=upgraded["id"], role="user", content="post-upgrade turn"
            )

        asyncio.run(seed2())
        dump2 = asyncio.run(export_legacy_dump(store2, tmp_path / "dump-2"))
        second = session.rpc("migration/run", {"source": str(dump2.parent)})
        assert second["phase"] == "activated"
        assert "After upgrade" in _workspace_titles(session)

        # 3. Roll the second run back: the store returns to the pre-upgrade
        # state exactly — the added session and its messages are gone, the
        # original data intact.
        rolled = session.rpc("migration/rollback", {"id": second["id"]})
        assert rolled["phase"] == "rolled_back"
        titles_after = _workspace_titles(session)
        assert "After upgrade" not in titles_after
        assert titles_before <= titles_after
        assert _message_events(session, "Before upgrade") == messages_before
    finally:
        session.close()
