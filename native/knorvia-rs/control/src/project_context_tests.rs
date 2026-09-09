use super::*;
use crate::{KernelTurnExecutor, KernelTurnSettings};
use knorvia_platform_paths::layout;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

struct Fixture {
    root: PathBuf,
    home: PathBuf,
    repo: PathBuf,
    scope: PathBuf,
    outside: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "knorvia-project-context-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let home = root.join("knorvia-home");
        let repo = root.join("repo");
        let scope = repo.join("scope");
        let outside = repo.join("outside.txt");
        fs::create_dir_all(&scope).unwrap();
        fs::write(scope.join("text.txt"), "one\ntwo\n").unwrap();
        fs::write(scope.join("utf8.txt"), "中文").unwrap();
        fs::write(scope.join("binary.bin"), [0_u8, 0x81, 0x82]).unwrap();
        fs::write(scope.join("deleted.txt"), "delete me\n").unwrap();
        fs::write(scope.join("old.txt"), "old\n").unwrap();
        fs::write(&outside, "outside committed\n").unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["config", "user.name", "Knorvia Test"]);
        git(
            &repo,
            &["config", "user.email", "knorvia-test@example.invalid"],
        );
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "initial"]);
        Self {
            root,
            home,
            repo,
            scope,
            outside,
        }
    }

    fn plane(&self) -> ControlPlane {
        let paths = layout(self.home.clone());
        ControlPlane::open_with_executor(paths.clone(), Box::new(KernelTurnExecutor::new(paths)))
            .unwrap()
    }

    fn workspace(&self, plane: &ControlPlane, title: &str, cwd: &Path) -> String {
        plane
            .store()
            .create_workspace_with_cwd(title, Some(cwd.to_str().unwrap()))
            .unwrap()
            .id
    }

    fn cleanup(self) {
        let canonical_root = fs::canonicalize(&self.root).unwrap();
        let canonical_temp = fs::canonicalize(std::env::temp_dir()).unwrap();
        assert!(canonical_root.starts_with(canonical_temp));
        let _ = fs::remove_dir_all(canonical_root);
    }
}

fn git(cwd: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git {:?} failed with {status}", args);
}

fn path_in_entries(entries: &Value, path: &str) -> bool {
    entries
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["path"] == path)
}

#[test]
fn file_browsing_is_scoped_truncated_and_binary_safe() {
    let fixture = Fixture::new();
    let plane = fixture.plane();
    let workspace_id = fixture.workspace(&plane, "Scope", &fixture.scope);

    let listing = plane
        .rpc_workspace_files_list(&json!({"workspaceId": workspace_id, "limit": 50}))
        .unwrap();
    assert!(path_in_entries(&listing["entries"], "text.txt"));
    assert!(path_in_entries(&listing["entries"], "binary.bin"));

    let root = plane
        .rpc_workspace_path_resolve(&json!({"workspaceId": workspace_id, "path": ""}))
        .unwrap();
    assert_eq!(root["path"], "");
    assert_eq!(root["kind"], "directory");
    let resolved = plane
        .rpc_workspace_path_resolve(&json!({"workspaceId": workspace_id, "path": "text.txt"}))
        .unwrap();
    assert_eq!(resolved["path"], "text.txt");
    assert!(Path::new(resolved["absolutePath"].as_str().unwrap()).is_absolute());

    let text = plane
        .rpc_workspace_files_read(&json!({
            "workspaceId": workspace_id,
            "path": "text.txt",
            "maxBytes": 2,
        }))
        .unwrap();
    assert_eq!(text["kind"], "text");
    assert_eq!(text["content"], "on");
    assert_eq!(text["truncated"], true);
    assert_eq!(text["nextOffset"], 2);

    let binary = plane
        .rpc_workspace_files_read(&json!({
            "workspaceId": workspace_id,
            "path": "binary.bin",
        }))
        .unwrap();
    assert_eq!(binary["kind"], "binary");
    assert!(binary.get("content").is_none());
    assert_eq!(binary["size"], 3);

    let utf8 = plane
        .rpc_workspace_files_read(&json!({
            "workspaceId": workspace_id,
            "path": "utf8.txt",
            "maxBytes": 1,
        }))
        .unwrap();
    assert_eq!(utf8["kind"], "text");
    assert_eq!(utf8["content"], "中");
    assert_eq!(utf8["nextOffset"], 3);
    assert_eq!(utf8["truncated"], true);
    let utf8_tail = plane
        .rpc_workspace_files_read(&json!({
            "workspaceId": workspace_id,
            "path": "utf8.txt",
            "offset": utf8["nextOffset"],
            "maxBytes": 1,
        }))
        .unwrap();
    assert_eq!(utf8_tail["kind"], "text");
    assert_eq!(utf8_tail["content"], "文");
    assert_eq!(utf8_tail["truncated"], false);

    let escaped = plane
        .rpc_workspace_files_read(&json!({
            "workspaceId": workspace_id,
            "path": "../outside.txt",
        }))
        .unwrap_err();
    assert_eq!(escaped.category, ErrorCategory::PermissionDenied);

    drop(plane);
    fixture.cleanup();
}

#[cfg(unix)]
#[test]
fn symlinked_paths_that_leave_the_workspace_are_denied() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    let plane = fixture.plane();
    let workspace_id = fixture.workspace(&plane, "Scope", &fixture.scope);
    symlink(&fixture.root, fixture.scope.join("escape")).unwrap();

    let escaped = plane
        .rpc_workspace_files_read(&json!({
            "workspaceId": workspace_id,
            "path": "escape/repo/outside.txt",
        }))
        .unwrap_err();
    assert_eq!(escaped.category, ErrorCategory::PermissionDenied);

    drop(plane);
    fixture.cleanup();
}

#[test]
fn thread_saved_cwd_overrides_workspace_cwd_for_every_project_operation() {
    let fixture = Fixture::new();
    let thread_scope = fixture.root.join("thread-scope");
    fs::create_dir_all(&thread_scope).unwrap();
    fs::write(
        thread_scope.join("thread.txt"),
        "thread owns this directory\n",
    )
    .unwrap();
    let mut plane = fixture.plane();
    let workspace_id = fixture.workspace(&plane, "Workspace cwd", &fixture.scope);
    let thread = plane
        .store()
        .create_thread(&workspace_id, "Pinned cwd", None, None)
        .unwrap();
    plane
        .executor_lock()
        .configure_thread(
            &thread.id,
            &KernelTurnSettings {
                cwd: Some(thread_scope.to_str().unwrap().to_string()),
                ..KernelTurnSettings::default()
            },
        )
        .unwrap();

    let listing = plane
        .rpc_workspace_files_list(&json!({
            "workspaceId": workspace_id,
            "threadId": thread.id,
        }))
        .unwrap();
    assert_eq!(
        listing["workspace"]["cwd"],
        display_path(&fs::canonicalize(&thread_scope).unwrap())
    );
    assert!(path_in_entries(&listing["entries"], "thread.txt"));
    assert!(!path_in_entries(&listing["entries"], "text.txt"));

    let second_workspace = fixture.workspace(&plane, "Other", &fixture.scope);
    let mismatched = plane
        .rpc_workspace_files_list(&json!({
            "workspaceId": second_workspace,
            "threadId": thread.id,
        }))
        .unwrap_err();
    assert_eq!(mismatched.category, ErrorCategory::InvalidArgument);

    drop(plane);
    fixture.cleanup();
}

#[test]
fn git_status_and_diff_never_escape_the_workspace_and_render_untracked_text() {
    let fixture = Fixture::new();
    let plane = fixture.plane();
    let workspace_id = fixture.workspace(&plane, "Scoped Git", &fixture.scope);

    fs::write(fixture.scope.join("text.txt"), "one\nstaged\n").unwrap();
    git(&fixture.repo, &["add", "scope/text.txt"]);
    fs::write(fixture.scope.join("text.txt"), "one\nstaged\nunstaged\n").unwrap();
    fs::write(fixture.scope.join("new.txt"), "brand new\n").unwrap();
    fs::write(fixture.scope.join("new-binary.bin"), [0_u8, 9, 8]).unwrap();
    fs::remove_file(fixture.scope.join("deleted.txt")).unwrap();
    fs::write(&fixture.outside, "outside changed\n").unwrap();
    git(&fixture.repo, &["mv", "scope/old.txt", "scope/renamed.txt"]);

    let status = plane
        .rpc_workspace_git_status(&json!({"workspaceId": workspace_id}))
        .unwrap();
    assert_eq!(status["available"], true);
    assert!(path_in_entries(&status["staged"], "text.txt"));
    assert!(path_in_entries(&status["unstaged"], "text.txt"));
    assert!(path_in_entries(&status["untracked"], "new.txt"));
    assert!(path_in_entries(&status["untracked"], "new-binary.bin"));
    for section in ["staged", "unstaged", "untracked", "conflicts"] {
        assert!(
            !path_in_entries(&status[section], "../outside.txt")
                && !path_in_entries(&status[section], "outside.txt"),
            "{section} leaked a path outside workspace: {status}"
        );
    }
    let rename = status["staged"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["path"] == "renamed.txt")
        .unwrap();
    assert_eq!(rename["oldPath"], "old.txt");

    let untracked = plane
        .rpc_workspace_git_diff(&json!({
            "workspaceId": workspace_id,
            "path": "new.txt",
        }))
        .unwrap();
    assert_eq!(untracked["untracked"], true);
    assert_eq!(untracked["binary"], false);
    assert!(untracked["diff"].as_str().unwrap().contains("+brand new"));

    let binary = plane
        .rpc_workspace_git_diff(&json!({
            "workspaceId": workspace_id,
            "path": "new-binary.bin",
        }))
        .unwrap();
    assert_eq!(binary["untracked"], true);
    assert_eq!(binary["binary"], true);
    assert_eq!(binary["diff"], "");

    let staged = plane
        .rpc_workspace_git_diff(&json!({
            "workspaceId": workspace_id,
            "path": "text.txt",
            "staged": true,
        }))
        .unwrap();
    assert_eq!(staged["path"], "text.txt");
    assert!(staged["diff"].as_str().unwrap().contains("+staged"));

    let deleted = plane
        .rpc_workspace_git_diff(&json!({
            "workspaceId": workspace_id,
            "path": "deleted.txt",
        }))
        .unwrap();
    assert_eq!(deleted["path"], "deleted.txt");
    assert!(
        deleted["diff"]
            .as_str()
            .unwrap()
            .contains("deleted file mode")
    );

    let escape = plane
        .rpc_workspace_git_diff(&json!({
            "workspaceId": workspace_id,
            "path": "../outside.txt",
        }))
        .unwrap_err();
    assert_eq!(escape.category, ErrorCategory::PermissionDenied);

    #[cfg(unix)]
    {
        let literal_magic = plane
            .rpc_workspace_git_diff(&json!({
                "workspaceId": workspace_id,
                "path": ":(top)outside.txt",
            }))
            .unwrap();
        assert_eq!(literal_magic["path"], ":(top)outside.txt");
        assert_eq!(literal_magic["diff"], "");
        assert_eq!(literal_magic["untracked"], false);
    }
    #[cfg(windows)]
    assert_eq!(
        git_literal_pathspec(":(top)outside.txt"),
        ":(literal):(top)outside.txt"
    );

    drop(plane);
    fixture.cleanup();
}

#[test]
fn worktree_creation_uses_knorvia_home_and_persists_a_new_workspace() {
    let fixture = Fixture::new();
    let plane = fixture.plane();
    let source_workspace_id = fixture.workspace(&plane, "Source", &fixture.scope);
    let before = plane.store().list_workspaces().unwrap().len();

    let created = plane
        .rpc_workspace_worktree_create(&json!({
            "workspaceId": source_workspace_id,
            "branch": "knorvia-test/context-worktree",
            "title": "Isolated context worktree",
        }))
        .unwrap();
    let cwd = fs::canonicalize(created["cwd"].as_str().unwrap()).unwrap();
    let canonical_home = fs::canonicalize(&fixture.home).unwrap();
    assert!(cwd.starts_with(canonical_home.join("worktrees")));
    assert_eq!(
        cwd.file_name().and_then(|name| name.to_str()),
        Some("scope")
    );
    assert_eq!(created["sourceWorkspaceId"], source_workspace_id);
    assert_eq!(
        created["worktree"]["branch"],
        "knorvia-test/context-worktree"
    );
    let persisted_cwd = plane
        .store()
        .read_workspace_cwd(created["id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    assert_eq!(fs::canonicalize(persisted_cwd).unwrap(), cwd);
    let actual_branch = Command::new("git")
        .arg("-C")
        .arg(&cwd)
        .args(["branch", "--show-current"])
        .output()
        .unwrap();
    assert!(actual_branch.status.success());
    assert_eq!(
        String::from_utf8(actual_branch.stdout).unwrap().trim(),
        "knorvia-test/context-worktree"
    );
    let escaped_new_workspace = plane
        .rpc_workspace_files_read(&json!({
            "workspaceId": created["id"],
            "path": "../outside.txt",
        }))
        .unwrap_err();
    assert_eq!(
        escaped_new_workspace.category,
        ErrorCategory::PermissionDenied
    );

    let invalid = plane
        .rpc_workspace_worktree_create(&json!({
            "workspaceId": source_workspace_id,
            "branch": "../escape",
        }))
        .unwrap_err();
    assert_eq!(invalid.category, ErrorCategory::InvalidArgument);
    assert_eq!(plane.store().list_workspaces().unwrap().len(), before + 1);

    drop(plane);
    fixture.cleanup();
}

#[test]
fn worktree_creation_cleans_up_its_branch_and_directory_after_store_failure() {
    let fixture = Fixture::new();
    let plane = fixture.plane();
    let source_workspace_id = fixture.workspace(&plane, "Source", &fixture.scope);
    let before = plane.store().list_workspaces().unwrap().len();
    let branch = "knorvia-test/context-store-failure";

    let workspaces = plane
        .store()
        .paths()
        .state
        .join("product")
        .join("workspaces");
    let backup = fixture.root.join("workspaces-backup");
    fs::rename(&workspaces, &backup).unwrap();
    fs::write(&workspaces, "not a directory").unwrap();
    let failed = plane.rpc_workspace_worktree_create(&json!({
        "workspaceId": source_workspace_id,
        "branch": branch,
        "title": "This persistence intentionally fails",
    }));
    fs::remove_file(&workspaces).unwrap();
    fs::rename(&backup, &workspaces).unwrap();

    assert!(failed.is_err());
    assert_eq!(plane.store().list_workspaces().unwrap().len(), before);
    let worktree_list = Command::new("git")
        .arg("-C")
        .arg(&fixture.repo)
        .args(["worktree", "list", "--porcelain"])
        .output()
        .unwrap();
    assert!(worktree_list.status.success());
    assert!(
        !String::from_utf8(worktree_list.stdout)
            .unwrap()
            .contains(&display_path(&fixture.home.join("worktrees"))),
        "a failed workspace write left a registered worktree"
    );
    let branch_list = Command::new("git")
        .arg("-C")
        .arg(&fixture.repo)
        .args(["branch", "--list", branch])
        .output()
        .unwrap();
    assert!(branch_list.status.success());
    assert!(
        String::from_utf8(branch_list.stdout)
            .unwrap()
            .trim()
            .is_empty(),
        "a failed workspace write left its new branch"
    );

    drop(plane);
    fixture.cleanup();
}

#[test]
fn worktree_porcelain_parses_entries_locks_and_prunable_reasons() {
    let sample = "worktree D:/repo\nHEAD 1a2b3c4\nbranch refs/heads/main\n\nworktree D:/repo/wt-a\nHEAD deadbee\nbranch refs/heads/feature/a\nlocked reasons here\n\nworktree D:/repo/wt-b\ndetached\nprunable gitfile pointer already registered\n\nworktree D:/bare\nbare\n";
    let parsed = parse_worktree_porcelain(sample).unwrap();
    assert_eq!(parsed.len(), 4);
    assert_eq!(parsed[0].branch.as_deref(), Some("refs/heads/main"));
    assert!(!parsed[0].locked);
    assert_eq!(parsed[1].path, "D:/repo/wt-a");
    assert!(parsed[1].locked);
    assert_eq!(parsed[1].lock_reason.as_deref(), Some("reasons here"));
    assert!(parsed[2].detached);
    assert!(parsed[2].prunable);
    assert_eq!(
        parsed[2].prunable_reason.as_deref(),
        Some("gitfile pointer already registered")
    );
    assert!(parsed[3].bare);
}

#[test]
fn worktree_removal_protects_dirty_ignored_locked_and_running_then_retains_history() {
    let fixture = Fixture::new();
    fs::write(fixture.repo.join(".gitignore"), "cache/\n").unwrap();
    git(&fixture.repo, &["add", ".gitignore"]);
    git(&fixture.repo, &["commit", "-q", "-m", "ignore local cache"]);
    let plane = fixture.plane();
    let source = fixture.workspace(&plane, "Source", &fixture.repo);
    let created = plane
        .rpc_workspace_worktree_create(
            &json!({"workspaceId": source, "branch": "knorvia-test/removal"}),
        )
        .unwrap();
    let id = created["id"].as_str().unwrap();
    let cwd = PathBuf::from(created["cwd"].as_str().unwrap());
    let listing = plane
        .rpc_workspace_worktree_list(&json!({"workspaceId": source}))
        .unwrap();
    let requested = listing["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["branch"] == "refs/heads/knorvia-test/removal")
        .unwrap()["path"]
        .as_str()
        .unwrap()
        .to_string();
    let params = json!({"workspaceId": source, "path": requested});
    git(
        &cwd,
        &["update-index", "--assume-unchanged", "scope/text.txt"],
    );
    assert!(plane.rpc_workspace_worktree_remove(&params).is_err());
    git(
        &cwd,
        &["update-index", "--no-assume-unchanged", "scope/text.txt"],
    );
    git(&cwd, &["update-index", "--skip-worktree", "scope/text.txt"]);
    assert!(plane.rpc_workspace_worktree_remove(&params).is_err());
    git(
        &cwd,
        &["update-index", "--no-skip-worktree", "scope/text.txt"],
    );
    fs::create_dir(cwd.join("cache")).unwrap();
    fs::write(cwd.join("cache/data.bin"), b"private cache").unwrap();
    assert!(plane.rpc_workspace_worktree_remove(&params).is_err());
    assert_eq!(
        fs::read(cwd.join("cache/data.bin")).unwrap(),
        b"private cache"
    );
    fs::remove_file(cwd.join("cache/data.bin")).unwrap();
    fs::remove_dir(cwd.join("cache")).unwrap();
    fs::write(cwd.join("new.txt"), "untracked").unwrap();
    assert!(plane.rpc_workspace_worktree_remove(&params).is_err());
    fs::remove_file(cwd.join("new.txt")).unwrap();
    fs::write(cwd.join("scope/text.txt"), "changed\n").unwrap();
    assert!(plane.rpc_workspace_worktree_remove(&params).is_err());
    git(&cwd, &["checkout", "--", "scope/text.txt"]);
    plane.rpc_workspace_worktree_lock(&params, true).unwrap();
    assert!(plane.rpc_workspace_worktree_remove(&params).is_err());
    plane.rpc_workspace_worktree_lock(&params, false).unwrap();
    let thread = plane
        .store()
        .create_thread(id, "Retained task", None, None)
        .unwrap();
    let turn = plane.store().start_turn(&thread.id).unwrap();
    assert!(plane.rpc_workspace_worktree_remove(&params).is_err());
    plane.store().complete_turn(&turn.id, "completed").unwrap();
    let result = plane.rpc_workspace_worktree_remove(&params).unwrap();
    assert_eq!(result["removed"], true);
    assert_eq!(result["branchRetained"], true);
    assert_eq!(result["historyRetained"], true);
    assert!(!cwd.exists());
    assert!(plane.store().read_thread(&thread.id).is_ok());
    assert!(plane.ensure_workspace_runnable(id).is_err());
    assert!(
        plane
            .rpc_workspace_path_resolve(&json!({"workspaceId": id, "path": ""}))
            .is_err()
    );
    let branches = Command::new("git")
        .arg("-C")
        .arg(&fixture.repo)
        .args(["branch", "--list", "knorvia-test/removal"])
        .output()
        .unwrap();
    assert!(
        String::from_utf8(branches.stdout)
            .unwrap()
            .contains("knorvia-test/removal")
    );
    drop(plane);
    fixture.cleanup();
}

#[test]
fn worktree_porcelain_tolerates_unknown_attributes_and_blank_paths() {
    let sample = "worktree D:/repo
future-attribute whatever

worktree D:/repo/wt-c
locked
";
    let parsed = parse_worktree_porcelain(sample).unwrap();
    assert_eq!(
        parsed.len(),
        2,
        "unknown attributes are ignored, entries kept"
    );
    assert!(parsed[1].locked);
    assert_eq!(parsed[1].lock_reason, None);
}
