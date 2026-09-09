"""Export the legacy SQLite chat history as a ``legacy.json`` migration dump.

The daemon's migrator (``knorvia_migration``) imports a ``legacy.json`` dump
into the Product Store — sessions become workspaces + threads, messages
become turn events (role/content/metadata preserved, marked ``imported``).
This module is the export side: read the real SQLite chat history the
product has been persisting all along and write the dump the migrator
consumes. The source database is never modified.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from knorvia.services.session.sqlite_store import SQLiteSessionStore

_DUMP_NAME = "legacy.json"


async def export_legacy_dump(store: SQLiteSessionStore, dest: Path) -> Path:
    """Write the migration dump for *store* to ``dest/legacy.json``.

    Returns the dump path. Sessions without messages are exported with an
    empty ``messages`` list so titles survive even for empty chats.
    """
    sessions = await store.list_sessions(limit=10000)
    dump_sessions: list[dict[str, Any]] = []
    for session in sessions:
        detail = await store.get_session_with_messages(session["id"])
        if detail is None:
            continue
        messages: list[dict[str, Any]] = []
        for message in detail.get("messages") or []:
            messages.append(
                {
                    "role": str(message.get("role") or ""),
                    "content": str(message.get("content") or ""),
                    "metadata": dict(message.get("metadata") or {}),
                }
            )
        dump_sessions.append(
            {
                "id": str(session["id"]),
                "title": str(session.get("title") or ""),
                "messages": messages,
            }
        )

    dump = {
        "sessions": dump_sessions,
        # Artifacts/jobs were never stored in the SQLite chat history (they
        # live in the daemon's Product Store already); the migrator treats
        # missing sections as empty.
        "artifacts": [],
        "jobs": [],
        "settings": {},
    }
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    out = dest / _DUMP_NAME
    out.write_text(json.dumps(dump, ensure_ascii=False, indent=2), encoding="utf-8")
    return out


__all__ = ["export_legacy_dump"]
