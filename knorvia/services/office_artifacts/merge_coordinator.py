"""Merge coordinator — publishes a confirmed draft, or nothing at all.

A merge is the one moment the runtime touches the outside world, so it is
staged in two phases inside a single critical section:

1. **Plan.** Every artifact's destination and conflict check is resolved
   first — draft status, library/workspace hash CAS, entry existence, and
   duplicate destinations. A plan that cannot complete raises before a single
   byte is written.
2. **Stage.** Each planned write is *re-proved* immediately before it lands:
   the destination must still hold exactly the bytes the plan saw (or still be
   absent, which is published with an exclusive create). Anything already
   written is rolled back if a later proof, write, or the status flip fails.

The draft lock is held across both phases, so no other writer can add an
artifact or commit a revision to the snapshot being published. The lock does
not cover the outside world, which is why plan-time checks are never the last
word: proof and write are one step.

Where the bytes go depends on where they came from: a library entry merges
back into the library, a workspace file over the exact file its source ref
resolved to, and everything else is published under a name that does not
shadow an unrelated file.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from knorvia.services.office_artifacts import publication
from knorvia.services.office_artifacts.addresses import non_conflicting
from knorvia.services.office_artifacts.contracts import (
    ArtifactNotFoundError,
    DraftStateError,
    MergeConflictError,
)
from knorvia.services.office_artifacts.sources import resolve_workspace_target
from knorvia.services.office_artifacts.store_io import sha256_of

RENAME_ATTEMPTS = 5


class MergeCoordinator:
    def __init__(self, store: Any, source_context: Any) -> None:
        self.store = store
        self.source_context = source_context

    def merge(self, draft_id: str) -> dict[str, Any]:
        with self.store.merge_guard(draft_id):
            return self._stage(draft_id, self._plan(draft_id))

    # ------------------------------------------------------------------
    # Phase 1: plan
    # ------------------------------------------------------------------

    def _plan(self, draft_id: str) -> list[dict[str, Any]]:
        meta = self.store.assert_mergeable(draft_id)
        workspace = self.store.workspace_dir
        workspace.mkdir(parents=True, exist_ok=True)
        plan: list[dict[str, Any]] = []
        taken: set[str] = set()
        for artifact in meta.get("artifacts") or []:
            data = self.store.current_bytes(draft_id, artifact["artifact_id"])
            origin_kind = str(artifact.get("origin_kind") or "")
            if origin_kind == "library":
                item = self._plan_library(artifact, data)
            elif origin_kind == "workspace":
                item = self._plan_workspace(artifact, data)
            else:
                # attachment / generated / draft_file: never publish over a
                # file this draft did not come from. v1_migration keeps the
                # by-name semantics of the v1 store it was migrated from.
                target = (
                    workspace / artifact["filename"]
                    if origin_kind == "v1_migration"
                    else non_conflicting(workspace, artifact["filename"])
                )
                item = self._file_item(
                    artifact, data, target, renamable=origin_kind != "v1_migration"
                )
            key = str(item.get("path") or item.get("library_entry_id") or "")
            if key in taken:
                raise DraftStateError(
                    f"two artifacts in this draft both merge to {item['name']!r}; "
                    "merge them separately"
                )
            taken.add(key)
            plan.append(item)
        return plan

    def _plan_library(self, artifact: dict[str, Any], data: bytes) -> dict[str, Any]:
        entry_id = self._library_entry_id(artifact)
        current_bytes = self._read_library_bytes(entry_id)
        if sha256_of(current_bytes) != artifact.get("origin_base_hash"):
            raise MergeConflictError(
                "the library entry changed since this draft was opened; "
                "reopen it and re-apply your changes"
            )
        return {
            "artifact_id": artifact["artifact_id"],
            "library_entry_id": entry_id,
            "data": data,
            "previous_entry_bytes": current_bytes,
            # The bytes land in the library, not the workspace: the entry keeps
            # its own name and the card must not link a workspace file.
            "name": str(artifact["filename"]),
        }

    def _plan_workspace(self, artifact: dict[str, Any], data: bytes) -> dict[str, Any]:
        target = resolve_workspace_target(
            self.source_context, str(artifact.get("origin_ref") or "")
        )
        previous = target.read_bytes()
        if sha256_of(previous) != artifact.get("origin_base_hash"):
            raise MergeConflictError(
                f"{target.name} changed since this draft was opened; "
                "reopen it and re-apply your changes"
            )
        return self._file_item(artifact, data, target)

    def _file_item(
        self,
        artifact: dict[str, Any],
        data: bytes,
        target: Path,
        *,
        renamable: bool = False,
    ) -> dict[str, Any]:
        previous = target.read_bytes() if target.is_file() else None
        return {
            "artifact_id": artifact["artifact_id"],
            "path": target,
            "data": data,
            "name": target.name,
            "publish_as": str(artifact["filename"]),
            "renamable": renamable,
            "expect_hash": sha256_of(previous) if previous is not None else "",
        }

    # ------------------------------------------------------------------
    # Phase 2: stage — prove the destination, then write it
    # ------------------------------------------------------------------

    def _stage(self, draft_id: str, plan: list[dict[str, Any]]) -> dict[str, Any]:
        undo: list[tuple[str, Any, Any]] = []
        published: list[dict[str, str]] = []
        try:
            for item in plan:
                if item.get("library_entry_id") is not None:
                    self._write_library(item, undo)
                    published.append(
                        {"artifact_id": str(item["artifact_id"]), "name": str(item["name"])}
                    )
                else:
                    self._write_file(item, undo)
                    # The path is the fact the card needs: a workspace
                    # write-back lands at its resolved source, which is not
                    # under the task workspace directory.
                    published.append(
                        {
                            "artifact_id": str(item["artifact_id"]),
                            "name": str(item["name"]),
                            "path": str(item["path"]),
                        }
                    )
            result = self.store.finalize_merge(draft_id, published)
        except Exception as exc:
            rollback_errors: list[Exception] = []
            for entry in reversed(undo):
                try:
                    self._undo(entry)
                except Exception as rollback_exc:
                    rollback_errors.append(rollback_exc)
            for rollback_exc in rollback_errors:
                exc.add_note(f"merge rollback also failed: {rollback_exc}")
            raise
        return result

    def _write_library(self, item: dict[str, Any], undo: list[tuple[str, Any, Any]]) -> None:
        entry_id = str(item["library_entry_id"])
        published_hash = sha256_of(item["data"])
        replaced = self._replace_library_bytes(
            entry_id,
            item["data"],
            expect_sha256=sha256_of(item["previous_entry_bytes"]),
        )
        if replaced is None:
            raise MergeConflictError(
                "the library entry changed while this merge was running; nothing was published"
            )
        undo.append(
            (
                "library",
                entry_id,
                (item["previous_entry_bytes"], published_hash),
            )
        )

    def _write_file(self, item: dict[str, Any], undo: list[tuple[str, Any, Any]]) -> None:
        for _ in range(RENAME_ATTEMPTS):
            path: Path = item["path"]
            expected = str(item["expect_hash"])
            if not expected:
                try:
                    receipt = publication.publish_exclusive(path, item["data"])
                except FileExistsError as exc:
                    if item["renamable"]:
                        self._relocate(item)
                        continue
                    raise MergeConflictError(
                        f"{path.name} appeared while this merge was running; nothing was published"
                    ) from exc
                undo.append(("file", receipt, None))
                return
            receipt = publication.replace_if_hash(path, item["data"], expected)
            if receipt is None:
                raise MergeConflictError(
                    f"{path.name} changed while this merge was running; nothing was published"
                )
            undo.append(("file", receipt, None))
            return
        raise MergeConflictError(
            f"could not find a free name for {item['publish_as']} in the workspace"
        )

    def _relocate(self, item: dict[str, Any]) -> None:
        """The slot the plan picked is taken now; move to a name that is free."""
        path = non_conflicting(Path(item["path"]).parent, str(item["publish_as"]))
        item["path"] = path
        item["name"] = path.name

    def _undo(self, entry: tuple[str, Any, Any]) -> None:
        kind, target, previous = entry
        if kind == "library" and previous is not None:
            old_bytes, published_hash = previous
            self._replace_library_bytes(str(target), old_bytes, expect_sha256=str(published_hash))
        elif kind == "file":
            publication.rollback(target)

    def _library_entry_id(self, artifact: dict[str, Any]) -> str:
        store = self.source_context.library_store
        if store is None:
            raise DraftStateError(
                "this draft came from the creative library but no library store is "
                "wired; refusing to merge it into the workspace instead"
            )
        return str(artifact.get("origin_ref") or "").partition(":")[2]

    def _read_library_bytes(self, entry_id: str) -> bytes:
        store = self.source_context.library_store
        current = store.entry_bytes(entry_id) if store else None
        if current is None:
            raise ArtifactNotFoundError(f"library entry {entry_id!r} no longer exists")
        return current[0]

    def _replace_library_bytes(
        self, entry_id: str, data: bytes, *, expect_sha256: str
    ) -> dict[str, Any] | None:
        store = self.source_context.library_store
        replace = getattr(store, "replace_entry_bytes", None) if store else None
        if replace is None:
            raise DraftStateError("library store does not support binary replacement")
        try:
            return replace(entry_id, data, expect_sha256=expect_sha256)
        except TypeError as exc:
            raise DraftStateError(
                "library store does not support compare-and-swap replacement"
            ) from exc
