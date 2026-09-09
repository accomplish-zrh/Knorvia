# Office Artifact Runtime (v2)

The Office capability is a strict, agent-native artifact runtime with XLSX as
the first complete vertical slice. Agents and humans edit through the **same**
typed operation protocol and write service; nothing ever rewrites an imported
workbook wholesale.

This document covers the module boundaries and the invariants that keep them
honest. The user-visible capability spec is `SPEC-office-capability.md`.

## Core principles

1. **One protocol for everyone.** The agent (`office_apply` tool) and the human
   save path (frontend editor) both send the same operation batches to
   `OfficeArtifactService.apply_operations()`.
2. **CAS on every mutation.** Each batch carries `base_revision`; the store
   rejects stale bases with `RevisionConflictError` (HTTP 409). The last
   writer never silently wins.
3. **Atomic transactions in isolated drafts.** Work happens in a draft under
   `office_drafts/<draft_id>/`; nothing leaves the draft until the user
   confirms a merge.
4. **Semantic diffs.** Every revision stores a per-operation diff (`DiffEntry`
   list), not a byte delta.
5. **Append-only revision journal.** Revision ids come from a per-artifact
   monotonic counter and are never reused, so committing after an undo writes
   a **new** record instead of overwriting the branch it forked away from.
   The counter also counts the record files already on disk: when a
   transaction's manifest write is lost, the retry allocates past that orphan
   instead of rewriting it, and record files are written exclusively, so a
   record is created once and never modified. Which revisions were dropped is
   manifest state (`detached`).
6. **Fail closed.** Operations that cannot be proven safe, correct, or
   format-faithful are rejected with a typed error; they are never
   approximated. This covers the frozen selection too: an operation whose
   target cannot be audited is refused rather than allowed.
7. **Pre-commit verification.** A revision only advances after the candidate
   file (a) reopens under openpyxl, (b) reads back the exact targeted cells,
   (c) has valid ZIP structure **and** no dangling package relationship or
   content-type override, and (d) leaves every untouched OOXML part
   byte-identical (`VerificationSummary`).
8. **A merge publishes completely or not at all.** The draft lock is held from
   plan through stage, so the snapshot being published cannot move underneath
   it. Library updates use a SQLite-serialized hash CAS; filesystem updates use
   a per-destination cross-process lock around proof + atomic publish (or an
   exclusive create). Every successful write returns a receipt, and rollback
   restores it only while the destination still contains that exact published
   hash, so a later writer is never erased.
9. **Metadata is the commit point.** Immutable blobs plus `meta.json` are the
   source of truth. The old flat `<draft>/<filename>` mirror is a best-effort
   compatibility cache refreshed only after metadata commits; review previews
   read the revisioned artifact endpoint directly. A failed cache refresh can
   neither uncommit a revision nor expose an uncommitted one.

## Module map (`knorvia/services/office_artifacts/`)

| Module                  | Role                                                                 |
| ----------------------- | -------------------------------------------------------------------- |
| `contracts.py`          | Typed op models (Pydantic, `extra="forbid"`), limits, errors, ranges  |
| `sources.py`            | Opaque source refs (`attachment:`, `library:`, `workspace:`, `generated:new`) and ZIP/OOXML safety screening |
| `store_io.py`           | Filesystem primitives: reentrant draft lock, atomic and exclusive writes, id/name sanitizers |
| `store.py`              | Draft lifecycle, artifacts, content-addressed blobs, CAS commit, undo/redo cursors, v1→v2 migration |
| `revisions.py`          | Append-only revision journal: id allocation, branch/detached bookkeeping, record shape |
| `publication.py`        | Per-destination publication lock, file CAS, and conditional rollback receipts |
| `merge_coordinator.py`  | Publish under one lock: plan every destination and conflict, then prove and write each one, with rollback |
| `addresses.py`          | "Which cells does this touch?" — snapshots, diff bounds, selection checks |
| `diff.py`               | Semantic diff construction                                            |
| `verification.py`       | Reopen / read-back / ZIP / package-relations / untouched-parts checks |
| `adapters/`             | `xlsx_adapter` (narrow lxml patching for imports; openpyxl only for generated workbooks and reads), `xlsx_reader` (read model), `generated_docx`, `generated_pptx`, `univer_container` |
| `service.py`            | Orchestration: open / read / apply / undo / redo / merge lifecycle    |

`store.py` and `service.py` sit just under the 800-line new-file cap, which
`scripts/architecture_guard.py` now enforces for this package by prefix —
split a module when it needs to grow.

Imported workbooks are patched **narrowly** with lxml: only the target
worksheet XML, `workbook.xml` (`fullCalcOnLoad`), the content-type manifest and
rels change, and `calcChain.xml` is deleted *together with every reference to
it*. openpyxl never saves an imported workbook, and the legacy
`office_document` facade refuses write actions on artifacts that were not
runtime-generated.

## Operation protocol

Limits: 200 ops per batch, 20 000 touched cells, 31-char sheet names,
`A1`-style addresses without `$` anchors. Each op is a strict Pydantic model
(`extra="forbid"`):

- `set_cell` — exactly one of `text` / `number` / `boolean` / `value_date` /
  `value_datetime` / `empty`; text starting with `=` is rejected (use
  `set_formula`).
- `set_formula` — `formula` must start with `=`.
- `clear_cells`, `set_range`, `copy_style`, `merge_cells`, `unmerge_cells`,
  `set_row_height`, `set_column_width`, `freeze_panes`.

Errors carry `http_status`: not found 404, draft-state/CAS/merge conflicts
409, invalid/unsupported/source-verification 422.

## Sources and user-confirmed merge

`POST /api/v1/chat/office-drafts/open` with `{"source": "library:<id>"}` (or
`workspace:` / `attachment:`) resolves bytes through `sources.py`, screens the
ZIP, and registers the artifact with `origin_base_hash`. The optional
`expected_base_hash` is the SHA-256 of the bytes the caller is editing: when it
does not match the live source, the open fails with 409 **before** a draft
directory is created.

`PATCH /chat/office-drafts/{id}` (merge / discard) is the user confirmation
step, handled by `MergeCoordinator`:

- **library** origins merge back into the entry under a hash CAS. Their bytes
  end up in the library, not the workspace, so the card reports the entry's real
  name with no file url and labels it as a write-back — a link to a workspace
  file that was never written is worse than no link;
- **workspace** origins overwrite the exact file their `workspace:` ref resolved
  to. `sources.resolve_workspace_target()` is the single rule for that ref
  (authorized by the path service, so a nested source never turns into a
  same-named file under a different root), and the source must still hold the
  `origin_base_hash` recorded at open;
- **attachment / generated / draft** origins land in the task workspace
  (`exec/`) under a name that does not shadow an unrelated file, and the
  artifact records where it landed (`merged_as` + `merged_path`) so the card
  links the file that exists — a name joined onto the workspace directory is
  not enough, because a workspace write-back lands at its resolved source;
- every destination is proved again at write time under its publication lock:
  an occupied publish slot moves to a name that is still free (published with
  an exclusive create), a moved or vanished source aborts the merge, and two
  artifacts resolving to the same destination abort the whole merge;
- rollback is conditional: it restores a file or library entry only if the
  current hash is still the one this merge wrote. A save that takes ownership
  after publication therefore survives a later failure elsewhere in the merge.

## Human save chain (creative library editor)

`LibraryExcelEditor` fingerprints the exact bytes it rendered (SHA-256 via
SubtleCrypto) when the workbook loads, diffs the user's edits against that
snapshot, opens its draft with the fingerprint as `expected_base_hash`, applies
chunked batches, and merges. After a successful merge it re-anchors both the
baseline snapshot and the fingerprint from the published `current_hash`, so a
second save sends only its own changes. Without a fingerprint the editor
refuses to save instead of silently losing the conflict check.

## Frozen selection (chat UI → agent)

Range selection in the preview (`SpreadsheetGrid`: click, drag, shift+arrow)
flows through a session-scoped holder into the `start_turn` payload as
`office_selection` (`draft_id`/`artifact_id`/`sheet`/`range`/`revision`), is
whitelisted by `contracts.normalize_client_selection`, frozen into
`context.metadata`, and injected server-side into `office_apply`. Closing the
preview clears it, and a selection recorded by one conversation is not consumed
by another.

The `_check_frozen_selection` gate fails closed: a selection pinned to a
different draft is a refusal, not a pass-through; every operation type is
bounds-checked, including the structural ones (`set_row_height` against the
selected rows, `set_column_width` against the selected columns, `freeze_panes`
against the selected anchor); and an operation with no auditable target is
rejected. The model cannot forge selection state: every `_`-prefixed kwarg is
stripped from model kwargs before injection.

## API surface (`/api/v1/chat/office-drafts`)

- `POST /open` — open a source in a fresh draft (`expected_base_hash` optional).
- `GET /{draft_id}` — review card (status, files, artifacts with `origin_ref`,
  `current_hash`, `last_diff`, `last_verification`, `detached_revisions`).
- `PATCH /{draft_id}` — merge / discard (user confirmation).
- `GET /{draft_id}/artifacts/{id}/overview|range|find|diff|history|content`.
- `POST /{draft_id}/artifacts/{id}/operations` — typed batch (`base_revision`).
- `POST /{draft_id}/artifacts/{id}/undo|redo`.

## Tools and compat facade

| Tool              | Status    | Purpose                                              |
| ----------------- | --------- | ---------------------------------------------------- |
| `office_artifact` | always-on | Draft lifecycle, source opening, reads, merge        |
| `office_read`     | deferred  | Overview / range / find / diff / history reads       |
| `office_apply`    | deferred  | Typed operation batches (CAS + verification)         |
| `office_document` | facade    | Legacy action vocabulary mapped onto the runtime; retired after one compat cycle |

## Storage layout and migration

```
office_drafts/<draft_id>/
  meta.json                     # schema_version=2, status, artifacts[]
  draft.lock
  artifacts/<artifact_id>/
    blobs/<sha256-32hex>.<ext>  # content-addressed, never rewritten
    revisions/<n>.json          # one record per transaction, written once
```

Every metadata mutation reads and writes `meta.json` while holding the draft
lock, so concurrent writers cannot lose each other's change; a merge holds that
same lock from plan through stage. A mirror of the current revision is written
to `draft_dir/<filename>` for the preview card, and it is resolved from the
manifest the caller just updated — reading `meta.json` back inside the open
transaction would mirror the *previous* revision and serve stale bytes until
the next write.

v1 drafts (plain file lists) are migrated in place on first v2 access. v1
recorded files lazily — the directory scan was its read-time source of truth —
so migration unions the recorded list with a scan instead of trusting
`meta["files"]`. The API loader discriminates by `schema_version` read-only.

## Import memory boundary

`import knorvia.api.main` must keep openpyxl / numpy / docx / pptx cold. All
heavy imports in the service package, tool layer, and facade are therefore
function-local (`ruff` plus `tests/core/test_api_import_memory.py` enforce it).

## Quality gates

Backend: office-targeted pytest, full pytest, `ruff check knorvia tests
scripts`, `scripts/architecture_guard.py`.
Web: `npm run test:node`, `npx tsc --noEmit`, `npm run lint:ci`,
`npm run i18n:check`, `npm run build`.

Regression coverage for the invariants above lives in
`tests/services/office_artifacts/` (store transactions, merge coordinator,
patcher fidelity, package integrity, frozen selection, revision diff),
`tests/api/test_office_artifact_api.py`, `tests/tools/`, and
`web/tests/office-review-selection.test.ts` /
`web/tests/library-excel-editor-cas.test.ts`.
