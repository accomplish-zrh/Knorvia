"""Discover default Claude Code / Codex homes on this machine and import them.

The desktop app should not make the user hunt for hidden ``.claude`` / ``.codex``
folders. After they click Add agent, we look in the usual locations, list what
we found, and can parse those transcripts server-side.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
from typing import Any

_MAX_SESSIONS = 1000
_MAX_FILE_BYTES = 20 * 1024 * 1024


def discover_import_homes() -> list[dict[str, Any]]:
    homes: list[dict[str, Any]] = []
    claude = _claude_home()
    if claude is not None:
        homes.append(_home_entry("claude_code", "Claude Code", claude, _count_claude(claude)))
    codex = _codex_home()
    if codex is not None:
        homes.append(_home_entry("codex", "Codex", codex, _count_codex(codex)))
    return homes


async def import_home_async(
    source: str, *, agent_id: str = "", agent_name: str = ""
) -> dict[str, Any]:
    from knorvia.services.session import get_sqlite_session_store, make_imported_session_id

    source = (source or "").strip().lower()
    if source == "claude_code":
        root = _claude_home()
        parsed = _parse_claude_home(root) if root else []
    elif source == "codex":
        root = _codex_home()
        parsed = _parse_codex_home(root) if root else []
    else:
        raise ValueError(f"Unsupported import source: {source!r}")
    if root is None:
        raise FileNotFoundError(f"No local {source} home was found.")

    store = get_sqlite_session_store()
    imported = 0
    skipped = 0
    results: list[dict[str, Any]] = []
    label = agent_name.strip() or ("Claude Code" if source == "claude_code" else "Codex")
    aid = agent_id.strip()
    for session in parsed[:_MAX_SESSIONS]:
        messages = [m for m in session["messages"] if (m.get("content") or "").strip()]
        if not messages:
            skipped += 1
            results.append(
                {"external_id": session["external_id"], "imported": False, "reason": "empty"}
            )
            continue
        session_id = make_imported_session_id(source, session["external_id"])
        import_meta: dict[str, Any] = {
            "source": source,
            "source_cwd": session.get("source_cwd") or "",
            "external_id": session["external_id"],
        }
        if aid:
            import_meta["agent_id"] = aid
        import_meta["agent_name"] = label
        try:
            result = await store.import_session(
                session_id,
                session.get("title") or label,
                session["created_at"],
                session["updated_at"],
                {"import": import_meta},
                messages,
            )
        except Exception:
            skipped += 1
            results.append(
                {"external_id": session["external_id"], "imported": False, "reason": "error"}
            )
            continue
        if result.get("imported"):
            imported += 1
        else:
            skipped += 1
        results.append({"external_id": session["external_id"], **result})
    return {
        "imported": imported,
        "skipped": skipped,
        "sessions": results,
        "source": source,
        "path": str(root),
    }


def _home_entry(source: str, label: str, path: Path, count: int) -> dict[str, Any]:
    return {
        "source": source,
        "label": label,
        "path": str(path),
        "session_count": count,
        "available": count > 0,
    }


def _claude_home() -> Path | None:
    raw = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    path = Path(raw).expanduser() if raw else Path.home() / ".claude"
    projects = path / "projects"
    return path if projects.is_dir() else None


def _codex_home() -> Path | None:
    raw = os.environ.get("CODEX_HOME", "").strip()
    path = Path(raw).expanduser() if raw else Path.home() / ".codex"
    sessions = path / "sessions"
    return path if sessions.is_dir() else None


def _count_claude(root: Path) -> int:
    projects = root / "projects"
    if not projects.is_dir():
        return 0
    return sum(1 for path in projects.glob("*/*.jsonl") if path.is_file())


def _count_codex(root: Path) -> int:
    sessions = root / "sessions"
    if not sessions.is_dir():
        return 0
    return sum(1 for path in sessions.rglob("*.jsonl") if path.is_file())


def _parse_claude_home(root: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    projects = root / "projects"
    if not projects.is_dir():
        return out
    for file in sorted(projects.glob("*/*.jsonl")):
        if not file.is_file() or file.stat().st_size > _MAX_FILE_BYTES:
            continue
        parsed = _parse_claude_file(file)
        if parsed:
            out.append(parsed)
        if len(out) >= _MAX_SESSIONS:
            break
    return out


def _parse_codex_home(root: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    sessions = root / "sessions"
    if not sessions.is_dir():
        return out
    for file in sorted(sessions.rglob("*.jsonl")):
        if not file.is_file() or file.stat().st_size > _MAX_FILE_BYTES:
            continue
        parsed = _parse_codex_file(file)
        if parsed:
            out.append(parsed)
        if len(out) >= _MAX_SESSIONS:
            break
    return out


def _parse_claude_file(path: Path) -> dict[str, Any] | None:
    messages: list[dict[str, Any]] = []
    cwd = ""
    title = ""
    mtime = path.stat().st_mtime
    for rec in _iter_jsonl(path):
        if rec.get("type") == "ai-title" and isinstance(rec.get("aiTitle"), str):
            title = rec["aiTitle"]
            continue
        if not cwd and isinstance(rec.get("cwd"), str):
            cwd = rec["cwd"]
        msg = _claude_message(rec)
        if msg:
            messages.append(msg)
    if not messages:
        return None
    first = next((m["created_at"] for m in messages if m.get("created_at")), mtime)
    last = next((m["created_at"] for m in reversed(messages) if m.get("created_at")), mtime)
    if not title:
        title = _derive_title(messages[0]["content"])
    return {
        "external_id": path.stem,
        "title": title,
        "source_cwd": cwd,
        "created_at": first,
        "updated_at": last,
        "messages": messages,
    }


def _parse_codex_file(path: Path) -> dict[str, Any] | None:
    messages: list[dict[str, Any]] = []
    cwd = ""
    external_id = path.stem
    mtime = path.stat().st_mtime
    for rec in _iter_jsonl(path):
        if rec.get("type") == "session_meta":
            payload = rec.get("payload") if isinstance(rec.get("payload"), dict) else {}
            if payload.get("thread_source") == "subagent":
                return None
            if isinstance(payload.get("cwd"), str):
                cwd = payload["cwd"]
            if isinstance(payload.get("id"), str) and payload["id"]:
                external_id = payload["id"]
            continue
        msg = _codex_message(rec)
        if msg:
            messages.append(msg)
    if not messages:
        return None
    first = next((m["created_at"] for m in messages if m.get("created_at")), mtime)
    last = next((m["created_at"] for m in reversed(messages) if m.get("created_at")), mtime)
    return {
        "external_id": external_id,
        "title": _derive_title(messages[0]["content"]),
        "source_cwd": cwd,
        "created_at": first,
        "updated_at": last,
        "messages": messages,
    }


def _claude_message(rec: dict[str, Any]) -> dict[str, Any] | None:
    if rec.get("isSidechain") or rec.get("isMeta"):
        return None
    message = rec.get("message")
    if not isinstance(message, dict):
        return None
    role = message.get("role")
    if role not in ("user", "assistant"):
        return None
    text = _flatten_content(message.get("content"))
    if not text:
        return None
    created = _iso_to_epoch(rec.get("timestamp"))
    item: dict[str, Any] = {"role": role, "content": text}
    if created:
        item["created_at"] = created
    return item


def _codex_message(rec: dict[str, Any]) -> dict[str, Any] | None:
    if rec.get("type") != "event_msg":
        return None
    payload = rec.get("payload") if isinstance(rec.get("payload"), dict) else {}
    kind = payload.get("type")
    if kind == "user_message":
        role = "user"
    elif kind == "agent_message":
        role = "assistant"
    else:
        return None
    text = str(payload.get("message") or "").strip()
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return None
    created = _iso_to_epoch(rec.get("timestamp"))
    item: dict[str, Any] = {"role": role, "content": text}
    if created:
        item["created_at"] = created
    return item


def _flatten_content(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if (
            isinstance(block, dict)
            and block.get("type") == "text"
            and isinstance(block.get("text"), str)
        ):
            parts.append(block["text"])
    return "\n".join(parts).strip()


def _iter_jsonl(path: Path):
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if isinstance(rec, dict):
            yield rec


def _iso_to_epoch(value: Any) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    from datetime import datetime

    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _derive_title(text: str) -> str:
    line = " ".join((text or "").split())
    return line[:48] if line else ""


__all__ = ["discover_import_homes", "import_home_async"]
