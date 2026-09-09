"""V2 office-artifact draft store: immutable blobs + append-only revision journal.

Layout per draft::

    office_drafts/<draft_id>/
      meta.json                     # schema_version=2, status, artifacts[]
      draft.lock
      artifacts/<artifact_id>/
        blobs/<sha256-prefix>.<ext> # content-addressed, never rewritten
        revisions/<n>.json          # one record per transaction, written once

Invariants enforced here:

- Blobs are written once (same SHA-256 is never rewritten) via a temp file
  in the same directory, verified, then ``os.replace``d.
- Every metadata mutation reads and writes ``meta.json`` while holding the
  draft lock (``_transaction``), so two concurrent writers cannot lose each
  other's change and no writer can persist a stale read.
- ``current_revision`` CAS: a commit whose ``base_revision`` is stale is
  rejected; the last writer never silently wins.
- Revision ids are monotonic and never reused (see ``revisions.py``), so
  committing after an undo adds a new record instead of overwriting the
  branch it forked away from. Dropped revisions are listed in the manifest's
  ``detached`` array; their record files stay byte-identical.
- Undo/redo move the manifest history cursor only; blobs are immutable.
- Finalizing a merge never writes outside the draft; the service resolves and
  stages destination files, this store only flips the status.
- v1 drafts (plain file lists) are migrated in place on first access.
"""

from __future__ import annotations

from contextlib import contextmanager
import json
from pathlib import Path
from typing import Any, Iterator
import uuid

from knorvia.services.office_artifacts import revisions
from knorvia.services.office_artifacts.contracts import (
    ArtifactNotFoundError,
    DraftStateError,
    RevisionConflictError,
)
from knorvia.services.office_artifacts.migration import migrate_v1_draft
from knorvia.services.office_artifacts.store_io import (
    LOCK_NAME,
    META_NAME,
    SCHEMA_VERSION,
    atomic_write,
    dir_lock,
    kind_of,
    public_output_url,
    safe_component,
    safe_under_root,
    sha256_of,
    utcnow,
    validate_artifact_id,
    validate_draft_id,
    write_json_atomic,
)

TERMINAL_STATUSES = frozenset({"merged", "discarded"})
ALLOWED_TRANSITIONS = {
    "draft": frozenset({"ready", "discarded"}),
    "ready": frozenset({"merged", "discarded"}),
    "merged": frozenset(),
    "discarded": frozenset(),
}


class OfficeArtifactStore:
    """Filesystem-backed v2 draft store scoped to one chat turn ``task_dir``."""

    def __init__(
        self,
        task_dir: Path,
        *,
        workspace_dir: Path | None = None,
        public_root: Path | None = None,
    ) -> None:
        self.task_dir = Path(task_dir).expanduser().resolve()
        self.workspace_dir = (
            Path(workspace_dir).expanduser().resolve()
            if workspace_dir is not None
            else (self.task_dir / "exec")
        )
        self.public_root = Path(public_root).expanduser().resolve() if public_root else None
        self.root = self.task_dir / "office_drafts"

    # ------------------------------------------------------------------
    # Draft lifecycle
    # ------------------------------------------------------------------

    def draft_dir(self, draft_id: str) -> Path:
        return self.root / validate_draft_id(draft_id)

    def _artifact_dir(self, draft_id: str, artifact_id: str) -> Path:
        return self.draft_dir(draft_id) / "artifacts" / validate_artifact_id(artifact_id)

    @contextmanager
    def merge_guard(self, draft_id: str) -> Iterator[None]:
        """Hold the draft lock while a merge plans and then stages its writes.

        The plan is only a snapshot for as long as nothing else can add an
        artifact, commit a revision, or finalize a second merge of the same
        draft, so plan and stage have to share one critical section.
        """
        with dir_lock(self.draft_dir(draft_id) / LOCK_NAME):
            yield

    def create_draft(self) -> str:
        draft_id = self._allocate_id()
        dest = self.draft_dir(draft_id)
        dest.mkdir(parents=True, exist_ok=True)
        meta = {
            "schema_version": SCHEMA_VERSION,
            "draft_id": draft_id,
            "status": "draft",
            "artifacts": [],
            "created_at": utcnow(),
            "updated_at": utcnow(),
        }
        with dir_lock(dest / LOCK_NAME):
            write_json_atomic(dest / META_NAME, meta)
        self._register(draft_id)
        return draft_id

    def status(self, draft_id: str) -> dict[str, Any]:
        meta = self._read_meta(draft_id)
        files = [a["filename"] for a in meta.get("artifacts") or []]
        return {
            "draft_id": meta["draft_id"],
            "status": meta["status"],
            "files": files,
            "artifacts": meta.get("artifacts") or [],
        }

    def mark_ready(self, draft_id: str) -> dict[str, Any]:
        return self._transition(draft_id, "ready")

    def discard(self, draft_id: str) -> dict[str, Any]:
        return self._transition(draft_id, "discarded")

    def assert_writable(self, draft_id: str) -> dict[str, Any]:
        """Reject writes to a draft that has already been merged or discarded."""
        meta = self._read_meta(draft_id)
        if meta["status"] in TERMINAL_STATUSES:
            raise DraftStateError(
                f"draft {draft_id} is {meta['status']}; further writes are refused."
            )
        return meta

    def assert_mergeable(self, draft_id: str) -> dict[str, Any]:
        """Fail now if this draft can never reach ``merged``.

        Callers stage real files afterwards, so the status check has to run
        before a single byte leaves the draft directory.
        """
        meta = self._read_meta(draft_id)
        self._assert_transition(meta["status"], "merged")
        return meta

    def finalize_merge(
        self, draft_id: str, published: list[dict[str, str]]
    ) -> dict[str, Any]:
        """Flip the draft to ``merged``. Destination files are the caller's job.

        ``published`` carries the name each artifact actually landed under,
        which differs from ``filename`` when a clash forced a rename, plus the
        path for a file publish (a workspace write-back lands at its resolved
        source, not in the task workspace).
        """
        landed_by_id = {item["artifact_id"]: item for item in published}
        with self._transaction(draft_id) as meta:
            self._assert_transition(meta["status"], "merged")
            meta["status"] = "merged"
            for artifact in meta.get("artifacts") or []:
                landed = landed_by_id.get(str(artifact.get("artifact_id")))
                if landed:
                    artifact["merged_as"] = landed["name"]
                    if landed.get("path"):
                        artifact["merged_path"] = str(landed["path"])
            result = {
                "draft_id": meta["draft_id"],
                "status": "merged",
                "files": [item["name"] for item in published],
                "artifacts": meta.get("artifacts") or [],
            }
        return result

    # ------------------------------------------------------------------
    # Artifacts and revisions
    # ------------------------------------------------------------------

    def add_artifact(
        self,
        draft_id: str,
        *,
        filename: str,
        mime: str,
        kind: str,
        origin_kind: str,
        origin_ref: str,
        data: bytes | None,
        origin_base_hash: str = "",
    ) -> str:
        """Register an artifact. ``data`` (the immutable base) may be None
        only when the caller immediately commits a revision on top."""
        safe_name = safe_component(filename)
        base_hash = origin_base_hash or (sha256_of(data) if data is not None else "")
        with self._transaction(draft_id) as meta:
            self._assert_writable_locked(meta, draft_id)
            manifest = self._add_artifact_locked(
                draft_id,
                meta,
                filename=safe_name,
                mime=mime,
                kind=kind,
                origin_kind=origin_kind,
                origin_ref=origin_ref,
                data=data,
                origin_base_hash=base_hash,
            )
            artifact_id = str(manifest["artifact_id"])
        if data is not None:
            self._sync_mirror(draft_id, manifest)
        return artifact_id

    def find_artifact_by_filename(self, draft_id: str, filename: str) -> str | None:
        wanted = safe_component(filename)
        for artifact in self._read_meta(draft_id).get("artifacts") or []:
            if artifact["filename"] == wanted:
                return artifact["artifact_id"]
        return None

    def manifest(self, draft_id: str, artifact_id: str) -> dict[str, Any]:
        for artifact in self._read_meta(draft_id).get("artifacts") or []:
            if artifact.get("artifact_id") == validate_artifact_id(artifact_id):
                return dict(artifact)
        raise ArtifactNotFoundError(f"artifact {artifact_id!r} not found in draft {draft_id}")

    def current_revision(self, draft_id: str, artifact_id: str) -> int:
        return int(self.manifest(draft_id, artifact_id).get("current_revision") or 0)

    def current_hash(self, draft_id: str, artifact_id: str) -> str:
        manifest = self.manifest(draft_id, artifact_id)
        return self._blob_hash_for_revision(draft_id, manifest, int(manifest["current_revision"]))

    def current_bytes(self, draft_id: str, artifact_id: str) -> bytes:
        manifest = self.manifest(draft_id, artifact_id)
        blob_hash = self._blob_hash_for_revision(
            draft_id, manifest, int(manifest["current_revision"])
        )
        return self._read_blob(draft_id, artifact_id, blob_hash, manifest["filename"])

    def revision_bytes(self, draft_id: str, artifact_id: str, revision: int) -> bytes:
        manifest = self.manifest(draft_id, artifact_id)
        blob_hash = self._blob_hash_for_revision(draft_id, manifest, int(revision))
        return self._read_blob(draft_id, artifact_id, blob_hash, manifest["filename"])

    def revision_record(self, draft_id: str, artifact_id: str, revision: int) -> dict[str, Any]:
        path = revisions.record_path(
            self.draft_dir(draft_id) / "artifacts" / validate_artifact_id(artifact_id),
            int(revision),
        )
        if not path.is_file():
            return {}
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise DraftStateError(f"revision {revision} record is corrupt") from exc
        return record if isinstance(record, dict) else {}

    def commit_revision(
        self,
        draft_id: str,
        artifact_id: str,
        *,
        new_bytes: bytes,
        base_revision: int,
        actor: str,
        operations_summary: list[str],
        diff: dict[str, Any] | None,
        verification: dict[str, Any] | None,
        calculation_required: bool = False,
    ) -> dict[str, Any]:
        """One atomic transaction: CAS check → blob → revision → manifest.

        Any failure leaves the current revision untouched.
        """
        after_hash = sha256_of(new_bytes)
        with self._transaction(draft_id) as meta:
            self._assert_writable_locked(meta, draft_id)
            artifact = self._artifact_locked(meta, artifact_id)
            current = int(artifact.get("current_revision") or 0)
            if current != int(base_revision):
                raise RevisionConflictError(
                    f"artifact {artifact_id} is at revision {current}, "
                    f"caller based the batch on {base_revision}",
                    current_revision=current,
                )
            before_hash = self._blob_hash_for_revision(draft_id, artifact, current)
            if after_hash == before_hash:
                return {
                    "artifact_id": artifact_id,
                    "revision_before": current,
                    "revision_after": current,
                    "unchanged": True,
                }
            self._write_blob(
                self._blob_dir(draft_id, artifact_id), after_hash, artifact["filename"], new_bytes
            )
            artifact_dir = self._artifact_dir(draft_id, artifact_id)
            new_revision = revisions.allocate_id(artifact, artifact_dir)
            revisions.advance(artifact, new_revision)
            record = revisions.build_record(
                revision=new_revision,
                parent=current,
                before_hash=before_hash,
                after_hash=after_hash,
                created_at=utcnow(),
                actor=actor,
                operations_summary=operations_summary,
                diff=diff,
                verification=verification,
                calculation_required=calculation_required,
            )
            try:
                write_json_atomic(
                    revisions.record_path(artifact_dir, new_revision), record, exclusive=True
                )
            except FileExistsError as exc:
                raise DraftStateError(
                    f"revision {new_revision} is already recorded for artifact {artifact_id}; "
                    "the journal was written by someone else and is never rewritten"
                ) from exc
            artifact["updated_at"] = utcnow()
        self._sync_mirror(draft_id, artifact)
        return {
            "artifact_id": artifact_id,
            "revision_before": current,
            "revision_after": new_revision,
            "unchanged": False,
        }

    def undo(self, draft_id: str, artifact_id: str) -> dict[str, Any]:
        return self._move_cursor(draft_id, artifact_id, -1)

    def redo(self, draft_id: str, artifact_id: str) -> dict[str, Any]:
        return self._move_cursor(draft_id, artifact_id, +1)

    def _move_cursor(self, draft_id: str, artifact_id: str, step: int) -> dict[str, Any]:
        with self._transaction(draft_id) as meta:
            self._assert_writable_locked(meta, draft_id)
            artifact = self._artifact_locked(meta, artifact_id)
            history = revisions.branch(artifact)
            cursor = int(artifact.get("cursor") or 0)
            target = cursor + step
            if not 0 <= target < len(history):
                raise DraftStateError(
                    f"cannot {'undo' if step < 0 else 'redo'}: history cursor at edge"
                )
            artifact["cursor"] = target
            artifact["current_revision"] = history[target]
            artifact["updated_at"] = utcnow()
        self._sync_mirror(draft_id, artifact)
        return {
            "artifact_id": artifact_id,
            "current_revision": int(artifact["current_revision"]),
            "cursor": target,
            "history_length": len(history),
        }

    # ------------------------------------------------------------------
    # Legacy-compat surface (v1-shaped helpers used by cards and facade)
    # ------------------------------------------------------------------

    def diff(self, draft_id: str) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        for artifact in self._read_meta(draft_id).get("artifacts") or []:
            name = artifact["filename"]
            draft_file = self._blob_path(
                draft_id,
                artifact["artifact_id"],
                self._blob_hash_for_revision(
                    draft_id, artifact, int(artifact.get("current_revision") or 0)
                ),
            )
            official = self.workspace_dir / name
            d_stat = draft_file.stat() if draft_file.is_file() else None
            o_stat = official.stat() if official.is_file() else None
            rows.append(
                {
                    "name": name,
                    "draft_size": int(d_stat.st_size) if d_stat else 0,
                    "official_size": int(o_stat.st_size) if o_stat else 0,
                    "exists_in_workspace": o_stat is not None,
                }
            )
        return rows

    def note_file(self, draft_id: str, relative_name: str) -> dict[str, Any]:
        """Register a file that already exists in the draft as an artifact."""
        name = safe_component(relative_name)
        candidate = self.draft_dir(draft_id) / name
        data = candidate.read_bytes() if candidate.is_file() else None
        with self._transaction(draft_id) as meta:
            self._assert_writable_locked(meta, draft_id)
            for artifact in meta.get("artifacts") or []:
                if artifact["filename"] == name:
                    return meta
            if data is None:
                return meta
            self._add_artifact_locked(
                draft_id,
                meta,
                filename=name,
                mime="",
                kind=kind_of(name),
                origin_kind="draft_file",
                origin_ref=f"draft:{name}",
                data=data,
                origin_base_hash=sha256_of(data),
            )
            return meta

    def card_payload(self, draft_id: str) -> dict[str, Any]:
        meta = self._read_meta(draft_id)
        files = self._file_entries(draft_id, meta)
        artifacts: list[dict[str, Any]] = []
        for artifact in meta.get("artifacts") or []:
            current = int(artifact.get("current_revision") or 0)
            record = self.revision_record(draft_id, artifact["artifact_id"], current)
            history = revisions.branch(artifact)
            cursor = int(artifact.get("cursor") or 0)
            artifacts.append(
                {
                    "artifact_id": artifact["artifact_id"],
                    "filename": artifact["filename"],
                    "kind": artifact.get("kind"),
                    "origin_kind": artifact.get("origin_kind"),
                    "origin_ref": artifact.get("origin_ref"),
                    "current_revision": current,
                    "current_hash": self._blob_hash_for_revision(draft_id, artifact, current),
                    "history_length": len(history),
                    "cursor": cursor,
                    "can_undo": cursor > 0,
                    "can_redo": cursor < len(history) - 1,
                    "detached_revisions": revisions.detached(artifact),
                    "last_diff": record.get("diff") if record else None,
                    "last_verification": record.get("verification") if record else None,
                    "calculation_required": bool(record.get("calculation_required"))
                    if record
                    else False,
                }
            )
        nested = {
            "draft_id": meta["draft_id"],
            "status": meta["status"],
            "files": files,
            "artifacts": artifacts,
        }
        return {
            "draft_id": meta["draft_id"],
            "draft_status": meta["status"],
            "files": files,
            "artifacts": artifacts,
            "office_draft": nested,
        }

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    @contextmanager
    def _transaction(self, draft_id: str) -> Iterator[dict[str, Any]]:
        """Hold the draft lock while reading metadata, persist it on success.

        The caller mutates the yielded dict in place; nothing is written if
        the body raises, and no metadata read escapes the lock.
        """
        meta_path = self.draft_dir(draft_id) / META_NAME
        with dir_lock(self.draft_dir(draft_id) / LOCK_NAME):
            meta = self._read_meta(draft_id)
            yield meta
            meta["updated_at"] = utcnow()
            write_json_atomic(meta_path, meta)

    def _read_meta(self, draft_id: str) -> dict[str, Any]:
        path = self.draft_dir(draft_id) / META_NAME
        if not path.is_file():
            raise ArtifactNotFoundError(f"draft {draft_id!r} not found")
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise DraftStateError(f"draft {draft_id!r} metadata is corrupt") from exc
        if not isinstance(payload, dict):
            raise DraftStateError(f"draft {draft_id!r} metadata is corrupt")
        if int(payload.get("schema_version") or 1) < SCHEMA_VERSION:
            self._migrate_v1(draft_id, payload)
            payload = json.loads(path.read_text(encoding="utf-8"))
        for artifact in payload.get("artifacts") or []:
            if isinstance(artifact, dict):
                revisions.ensure_journal(artifact)
        return payload

    def _add_artifact_locked(
        self,
        draft_id: str,
        meta: dict[str, Any],
        *,
        filename: str,
        mime: str,
        kind: str,
        origin_kind: str,
        origin_ref: str,
        data: bytes | None,
        origin_base_hash: str,
    ) -> dict[str, Any]:
        artifact_id = uuid.uuid4().hex[:8]
        if data is not None:
            self._write_blob(self._blob_dir(draft_id, artifact_id), origin_base_hash, filename, data)
        manifest: dict[str, Any] = {
            "artifact_id": artifact_id,
            "filename": filename,
            "mime": mime,
            "kind": kind,
            "origin_kind": origin_kind,
            "origin_ref": origin_ref,
            "origin_base_hash": origin_base_hash,
            "current_revision": revisions.BASE_REVISION,
            "history": [revisions.BASE_REVISION],
            "cursor": 0,
            "revision_seq": revisions.BASE_REVISION,
            "detached": [],
            "created_at": utcnow(),
            "updated_at": utcnow(),
        }
        meta["artifacts"] = [*(meta.get("artifacts") or []), manifest]
        return manifest

    def _migrate_v1(self, draft_id: str, legacy: dict[str, Any]) -> None:
        """Convert a v1 draft (flat file list) into a v2 manifest in place."""
        migrate_v1_draft(
            self.draft_dir(draft_id), draft_id, legacy, self._write_blob
        )

    def _sync_mirror(self, draft_id: str, artifact: dict[str, Any]) -> None:
        """Keep ``<draft>/<filename>`` reflecting ``artifact``'s current revision.

        Blobs are the source of truth; this derived file preserves the
        v1-era physical layout that review cards, ``/api/outputs`` URLs and
        existing consumers depend on. The revision is read off the manifest the
        caller just updated: ``meta.json`` on disk still names the previous
        revision while the enclosing transaction is open.
        """
        try:
            blob_hash = self._blob_hash_for_revision(
                draft_id, artifact, int(artifact.get("current_revision") or 0)
            )
            data = self._read_blob(
                draft_id, artifact["artifact_id"], blob_hash, artifact["filename"]
            )
            target = self.draft_dir(draft_id) / artifact["filename"]
            if target.is_file() and sha256_of(target.read_bytes()) == sha256_of(data):
                return
            atomic_write(target, data)
        except (OSError, ArtifactNotFoundError, DraftStateError):
            # The flat file is a legacy cache. Immutable blobs + meta.json are
            # authoritative, so cache refresh failure cannot uncommit or
            # misreport an otherwise successful revision.
            return

    def _blob_dir(self, draft_id: str, artifact_id: str) -> Path:
        return self.draft_dir(draft_id) / "artifacts" / validate_artifact_id(artifact_id) / "blobs"

    def _blob_path(self, draft_id: str, artifact_id: str, blob_hash: str) -> Path:
        prefix = blob_hash[:32]  # matches the truncated name _write_blob uses
        matches = sorted(self._blob_dir(draft_id, artifact_id).glob(f"{prefix}.*"))
        if matches:
            return matches[0]
        return self._blob_dir(draft_id, artifact_id) / f"{prefix}.bin"

    def _write_blob(self, blob_dir: Path, blob_hash: str, filename: str, data: bytes) -> None:
        blob_dir.mkdir(parents=True, exist_ok=True)
        suffix = Path(filename).suffix.lower() or ".bin"
        # 128-bit name prefix keeps paths short; the full hash still verifies
        # the content after every write and read.
        target = blob_dir / f"{blob_hash[:32]}{suffix}"
        if target.is_file() and sha256_of(target.read_bytes()) == blob_hash:
            return
        atomic_write(target, data)
        if sha256_of(target.read_bytes()) != blob_hash:
            raise DraftStateError("blob write verification failed")

    def _read_blob(self, draft_id: str, artifact_id: str, blob_hash: str, filename: str) -> bytes:
        path = self._blob_path(draft_id, artifact_id, blob_hash)
        if not path.is_file():
            raise ArtifactNotFoundError(f"blob {blob_hash[:12]}… is missing")
        data = path.read_bytes()
        if sha256_of(data) != blob_hash:
            raise DraftStateError("blob content hash mismatch")
        return data

    def _blob_hash_for_revision(
        self, draft_id: str, artifact: dict[str, Any], revision: int
    ) -> str:
        if int(revision) == revisions.BASE_REVISION:
            return str(artifact.get("origin_base_hash") or "")
        record = self.revision_record(draft_id, artifact["artifact_id"], int(revision))
        if not record:
            raise DraftStateError(
                f"revision {revision} is not recorded for artifact {artifact.get('artifact_id')}"
            )
        return str(record.get("after_hash") or "")

    def _transition(self, draft_id: str, target: str) -> dict[str, Any]:
        with self._transaction(draft_id) as meta:
            self._assert_transition(meta["status"], target)
            meta["status"] = target
        return self.status(draft_id)

    def _assert_transition(self, current: str, target: str) -> None:
        if target not in ALLOWED_TRANSITIONS.get(current, frozenset()):
            raise DraftStateError(
                f"cannot transition office draft from {current!r} to {target!r}"
            )

    def _assert_writable_locked(self, meta: dict[str, Any], draft_id: str) -> None:
        if meta["status"] in TERMINAL_STATUSES:
            raise DraftStateError(
                f"draft {draft_id} is {meta['status']}; further writes are refused."
            )

    def _artifact_locked(self, meta: dict[str, Any], artifact_id: str) -> dict[str, Any]:
        for artifact in meta.get("artifacts") or []:
            if artifact.get("artifact_id") == validate_artifact_id(artifact_id):
                return artifact
        raise ArtifactNotFoundError(f"artifact {artifact_id!r} not found")

    def _file_entries(self, draft_id: str, meta: dict[str, Any]) -> list[dict[str, str]]:
        status = str(meta.get("status") or "draft")
        entries: list[dict[str, str]] = []
        for artifact in meta.get("artifacts") or []:
            if status == "merged" and str(artifact.get("origin_kind") or "") == "library":
                # The bytes went back into the creative library; there is no
                # workspace file to link, and inventing one hands out a 404.
                entries.append(
                    {
                        "name": artifact["filename"],
                        "url": "",
                        "kind": "library",
                        "library_entry_id": str(
                            artifact.get("origin_ref") or ""
                        ).partition(":")[2],
                        "artifact_id": artifact["artifact_id"],
                    }
                )
                continue
            if status == "merged":
                # Prefer the path the merge wrote to; name-joined-workspace is
                # only the fallback for v1-era drafts that recorded no path at
                # all, and public_output_url fails closed for anything outside
                # the public root.
                landed = str(artifact.get("merged_path") or "")
                path = (
                    Path(landed)
                    if landed
                    else self.workspace_dir
                    / str(artifact.get("merged_as") or artifact["filename"])
                )
                name = Path(path).name
                url = public_output_url(path, self._resolved_public_root())
            else:
                name = str(artifact["filename"])
                revision = int(artifact.get("current_revision") or 0)
                url = (
                    f"/api/v1/chat/office-drafts/{draft_id}/artifacts/"
                    f"{artifact['artifact_id']}/content?revision={revision}"
                )
            entries.append(
                {
                    "name": name,
                    "url": url,
                    "kind": str(artifact.get("kind") or ""),
                    "artifact_id": artifact["artifact_id"],
                }
            )
        return entries

    def _allocate_id(self) -> str:
        for _ in range(8):
            candidate = uuid.uuid4().hex[:8]
            dest = self.root / candidate
            try:
                dest.mkdir(parents=True, exist_ok=False)
            except FileExistsError:
                continue
            return candidate
        raise DraftStateError("could not allocate a draft id")

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
        write_json_atomic(
            pointer_dir / f"{draft_id}.json",
            {
                "draft_id": draft_id,
                "task_dir": task_rel,
                "workspace_dir": workspace_rel,
            },
        )

    def _resolved_public_root(self) -> Path | None:
        if self.public_root is not None:
            return self.public_root
        try:
            from knorvia.services.path_service import get_path_service

            return get_path_service().get_public_outputs_root().resolve()
        except Exception:
            return None

    @classmethod
    def locate(
        cls,
        draft_id: str,
        *,
        public_root: Path,
        chat_root: Path | None = None,
    ) -> OfficeArtifactStore:
        """Find a draft under the current user's workspace (pointer first)."""
        draft_id = validate_draft_id(draft_id)
        public_root = Path(public_root).expanduser().resolve()
        chat_root = (
            Path(chat_root).expanduser().resolve()
            if chat_root is not None
            else (public_root / "workspace" / "chat")
        )
        pointer = chat_root / "office_drafts" / f"{draft_id}.json"
        candidates: list[tuple[Path, Path]] = []
        if pointer.is_file():
            try:
                data = json.loads(pointer.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise DraftStateError(f"draft {draft_id!r} locator is corrupt") from exc
            task_dir = safe_under_root(public_root, str(data.get("task_dir") or ""))
            workspace_raw = str(data.get("workspace_dir") or "")
            workspace_dir = (
                safe_under_root(public_root, workspace_raw)
                if workspace_raw
                else task_dir / "exec"
            )
            candidates.append((task_dir, workspace_dir))
        search_root = chat_root if chat_root.exists() else public_root
        for meta_path in search_root.glob(f"**/office_drafts/{draft_id}/{META_NAME}"):
            task_dir = meta_path.parent.parent
            try:
                task_dir.resolve().relative_to(public_root)
            except ValueError:
                continue
            candidates.append((task_dir, task_dir / "exec"))
        for task_dir, workspace_dir in candidates:
            # ``locate`` is read-only discovery: a pre-v2 draft (flat file
            # list) is still owned by the legacy store until the agent tool
            # path migrates it. Never adopt it here.
            meta_path = task_dir / "office_drafts" / draft_id / META_NAME
            if meta_path.is_file():
                try:
                    payload = json.loads(meta_path.read_text(encoding="utf-8"))
                except json.JSONDecodeError:
                    payload = {}
                if not isinstance(payload, dict) or int(payload.get("schema_version") or 1) < SCHEMA_VERSION:
                    continue
            store = cls(task_dir, workspace_dir=workspace_dir, public_root=public_root)
            try:
                store.status(draft_id)
            except ArtifactNotFoundError:
                continue
            return store
        raise ArtifactNotFoundError(f"draft {draft_id!r} not found")
