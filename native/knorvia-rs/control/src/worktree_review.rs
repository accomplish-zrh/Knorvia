//! Read-only pre-delivery worktree review (B05, night 2026-09-10).
//!
//! `workspace/git/compare` freezes both sides of a delivery (HEAD and an
//! explicitly resolved target ref) and reports ahead/behind, the commits and
//! files each side contributes, the source tree's uncommitted state, and a
//! `git merge-tree` conflict prediction. `workspace/git/compare-diff` returns
//! one file's diff for exactly the two frozen commits.
//!
//! Everything here is read-only and bounded: no merge is ever performed, the
//! working tree and index are never touched (`GIT_OPTIONAL_LOCKS=0`,
//! `merge-tree --write-tree` works on a temporary index), and every Git call
//! has a byte limit and a hard deadline. Anything the tooling cannot
//! determine is reported as `"undetermined"` instead of being guessed.

use super::*;
use std::io::Read;
use std::path::PathBuf;
use std::process::Command as StdCommand;
use std::sync::mpsc;
use std::time::Duration;

const REVIEW_DEFAULT_BYTES: usize = 64 * 1024;
const REVIEW_MAX_BYTES: usize = 512 * 1024;
const REVIEW_DIFF_BYTES: usize = 256 * 1024;
const REVIEW_TIMEOUT: Duration = Duration::from_secs(20);
const REVIEW_STDERR_BYTES: usize = 8 * 1024;
const MAX_COMMITS: usize = 200;
const MAX_STATUS_ENTRIES: usize = 500;
/// Full object names only: compare-diff must be bound to the exact SHAs the
/// compare step froze, so abbreviated or symbolic names are refused.
const FULL_OID_LEN: usize = 40;

#[derive(Debug)]
struct ReviewOutput {
    status_code: Option<i32>,
    stdout: String,
    stderr: String,
    truncated: bool,
}

impl ReviewOutput {
    fn success(&self) -> bool {
        self.status_code == Some(0)
    }

    /// Git exits 129 with a usage error when a subcommand is unknown.
    fn unknown_command(&self) -> bool {
        self.status_code == Some(129)
    }

    /// `git merge-tree --write-tree` exits 1 for conflicts and 2 for errors;
    /// status 1 carries the tree id plus conflicted paths on stdout.
    fn merge_conflict(&self) -> bool {
        self.status_code == Some(1) && !self.stdout.trim().is_empty()
    }
}

fn review_error(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(ErrorCategory::CapabilityUnavailable, message)
}

fn invalid(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(ErrorCategory::InvalidArgument, message)
}

fn review_failure(action: &str, stderr: &str) -> ProtocolError {
    ProtocolError::new(
        ErrorCategory::CapabilityUnavailable,
        format!("could not {action}: {}", stderr.trim()),
    )
}

fn bounded_review_bytes(params: &Value, key: &str, default: usize) -> Result<usize, ProtocolError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(default),
        Some(value) => {
            let limit = value
                .as_u64()
                .ok_or_else(|| invalid(format!("{key} must be an unsigned integer")))?;
            if limit == 0 || limit as usize > REVIEW_MAX_BYTES {
                return Err(invalid(format!(
                    "{key} must be between 1 and {REVIEW_MAX_BYTES}"
                )));
            }
            Ok(limit as usize)
        }
    }
}

fn drain_pipe(mut pipe: impl Read, limit: usize, truncated_sender: mpsc::Sender<bool>) -> Vec<u8> {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 16 * 1024];
    loop {
        match pipe.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let room = limit.saturating_sub(bytes.len());
                bytes.extend_from_slice(&buffer[..read.min(room)]);
                if read > room {
                    let _ = truncated_sender.send(true);
                    // Keep draining so git can finish, but stop storing.
                }
            }
        }
    }
    bytes
}

/// A bounded git read. Mirrors the crate's process discipline (piped output,
/// hard deadline, kill on overrun) without sharing mutable state with
/// project_context: this module stays independently reviewable.
fn run_review_git(
    cwd: &Path,
    args: &[&str],
    stdout_limit: usize,
) -> Result<ReviewOutput, ProtocolError> {
    let mut command = StdCommand::new("git");
    command.arg("-C").arg(cwd).args(args);
    command.env("GIT_OPTIONAL_LOCKS", "0");
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| review_error(format!("could not run git: {error}")))?;
    let stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| review_error("git stdout pipe was unavailable"))?;
    let stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| review_error("git stderr pipe was unavailable"))?;
    let (stdout_truncated_sender, stdout_truncated_receiver) = mpsc::channel();
    let (stderr_truncated_sender, stderr_truncated_receiver) = mpsc::channel();
    let stdout_thread =
        std::thread::spawn(move || drain_pipe(stdout_pipe, stdout_limit, stdout_truncated_sender));
    let stderr_thread = std::thread::spawn(move || {
        drain_pipe(stderr_pipe, REVIEW_STDERR_BYTES, stderr_truncated_sender)
    });
    let deadline = std::time::Instant::now() + REVIEW_TIMEOUT;
    let mut stdout_truncated = false;
    let status = loop {
        match child
            .try_wait()
            .map_err(|error| review_error(format!("git poll failed: {error}")))?
        {
            Some(status) => break status,
            None => {
                if let Ok(truncated) = stdout_truncated_receiver.try_recv() {
                    stdout_truncated = truncated || stdout_truncated;
                }
                if stdout_truncated {
                    // The byte bound was hit; stop the process and finish.
                    let _ = child.kill();
                    let status = child
                        .wait()
                        .map_err(|error| review_error(format!("git wait failed: {error}")))?;
                    let _ = stderr_truncated_receiver.try_recv();
                    break status;
                }
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_thread.join();
                    let _ = stderr_thread.join();
                    return Err(ProtocolError::new(
                        ErrorCategory::DeadlineExceeded,
                        "git review read exceeded its timeout",
                    ));
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    };
    let stdout_bytes = stdout_thread.join().unwrap_or_default();
    let stderr_bytes = stderr_thread.join().unwrap_or_default();
    Ok(ReviewOutput {
        status_code: status.code(),
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        truncated: stdout_truncated,
    })
}

fn discover_review_repository(cwd: &Path) -> Result<Option<PathBuf>, ProtocolError> {
    let output = run_review_git(cwd, &["rev-parse", "--show-toplevel"], 4 * 1024)?;
    if output.success() {
        let root = output.stdout.trim().to_string();
        if root.is_empty() {
            return Ok(None);
        }
        return Ok(Some(PathBuf::from(root)));
    }
    // "not a git repository" and friends simply mean unavailable.
    Ok(None)
}

fn rev_parse_commit(cwd: &Path, revision: &str) -> Result<Option<String>, ProtocolError> {
    let arg = format!("{revision}^{{commit}}");
    let output = run_review_git(cwd, &["rev-parse", "--verify", "--quiet", &arg], 128)?;
    if !output.success() {
        return Ok(None);
    }
    let oid = output.stdout.trim().to_string();
    if oid.len() != FULL_OID_LEN || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Ok(None);
    }
    Ok(Some(oid.to_ascii_lowercase()))
}

fn is_full_oid(value: &str) -> bool {
    value.len() == FULL_OID_LEN && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn commit_log(cwd: &Path, range: &str, max_bytes: usize) -> Result<Vec<Value>, ProtocolError> {
    let output = run_review_git(
        cwd,
        &[
            "log",
            "--no-color",
            "--date=iso-strict",
            "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s",
            &format!("--max-count={MAX_COMMITS}"),
            range,
        ],
        max_bytes,
    )?;
    if !output.success() {
        return Err(review_failure("list commits", &output.stderr));
    }
    let mut commits = Vec::new();
    for line in output.stdout.lines().filter(|line| !line.is_empty()) {
        let mut parts = line.split('\u{1f}');
        let (Some(id), Some(short), Some(author), Some(at), Some(subject)) = (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
        ) else {
            continue;
        };
        commits.push(json!({
            "id": id,
            "short": short,
            "author": author,
            "atMs": at.parse::<u64>().ok(),
            "subject": subject,
        }));
    }
    Ok(commits)
}

/// `git status --porcelain -z` of the source tree. Overflow past the entry
/// cap is reported through `truncated`, never silently dropped.
fn source_dirty_state(cwd: &Path) -> Result<Value, ProtocolError> {
    let output = run_review_git(cwd, &["status", "--porcelain", "-z"], REVIEW_DEFAULT_BYTES)?;
    if !output.success() {
        return Err(review_failure("read repository status", &output.stderr));
    }
    let mut staged: Vec<String> = Vec::new();
    let mut unstaged: Vec<String> = Vec::new();
    let mut untracked: Vec<String> = Vec::new();
    let mut truncated = output.truncated;
    for entry in output.stdout.split('\0').filter(|entry| !entry.is_empty()) {
        if staged.len() + unstaged.len() + untracked.len() >= MAX_STATUS_ENTRIES {
            truncated = true;
            break;
        }
        let mut bytes = entry.bytes();
        let x = bytes.next().unwrap_or(b' ') as char;
        let y = bytes.next().unwrap_or(b' ') as char;
        if entry.len() < 4 {
            continue;
        }
        let path = entry[3..].to_string();
        if x == '?' && y == '?' {
            untracked.push(path);
            continue;
        }
        if x != ' ' {
            staged.push(path.clone());
        }
        if y != ' ' {
            unstaged.push(path);
        }
    }
    Ok(json!({
        "staged": staged,
        "unstaged": unstaged,
        "untracked": untracked,
        "truncated": truncated,
    }))
}

/// Conflict prediction via the porcelain merge-tree. The repository is never
/// mutated; a Git build without the subcommand yields `undetermined`.
fn conflict_prediction(
    cwd: &Path,
    source_sha: &str,
    target_sha: &str,
) -> Result<Value, ProtocolError> {
    let output = run_review_git(
        cwd,
        &[
            "merge-tree",
            "--write-tree",
            "--name-only",
            source_sha,
            target_sha,
        ],
        REVIEW_DEFAULT_BYTES,
    )?;
    // A plain fn item: the elided output lifetime must bind to the input
    // `&str`, which a closure literal infers differently.
    fn conflicted_files(stdout: &str) -> Vec<&str> {
        // B05 follow-up (2026-09-11): the path block ends at the first blank
        // line; everything after it is git's informational narration
        // ("Auto-merging ...", "CONFLICT ...") and must not be reported as
        // a conflicted file.
        let mut lines = stdout.lines().skip(1);
        let mut files = Vec::new();
        for line in lines.by_ref() {
            if line.trim().is_empty() {
                break;
            }
            files.push(line);
        }
        files
    }
    if output.success() {
        let files = conflicted_files(&output.stdout);
        let state = if files.is_empty() {
            "clean"
        } else {
            "conflict"
        };
        return Ok(json!({"state": state, "files": files, "reason": null}));
    }
    if output.merge_conflict() {
        return Ok(json!({
            "state": "conflict",
            "files": conflicted_files(&output.stdout),
            "reason": null,
        }));
    }
    if output.unknown_command() {
        return Ok(json!({
            "state": "undetermined",
            "reason": "this Git build does not expose merge-tree --write-tree",
            "files": [],
        }));
    }
    Ok(json!({
        "state": "undetermined",
        "reason": output.stderr.trim(),
        "files": [],
    }))
}

fn changed_files(
    cwd: &Path,
    from: &str,
    to: &str,
    max_bytes: usize,
) -> Result<Vec<Value>, ProtocolError> {
    let range = format!("{from}..{to}");
    let output = run_review_git(
        cwd,
        &[
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--name-status",
            &range,
        ],
        max_bytes,
    )?;
    if !output.success() {
        return Err(review_failure("list changed files", &output.stderr));
    }
    let mut files = Vec::new();
    for line in output.stdout.lines().filter(|line| !line.is_empty()) {
        let mut parts = line.split('\t');
        let (Some(status), Some(path)) = (parts.next(), parts.next()) else {
            continue;
        };
        files.push(json!({"path": path, "status": status}));
    }
    Ok(files)
}

impl ControlPlane {
    /// Freeze both sides and report everything a delivery review needs. Read-only
    /// by construction: nothing here writes the working tree or the index.
    pub(crate) fn rpc_workspace_git_compare(&self, params: &Value) -> Result<Value, ProtocolError> {
        let scope = self.resolve_workspace_scope(params)?;
        let target_ref = params
            .get("targetRef")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid("targetRef is required"))?;
        if target_ref.contains("..") || target_ref.contains('\0') || target_ref.starts_with('-') {
            return Err(invalid(
                "targetRef must be a single revision, not a range or an option",
            ));
        }
        let max_bytes = bounded_review_bytes(params, "maxBytes", REVIEW_DEFAULT_BYTES)?;
        if discover_review_repository(&scope.cwd)?.is_none() {
            return Ok(json!({
                "workspace": scope.workspace_value(),
                "available": false,
            }));
        }

        // Freeze both sides up front: every later fact is computed between these
        // two object ids, never between moving names.
        let source_sha = rev_parse_commit(&scope.cwd, "HEAD")?.ok_or_else(|| {
            review_error("HEAD is unborn; make a commit before a delivery review")
        })?;
        let target_sha = rev_parse_commit(&scope.cwd, target_ref)?.ok_or_else(|| {
            invalid(format!(
                "targetRef {target_ref} did not resolve to a commit"
            ))
        })?;

        let counting = run_review_git(
            &scope.cwd,
            &[
                "rev-list",
                "--left-right",
                "--count",
                &format!("{source_sha}...{target_sha}"),
            ],
            4 * 1024,
        )?;
        if !counting.success() {
            return Err(review_failure("count ahead/behind", &counting.stderr));
        }
        let mut counts = counting.stdout.split('\t');
        let behind: usize = counts
            .next()
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(0);
        let ahead: usize = counts
            .next()
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(0);

        let merge_base =
            run_review_git(&scope.cwd, &["merge-base", &source_sha, &target_sha], 128)?;
        let merge_base = if merge_base.success() {
            Some(merge_base.stdout.trim().to_string())
        } else {
            None
        };

        let incoming_files = match &merge_base {
            Some(base) => changed_files(&scope.cwd, base, &target_sha, max_bytes)?,
            None => Vec::new(),
        };
        let outgoing_files = match &merge_base {
            Some(base) => changed_files(&scope.cwd, base, &source_sha, max_bytes)?,
            None => Vec::new(),
        };
        let incoming_commits = commit_log(
            &scope.cwd,
            &format!("{source_sha}..{target_sha}"),
            max_bytes,
        )?;
        let outgoing_commits = commit_log(
            &scope.cwd,
            &format!("{target_sha}..{source_sha}"),
            max_bytes,
        )?;
        let dirty = source_dirty_state(&scope.cwd)?;
        let conflicts = conflict_prediction(&scope.cwd, &source_sha, &target_sha)?;

        Ok(json!({
            "workspace": scope.workspace_value(),
            "available": true,
            "sourceRef": "HEAD",
            "sourceSha": source_sha,
            "targetRef": target_ref,
            "targetSha": target_sha,
            "mergeBaseSha": merge_base,
            "ahead": ahead,
            "behind": behind,
            "incomingCommits": incoming_commits,
            "outgoingCommits": outgoing_commits,
            "incomingFiles": incoming_files,
            "outgoingFiles": outgoing_files,
            "dirty": dirty,
            "conflicts": conflicts,
        }))
    }

    /// One file's diff between two frozen commits. Both SHAs must be the full
    /// object names frozen by `workspace/git/compare`, and the path must be part
    /// of that comparison, so a stale dialog cannot probe unrelated content.
    pub(crate) fn rpc_workspace_git_compare_diff(
        &self,
        params: &Value,
    ) -> Result<Value, ProtocolError> {
        let scope = self.resolve_workspace_scope(params)?;
        let base_sha = params
            .get("baseSha")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("baseSha is required"))?;
        let head_sha = params
            .get("headSha")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("headSha is required"))?;
        let path = params
            .get("path")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 1024)
            .ok_or_else(|| invalid("path is required"))?;
        for (name, value) in [("baseSha", base_sha), ("headSha", head_sha)] {
            if !is_full_oid(value) {
                return Err(invalid(format!(
                    "{name} must be a full {FULL_OID_LEN}-character object id"
                )));
            }
        }
        if path.contains("..") || path.starts_with('-') || path.contains('\0') {
            return Err(invalid("path must be a plain repository-relative path"));
        }
        let max_bytes = bounded_review_bytes(params, "maxBytes", REVIEW_DIFF_BYTES)?;
        if discover_review_repository(&scope.cwd)?.is_none() {
            return Err(review_error("this project does not use Git"));
        }
        // Re-bind both SHAs at read time: the frozen ids must still resolve, and
        // to the same commits their names claim.
        for (name, value) in [("baseSha", base_sha), ("headSha", head_sha)] {
            match rev_parse_commit(&scope.cwd, value)? {
                Some(resolved) if resolved == value.to_ascii_lowercase() => {}
                _ => return Err(invalid(format!("{name} no longer resolves to that commit"))),
            }
        }
        // Strict path binding: the path must be inside the frozen two-SHA diff.
        let listing = run_review_git(
            &scope.cwd,
            &[
                "diff",
                "--no-ext-diff",
                "--no-color",
                "--name-only",
                base_sha,
                head_sha,
            ],
            REVIEW_MAX_BYTES,
        )?;
        if !listing.success() {
            return Err(review_failure("list comparison files", &listing.stderr));
        }
        let wanted = path.replace('\\', "/");
        let listed = listing
            .stdout
            .lines()
            .any(|line| line.replace('\\', "/") == wanted);
        if !listed {
            return Err(invalid(format!(
                "path {path} is not part of the frozen comparison"
            )));
        }

        let output = run_review_git(
            &scope.cwd,
            &[
                "diff",
                "--no-ext-diff",
                "--no-color",
                "--unified=3",
                base_sha,
                head_sha,
                "--",
                path,
            ],
            max_bytes,
        )?;
        if !output.success() && !output.truncated {
            return Err(review_failure("read the comparison diff", &output.stderr));
        }
        Ok(json!({
            "workspace": scope.workspace_value(),
            "baseSha": base_sha,
            "headSha": head_sha,
            "path": path,
            "diff": output.stdout,
            "truncated": output.truncated || output.stdout.len() >= max_bytes,
        }))
    }
}

#[cfg(test)]
mod worktree_review_tests {
    use super::*;
    use crate::KernelTurnExecutor;
    use knorvia_platform_paths::layout;
    use std::fs;
    use std::process::Command as TestCommand;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn git(cwd: &Path, args: &[&str]) {
        let status = TestCommand::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .status()
            .expect("git should be runnable");
        assert!(status.success(), "git {args:?} failed");
    }

    struct Fixture {
        root: PathBuf,
        repo: PathBuf,
    }

    impl Fixture {
        /// One branch ("main") with two commits; a second branch ("feature")
        /// forked after the first commit.
        fn new(tag: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "knorvia-worktree-review-{tag}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let repo = root.join("repo");
            fs::create_dir_all(&repo).unwrap();
            git(&repo, &["init", "-q", "-b", "main"]);
            git(&repo, &["config", "user.name", "Knorvia Test"]);
            git(
                &repo,
                &["config", "user.email", "knorvia-test@example.invalid"],
            );
            fs::write(repo.join("shared.txt"), "line one\nline two\n").unwrap();
            fs::write(repo.join("kept.txt"), "kept\n").unwrap();
            git(&repo, &["add", "."]);
            git(&repo, &["commit", "-q", "-m", "base"]);
            git(&repo, &["checkout", "-q", "-b", "feature"]);
            fs::write(repo.join("shared.txt"), "line one\nfeature edit\n").unwrap();
            git(&repo, &["add", "."]);
            git(&repo, &["commit", "-q", "-m", "feature change"]);
            git(&repo, &["checkout", "-q", "main"]);
            fs::write(repo.join("shared.txt"), "line one\nmain edit\n").unwrap();
            git(&repo, &["add", "."]);
            git(&repo, &["commit", "-q", "-m", "main change"]);
            Self { root, repo }
        }

        fn plane(&self) -> ControlPlane {
            let home = self.root.join("home");
            let paths = layout(home);
            ControlPlane::open_with_executor(
                paths.clone(),
                Box::new(KernelTurnExecutor::new(paths)),
            )
            .unwrap()
        }

        fn workspace(&self, plane: &ControlPlane) -> String {
            plane
                .store()
                .create_workspace_with_cwd("review", Some(self.repo.to_str().unwrap()))
                .unwrap()
                .id
        }

        fn cleanup(self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn compare_freezes_shas_and_predicts_a_conflict_on_diverged_branches() {
        let fixture = Fixture::new("conflict");
        let plane = fixture.plane();
        let workspace = fixture.workspace(&plane);
        let result = plane
            .rpc_workspace_git_compare(&json!({
                "workspaceId": workspace,
                "targetRef": "feature",
            }))
            .unwrap();
        assert_eq!(result["available"], json!(true));
        let source_sha = result["sourceSha"].as_str().unwrap();
        let target_sha = result["targetSha"].as_str().unwrap();
        assert_eq!(source_sha.len(), 40);
        assert_eq!(target_sha.len(), 40);
        assert_ne!(source_sha, target_sha);
        assert_eq!(result["mergeBaseSha"].is_null(), false);
        // main moved ahead with its own commit while feature holds another.
        assert_eq!(result["ahead"], json!(1));
        assert_eq!(result["behind"], json!(1));
        assert_eq!(
            result["incomingCommits"].as_array().unwrap().len(),
            1,
            "feature carries exactly one incoming commit"
        );
        assert_eq!(result["conflicts"]["state"], json!("conflict"));
        let files: Vec<&str> = result["conflicts"]["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect();
        assert_eq!(
            files.len(),
            1,
            "informational merge narration must not appear as a conflicted file: {files:?}"
        );
        assert!(files[0].contains("shared.txt"));
        assert_eq!(result["dirty"]["staged"].as_array().unwrap().len(), 0);
        fixture.cleanup();
    }

    #[test]
    fn compare_diff_is_bound_to_full_shas_and_to_compared_paths_only() {
        let fixture = Fixture::new("binding");
        let plane = fixture.plane();
        let workspace = fixture.workspace(&plane);
        let compare = plane
            .rpc_workspace_git_compare(&json!({ "workspaceId": workspace, "targetRef": "feature" }))
            .unwrap();
        let base = compare["sourceSha"].as_str().unwrap();
        let head = compare["targetSha"].as_str().unwrap();
        let diff = plane
            .rpc_workspace_git_compare_diff(&json!({
                "workspaceId": workspace, "baseSha": base, "headSha": head, "path": "shared.txt",
            }))
            .unwrap();
        assert!(diff["diff"].as_str().unwrap().contains("feature edit"));
        // An abbreviated SHA is refused even though git itself would accept it.
        let short = plane.rpc_workspace_git_compare_diff(&json!({
            "workspaceId": workspace, "baseSha": &base[..8], "headSha": head, "path": "shared.txt",
        }));
        assert_eq!(short.unwrap_err().category, ErrorCategory::InvalidArgument);
        // A path outside the frozen comparison is refused.
        let outside = plane.rpc_workspace_git_compare_diff(&json!({
            "workspaceId": workspace, "baseSha": base, "headSha": head, "path": "kept.txt",
        }));
        assert_eq!(
            outside.unwrap_err().category,
            ErrorCategory::InvalidArgument
        );
        fixture.cleanup();
    }

    #[test]
    fn non_git_workspaces_report_unavailable_and_undocumented_refs_are_refused() {
        let root = std::env::temp_dir().join(format!(
            "knorvia-worktree-review-plain-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let plain = root.join("plain");
        fs::create_dir_all(&plain).unwrap();
        let paths = layout(root.join("home"));
        let plane = ControlPlane::open_with_executor(
            paths.clone(),
            Box::new(KernelTurnExecutor::new(paths)),
        )
        .unwrap();
        let workspace = plane
            .store()
            .create_workspace_with_cwd("plain", Some(plain.to_str().unwrap()))
            .unwrap()
            .id;
        let result = plane
            .rpc_workspace_git_compare(&json!({ "workspaceId": workspace, "targetRef": "main" }))
            .unwrap();
        assert_eq!(result["available"], json!(false));
        fixture_cleanup(root);

        let fixture = Fixture::new("unknown-ref");
        let plane = fixture.plane();
        let workspace = fixture.workspace(&plane);
        let missing = plane.rpc_workspace_git_compare(
            &json!({ "workspaceId": workspace, "targetRef": "no-such-branch" }),
        );
        assert_eq!(
            missing.unwrap_err().category,
            ErrorCategory::InvalidArgument
        );
        fixture.cleanup();
    }

    fn fixture_cleanup(root: PathBuf) {
        let _ = fs::remove_dir_all(root);
    }
}
