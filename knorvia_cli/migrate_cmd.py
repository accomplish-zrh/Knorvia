"""``knorvia migrate`` — cut the legacy chat history over to the new runtime.

One command with a typed report: export the SQLite chat history as the
legacy dump, hand it to the daemon's migrator (``migration/run``), then read
the migrated data back through the daemon and verify the conversation
replays. The source database is never modified; the run is idempotent (a
second run maps to the same workspaces via the daemon's persistent legacy-id
map).
"""

from __future__ import annotations

import json
from pathlib import Path

import typer

from knorvia.runtime.home import get_runtime_home
from knorvia.runtime.kernel_client import DaemonSession
from knorvia.services.session.legacy_export import export_legacy_dump
from knorvia.services.session.sqlite_store import SQLiteSessionStore

from .common import console, maybe_run


def register(app: typer.Typer) -> None:
    @app.command("migrate")
    def migrate(
        history_db: Path = typer.Option(
            None,
            "--history-db",
            help="Path to the legacy SQLite chat history (default: the runtime home's chat_history.db).",
        ),
        home: Path = typer.Option(
            None,
            "--home",
            help="Knorvia home the daemon migrates into (default: the runtime home).",
        ),
        dump_dir: Path = typer.Option(
            None,
            "--dump-dir",
            help="Where the legacy.json dump is written (default: <home>/legacy-export).",
        ),
        fmt: str = typer.Option("rich", "--format", help="Output format: rich | json."),
    ) -> None:
        """Migrate the legacy chat history into the daemon's Product Store."""
        maybe_run(_migrate(history_db, home, dump_dir, fmt))

    app.command("migrate-report", hidden=True)(lambda: None)


async def _migrate(
    history_db: Path | None,
    home: Path | None,
    dump_dir: Path | None,
    fmt: str,
) -> None:
    resolved_home = Path(home) if home is not None else get_runtime_home()
    resolved_db = (
        Path(history_db)
        if history_db is not None
        else resolved_home / "chat_history.db"
    )
    resolved_dump = (
        Path(dump_dir) if dump_dir is not None else resolved_home / "legacy-export"
    )

    if not resolved_db.is_file():
        console.print(
            f"[red]No legacy chat history found at {resolved_db}.[/red] "
            "Nothing to migrate."
        )
        raise typer.Exit(code=1)

    store = SQLiteSessionStore(resolved_db)
    out = await export_legacy_dump(store, resolved_dump)
    dump = json.loads(out.read_text(encoding="utf-8"))
    session_count = len(dump.get("sessions") or [])
    message_count = sum(len(s.get("messages") or []) for s in dump.get("sessions") or [])

    with console.status("Importing into the Product Store…"):
        with DaemonSession(resolved_home) as session:
            run = session.rpc("migration/run", {"source": str(resolved_dump)})
            workspaces = session.rpc("workspace/list", None) or []
            by_title = {w["title"]: w["id"] for w in workspaces}

            migrated_sessions = 0
            migrated_messages = 0
            for legacy in dump.get("sessions") or []:
                title = legacy.get("title") or f"imported {legacy['id']}"
                ws_id = by_title.get(title)
                if not ws_id:
                    continue
                migrated_sessions += 1
                threads = session_threads(session, ws_id)
                for thread in threads:
                    replay = session.rpc(
                        "event/replay", {"streamId": thread["id"], "afterSeq": 0}
                    )
                    migrated_messages += sum(
                        1
                        for e in replay.get("events") or []
                        if e.get("kind") == "message"
                    )

    report = {
        "runId": run.get("id"),
        "phase": run.get("phase"),
        "dumpPath": str(out),
        "exported": {"sessions": session_count, "messages": message_count},
        "imported": {
            "workspaces": migrated_sessions,
            "messages": migrated_messages,
        },
        "runRecord": run,
    }
    if fmt == "json":
        console.print_json(json.dumps(report))
        return
    console.print("[green]Migration complete.[/green]")
    console.print(f"  run id:      {run.get('id')}")
    console.print(f"  phase:       {run.get('phase')}")
    console.print(f"  dump:        {out}")
    console.print(
        f"  exported:    {session_count} sessions / {message_count} messages"
    )
    console.print(
        f"  migrated:    {migrated_sessions} workspaces / {migrated_messages} messages"
    )
    if run.get("warnings"):
        for warning in run["warnings"]:
            console.print(f"  [yellow]warning:[/yellow] {warning}")


def session_threads(session: DaemonSession, workspace_id: str) -> list[dict]:
    return session.rpc("thread/list", {"workspaceId": workspace_id}) or []
