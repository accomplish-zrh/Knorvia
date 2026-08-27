"""Isolated office-draft store for chat authoring.

Agent writes land under ``<task_dir>/office_drafts/<draft_id>/`` until the
user (or a ``draft_action``) merges them onto the turn's official workspace
path (typically ``<task_dir>/exec/``). Status machine:

    draft -> ready -> merged | discarded
    draft -> discarded

``draft -> merged`` is illegal. Terminal states refuse further writes.
"""

from __future__ import annotations

from collections.abc import Sequence
import json
from pathlib import Path
import re
import shutil
from typing import Any, Literal
import uuid

DraftStatus = Literal["draft", "ready", "merged", "discarded"]

DRAFT_STATUSES: tuple[DraftStatus, ...] = ("draft", "ready", "merged", "discarded")
TERMINAL_STATUSES: frozenset[str] = frozenset({"merged", "discarded"})
ALLOWED_TRANSITIONS: dict[str, frozenset[str]] = {
    "draft": frozenset({"ready", "discarded"}),
    "ready": frozenset({"merged", "discarded"}),
    "merged": frozenset(),
    "discarded": frozenset(),
}
DRAFT_ID_RE = re.compile(r"^[0-9a-f]{8}$")
_META_NAME = "meta.json"
_OUTPUTS_PREFIX = "/api/outputs/"


class DraftError(ValueError):
    """Base error for office-draft operations."""


class DraftNotFoundError(DraftError):
    """The requested ``draft_id`` does not exist in this workspace."""


class DraftTransitionError(DraftError):
    """Caller requested a status change the state machine forbids."""


def validate_draft_id(draft_id: str) -> str:
    """Return ``draft_id`` if it is an 8-char hex token, else raise."""
    value = str(draft_id or "").strip().lower()
    if not DRAFT_ID_RE.fullmatch(value):
        raise DraftError(f"invalid draft_id {draft_id!r}")
    return value


def public_output_url(path: Path, public_root: Path | None) -> str:
    """Map a workspace file to the ``/api/outputs/...`` URL, or ``""``."""
    if public_root is None:
        return ""
    try:
        relative = path.resolve().relative_to(Path(public_root).resolve())
    except ValueError:
        return ""
    return f"{_OUTPUTS_PREFIX}{relative.as_posix()}"


class OfficeDraftStore:
    """Filesystem-backed draft store scoped to one chat turn ``task_dir``."""

    def __init__(
        self,
        task_dir: Path,
        *,
        workspace_dir: Path | None = None,
        public_root: Path | None = None,
    ) -> None:
        """Bind the store to a turn directory.

        Args:
            task_dir: Turn workspace (``PathService.get_task_workspace``).
            workspace_dir: Official output dir that ``merge`` copies into.
                Defaults to ``<task_dir>/exec``.
            public_root: User data root used to build ``/api/outputs`` URLs
                and the cross-turn locator pointer. Optional in unit tests.
        """
        self.task_dir = Path(task_dir).expanduser().resolve()
        self.workspace_dir = (
            Path(workspace_dir).expanduser().resolve()
            if workspace_dir is not None
            else (self.task_dir / "exec")
        )
        self.public_root = Path(public_root).expanduser().resolve() if public_root else None
        self.root = self.task_dir / "office_drafts"

    def draft_dir(self, draft_id: str) -> Path:
        """Return the directory that holds one draft's files."""
        return self.root / validate_draft_id(draft_id)

    def create(self, files: Sequence[str] | None = None) -> str:
        """Create a new draft (status ``draft``) and return its 8-char id.

        ``files`` are optional relative names; any that already exist in the
        official workspace are copied into the draft so the agent can edit
        them in isolation.
        """
        draft_id = self._allocate_id()
        dest = self.draft_dir(draft_id)
        dest.mkdir(parents=True, exist_ok=True)
        recorded: list[str] = []
        for raw in files or ():
            name = _safe_relative_name(raw)
            src = self.workspace_dir / name
            target = dest / name
            if src.is_file():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, target)
            recorded.append(name)
        self._write_meta(
            draft_id,
            {
                "draft_id": draft_id,
                "status": "draft",
                "files": recorded,
            },
        )
        self._register(draft_id)
        return draft_id

    def mark_ready(self, draft_id: str) -> dict[str, Any]:
        """Transition ``draft -> ready`` so the user can confirm a merge."""
        return self._transition(draft_id, "ready")

    def merge(self, draft_id: str) -> dict[str, Any]:
        """Copy draft files over the official workspace and mark ``merged``.

        Only legal from ``ready``. Existing official files with the same
        relative names are overwritten.
        """
        meta = self.status(draft_id)
        self._assert_transition(meta["status"], "merged")
        draft_root = self.draft_dir(draft_id)
        self.workspace_dir.mkdir(parents=True, exist_ok=True)
        names = self._scan_files(draft_id) or list(meta.get("files") or [])
        for name in names:
            src = draft_root / name
            if not src.is_file():
                continue
            dest = self.workspace_dir / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
        meta["files"] = names
        meta["status"] = "merged"
        self._write_meta(draft_id, meta)
        return dict(meta)

    def discard(self, draft_id: str) -> dict[str, Any]:
        """Abandon a non-terminal draft (``draft|ready -> discarded``)."""
        return self._transition(draft_id, "discarded")

    def status(self, draft_id: str) -> dict[str, Any]:
        """Return the persisted metadata dict for ``draft_id``.

        Unknown ids raise :class:`DraftNotFoundError`. File names are
        refreshed from the directory so a write that forgot ``note_file``
        still surfaces on the review card.
        """
        meta_path = self.draft_dir(draft_id) / _META_NAME
        if not meta_path.is_file():
            raise DraftNotFoundError(f"draft {draft_id!r} not found")
        try:
            payload = json.loads(meta_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise DraftError(f"draft {draft_id!r} metadata is corrupt") from exc
        if not isinstance(payload, dict):
            raise DraftError(f"draft {draft_id!r} metadata is corrupt")
        scanned = self._scan_files(draft_id)
        if scanned:
            payload["files"] = scanned
        payload["draft_id"] = validate_draft_id(draft_id)
        payload["status"] = _coerce_status(payload.get("status"))
        return payload

    def diff(self, draft_id: str) -> list[dict[str, Any]]:
        """Simple size/mtime listing of draft files vs official copies."""
        rows: list[dict[str, Any]] = []
        for name in self.status(draft_id).get("files") or []:
            if not isinstance(name, str):
                continue
            draft_file = self.draft_dir(draft_id) / name
            official = self.workspace_dir / name
            d_stat = draft_file.stat() if draft_file.is_file() else None
            o_stat = official.stat() if official.is_file() else None
            rows.append(
                {
                    "name": name,
                    "draft_size": int(d_stat.st_size) if d_stat else 0,
                    "draft_mtime": float(d_stat.st_mtime) if d_stat else 0.0,
                    "official_size": int(o_stat.st_size) if o_stat else 0,
                    "official_mtime": float(o_stat.st_mtime) if o_stat else 0.0,
                    "exists_in_workspace": o_stat is not None,
                }
            )
        return rows

    def note_file(self, draft_id: str, relative_name: str) -> dict[str, Any]:
        """Record that ``relative_name`` now exists inside the draft."""
        meta = self.status(draft_id)
        if meta["status"] in TERMINAL_STATUSES:
            raise DraftTransitionError(
                f"draft {draft_id} is {meta['status']}; further writes are refused."
            )
        name = _safe_relative_name(relative_name)
        files = [str(item) for item in meta.get("files") or [] if isinstance(item, str)]
        if name not in files:
            files.append(name)
            meta["files"] = files
            self._write_meta(draft_id, meta)
        return meta

    def assert_writable(self, draft_id: str) -> dict[str, Any]:
        """Raise if ``draft_id`` is missing or in a terminal status."""
        meta = self.status(draft_id)
        if meta["status"] in TERMINAL_STATUSES:
            raise DraftTransitionError(
                f"draft {draft_id} is {meta['status']}; further writes are refused."
            )
        return meta

    def card_payload(self, draft_id: str) -> dict[str, Any]:
        """Metadata envelope streamed to the frontend review card."""
        meta = self.status(draft_id)
        files = self._file_entries(draft_id, meta)
        nested = {
            "draft_id": meta["draft_id"],
            "status": meta["status"],
            "files": files,
        }
        return {
            "draft_id": meta["draft_id"],
            "draft_status": meta["status"],
            "files": files,
            "office_draft": nested,
        }

    @classmethod
    def locate(
        cls,
        draft_id: str,
        *,
        public_root: Path,
        chat_root: Path | None = None,
    ) -> OfficeDraftStore:
        """Find a draft by id under the current user's workspace.

        Prefers the registry pointer at ``<chat_root>/office_drafts/<id>.json``
        and falls back to a bounded glob under ``chat_root``.
        """
        draft_id = validate_draft_id(draft_id)
        public_root = Path(public_root).expanduser().resolve()
        chat_root = (
            Path(chat_root).expanduser().resolve()
            if chat_root is not None
            else (public_root / "workspace" / "chat")
        )
        pointer = chat_root / "office_drafts" / f"{draft_id}.json"
        if pointer.is_file():
            try:
                data = json.loads(pointer.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise DraftError(f"draft {draft_id!r} locator is corrupt") from exc
            if not isinstance(data, dict):
                raise DraftError(f"draft {draft_id!r} locator is corrupt")
            task_dir = _safe_under_root(public_root, str(data.get("task_dir") or ""))
            workspace_raw = str(data.get("workspace_dir") or "")
            workspace_dir = (
                _safe_under_root(public_root, workspace_raw)
                if workspace_raw
                else task_dir / "exec"
            )
            store = cls(task_dir, workspace_dir=workspace_dir, public_root=public_root)
            store.status(draft_id)
            return store
        pattern = f"**/office_drafts/{draft_id}/{_META_NAME}"
        search_root = chat_root if chat_root.exists() else public_root
        for meta_path in search_root.glob(pattern):
            task_dir = meta_path.parent.parent
            try:
                task_dir.resolve().relative_to(public_root)
            except ValueError:
                continue
            store = cls(task_dir, public_root=public_root)
            store.status(draft_id)
            return store
        raise DraftNotFoundError(f"draft {draft_id!r} not found")

    def _allocate_id(self) -> str:
        for _ in range(8):
            candidate = uuid.uuid4().hex[:8]
            dest = self.root / candidate
            try:
                dest.mkdir(parents=True, exist_ok=False)
            except FileExistsError:
                continue
            return candidate
        raise DraftError("could not allocate a draft id")

    def _transition(self, draft_id: str, target: DraftStatus) -> dict[str, Any]:
        meta = self.status(draft_id)
        self._assert_transition(meta["status"], target)
        meta["status"] = target
        self._write_meta(draft_id, meta)
        return dict(meta)

    def _assert_transition(self, current: str, target: str) -> None:
        allowed = ALLOWED_TRANSITIONS.get(current, frozenset())
        if target not in allowed:
            raise DraftTransitionError(
                f"cannot transition office draft from {current!r} to {target!r}"
            )

    def _scan_files(self, draft_id: str) -> list[str]:
        root = self.draft_dir(draft_id)
        if not root.is_dir():
            return []
        names: list[str] = []
        for path in sorted(root.rglob("*")):
            if not path.is_file() or path.name == _META_NAME:
                continue
            names.append(path.relative_to(root).as_posix())
        return names

    def _file_entries(self, draft_id: str, meta: dict[str, Any]) -> list[dict[str, str]]:
        status = str(meta.get("status") or "draft")
        names = [str(name) for name in meta.get("files") or [] if isinstance(name, str)]
        entries: list[dict[str, str]] = []
        for name in names:
            path = (
                (self.workspace_dir / name)
                if status == "merged"
                else (self.draft_dir(draft_id) / name)
            )
            entries.append(
                {
                    "name": name,
                    "url": public_output_url(path, self._resolved_public_root()),
                }
            )
        return entries

    def _write_meta(self, draft_id: str, meta: dict[str, Any]) -> None:
        dest = self.draft_dir(draft_id)
        dest.mkdir(parents=True, exist_ok=True)
        payload = {
            "draft_id": validate_draft_id(draft_id),
            "status": _coerce_status(meta.get("status")),
            "files": [str(name) for name in meta.get("files") or [] if isinstance(name, str)],
        }
        (dest / _META_NAME).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def _register(self, draft_id: str) -> None:
        public_root = self._resolved_public_root()
        if public_root is None:
            return
        try:
            task_rel = self.task_dir.relative_to(public_root).as_posix()
            workspace_rel = self.workspace_dir.relative_to(public_root).as_posix()
        except ValueError:
            return
        pointer_dir = public_root / "workspace" / "chat" / "office_drafts"
        pointer_dir.mkdir(parents=True, exist_ok=True)
        (pointer_dir / f"{draft_id}.json").write_text(
            json.dumps(
                {
                    "draft_id": draft_id,
                    "task_dir": task_rel,
                    "workspace_dir": workspace_rel,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    def _resolved_public_root(self) -> Path | None:
        if self.public_root is not None:
            return self.public_root
        try:
            from knorvia.services.path_service import get_path_service

            return get_path_service().get_public_outputs_root().resolve()
        except Exception:
            return None


def _coerce_status(raw: Any) -> DraftStatus:
    value = str(raw or "draft").strip().lower()
    if value in DRAFT_STATUSES:
        return value  # type: ignore[return-value]
    return "draft"


def _safe_relative_name(raw: str) -> str:
    text = str(raw or "").strip().replace("\\", "/")
    if not text or text.startswith("/") or ".." in Path(text).parts:
        raise DraftError(f"invalid draft file name {raw!r}")
    return text.lstrip("./")


def _safe_under_root(root: Path, relative: str) -> Path:
    text = str(relative or "").replace("\\", "/").lstrip("/")
    if not text or ".." in Path(text).parts:
        raise DraftError("invalid stored draft path")
    candidate = (root / text).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise DraftError("stored draft path is outside the workspace") from exc
    return candidate
