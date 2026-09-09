"""Filesystem primitives shared by the office artifact store.

Kept separate from ``store.py`` because they are the low-level guarantees the
store's invariants rest on: cross-process (and reentrant) draft locking,
atomic replace-with-fsync writes, and the identifier/name sanitizers that keep
draft paths inside their own directory.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import threading
import time
from typing import Any, Iterator
import uuid

from knorvia.services.office_artifacts.contracts import DraftStateError

DRAFT_ID_RE = re.compile(r"^[0-9a-f]{8}$")
ARTIFACT_ID_RE = re.compile(r"^[0-9a-f]{8}$")
META_NAME = "meta.json"
LOCK_NAME = "draft.lock"
SCHEMA_VERSION = 2
_LOCK_STALE_SECONDS = 30.0
_LOCK_TIMEOUT_SECONDS = 10.0

# ``_dir_lock`` is not owned by a lock file alone: a transaction may load
# metadata that migrates a v1 draft, which re-enters the same path. The depth
# map makes re-entry cheap instead of self-deadlocking.
_HELD = threading.local()


def _held_paths() -> dict[str, int]:
    held = getattr(_HELD, "paths", None)
    if held is None:
        held = {}
        _HELD.paths = held
    return held


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _unlink_quietly(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def sha256_of(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()


def safe_component(raw: str, *, default: str = "artifact") -> str:
    text = str(raw or "").strip().replace("\\", "/").split("/")[-1]
    text = text.replace(":", "_").strip("._ ") or default
    if len(text) > 120:
        stem, suffix = os.path.splitext(text)
        text = stem[: 120 - len(suffix)] + suffix
    if re.search(r"[\x00-\x1f]", text) or text in {".", ".."}:
        raise DraftStateError(f"unsafe artifact file name {raw!r}")
    return text


@contextmanager
def dir_lock(lock_path: Path) -> Iterator[None]:
    """Reentrant, cross-process mutual exclusion with stale-lock rescue."""
    key = str(Path(lock_path).resolve())
    held = _held_paths()
    depth = held.get(key, 0)
    if depth:
        held[key] = depth + 1
        try:
            yield
        finally:
            held[key] = depth
        return

    lock_path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + _LOCK_TIMEOUT_SECONDS
    handle = None
    while True:
        try:
            handle = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            break
        except FileExistsError:
            try:
                if time.time() - lock_path.stat().st_mtime > _LOCK_STALE_SECONDS:
                    lock_path.unlink(missing_ok=True)
                    continue
            except OSError:
                pass
            if time.monotonic() >= deadline:
                raise DraftStateError("another writer holds the office draft lock")
            time.sleep(0.05)
    held[key] = 1
    try:
        os.write(handle, f"{os.getpid()} {utcnow()}".encode())
        yield
    finally:
        held.pop(key, None)
        try:
            os.close(handle)
        except OSError:
            pass
        # Cleanup happens after the protected mutation. Never turn a committed
        # operation into a reported failure; stale-lock rescue removes a lock
        # file if the platform keeps it temporarily.
        _unlink_quietly(lock_path)


def _write_temp(path: Path, data: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Short random tmp name: blob file names already carry a hash, and long
    # derived names push Windows paths past MAX_PATH (260) in deep workspaces.
    tmp = path.parent / f".{uuid.uuid4().hex[:12]}.tmp"
    try:
        with open(tmp, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
    except BaseException:
        _unlink_quietly(tmp)
        raise
    return tmp


def atomic_write(path: Path, data: bytes) -> None:
    tmp = _write_temp(path, data)
    try:
        os.replace(tmp, path)
    finally:
        _unlink_quietly(tmp)


def atomic_write_exclusive(path: Path, data: bytes) -> None:
    """Publish ``data`` at ``path`` only if nothing is there.

    ``os.link`` fails with ``FileExistsError`` when the destination already
    exists, so the check and the publish are one operation instead of a
    check-then-replace window.
    """
    tmp = _write_temp(path, data)
    try:
        os.link(tmp, path)
    except FileExistsError:
        _unlink_quietly(tmp)
        raise
    except OSError:
        # Filesystems without hard links (exFAT, some network mounts): still
        # refuse to shadow, at the cost of a non-atomic final create.
        _unlink_quietly(tmp)
        try:
            handle = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            raise
        try:
            with os.fdopen(handle, "wb") as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
        except BaseException:
            _unlink_quietly(path)
            raise
        return
    _unlink_quietly(tmp)


def write_json_atomic(path: Path, payload: dict[str, Any], *, exclusive: bool = False) -> None:
    data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    if exclusive:
        atomic_write_exclusive(path, data)
    else:
        atomic_write(path, data)


def public_output_url(path: Path, public_root: Path | None) -> str:
    if public_root is None:
        return ""
    try:
        relative = Path(path).resolve().relative_to(Path(public_root).resolve())
    except ValueError:
        return ""
    return f"/api/outputs/{relative.as_posix()}"


def validate_draft_id(draft_id: str) -> str:
    value = str(draft_id or "").strip().lower()
    if not DRAFT_ID_RE.fullmatch(value):
        raise DraftStateError(f"invalid draft_id {draft_id!r}")
    return value


def validate_artifact_id(artifact_id: str) -> str:
    value = str(artifact_id or "").strip().lower()
    if not ARTIFACT_ID_RE.fullmatch(value):
        raise DraftStateError(f"invalid artifact_id {artifact_id!r}")
    return value


DRAFT_STATUSES = ("draft", "ready", "merged", "discarded")


def coerce_status(raw: Any) -> str:
    value = str(raw or "draft").strip().lower()
    return value if value in DRAFT_STATUSES else "draft"


def kind_of(filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    return {".xlsx": "xlsx", ".xlsm": "xlsx", ".docx": "docx", ".pptx": "pptx"}.get(
        suffix, "binary"
    )


def safe_under_root(root: Path, relative: str) -> Path:
    text = str(relative or "").replace("\\", "/").lstrip("/")
    if not text or ".." in Path(text).parts:
        raise DraftStateError("invalid stored draft path")
    candidate = (root / text).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise DraftStateError("stored draft path is outside the workspace") from exc
    return candidate
