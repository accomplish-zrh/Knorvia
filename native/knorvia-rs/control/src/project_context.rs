//! Read-only project context and narrowly-scoped Git worktree operations.
//!
//! The control plane deliberately does not expose a general command endpoint.
//! Every path here is rooted in a durable workspace (or its explicitly saved
//! per-thread cwd), canonicalized, and checked again before it is used.

use crate::ControlPlane;
use knorvia_platform_paths::is_codex_path;
use knorvia_protocol::{ErrorCategory, ProtocolError};
use serde_json::{Map, Value, json};
use std::fs::{self, File, Metadata};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const DEFAULT_FILE_LIST_LIMIT: usize = 200;
const MAX_FILE_LIST_LIMIT: usize = 500;
const MAX_DIRECTORY_SCAN: usize = 10_000;
const DEFAULT_READ_BYTES: usize = 64 * 1024;
const MAX_READ_BYTES: usize = 256 * 1024;
const DEFAULT_DIFF_BYTES: usize = 128 * 1024;
const MAX_DIFF_BYTES: usize = 256 * 1024;
const BINARY_PROBE_BYTES: usize = 8 * 1024;
const MAX_RELATIVE_PATH_BYTES: usize = 4 * 1024;
const GIT_STDERR_BYTES: usize = 32 * 1024;
const GIT_READ_TIMEOUT: Duration = Duration::from_secs(5);
const GIT_WORKTREE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_UTF8_CONTINUATION_BYTES: usize = 3;

/// A durable, canonical directory authority. `cwd` is always the canonical
/// filesystem location; callers should never substitute an arbitrary path.
#[derive(Debug, Clone)]
pub(crate) struct WorkspaceScope {
    pub(crate) workspace_id: String,
    pub(crate) cwd: PathBuf,
}

impl WorkspaceScope {
    pub(crate) fn workspace_value(&self) -> Value {
        json!({
            "id": self.workspace_id,
            "cwd": display_path(&self.cwd),
        })
    }
}

#[derive(Debug)]
struct GitRepository {
    root: PathBuf,
}

#[derive(Debug)]
struct ProcessOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    truncated: bool,
}

#[derive(Debug)]
struct LimitedBytes {
    bytes: Vec<u8>,
    truncated: bool,
}

#[derive(Debug)]
struct FileChunk {
    size: u64,
    bytes: Vec<u8>,
    truncated: bool,
    binary: bool,
}

#[derive(Debug)]
struct DirectoryEntryInfo {
    target: PathBuf,
    path: String,
    name: String,
    kind: &'static str,
    size: u64,
    is_regular_file: bool,
}

impl ControlPlane {
    /// A removed or interrupted-removal worktree keeps its durable history,
    /// but must never fall back to another directory when a task is resumed.
    pub(super) fn ensure_workspace_runnable(
        &self,
        workspace_id: &str,
    ) -> Result<(), ProtocolError> {
        let marker = self
            .store
            .paths()
            .state
            .join("product/worktree-tombstones")
            .join(format!("{workspace_id}.json"));
        if marker.exists() {
            return Err(ProtocolError::new(
                ErrorCategory::PreconditionFailed,
                "This worktree was removed or its removal needs recovery. Its task history is retained; choose another project",
            ));
        }
        Ok(())
    }

    /// Resolve the only directory authority accepted by project-context RPCs.
    /// A thread's explicitly persisted cwd wins over the workspace cwd so a
    /// later workspace update cannot retarget an existing task.
    pub(crate) fn resolve_workspace_scope(
        &self,
        params: &Value,
    ) -> Result<WorkspaceScope, ProtocolError> {
        let requested_workspace = optional_string(params, "workspaceId")?;
        let requested_thread = optional_string(params, "threadId")?;
        if requested_workspace.is_none() && requested_thread.is_none() {
            return Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "workspaceId or threadId is required",
            ));
        }

        let (workspace_id, thread_cwd) = if let Some(thread_id) = requested_thread {
            let thread = self
                .store
                .read_thread(&thread_id)
                .map_err(|error| error.into_protocol())?;
            if let Some(workspace_id) = requested_workspace.as_deref()
                && workspace_id != thread.workspace_id
            {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "workspaceId does not own threadId",
                ));
            }
            let settings = self.executor_lock().thread_settings(&thread.id)?;
            (
                thread.workspace_id,
                settings.and_then(|settings| settings.cwd),
            )
        } else {
            (requested_workspace.expect("checked above"), None)
        };

        self.ensure_workspace_runnable(&workspace_id)?;
        let workspace_cwd = self
            .store
            .read_workspace_cwd(&workspace_id)
            .map_err(|error| error.into_protocol())?;
        let configured_cwd = thread_cwd.or(workspace_cwd).ok_or_else(|| {
            ProtocolError::new(
                ErrorCategory::PreconditionFailed,
                "the selected workspace or thread has no project directory",
            )
        })?;
        let configured_path = PathBuf::from(&configured_cwd);
        if !configured_path.is_absolute() {
            return Err(ProtocolError::new(
                ErrorCategory::PreconditionFailed,
                "the persisted project directory is not absolute",
            ));
        }
        let cwd = canonicalize_directory(&configured_path, "the selected project directory")?;
        Ok(WorkspaceScope { workspace_id, cwd })
    }

    /// Canonically resolve a project-relative target for native desktop IPC.
    /// This endpoint is intentionally read-only and does not permit bare
    /// absolute paths from the renderer.
    pub(crate) fn rpc_workspace_path_resolve(
        &self,
        params: &Value,
    ) -> Result<Value, ProtocolError> {
        let scope = self.resolve_workspace_scope(params)?;
        let raw_path = optional_path(params, "path")?;
        let target = resolve_relative_path(&scope, &raw_path, true)?;
        let metadata = fs::symlink_metadata(&target)
            .map_err(|error| io_error("read the selected project path", error))?;
        Ok(json!({
            "workspace": scope.workspace_value(),
            "path": scope_relative_path(&scope, &target)?,
            "absolutePath": display_path(&target),
            "kind": entry_kind(&metadata),
        }))
    }

    pub(crate) fn rpc_workspace_files_list(&self, params: &Value) -> Result<Value, ProtocolError> {
        let scope = self.resolve_workspace_scope(params)?;
        let raw_path = optional_path(params, "path")?;
        let directory = resolve_relative_path(&scope, &raw_path, true)?;
        let metadata = fs::metadata(&directory)
            .map_err(|error| io_error("read the selected project directory", error))?;
        if !metadata.is_dir() {
            return Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "path must name a directory",
            ));
        }
        let limit = bounded_usize(
            params,
            "limit",
            DEFAULT_FILE_LIST_LIMIT,
            MAX_FILE_LIST_LIMIT,
        )?;
        let cursor = page_cursor(params)?;

        let mut entries = Vec::new();
        let read_dir = fs::read_dir(&directory)
            .map_err(|error| io_error("list the selected project directory", error))?;
        for entry in read_dir {
            if entries.len() >= MAX_DIRECTORY_SCAN {
                return Err(ProtocolError::new(
                    ErrorCategory::ResourceExhausted,
                    format!("directory has more than {MAX_DIRECTORY_SCAN} entries"),
                ));
            }
            let entry =
                entry.map_err(|error| io_error("list the selected project directory", error))?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| io_error("inspect a project directory entry", error))?;
            entries.push(DirectoryEntryInfo {
                path: scope_relative_path(&scope, &path)?,
                name: entry.file_name().to_string_lossy().to_string(),
                kind: entry_kind(&metadata),
                size: metadata.len(),
                is_regular_file: metadata.is_file(),
                target: path,
            });
        }
        entries.sort_by(|left, right| left.path.cmp(&right.path));
        if cursor > entries.len() {
            return Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "cursor is outside this directory listing",
            ));
        }
        let end = (cursor + limit).min(entries.len());
        let truncated = end < entries.len();
        // Probe only entries that are actually returned. A large directory
        // should not read up to 8 KiB from every file before its first page.
        let values = entries[cursor..end]
            .iter()
            .map(|entry| {
                let is_binary = if entry.is_regular_file {
                    match read_file_chunk(&entry.target, 0, 0) {
                        Ok(chunk) => Value::Bool(chunk.binary),
                        // A concurrent delete or permission change must not turn a
                        // directory listing into an arbitrary filesystem read.
                        Err(_) => Value::Null,
                    }
                } else {
                    Value::Null
                };
                json!({
                    "path": entry.path,
                    "name": entry.name,
                    "kind": entry.kind,
                    "size": entry.size,
                    "isBinary": is_binary,
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "workspace": scope.workspace_value(),
            "path": scope_relative_path(&scope, &directory)?,
            "entries": values,
            "nextCursor": truncated.then(|| end.to_string()),
            "truncated": truncated,
        }))
    }

    pub(crate) fn rpc_workspace_files_read(&self, params: &Value) -> Result<Value, ProtocolError> {
        let scope = self.resolve_workspace_scope(params)?;
        let raw_path = required_string(params, "path")?;
        let target = resolve_relative_path(&scope, raw_path, false)?;
        let offset = optional_u64(params, "offset")?.unwrap_or(0);
        let max_bytes = bounded_usize(params, "maxBytes", DEFAULT_READ_BYTES, MAX_READ_BYTES)?;
        let chunk = read_file_chunk(&target, offset, max_bytes)?;
        let path = scope_relative_path(&scope, &target)?;
        if chunk.binary {
            return Ok(json!({
                "workspace": scope.workspace_value(),
                "path": path,
                "kind": "binary",
                "size": chunk.size,
                "offset": offset,
                "truncated": false,
                "nextOffset": Value::Null,
            }));
        }
        let content = String::from_utf8(chunk.bytes).map_err(|_| {
            ProtocolError::new(
                ErrorCategory::CapabilityUnavailable,
                "file content is binary and cannot be returned as text",
            )
        })?;
        let next_offset = chunk
            .truncated
            .then(|| offset.saturating_add(content.len() as u64));
        Ok(json!({
            "workspace": scope.workspace_value(),
            "path": path,
            "kind": "text",
            "encoding": "utf-8",
            "size": chunk.size,
            "offset": offset,
            "content": content,
            "truncated": chunk.truncated,
            "nextOffset": next_offset,
        }))
    }

    pub(crate) fn rpc_workspace_git_status(&self, params: &Value) -> Result<Value, ProtocolError> {
        let scope = self.resolve_workspace_scope(params)?;
        let Some(repository) = discover_git_repository(&scope)? else {
            return Ok(git_unavailable_value(&scope));
        };
        let status = run_git_read(
            &scope.cwd,
            &[
                "-c",
                "status.relativePaths=true",
                "status",
                "--porcelain=v1",
                "-z",
                "--untracked-files=all",
                "--ignored=no",
                "--",
                ".",
            ],
            MAX_DIFF_BYTES,
        )?;
        if status.truncated {
            return Err(ProtocolError::new(
                ErrorCategory::ResourceExhausted,
                "Git status output exceeded its bounded limit",
            ));
        }
        if !status.status.success() {
            return Err(git_failure("read repository status", &status));
        }
        let parsed = parse_status_porcelain(&scope, &repository, &status.stdout)?;
        let branch = git_optional_line(&scope.cwd, &["branch", "--show-current"])?;
        let head = git_optional_line(&scope.cwd, &["rev-parse", "--verify", "HEAD"])?;
        Ok(json!({
            "workspace": scope.workspace_value(),
            "available": true,
            "root": repository_root_for_scope(&scope, &repository),
            "branch": branch,
            "head": head,
            "staged": parsed.staged,
            "unstaged": parsed.unstaged,
            "untracked": parsed.untracked,
            "conflicts": parsed.conflicts,
            "clean": parsed.staged.is_empty()
                && parsed.unstaged.is_empty()
                && parsed.untracked.is_empty()
                && parsed.conflicts.is_empty(),
        }))
    }

    pub(crate) fn rpc_workspace_git_diff(&self, params: &Value) -> Result<Value, ProtocolError> {
        let scope = self.resolve_workspace_scope(params)?;
        let raw_path = required_string(params, "path")?;
        let target = resolve_relative_path(&scope, raw_path, false)?;
        let metadata = match fs::metadata(&target) {
            Ok(metadata) if metadata.is_file() => Some(metadata),
            Ok(_) => {
                return Err(ProtocolError::new(
                    ErrorCategory::InvalidArgument,
                    "path must name one regular file",
                ));
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(io_error("read the selected project file", error)),
        };
        let path = scope_relative_path(&scope, &target)?;
        let staged = optional_bool(params, "staged")?.unwrap_or(false);
        let max_bytes = bounded_usize(params, "maxBytes", DEFAULT_DIFF_BYTES, MAX_DIFF_BYTES)?;
        let Some(repository) = discover_git_repository(&scope)? else {
            return Ok(json!({
                "workspace": scope.workspace_value(),
                "available": false,
                "root": Value::Null,
                "path": path,
                "staged": staged,
                "untracked": false,
                "binary": false,
                "diff": "",
                "size": 0,
                "truncated": false,
            }));
        };

        if metadata.is_some() && git_path_is_untracked(&scope, &path)? {
            let content_budget = max_bytes.saturating_sub(2 * 1024).max(1);
            let chunk = read_file_chunk(&target, 0, content_budget)?;
            if chunk.binary {
                return Ok(json!({
                    "workspace": scope.workspace_value(),
                    "available": true,
                    "root": repository_root_for_scope(&scope, &repository),
                    "path": path,
                    "staged": staged,
                    "untracked": true,
                    "binary": true,
                    "diff": "",
                    "size": 0,
                    "truncated": false,
                }));
            }
            let text = String::from_utf8(chunk.bytes).map_err(|_| {
                ProtocolError::new(
                    ErrorCategory::CapabilityUnavailable,
                    "untracked binary file cannot be returned as a text diff",
                )
            })?;
            let (diff, output_truncated) =
                untracked_unified_diff(&path, &text, chunk.truncated, max_bytes);
            return Ok(json!({
                "workspace": scope.workspace_value(),
                "available": true,
                "root": repository_root_for_scope(&scope, &repository),
                "path": path,
                "staged": staged,
                "untracked": true,
                "binary": false,
                "diff": diff,
                "size": diff.len(),
                "truncated": output_truncated,
            }));
        }

        let mut args = vec![
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--relative",
            "--unified=3",
        ];
        if staged {
            args.push("--cached");
        }
        let literal_pathspec = git_literal_pathspec(&path);
        args.push("--");
        args.push(&literal_pathspec);
        let output = run_git_read(&scope.cwd, &args, max_bytes)?;
        if !output.status.success() && !output.truncated {
            return Err(git_failure("read a file diff", &output));
        }
        let binary = metadata
            .as_ref()
            .map(|_| read_file_chunk(&target, 0, 0).map(|chunk| chunk.binary))
            .transpose()?
            .unwrap_or(false);
        let (diff, text_truncated) = decode_git_text(&output.stdout, output.truncated)?;
        Ok(json!({
            "workspace": scope.workspace_value(),
            "available": true,
            "root": repository_root_for_scope(&scope, &repository),
            "path": path,
            "staged": staged,
            "untracked": false,
            "binary": binary,
            "diff": diff,
            "size": diff.len(),
            "truncated": output.truncated || text_truncated,
        }))
    }

    /// Read-only worktree inventory from `git worktree list --porcelain`.
    /// Paths are reported verbatim by Git; `managed` marks worktrees that
    /// Knorvia itself created under `<Home>/worktrees`. Removal is
    /// deliberately not exposed: real user worktrees are never deleted by the
    /// product, so the only mutating operations are protective locks.
    pub(crate) fn rpc_workspace_worktree_list(
        &self,
        params: &Value,
    ) -> Result<Value, ProtocolError> {
        let scope = self.resolve_workspace_scope(params)?;
        let Some(repository) = discover_git_repository(&scope)? else {
            return Ok(git_unavailable_value(&scope));
        };
        let listing = run_git_read(
            &scope.cwd,
            &["worktree", "list", "--porcelain"],
            MAX_DIFF_BYTES,
        )?;
        if listing.truncated {
            return Err(ProtocolError::new(
                ErrorCategory::ResourceExhausted,
                "Git worktree listing exceeded its bounded limit",
            ));
        }
        if !listing.status.success() {
            return Err(git_failure("list Git worktrees", &listing));
        }
        let stdout_text = String::from_utf8(listing.stdout.clone()).map_err(|_| {
            ProtocolError::new(
                ErrorCategory::Internal,
                "Git worktree listing was not valid UTF-8",
            )
        })?;
        let worktrees = parse_worktree_porcelain(&stdout_text)?;
        let worktrees_root = canonical_worktrees_root(self.store.paths().home.as_path())
            .map(|root| root.to_string_lossy().into_owned())
            .ok();
        let normalize = |value: &str| {
            let stripped = value
                .strip_prefix(r"\\?\UNC\")
                .or_else(|| value.strip_prefix(r"\\?\"))
                .unwrap_or(value);
            stripped.replace('\\', "/").to_lowercase()
        };
        let managed_root = worktrees_root.as_ref().map(|root| normalize(root));
        let entries: Vec<Value> = worktrees
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                // Git lists the main worktree first; only a bare repository
                // entry can also claim `bare`. Locking either is refused.
                let is_main = index == 0 || entry.bare;
                let managed = managed_root
                    .as_ref()
                    .is_some_and(|root| normalize(&entry.path).starts_with(&format!("{root}/")));
                json!({
                    "path": entry.path,
                    "main": is_main,
                    "managed": managed,
                    "head": entry.head,
                    "branch": entry.branch,
                    "bare": entry.bare,
                    "detached": entry.detached,
                    "locked": entry.locked,
                    "lockReason": entry.lock_reason,
                    "prunable": entry.prunable,
                    "prunableReason": entry.prunable_reason,
                })
            })
            .collect();
        Ok(json!({
            "workspace": scope.workspace_value(),
            "available": true,
            "root": repository_root_for_scope(&scope, &repository),
            "worktreesRoot": worktrees_root,
            "worktrees": entries,
        }))
    }

    /// Lock or unlock a non-main worktree. Locking is protective: it stops
    /// `git worktree remove`/`prune` from deleting the tree while tasks may
    /// still use it. The target must already be registered by Git, and the
    /// main worktree is always refused.
    pub(crate) fn rpc_workspace_worktree_lock(
        &self,
        params: &Value,
        lock: bool,
    ) -> Result<Value, ProtocolError> {
        let scope = self.resolve_workspace_scope(params)?;
        let target = required_string(params, "path")?;
        let reason = optional_string(params, "reason")?;
        let Some(_repository) = discover_git_repository(&scope)? else {
            return Err(ProtocolError::new(
                ErrorCategory::CapabilityUnavailable,
                "the selected project is not a Git repository",
            ));
        };
        let listing = run_git_read(
            &scope.cwd,
            &["worktree", "list", "--porcelain"],
            MAX_DIFF_BYTES,
        )?;
        if !listing.status.success() {
            return Err(git_failure("list Git worktrees", &listing));
        }
        let stdout_text = String::from_utf8(listing.stdout.clone()).map_err(|_| {
            ProtocolError::new(
                ErrorCategory::Internal,
                "Git worktree listing was not valid UTF-8",
            )
        })?;
        let worktrees = parse_worktree_porcelain(&stdout_text)?;
        let entry = worktrees
            .iter()
            .find(|entry| entry.path == target)
            .ok_or_else(|| {
                ProtocolError::new(
                    ErrorCategory::NotFound,
                    "the requested worktree is not registered in this repository",
                )
            })?;
        let is_main = worktrees.iter().enumerate().any(|(index, candidate)| {
            (index == 0 || candidate.bare) && candidate.path == entry.path
        });
        if is_main {
            return Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "the main worktree cannot be locked",
            ));
        }
        let mut args: Vec<String> = vec![
            "worktree".to_string(),
            (if lock { "lock" } else { "unlock" }).to_string(),
        ];
        if lock {
            if let Some(reason) = reason {
                args.push("--reason".to_string());
                args.push(reason);
            }
        }
        args.push(target.to_string());
        let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let outcome = run_git_mutating(
            &scope.cwd,
            &arg_refs,
            8 * 1024,
            std::time::Duration::from_secs(20),
        )?;
        if !outcome.status.success() {
            return Err(git_failure(
                if lock {
                    "lock worktree"
                } else {
                    "unlock worktree"
                },
                &outcome,
            ));
        }
        Ok(json!({
            "workspace": scope.workspace_value(),
            "path": target,
            "locked": lock,
        }))
    }

    /// Remove only an idle, clean, unlocked, Knorvia-owned worktree. History
    /// remains durable and is made non-runnable before any directory removal.
    pub(crate) fn rpc_workspace_worktree_remove(
        &self,
        params: &Value,
    ) -> Result<Value, ProtocolError> {
        use std::io::Write;
        use std::sync::atomic::Ordering;
        let scope = self.resolve_workspace_scope(params)?;
        let requested = required_string(params, "path")?;
        let repository = discover_git_repository(&scope)?.ok_or_else(|| {
            ProtocolError::new(
                ErrorCategory::CapabilityUnavailable,
                "The selected project is not a Git repository",
            )
        })?;
        if scope.cwd != repository.root {
            return Err(ProtocolError::new(
                ErrorCategory::PermissionDenied,
                "Open the repository root project before removing a whole worktree",
            ));
        }
        let listing = run_git_read(
            &scope.cwd,
            &["worktree", "list", "--porcelain"],
            MAX_DIFF_BYTES,
        )?;
        if !listing.status.success() || listing.truncated {
            return Err(git_failure("list Git worktrees", &listing));
        }
        let text = String::from_utf8(listing.stdout)
            .map_err(|_| ProtocolError::new(ErrorCategory::Internal, "Invalid worktree listing"))?;
        let entries = parse_worktree_porcelain(&text)?;
        let (index, entry) = entries
            .iter()
            .enumerate()
            .find(|(_, entry)| entry.path == requested)
            .ok_or_else(|| {
                ProtocolError::new(
                    ErrorCategory::NotFound,
                    "Worktree is not registered in this repository",
                )
            })?;
        if index == 0 || entry.bare || entry.locked {
            return Err(ProtocolError::new(
                ErrorCategory::PreconditionFailed,
                "Main, bare, and locked worktrees cannot be removed",
            ));
        }
        let target = canonicalize_directory(Path::new(requested), "worktree to remove")?;
        let owned = canonical_worktrees_root(self.store.paths().home.as_path())?;
        if target == owned
            || !target.starts_with(&owned)
            || fs::symlink_metadata(requested)
                .map_err(|error| io_error("inspect worktree", error))?
                .file_type()
                .is_symlink()
        {
            return Err(ProtocolError::new(
                ErrorCategory::PermissionDenied,
                "Only Knorvia-managed worktrees can be removed",
            ));
        }
        if self.admissions_paused.swap(true, Ordering::AcqRel) {
            return Err(ProtocolError::new(
                ErrorCategory::PreconditionFailed,
                "The runtime is busy with another lifecycle operation",
            ));
        }
        let result = (|| {
            if self
                .store
                .running_turn_count()
                .map_err(|error| error.into_protocol())?
                != 0
            {
                return Err(ProtocolError::new(
                    ErrorCategory::PreconditionFailed,
                    "Finish or stop active tasks before removing a worktree",
                ));
            }
            let hidden = run_git_read(&target, &["ls-files", "-v", "-z"], MAX_DIFF_BYTES)?;
            if !hidden.status.success() {
                return Err(git_failure("inspect worktree index flags", &hidden));
            }
            if hidden.truncated
                || hidden.stdout.split(|byte| *byte == 0).any(|entry| {
                    entry
                        .first()
                        .is_some_and(|flag| flag.is_ascii_lowercase() || *flag == b'S')
                })
            {
                return Err(ProtocolError::new(
                    ErrorCategory::Conflict,
                    "Worktree index contains hidden-file flags or could not be fully inspected; preserve and clear those flags before removal",
                ));
            }
            let status = run_git_read(
                &target,
                &[
                    "status",
                    "--porcelain=v1",
                    "-z",
                    "--untracked-files=all",
                    "--ignored=matching",
                    "--ignore-submodules=none",
                ],
                MAX_DIFF_BYTES,
            )?;
            if !status.status.success() || status.truncated {
                return Err(git_failure("inspect worktree changes", &status));
            }
            if !status.stdout.is_empty() {
                return Err(ProtocolError::new(
                    ErrorCategory::Conflict,
                    "Worktree contains changed, untracked, or ignored files; preserve them before removal",
                ));
            }
            let target_repo = discover_git_repository(&WorkspaceScope {
                workspace_id: scope.workspace_id.clone(),
                cwd: target.clone(),
            })?
            .ok_or_else(|| {
                ProtocolError::new(
                    ErrorCategory::Conflict,
                    "Worktree repository is unavailable",
                )
            })?;
            if target_repo.root != target {
                return Err(ProtocolError::new(
                    ErrorCategory::PermissionDenied,
                    "The removal target is not a worktree root",
                ));
            }
            let workspaces = self
                .store
                .list_workspaces()
                .map_err(|error| error.into_protocol())?;
            let affected: Vec<String> = workspaces
                .iter()
                .filter_map(|workspace| {
                    self.store
                        .read_workspace_cwd(&workspace.id)
                        .ok()
                        .flatten()
                        .and_then(|cwd| fs::canonicalize(cwd).ok())
                        .filter(|cwd| cwd.starts_with(&target))
                        .map(|_| workspace.id.clone())
                })
                .collect();
            if affected.is_empty() {
                return Err(ProtocolError::new(
                    ErrorCategory::PermissionDenied,
                    "This worktree has no Knorvia workspace owner",
                ));
            }
            let markers = self.store.paths().state.join("product/worktree-tombstones");
            fs::create_dir_all(&markers)
                .map_err(|error| io_error("create worktree recovery directory", error))?;
            let mut written = Vec::new();
            for id in &affected {
                let file = markers.join(format!("{id}.json"));
                let bytes = serde_json::to_vec(&json!({"workspaceId": id, "path": display_path(&target), "state": "removal-pending", "branchRetained": true})).map_err(|_| ProtocolError::new(ErrorCategory::Internal, "Cannot serialize worktree recovery record"))?;
                let write = (|| -> io::Result<()> {
                    let mut out = fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&file)?;
                    out.write_all(&bytes)?;
                    out.sync_all()
                })();
                if let Err(error) = write {
                    for prior in &written {
                        let _ = fs::remove_file(prior);
                    }
                    return Err(io_error("write worktree recovery record", error));
                }
                written.push(file);
            }
            // Git performs its own final dirty check; --force is never used.
            // Execute from the surviving primary worktree, not the target cwd.
            let source = canonicalize_directory(Path::new(&entries[0].path), "primary worktree")?;
            let output = run_git_mutating(
                &source,
                &["worktree", "remove", requested],
                MAX_DIFF_BYTES,
                GIT_WORKTREE_TIMEOUT,
            );
            match output {
                Ok(output) if output.status.success() && !target.exists() => {
                    for file in &written {
                        let _ = fs::write(file, serde_json::to_vec(&json!({"path": display_path(&target), "state": "removed", "branchRetained": true})).unwrap_or_default());
                    }
                    Ok(
                        json!({"removed": true, "path": requested, "workspaceIds": affected, "historyRetained": true, "branchRetained": true}),
                    )
                }
                Ok(output) if target.exists() => {
                    for file in &written {
                        fs::remove_file(file)
                            .map_err(|error| io_error("restore worktree availability", error))?;
                    }
                    Err(git_failure("remove Git worktree", &output))
                }
                _ => Err(ProtocolError::new(
                    ErrorCategory::PreconditionFailed,
                    "Worktree removal outcome requires recovery. Its history and recovery records are preserved",
                )),
            }
        })();
        self.admissions_paused.store(false, Ordering::Release);
        result
    }

    pub(crate) fn rpc_workspace_worktree_create(
        &self,
        params: &Value,
    ) -> Result<Value, ProtocolError> {
        let scope = self.resolve_workspace_scope(params)?;
        let branch = required_string(params, "branch")?;
        validate_branch_name(branch)?;
        let base_ref = optional_string(params, "baseRef")?.unwrap_or_else(|| "HEAD".to_string());
        validate_base_ref(&base_ref)?;
        // Validate every caller-controlled value before Git mutates either the
        // repository or its worktree registry. In particular, a bad title must
        // never leave a branch and worktree behind.
        let title =
            optional_string(params, "title")?.unwrap_or_else(|| format!("Worktree: {branch}"));
        let Some(repository) = discover_git_repository(&scope)? else {
            return Err(ProtocolError::new(
                ErrorCategory::CapabilityUnavailable,
                "the selected project is not a Git repository",
            ));
        };
        // A nested workspace is an authority boundary. The Git worktree itself
        // is rooted at the repository, but its new durable workspace must keep
        // precisely the same subtree rather than exposing that repository root.
        let scope_from_root = scope
            .cwd
            .strip_prefix(&repository.root)
            .map_err(|_| {
                ProtocolError::new(
                    ErrorCategory::PermissionDenied,
                    "the selected workspace is outside its Git repository",
                )
            })?
            .to_path_buf();

        // Resolve a commit first, so an invalid or unavailable base never
        // creates a partially registered worktree.
        let base_commit = git_required_line(
            &repository.root,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("{base_ref}^{{commit}}"),
            ],
            "baseRef does not resolve to a commit",
        )?;
        let worktrees_root = canonical_worktrees_root(self.store.paths().home.as_path())?;
        let destination = generated_worktree_path(
            self.store.paths().home.as_path(),
            &scope.workspace_id,
            branch,
        )?;
        if !destination.starts_with(&worktrees_root) {
            return Err(ProtocolError::new(
                ErrorCategory::PermissionDenied,
                "generated worktree path is outside the Knorvia worktree directory",
            ));
        }
        let destination_string = display_path(&destination);
        let output = run_git_mutating(
            &repository.root,
            &[
                "worktree",
                "add",
                "-b",
                branch,
                &destination_string,
                &base_commit,
            ],
            MAX_DIFF_BYTES,
            GIT_WORKTREE_TIMEOUT,
        )?;
        if !output.status.success() {
            return Err(ProtocolError::new(
                ErrorCategory::Conflict,
                "Git could not create the requested worktree",
            ));
        }
        // At this point `-b` has succeeded: this call owns both the generated
        // worktree and branch. Any later error must compensate only that exact
        // canonical location, without touching a user-owned worktree.
        let result = (|| {
            if output.truncated {
                return Err(ProtocolError::new(
                    ErrorCategory::ResourceExhausted,
                    "Git worktree creation output exceeded its bounded limit",
                ));
            }
            let worktree_root = canonicalize_directory(&destination, "the newly created worktree")?;
            if !worktree_root.starts_with(&worktrees_root) {
                return Err(ProtocolError::new(
                    ErrorCategory::PermissionDenied,
                    "new worktree resolves outside the Knorvia worktree directory",
                ));
            }
            let cwd = canonicalize_directory(
                &worktree_root.join(&scope_from_root),
                "the selected directory in the new worktree",
            )?;
            if !cwd.starts_with(&worktree_root) {
                return Err(ProtocolError::new(
                    ErrorCategory::PermissionDenied,
                    "new workspace directory resolves outside its worktree",
                ));
            }
            let cwd_string = display_path(&cwd);
            let workspace = self
                .store
                .create_workspace_with_cwd(&title, Some(&cwd_string))
                .map_err(|error| error.into_protocol())?;
            // Keep the established flat Workspace result and avoid a fallible
            // post-commit store read that could turn a completed creation into
            // an orphaned workspace.
            let workspace_id = workspace.id.clone();
            let created_at = workspace.created_at.clone();
            let mut value = json!({
                "id": workspace.id,
                "title": workspace.title,
                "revision": workspace.revision,
                "createdAt": workspace.created_at,
                "updatedAt": workspace.updated_at,
                "cwd": cwd_string,
            });
            value["sourceWorkspaceId"] = json!(scope.workspace_id);
            value["worktree"] = json!({
                "id": workspace_id,
                "cwd": display_path(&cwd),
                "branch": branch,
                "baseRef": base_ref,
                "createdAt": created_at,
            });
            Ok(value)
        })();
        if result.is_err() {
            cleanup_created_worktree(&repository, &worktrees_root, &destination, branch);
        }
        result
    }
}

/// Resolve a non-absolute path within a canonical workspace directory.  For a
/// target that no longer exists (for example a deleted Git path), its nearest
/// existing ancestor is canonicalized and checked so a hidden symlink cannot
/// turn a later Git pathspec into an escape.
pub(crate) fn resolve_relative_path(
    scope: &WorkspaceScope,
    raw: &str,
    allow_root: bool,
) -> Result<PathBuf, ProtocolError> {
    if raw.len() > MAX_RELATIVE_PATH_BYTES {
        return Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            format!("path exceeds {MAX_RELATIVE_PATH_BYTES} bytes"),
        ));
    }
    if raw.is_empty() {
        return if allow_root {
            Ok(scope.cwd.clone())
        } else {
            Err(ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "path must not be empty",
            ))
        };
    }
    let path = Path::new(raw);
    if path.is_absolute() {
        return Err(ProtocolError::new(
            ErrorCategory::PermissionDenied,
            "path must be relative to the selected workspace",
        ));
    }
    let mut candidate = scope.cwd.clone();
    let mut saw_normal = false;
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                candidate.push(value);
                saw_normal = true;
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(ProtocolError::new(
                    ErrorCategory::PermissionDenied,
                    "path traversal is not permitted",
                ));
            }
        }
    }
    if !saw_normal && !allow_root {
        return Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            "path must name a file or directory",
        ));
    }
    canonicalize_scoped_candidate(scope, &candidate)
}

fn canonicalize_scoped_candidate(
    scope: &WorkspaceScope,
    candidate: &Path,
) -> Result<PathBuf, ProtocolError> {
    let mut existing = candidate.to_path_buf();
    loop {
        match fs::symlink_metadata(&existing) {
            Ok(_) => break,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if !existing.pop() {
                    return Err(ProtocolError::new(
                        ErrorCategory::PermissionDenied,
                        "path is outside the selected workspace",
                    ));
                }
            }
            Err(error) => return Err(io_error("resolve a project path", error)),
        }
    }
    let canonical_ancestor =
        fs::canonicalize(&existing).map_err(|error| io_error("resolve a project path", error))?;
    if !canonical_ancestor.starts_with(&scope.cwd) {
        return Err(ProtocolError::new(
            ErrorCategory::PermissionDenied,
            "path resolves outside the selected workspace",
        ));
    }
    match fs::symlink_metadata(candidate) {
        Ok(_) => {
            let canonical = fs::canonicalize(candidate)
                .map_err(|error| io_error("resolve a project path", error))?;
            if !canonical.starts_with(&scope.cwd) {
                return Err(ProtocolError::new(
                    ErrorCategory::PermissionDenied,
                    "path resolves outside the selected workspace",
                ));
            }
            return Ok(canonical);
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error("resolve a project path", error)),
    }
    let suffix = candidate.strip_prefix(&existing).map_err(|_| {
        ProtocolError::new(
            ErrorCategory::PermissionDenied,
            "path is outside the selected workspace",
        )
    })?;
    let resolved = canonical_ancestor.join(suffix);
    if !resolved.starts_with(&scope.cwd) {
        return Err(ProtocolError::new(
            ErrorCategory::PermissionDenied,
            "path resolves outside the selected workspace",
        ));
    }
    Ok(resolved)
}

fn canonicalize_directory(path: &Path, label: &str) -> Result<PathBuf, ProtocolError> {
    let canonical = fs::canonicalize(path).map_err(|error| io_error(label, error))?;
    let metadata = fs::metadata(&canonical).map_err(|error| io_error(label, error))?;
    if !metadata.is_dir() {
        return Err(ProtocolError::new(
            ErrorCategory::PreconditionFailed,
            format!("{label} must be a directory"),
        ));
    }
    Ok(canonical)
}

fn scope_relative_path(scope: &WorkspaceScope, path: &Path) -> Result<String, ProtocolError> {
    let relative = path.strip_prefix(&scope.cwd).map_err(|_| {
        ProtocolError::new(
            ErrorCategory::PermissionDenied,
            "path is outside the selected workspace",
        )
    })?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn display_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    #[cfg(windows)]
    {
        if let Some(without_verbatim) = path.strip_prefix(r"\\?\") {
            if let Some(unc) = without_verbatim.strip_prefix("UNC\\") {
                return format!(r"\\{unc}");
            }
            return without_verbatim.to_string();
        }
    }
    path.to_string()
}

fn entry_kind(metadata: &Metadata) -> &'static str {
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        "symlink"
    } else if metadata.is_dir() {
        "directory"
    } else if metadata.is_file() {
        "file"
    } else {
        "other"
    }
}

fn required_string<'a>(params: &'a Value, key: &str) -> Result<&'a str, ProtocolError> {
    params.get(key).and_then(Value::as_str).ok_or_else(|| {
        ProtocolError::new(
            ErrorCategory::InvalidArgument,
            format!("missing string field {key}"),
        )
    })
}

fn optional_string(params: &Value, key: &str) -> Result<Option<String>, ProtocolError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.trim().is_empty() => Ok(Some(value.clone())),
        Some(Value::String(_)) => Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            format!("{key} must not be empty"),
        )),
        Some(_) => Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            format!("{key} must be a string"),
        )),
    }
}

fn optional_path(params: &Value, key: &str) -> Result<String, ProtocolError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(value)) => Ok(value.clone()),
        Some(_) => Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            format!("{key} must be a string"),
        )),
    }
}

fn optional_u64(params: &Value, key: &str) -> Result<Option<u64>, ProtocolError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_u64().map(Some).ok_or_else(|| {
            ProtocolError::new(
                ErrorCategory::InvalidArgument,
                format!("{key} must be an unsigned integer"),
            )
        }),
    }
}

fn optional_bool(params: &Value, key: &str) -> Result<Option<bool>, ProtocolError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            format!("{key} must be a boolean"),
        )),
    }
}

fn bounded_usize(
    params: &Value,
    key: &str,
    default: usize,
    maximum: usize,
) -> Result<usize, ProtocolError> {
    match optional_u64(params, key)? {
        None => Ok(default),
        Some(value) if value == 0 || value > maximum as u64 => Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            format!("{key} must be between 1 and {maximum}"),
        )),
        Some(value) => Ok(value as usize),
    }
}

fn page_cursor(params: &Value) -> Result<usize, ProtocolError> {
    match params.get("cursor") {
        None | Some(Value::Null) => Ok(0),
        Some(Value::String(cursor)) => cursor.parse::<usize>().map_err(|_| {
            ProtocolError::new(
                ErrorCategory::InvalidArgument,
                "cursor must be a non-negative decimal offset",
            )
        }),
        Some(_) => Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            "cursor must be a string",
        )),
    }
}

fn read_file_chunk(path: &Path, offset: u64, max_bytes: usize) -> Result<FileChunk, ProtocolError> {
    let mut file =
        File::open(path).map_err(|error| io_error("read the selected project file", error))?;
    let metadata = file
        .metadata()
        .map_err(|error| io_error("read the selected project file", error))?;
    if !metadata.is_file() {
        return Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            "path must name one regular file",
        ));
    }
    let size = metadata.len();
    if offset > size {
        return Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            "offset is beyond the end of the file",
        ));
    }
    let probe_len =
        usize::try_from(size.min(BINARY_PROBE_BYTES as u64)).unwrap_or(BINARY_PROBE_BYTES);
    let probe = read_up_to(&mut file, probe_len)?;
    if looks_binary(&probe) {
        return Ok(FileChunk {
            size,
            bytes: Vec::new(),
            truncated: false,
            binary: true,
        });
    }
    if max_bytes == 0 {
        return Ok(FileChunk {
            size,
            bytes: Vec::new(),
            truncated: offset < size,
            binary: false,
        });
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| io_error("read the selected project file", error))?;
    let mut bytes = read_up_to(&mut file, max_bytes)?;
    if bytes.contains(&0) {
        return Ok(binary_file_chunk(size));
    }
    if let Err(error) = std::str::from_utf8(&bytes) {
        if error.error_len().is_some() {
            return Ok(binary_file_chunk(size));
        }
        // A valid UTF-8 scalar can straddle the caller's byte budget. Read
        // only the missing continuation bytes, then either keep one initial
        // scalar for forward progress or trim back to the prior scalar boundary.
        let trim_at = error.valid_up_to();
        let mut completed = false;
        for _ in 0..MAX_UTF8_CONTINUATION_BYTES {
            let tail = read_up_to(&mut file, 1)?;
            if tail.is_empty() {
                return Ok(binary_file_chunk(size));
            }
            bytes.extend_from_slice(&tail);
            match std::str::from_utf8(&bytes) {
                Ok(_) => {
                    completed = true;
                    break;
                }
                Err(error) if error.error_len().is_some() => return Ok(binary_file_chunk(size)),
                Err(_) => {}
            }
        }
        if !completed {
            return Ok(binary_file_chunk(size));
        }
        if trim_at > 0 {
            bytes.truncate(trim_at);
        }
    }
    let truncated = offset.saturating_add(bytes.len() as u64) < size;
    Ok(FileChunk {
        size,
        bytes,
        truncated,
        binary: false,
    })
}

fn read_up_to(file: &mut File, maximum: usize) -> Result<Vec<u8>, ProtocolError> {
    let mut bytes = Vec::with_capacity(maximum.min(BINARY_PROBE_BYTES));
    let mut buffer = [0_u8; 8192];
    while bytes.len() < maximum {
        let wanted = (maximum - bytes.len()).min(buffer.len());
        let count = file
            .read(&mut buffer[..wanted])
            .map_err(|error| io_error("read the selected project file", error))?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    Ok(bytes)
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.contains(&0)
        || matches!(
            std::str::from_utf8(bytes),
            Err(error) if error.error_len().is_some()
        )
}

fn binary_file_chunk(size: u64) -> FileChunk {
    FileChunk {
        size,
        bytes: Vec::new(),
        truncated: false,
        binary: true,
    }
}

fn discover_git_repository(scope: &WorkspaceScope) -> Result<Option<GitRepository>, ProtocolError> {
    let output = run_git_read(&scope.cwd, &["rev-parse", "--show-toplevel"], 64 * 1024)?;
    if output.truncated {
        return Err(ProtocolError::new(
            ErrorCategory::ResourceExhausted,
            "Git repository discovery output exceeded its bounded limit",
        ));
    }
    if !output.status.success() {
        return Ok(None);
    }
    let root_text = std::str::from_utf8(&output.stdout).map_err(|_| {
        ProtocolError::new(
            ErrorCategory::CapabilityUnavailable,
            "Git returned a non-text repository path",
        )
    })?;
    let root = canonicalize_directory(Path::new(root_text.trim()), "the Git repository root")?;
    Ok(Some(GitRepository { root }))
}

/// One entry of `git worktree list --porcelain`. Only documented fields are
/// represented; unknown attributes are ignored so a newer Git cannot crash
/// the projection.
#[derive(Debug, Clone, PartialEq)]
struct WorktreeEntry {
    path: String,
    head: Option<String>,
    branch: Option<String>,
    bare: bool,
    detached: bool,
    locked: bool,
    lock_reason: Option<String>,
    prunable: bool,
    prunable_reason: Option<String>,
}

fn parse_worktree_porcelain(output: &str) -> Result<Vec<WorktreeEntry>, ProtocolError> {
    fn finish(current: &mut Option<WorktreeEntry>, entries: &mut Vec<WorktreeEntry>) {
        if let Some(entry) = current.take() {
            if !entry.path.is_empty() {
                entries.push(entry);
            }
        }
    }
    let mut entries = Vec::new();
    let mut current: Option<WorktreeEntry> = None;
    for line in output.lines() {
        if line.is_empty() {
            finish(&mut current, &mut entries);
            continue;
        }
        let (key, value) = match line.split_once(' ') {
            Some((key, value)) => (key, Some(value.to_string())),
            None => (line, None),
        };
        match key {
            "worktree" => {
                finish(&mut current, &mut entries);
                current = Some(WorktreeEntry {
                    path: value.unwrap_or_default(),
                    head: None,
                    branch: None,
                    bare: false,
                    detached: false,
                    locked: false,
                    lock_reason: None,
                    prunable: false,
                    prunable_reason: None,
                });
            }
            "HEAD" => {
                if let Some(entry) = current.as_mut() {
                    entry.head = value;
                }
            }
            "branch" => {
                if let Some(entry) = current.as_mut() {
                    entry.branch = value;
                }
            }
            "bare" => {
                if let Some(entry) = current.as_mut() {
                    entry.bare = true;
                }
            }
            "detached" => {
                if let Some(entry) = current.as_mut() {
                    entry.detached = true;
                }
            }
            "locked" => {
                if let Some(entry) = current.as_mut() {
                    entry.locked = true;
                    entry.lock_reason = value.filter(|reason| !reason.is_empty());
                }
            }
            "prunable" => {
                if let Some(entry) = current.as_mut() {
                    entry.prunable = true;
                    entry.prunable_reason = value.filter(|reason| !reason.is_empty());
                }
            }
            _ => {}
        }
    }
    finish(&mut current, &mut entries);
    Ok(entries)
}

fn run_git_read(
    cwd: &Path,
    args: &[&str],
    stdout_limit: usize,
) -> Result<ProcessOutput, ProtocolError> {
    let mut command = git_command(cwd, args);
    command.env("GIT_OPTIONAL_LOCKS", "0");
    run_limited(command, stdout_limit, GIT_STDERR_BYTES, GIT_READ_TIMEOUT)
}

fn run_git_mutating(
    cwd: &Path,
    args: &[&str],
    stdout_limit: usize,
    timeout: Duration,
) -> Result<ProcessOutput, ProtocolError> {
    run_limited(
        git_command(cwd, args),
        stdout_limit,
        GIT_STDERR_BYTES,
        timeout,
    )
}

fn git_command(cwd: &Path, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command.arg("-C").arg(display_path(cwd)).args(args);
    command
}

fn run_limited(
    mut command: Command,
    stdout_limit: usize,
    stderr_limit: usize,
    timeout: Duration,
) -> Result<ProcessOutput, ProtocolError> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| spawn_error("Git", error))?;
    let stdout = child.stdout.take().ok_or_else(|| {
        ProtocolError::new(ErrorCategory::Internal, "Git stdout pipe was unavailable")
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        ProtocolError::new(ErrorCategory::Internal, "Git stderr pipe was unavailable")
    })?;
    let (limit_sender, limit_receiver) = mpsc::channel();
    let stdout_sender = limit_sender.clone();
    let stdout_thread = thread::spawn(move || drain_limited(stdout, stdout_limit, stdout_sender));
    let stderr_thread = thread::spawn(move || drain_limited(stderr, stderr_limit, limit_sender));
    let deadline = Instant::now() + timeout;
    let mut exceeded_output_limit = false;
    let status = loop {
        match child
            .try_wait()
            .map_err(|error| spawn_error("Git", error))?
        {
            Some(status) => break status,
            None => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_thread.join();
                    let _ = stderr_thread.join();
                    return Err(ProtocolError::new(
                        ErrorCategory::DeadlineExceeded,
                        "Git operation exceeded its timeout",
                    ));
                }
                if limit_receiver.try_recv().is_ok() {
                    exceeded_output_limit = true;
                    let _ = child.kill();
                    break child.wait().map_err(|error| spawn_error("Git", error))?;
                }
                thread::sleep(Duration::from_millis(5));
            }
        }
    };
    let stdout = stdout_thread
        .join()
        .map_err(|_| ProtocolError::new(ErrorCategory::Internal, "Git stdout reader panicked"))?
        .map_err(|error| spawn_error("read Git output", error))?;
    let stderr = stderr_thread
        .join()
        .map_err(|_| ProtocolError::new(ErrorCategory::Internal, "Git stderr reader panicked"))?
        .map_err(|error| spawn_error("read Git output", error))?;
    Ok(ProcessOutput {
        status,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
        truncated: exceeded_output_limit || stdout.truncated || stderr.truncated,
    })
}

fn drain_limited<R: Read>(
    mut reader: R,
    maximum: usize,
    limit_sender: mpsc::Sender<()>,
) -> io::Result<LimitedBytes> {
    let mut bytes = Vec::with_capacity(maximum.min(BINARY_PROBE_BYTES));
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        let remaining = maximum.saturating_sub(bytes.len());
        if count <= remaining {
            bytes.extend_from_slice(&buffer[..count]);
        } else {
            if remaining > 0 {
                bytes.extend_from_slice(&buffer[..remaining]);
            }
            if !truncated {
                truncated = true;
                let _ = limit_sender.send(());
            }
        }
    }
    Ok(LimitedBytes { bytes, truncated })
}

fn spawn_error(action: &str, error: io::Error) -> ProtocolError {
    if error.kind() == io::ErrorKind::NotFound {
        ProtocolError::new(
            ErrorCategory::CapabilityUnavailable,
            format!("{action} executable is unavailable"),
        )
    } else {
        ProtocolError::new(ErrorCategory::Internal, format!("{action}: {error}"))
    }
}

fn io_error(action: &str, error: io::Error) -> ProtocolError {
    let category = match error.kind() {
        io::ErrorKind::NotFound => ErrorCategory::NotFound,
        io::ErrorKind::PermissionDenied => ErrorCategory::PermissionDenied,
        _ => ErrorCategory::Internal,
    };
    ProtocolError::new(category, format!("cannot {action}: {error}"))
}

fn git_failure(action: &str, output: &ProcessOutput) -> ProtocolError {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let suffix = stderr.lines().next().filter(|line| !line.trim().is_empty());
    let message = suffix
        .map(|line| format!("Git could not {action}: {line}"))
        .unwrap_or_else(|| format!("Git could not {action}"));
    ProtocolError::new(ErrorCategory::CapabilityUnavailable, message)
}

fn git_optional_line(cwd: &Path, args: &[&str]) -> Result<Option<String>, ProtocolError> {
    let output = run_git_read(cwd, args, 64 * 1024)?;
    if output.truncated || !output.status.success() {
        return Ok(None);
    }
    let text = std::str::from_utf8(&output.stdout)
        .ok()
        .map(str::trim)
        .unwrap_or_default();
    Ok((!text.is_empty()).then(|| text.to_string()))
}

fn git_required_line(
    cwd: &Path,
    args: &[&str],
    missing_message: &str,
) -> Result<String, ProtocolError> {
    let output = run_git_read(cwd, args, 64 * 1024)?;
    if output.truncated || !output.status.success() {
        return Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            missing_message,
        ));
    }
    let text = std::str::from_utf8(&output.stdout)
        .ok()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .ok_or_else(|| ProtocolError::new(ErrorCategory::InvalidArgument, missing_message))?;
    Ok(text.to_string())
}

fn repository_root_for_scope(scope: &WorkspaceScope, repository: &GitRepository) -> Value {
    repository
        .root
        .strip_prefix(&scope.cwd)
        .ok()
        .map(|path| {
            if path.as_os_str().is_empty() {
                ".".to_string()
            } else {
                path.to_string_lossy().replace('\\', "/")
            }
        })
        .map(Value::String)
        .unwrap_or(Value::Null)
}

fn git_unavailable_value(scope: &WorkspaceScope) -> Value {
    json!({
        "workspace": scope.workspace_value(),
        "available": false,
        "root": Value::Null,
        "branch": Value::Null,
        "head": Value::Null,
        "staged": [],
        "unstaged": [],
        "untracked": [],
        "conflicts": [],
        "clean": true,
    })
}

#[derive(Default)]
struct ParsedStatus {
    staged: Vec<Value>,
    unstaged: Vec<Value>,
    untracked: Vec<Value>,
    conflicts: Vec<Value>,
}

fn parse_status_porcelain(
    scope: &WorkspaceScope,
    repository: &GitRepository,
    bytes: &[u8],
) -> Result<ParsedStatus, ProtocolError> {
    let mut result = ParsedStatus::default();
    let mut records = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    while let Some(record) = records.next() {
        if record.len() < 3 || record[2] != b' ' {
            return Err(ProtocolError::new(
                ErrorCategory::Internal,
                "Git returned malformed porcelain status",
            ));
        }
        let x = record[0] as char;
        let y = record[1] as char;
        let status = String::from_utf8_lossy(&record[..2]).to_string();
        let primary_raw = std::str::from_utf8(&record[3..]).map_err(|_| {
            ProtocolError::new(
                ErrorCategory::CapabilityUnavailable,
                "Git returned a non-text file path",
            )
        })?;
        let has_original = matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C');
        let original = if has_original {
            let next = records.next().ok_or_else(|| {
                ProtocolError::new(
                    ErrorCategory::Internal,
                    "Git returned an incomplete rename status",
                )
            })?;
            Some(std::str::from_utf8(next).map_err(|_| {
                ProtocolError::new(
                    ErrorCategory::CapabilityUnavailable,
                    "Git returned a non-text rename path",
                )
            })?)
        } else {
            None
        };
        let Some(path) = safe_git_relative_path(scope, repository, primary_raw) else {
            continue;
        };
        let old_path = original.and_then(|path| safe_git_relative_path(scope, repository, path));
        let value = git_file_value(&path, &status, old_path.as_deref());
        if status == "??" {
            result.untracked.push(value);
        } else if is_conflict(x, y) {
            result.conflicts.push(value);
        } else {
            if x != ' ' {
                result.staged.push(value.clone());
            }
            if y != ' ' {
                result.unstaged.push(value);
            }
        }
    }
    for list in [
        &mut result.staged,
        &mut result.unstaged,
        &mut result.untracked,
        &mut result.conflicts,
    ] {
        list.sort_by(|left, right| {
            left["path"]
                .as_str()
                .unwrap_or_default()
                .cmp(right["path"].as_str().unwrap_or_default())
        });
    }
    Ok(result)
}

fn safe_git_relative_path(
    scope: &WorkspaceScope,
    repository: &GitRepository,
    raw: &str,
) -> Option<String> {
    let raw = Path::new(raw);
    let scope_from_root = scope.cwd.strip_prefix(&repository.root).ok()?;
    let relative = if scope_from_root.as_os_str().is_empty() {
        raw
    } else {
        // Porcelain and `ls-files` paths are repository-root relative. Do
        // not fall back to treating an outside root-relative path as a cwd
        // path: a same-named file under the workspace could otherwise make
        // an outside change appear in this scoped result.
        raw.strip_prefix(scope_from_root).ok()?
    };
    let target = resolve_relative_path(scope, relative.to_str()?, false).ok()?;
    scope_relative_path(scope, &target).ok()
}

fn git_file_value(path: &str, status: &str, old_path: Option<&str>) -> Value {
    let mut value = Map::new();
    value.insert("path".to_string(), Value::String(path.to_string()));
    value.insert("status".to_string(), Value::String(status.to_string()));
    if let Some(old_path) = old_path {
        value.insert("oldPath".to_string(), Value::String(old_path.to_string()));
    }
    Value::Object(value)
}

fn is_conflict(x: char, y: char) -> bool {
    matches!(
        (x, y),
        ('D', 'D') | ('A', 'U') | ('U', 'D') | ('U', 'A') | ('D', 'U') | ('A', 'A') | ('U', 'U')
    )
}

fn git_path_is_untracked(scope: &WorkspaceScope, path: &str) -> Result<bool, ProtocolError> {
    let literal_pathspec = git_literal_pathspec(path);
    let output = run_git_read(
        &scope.cwd,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            &literal_pathspec,
        ],
        64 * 1024,
    )?;
    if output.truncated || !output.status.success() {
        return Ok(false);
    }
    // The pathspec is one already-canonicalized regular file. `ls-files`
    // therefore has no reason to return any other path; only its bounded,
    // non-empty result matters. Unlike porcelain, its output can be cwd
    // relative, so reinterpreting it as a repository-root path is incorrect.
    Ok(!output.stdout.is_empty())
}

/// Git's `--` ends option parsing but leaves pathspec magic active. Every
/// caller-owned project path must therefore use literal magic as well: a name
/// such as `:(top)secret.txt` is a normal file name in the workspace, never a
/// request to reinterpret the repository root.
fn git_literal_pathspec(path: &str) -> String {
    format!(":(literal){path}")
}

fn decode_git_text(bytes: &[u8], truncated: bool) -> Result<(String, bool), ProtocolError> {
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok((text.to_string(), false)),
        Err(error) if truncated => {
            let valid = error.valid_up_to();
            Ok((String::from_utf8_lossy(&bytes[..valid]).to_string(), true))
        }
        Err(_) => Err(ProtocolError::new(
            ErrorCategory::CapabilityUnavailable,
            "Git diff is non-text and cannot be returned as content",
        )),
    }
}

fn untracked_unified_diff(
    path: &str,
    text: &str,
    content_truncated: bool,
    maximum: usize,
) -> (String, bool) {
    let mut diff = String::new();
    let line_count = text.lines().count();
    let mut truncated = false;
    for part in [
        format!("diff --git a/{path} b/{path}\\n"),
        "new file mode 100644\\n".to_string(),
        "--- /dev/null\\n".to_string(),
        format!("+++ b/{path}\\n"),
        if text.is_empty() {
            String::new()
        } else {
            format!("@@ -0,0 +1,{line_count} @@\\n")
        },
    ] {
        truncated |= push_limited(&mut diff, &part, maximum);
        if truncated {
            return (diff, true);
        }
    }
    for line in text.split_inclusive('\n') {
        truncated |= push_limited(&mut diff, "+", maximum);
        truncated |= push_limited(&mut diff, line, maximum);
        if truncated {
            return (diff, true);
        }
    }
    if !content_truncated && !text.is_empty() && !text.ends_with('\n') {
        truncated |= push_limited(&mut diff, "\\ No newline at end of file\\n", maximum);
    }
    (diff, truncated || content_truncated)
}

fn push_limited(output: &mut String, part: &str, maximum: usize) -> bool {
    if output.len() + part.len() <= maximum {
        output.push_str(part);
        return false;
    }
    let remaining = maximum.saturating_sub(output.len());
    if remaining > 0 {
        let mut end = remaining.min(part.len());
        while end > 0 && !part.is_char_boundary(end) {
            end -= 1;
        }
        output.push_str(&part[..end]);
    }
    true
}

fn validate_branch_name(branch: &str) -> Result<(), ProtocolError> {
    if branch.is_empty()
        || branch.len() > 120
        || branch.starts_with('-')
        || branch.starts_with('/')
        || branch.ends_with('/')
        || branch.contains("..")
        || branch.contains("//")
        || branch.contains("@{")
        || branch.ends_with('.')
        || branch.ends_with(".lock")
        || !branch
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/'))
    {
        return Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            "branch must be a safe, new Git branch name",
        ));
    }
    Ok(())
}

fn validate_base_ref(base_ref: &str) -> Result<(), ProtocolError> {
    if base_ref.is_empty()
        || base_ref.len() > 160
        || base_ref.starts_with('-')
        || base_ref.contains("..")
        || base_ref.contains("@{")
        || base_ref.contains(':')
        || !base_ref.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'/' | b'^')
        })
    {
        return Err(ProtocolError::new(
            ErrorCategory::InvalidArgument,
            "baseRef must be a safe Git branch, tag, or commit reference",
        ));
    }
    Ok(())
}

/// Return the one canonical parent approved for worktrees created by this
/// daemon. The generated child is never accepted by cleanup unless it still
/// resolves beneath this directory.
fn canonical_worktrees_root(home: &Path) -> Result<PathBuf, ProtocolError> {
    if is_codex_path(home) {
        return Err(ProtocolError::new(
            ErrorCategory::PreconditionFailed,
            "Knorvia worktrees cannot be created inside a Codex Home",
        ));
    }
    fs::create_dir_all(home.join("worktrees"))
        .map_err(|error| io_error("create the Knorvia worktree directory", error))?;
    let canonical_home = canonicalize_directory(home, "Knorvia Home")?;
    let worktrees =
        canonicalize_directory(&home.join("worktrees"), "the Knorvia worktree directory")?;
    if !worktrees.starts_with(&canonical_home) {
        return Err(ProtocolError::new(
            ErrorCategory::PermissionDenied,
            "Knorvia worktree directory resolves outside Knorvia Home",
        ));
    }
    Ok(worktrees)
}

/// Best-effort compensation after this invocation's `git worktree add -b`
/// completed. A canonical containment check prevents a stale or replaced path
/// from directing Git at anything outside the generated Knorvia location.
/// Cleanup failures deliberately preserve the original operation failure.
fn cleanup_created_worktree(
    repository: &GitRepository,
    worktrees_root: &Path,
    destination: &Path,
    branch: &str,
) {
    let Ok(destination) = fs::canonicalize(destination) else {
        return;
    };
    if !destination.starts_with(worktrees_root) {
        return;
    }
    let destination_string = display_path(&destination);
    let removed = run_git_mutating(
        &repository.root,
        &["worktree", "remove", "--force", &destination_string],
        MAX_DIFF_BYTES,
        GIT_WORKTREE_TIMEOUT,
    )
    .map(|output| output.status.success())
    .unwrap_or(false);
    if removed {
        // `-b` on a successful add created this name. If another user made it
        // live in the meantime Git refuses deletion, which is safer than
        // overriding their state.
        let _ = run_git_mutating(
            &repository.root,
            &["branch", "-D", "--", branch],
            GIT_STDERR_BYTES,
            GIT_WORKTREE_TIMEOUT,
        );
    }
}

fn generated_worktree_path(
    home: &Path,
    source_workspace_id: &str,
    branch: &str,
) -> Result<PathBuf, ProtocolError> {
    if !source_workspace_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(ProtocolError::new(
            ErrorCategory::Internal,
            "source workspace id is not safe for a worktree path",
        ));
    }
    let worktrees = canonical_worktrees_root(home)?;
    let source_dir = worktrees.join(source_workspace_id);
    fs::create_dir_all(&source_dir)
        .map_err(|error| io_error("create the source worktree directory", error))?;
    let source_dir = fs::canonicalize(&source_dir)
        .map_err(|error| io_error("resolve the source worktree directory", error))?;
    if !source_dir.starts_with(&worktrees) {
        return Err(ProtocolError::new(
            ErrorCategory::PermissionDenied,
            "source worktree directory resolves outside Knorvia Home",
        ));
    }
    let slug = branch.replace('/', "-");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| ProtocolError::new(ErrorCategory::Internal, error.to_string()))?
        .as_nanos();
    for attempt in 0..100_u16 {
        let candidate = source_dir.join(format!("{slug}-{}-{nonce}-{attempt}", std::process::id()));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(ProtocolError::new(
        ErrorCategory::ResourceExhausted,
        "could not allocate a unique Knorvia worktree directory",
    ))
}

#[cfg(test)]
#[path = "project_context_tests.rs"]
mod project_context_tests;
