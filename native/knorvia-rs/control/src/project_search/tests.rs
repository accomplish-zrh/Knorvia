//! P01 search tests run against a real ControlPlane fixture with a temporary
//! Home and synthetic project trees (no network, no kernel binary).

use super::*;
use crate::ControlPlane;
use crate::turn_exec::KernelTurnExecutor;
use knorvia_platform_paths::layout;
use serde_json::{Value, json};
use std::fs;
use std::path::Path;

fn plane() -> ControlPlane {
    let base = std::env::temp_dir().join(format!(
        "knorvia-search-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&base).unwrap();
    let executor = KernelTurnExecutor::new(layout(base.clone()));
    let factory: crate::PackRunnerFactory =
        std::sync::Arc::new(std::sync::Mutex::new(Box::new(|| {
            // Tests render in-process (deterministic, no worker binary needed).
            let choice = if knorvia_packs::gateway::GatewayModel::from_env().is_some() {
                knorvia_packs::ModelChoice::GatewayFromEnv
            } else {
                knorvia_packs::ModelChoice::None
            };
            let runner: Box<dyn knorvia_packs::PackRunner + Send> =
                Box::new(knorvia_packs::InProcessRunner::<'static>::new(choice));
            Ok(runner)
        })));
    ControlPlane::open_full(layout(base), Box::new(executor), factory).unwrap()
}

fn init(plane: &mut ControlPlane) {
    let req = json!({
        "jsonrpc": "2.0",
        "id": "init",
        "method": "initialize",
        "params": {
            "protocol": {"major": 1, "minor": 0},
            "client": {"name": "knorvia_search_test", "version": "0.0.1", "platform": "windows"},
            "capabilities": ["thread", "artifact", "job", "approval", "reconnect"]
        }
    });
    let resp: Value =
        serde_json::from_str(&plane.handle_json(&req.to_string()).unwrap().unwrap()).unwrap();
    assert!(resp.get("error").is_none(), "{resp}");
    let note = json!({"jsonrpc":"2.0","method":"initialized"});
    assert!(plane.handle_json(&note.to_string()).unwrap().is_none());
}

fn call(plane: &mut ControlPlane, method: &str, params: Value) -> Value {
    let response = call_raw(plane, method, params);
    assert!(
        response.get("error").is_none(),
        "unexpected error: {response}"
    );
    response["result"].clone()
}

fn call_raw(plane: &mut ControlPlane, method: &str, params: Value) -> Value {
    let req = json!({"jsonrpc": "2.0", "id": "t", "method": method, "params": params});
    let body = plane
        .handle_json(&req.to_string())
        .unwrap()
        .expect("rpc reply");
    serde_json::from_str(&body).unwrap()
}

fn write(path: &Path, contents: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, contents).unwrap();
}

fn project_with_files(root: &Path) {
    // 600 same-level files, so a first 200-entry page can never cover them.
    for index in 0..600 {
        write(
            &root.join(format!("notes/file-{index:03}.txt")),
            &format!("body of file {index}\n"),
        );
    }
    // Deep directory chain with a Chinese name and a space in a file name.
    write(
        &root.join("docs/深/层级/notes.md"),
        "# 层级笔记\n深层的中文内容\n",
    );
    write(&root.join("docs/带 空格 文件.txt"), "带空格的文件名\n");
}

fn temp_project(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "knorvia-search-proj-{}-{}-{label}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn make_workspace(plane: &mut ControlPlane, project: &Path) -> String {
    let result = call(
        plane,
        "workspace/create",
        json!({"title": "search fixture", "cwd": project.to_string_lossy()}),
    );
    result["id"].as_str().expect("workspace id").to_string()
}

fn collect_all(plane: &mut ControlPlane, params: Value) -> (Value, Vec<Value>) {
    let mut matches = Vec::new();
    let mut last = Value::Null;
    let mut cursor: Option<String> = None;
    let mut search_id: Option<String> = None;
    loop {
        let mut page_params = params.clone();
        if let Some(id) = &search_id {
            page_params["searchId"] = json!(id);
        }
        if let Some(cursor) = &cursor {
            page_params["cursor"] = json!(cursor);
        }
        let page = call(plane, "workspace/files/search", page_params);
        search_id = Some(page["searchId"].as_str().expect("searchId").to_string());
        cursor = page["page"]["nextCursor"].as_str().map(str::to_string);
        let done = page["page"]["done"].as_bool().unwrap_or(true);
        if let Some(list) = page["matches"].as_array() {
            matches.extend(list.iter().cloned());
        }
        last = page;
        if done || cursor.is_none() {
            break;
        }
    }
    (last, matches)
}

#[test]
fn paths_search_finds_files_that_no_listing_page_has_loaded() {
    let mut plane = plane();
    init(&mut plane);
    let project = temp_project("deep");
    project_with_files(&project);
    let workspace = make_workspace(&mut plane, &project);

    // A name that sits far beyond the explorer's first loaded page.
    let (_, matches) = collect_all(
        &mut plane,
        json!({"workspaceId": workspace, "query": "file-450", "mode": "paths"}),
    );
    assert!(
        matches.iter().any(|m| m["path"] == "notes/file-450.txt"),
        "expected the 451st file to be found, got: {matches:?}"
    );

    // Deep directory chain and Chinese/space names.
    let (_, deep) = collect_all(
        &mut plane,
        json!({"workspaceId": workspace, "query": "层级", "mode": "paths"}),
    );
    assert!(deep.iter().any(|m| m["path"] == "docs/深/层级"));

    let (_, spaces) = collect_all(
        &mut plane,
        json!({"workspaceId": workspace, "query": "带 空格", "mode": "paths"}),
    );
    assert!(spaces.iter().any(|m| m["path"] == "docs/带 空格 文件.txt"));
}

#[test]
fn content_search_reports_line_column_and_snippet() {
    let mut plane = plane();
    init(&mut plane);
    let project = temp_project("content");
    write(
        &project.join("src/app.rs"),
        "fn main() {}\n// TODO: 调试日志\nlet ok = true;\n",
    );
    let workspace = make_workspace(&mut plane, &project);

    let (_, matches) = collect_all(
        &mut plane,
        json!({"workspaceId": workspace, "query": "调试", "mode": "content"}),
    );
    assert_eq!(matches.len(), 1, "{matches:?}");
    let m = &matches[0];
    assert_eq!(m["path"], "src/app.rs");
    assert_eq!(m["line"], 2);
    assert_eq!(m["matchCount"], 1);
    let snippet = m["snippet"].as_str().unwrap();
    assert!(snippet.contains("TODO"), "{snippet}");

    // Case-insensitive by default.
    let (_, lower) = collect_all(
        &mut plane,
        json!({"workspaceId": workspace, "query": "todo", "mode": "content"}),
    );
    assert_eq!(lower.len(), 1);
    // Case-sensitive misses the lowercase hit.
    let (_, sensitive) = collect_all(
        &mut plane,
        json!({"workspaceId": workspace, "query": "TODO", "mode": "content", "caseSensitive": true}),
    );
    assert_eq!(sensitive.len(), 1);
    let (_, none) = collect_all(
        &mut plane,
        json!({"workspaceId": workspace, "query": "todo", "mode": "content", "caseSensitive": true}),
    );
    assert!(none.is_empty(), "{none:?}");
}

#[test]
fn scope_excludes_ignored_hidden_binary_and_large_files() {
    let mut plane = plane();
    init(&mut plane);
    let project = temp_project("ignore");
    write(&project.join(".gitignore"), "secret-keys/\n*.log\nbuild/\n");
    write(&project.join("secret-keys/api.txt"), "matchneedle\n");
    write(&project.join("debug.log"), "matchneedle\n");
    write(&project.join("node_modules/pkg/index.js"), "matchneedle\n");
    write(&project.join(".hiddendir/x.txt"), "matchneedle\n");
    write(&project.join("visible.txt"), "matchneedle here\n");
    // Binary probe: NUL byte up front.
    let mut bin = b"matchn\x00eedle and more".to_vec();
    bin.extend(std::iter::repeat_n(b'a', 64));
    fs::write(project.join("blob.bin"), &bin).unwrap();
    // Larger than the 1 MiB content cap.
    let large = format!("matchneedle\n{}", "x".repeat(1024 * 1024 + 64));
    write(&project.join("large.txt"), &large);

    let workspace = make_workspace(&mut plane, &project);
    let (final_page, matches) = collect_all(
        &mut plane,
        json!({"workspaceId": workspace, "query": "matchneedle", "mode": "content"}),
    );
    let paths: Vec<&str> = matches.iter().filter_map(|m| m["path"].as_str()).collect();
    assert!(paths.contains(&"visible.txt"), "{paths:?}");
    assert!(
        !paths.iter().any(|p| p.contains("secret-keys")),
        "{paths:?}"
    );
    assert!(!paths.contains(&"debug.log"), "{paths:?}");
    assert!(
        !paths.iter().any(|p| p.contains("node_modules")),
        "{paths:?}"
    );
    assert!(!paths.contains(&"large.txt"), "{paths:?}");

    let coverage = &final_page["coverage"];
    assert!(
        coverage["skippedBinary"].as_u64().unwrap() >= 1,
        "{coverage}"
    );
    assert!(
        coverage["skippedLarge"].as_u64().unwrap() >= 1,
        "{coverage}"
    );
    assert!(
        coverage["ignoredEntries"].as_u64().unwrap() >= 3,
        "{coverage}"
    );

    // Ignored directories are not reachable by path search either.
    let (_, secret) = collect_all(
        &mut plane,
        json!({"workspaceId": workspace, "query": "api.txt", "mode": "paths"}),
    );
    assert!(secret.is_empty(), "{secret:?}");
    let (_, visible) = collect_all(
        &mut plane,
        json!({"workspaceId": workspace, "query": "visible.txt", "mode": "both"}),
    );
    assert_eq!(visible.len(), 1, "{visible:?}");
}

#[test]
fn pagination_walks_everything_exactly_once_and_reports_coverage() {
    let mut plane = plane();
    init(&mut plane);
    let project = temp_project("paging");
    project_with_files(&project);
    let workspace = make_workspace(&mut plane, &project);

    let mut params =
        json!({"workspaceId": workspace, "query": "file-", "mode": "paths", "maxResults": 100});
    let mut seen: Vec<String> = Vec::new();
    let mut pages = 0;
    let mut cursor: Option<String> = None;
    let mut search_id: Option<String> = None;
    let mut final_page = Value::Null;
    loop {
        if let Some(id) = &search_id {
            params["searchId"] = json!(id);
        }
        if let Some(c) = &cursor {
            params["cursor"] = json!(c);
        }
        let page = call(&mut plane, "workspace/files/search", params.clone());
        search_id = Some(page["searchId"].as_str().unwrap().to_string());
        cursor = page["page"]["nextCursor"].as_str().map(str::to_string);
        pages += 1;
        for m in page["matches"].as_array().unwrap() {
            seen.push(m["path"].as_str().unwrap().to_string());
        }
        let done = page["page"]["done"].as_bool().unwrap();
        final_page = page;
        if done {
            break;
        }
        assert!(cursor.is_some(), "not done but no cursor: {final_page}");
    }
    assert!(pages >= 6, "expected several pages, got {pages}");
    assert_eq!(seen.len(), 600, "600 files must each appear exactly once");
    let unique: std::collections::HashSet<&String> = seen.iter().collect();
    assert_eq!(unique.len(), seen.len(), "pages must not duplicate or skip");
    // 600 notes files + notes.md + the space-named file: coverage counts
    // every file the sweep actually read, not only the matches.
    assert_eq!(
        final_page["coverage"]["scannedFiles"].as_u64().unwrap(),
        602
    );
}

#[test]
fn cancel_really_stops_the_session_and_stale_cursors_are_rejected() {
    let mut plane = plane();
    init(&mut plane);
    let project = temp_project("cancel");
    project_with_files(&project);
    let workspace = make_workspace(&mut plane, &project);

    let first = call(
        &mut plane,
        "workspace/files/search",
        json!({"workspaceId": workspace, "query": "file-", "mode": "paths", "maxResults": 50}),
    );
    assert_eq!(first["page"]["done"].as_bool().unwrap(), false);
    let search_id = first["searchId"].as_str().unwrap().to_string();

    let cancelled = call(
        &mut plane,
        "workspace/files/search/cancel",
        json!({"searchId": search_id}),
    );
    assert_eq!(cancelled["cancelled"].as_bool().unwrap(), true);

    // The next page must fail: the traversal session no longer exists.
    let next = call_raw(
        &mut plane,
        "workspace/files/search",
        json!({"workspaceId": workspace, "query": "file-", "mode": "paths", "maxResults": 50,
               "searchId": search_id, "cursor": 1}),
    );
    assert!(next.get("error").is_some(), "expected NotFound, got {next}");

    // Cancelling again reports the session is gone.
    let again = call_raw(
        &mut plane,
        "workspace/files/search/cancel",
        json!({"searchId": search_id}),
    );
    assert!(again.get("error").is_some(), "{again}");

    // A wrong page cursor on a live session is an InvalidArgument, not data.
    let first2 = call(
        &mut plane,
        "workspace/files/search",
        json!({"workspaceId": workspace, "query": "file-", "mode": "paths", "maxResults": 50}),
    );
    let id2 = first2["searchId"].as_str().unwrap().to_string();
    let stale = call_raw(
        &mut plane,
        "workspace/files/search",
        json!({"workspaceId": workspace, "query": "file-", "mode": "paths", "maxResults": 50,
               "searchId": id2, "cursor": 7}),
    );
    assert!(stale.get("error").is_some(), "{stale}");

    // Changing the query mid-search is refused instead of returning mixed data.
    let stale2 = call_raw(
        &mut plane,
        "workspace/files/search",
        json!({"workspaceId": workspace, "query": "层级", "mode": "paths", "maxResults": 50,
               "searchId": id2, "cursor": 1}),
    );
    assert!(stale2.get("error").is_some(), "{stale2}");
}

#[test]
fn search_requires_scope_and_valid_parameters() {
    let mut plane = plane();
    init(&mut plane);
    let project = temp_project("params");
    write(&project.join("a.txt"), "hello\n");
    let workspace = make_workspace(&mut plane, &project);

    let no_scope = call_raw(
        &mut plane,
        "workspace/files/search",
        json!({"query": "hello"}),
    );
    assert!(no_scope.get("error").is_some(), "{no_scope}");

    let empty_query = call_raw(
        &mut plane,
        "workspace/files/search",
        json!({"workspaceId": workspace, "query": ""}),
    );
    assert!(empty_query.get("error").is_some(), "{empty_query}");

    let bad_mode = call_raw(
        &mut plane,
        "workspace/files/search",
        json!({"workspaceId": workspace, "query": "hello", "mode": "regex"}),
    );
    assert!(bad_mode.get("error").is_some(), "{bad_mode}");

    let bad_limit = call_raw(
        &mut plane,
        "workspace/files/search",
        json!({"workspaceId": workspace, "query": "hello", "maxResults": 5000}),
    );
    assert!(bad_limit.get("error").is_some(), "{bad_limit}");

    // A query that matches nothing still reports an honest, complete zero.
    let none = call(
        &mut plane,
        "workspace/files/search",
        json!({"workspaceId": workspace, "query": "zzz-not-there", "mode": "both"}),
    );
    assert_eq!(none["page"]["done"].as_bool().unwrap(), true);
    assert_eq!(none["matches"].as_array().unwrap().len(), 0);
    assert!(none["coverage"]["scannedFiles"].as_u64().unwrap() >= 1);
}

#[cfg(unix)]
#[test]
fn symlinks_are_named_but_never_followed() {
    let mut plane = plane();
    init(&mut plane);
    let project = temp_project("symlink");
    write(&project.join("real/target.txt"), "matchneedle\n");
    std::os::unix::fs::symlink(project.join("real"), project.join("link")).unwrap();
    let workspace = make_workspace(&mut plane, &project);

    let (_, matches) = collect_all(
        &mut plane,
        json!({"workspaceId": workspace, "query": "matchneedle", "mode": "content"}),
    );
    assert!(
        !matches
            .iter()
            .any(|m| m["path"].as_str().unwrap_or("").starts_with("link/")),
        "content must not leak through symlinks: {matches:?}"
    );

    let (_, path_matches) = collect_all(
        &mut plane,
        json!({"workspaceId": workspace, "query": "link", "mode": "paths"}),
    );
    assert!(
        path_matches.iter().any(|m| m["path"] == "link"),
        "{path_matches:?}"
    );
    assert!(
        path_matches.iter().all(|m| m["kind"] == "symlink"),
        "{path_matches:?}"
    );
}

#[test]
fn a07_low_hit_huge_directory_yields_empty_pages_and_matches_oracle() {
    let mut plane = plane();
    init(&mut plane);
    let project = temp_project("huge-directory");
    for index in 0..10_050 {
        write(&project.join(format!("file-{index:05}.txt")), "absent");
    }
    write(&project.join("zz-oracle-needle.txt"), "target");
    let workspace = make_workspace(&mut plane, &project);
    plane.project_search.request_budget = Some(Duration::from_millis(5));
    let params = json!({"workspaceId":workspace,"query":"needle","mode":"paths"});
    let began = Instant::now();
    let first = call(&mut plane, "workspace/files/search", params.clone());
    assert!(began.elapsed() < Duration::from_millis(500));
    assert_eq!(first["page"]["done"], false);
    assert!(first["page"]["nextCursor"].is_string());
    assert_eq!(first["coverage"]["complete"], false);
    assert!(
        first["coverage"]["enumeratedEntries"].as_u64().unwrap()
            <= SEARCH_MAX_ENTRIES_PER_RPC as u64
    );
    assert!(first["matches"].as_array().unwrap().is_empty());
    assert_eq!(call(&mut plane, "system/health", json!({}))["ok"], true);
    let mut next = params;
    next["searchId"] = first["searchId"].clone();
    next["cursor"] = first["page"]["nextCursor"].clone();
    let mut matches = Vec::new();
    let mut last_index = 0;
    loop {
        let page = call(&mut plane, "workspace/files/search", next.clone());
        let index = page["page"]["index"].as_u64().unwrap();
        assert!(index > last_index);
        last_index = index;
        matches.extend(page["matches"].as_array().unwrap().iter().cloned());
        if page["page"]["done"] == true {
            assert_eq!(page["coverage"]["scannedFiles"], 10_051);
            assert_eq!(page["coverage"]["complete"], true);
            break;
        }
        next["cursor"] = page["page"]["nextCursor"].clone();
        assert!(last_index < 20_000);
    }
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0]["path"], "zz-oracle-needle.txt");
}

#[test]
fn a07_zero_budget_cancel_expiry_and_session_capacity_are_honest() {
    let mut plane = plane();
    init(&mut plane);
    let project = temp_project("budget");
    for i in 0..30 {
        write(&project.join(format!("file{i}.txt")), "nothing");
    }
    let workspace = make_workspace(&mut plane, &project);
    plane.project_search.request_budget = Some(Duration::ZERO);
    let params = json!({"workspaceId":workspace,"query":"no match","mode":"content"});
    let first = call(&mut plane, "workspace/files/search", params.clone());
    assert_eq!(first["coverage"]["scannedFiles"], 0);
    assert_eq!(first["page"]["done"], false);
    let id = first["searchId"].as_str().unwrap().to_owned();
    let stopped = call(
        &mut plane,
        "workspace/files/search/cancel",
        json!({"searchId":id}),
    );
    assert_eq!(stopped["complete"], false);
    assert_eq!(stopped["coverage"]["scannedFiles"], 0);
    assert!(!plane.project_search.sessions.contains_key(&id));
    for _ in 0..SEARCH_MAX_SESSIONS {
        call(&mut plane, "workspace/files/search", params.clone());
    }
    let full = call_raw(&mut plane, "workspace/files/search", params.clone());
    assert_eq!(full["error"]["data"]["category"], "RESOURCE_EXHAUSTED");
    for session in plane.project_search.sessions.values_mut() {
        session.last_touched = Instant::now() - SEARCH_SESSION_TTL - Duration::from_secs(1);
    }
    let renewed = call(&mut plane, "workspace/files/search", params);
    assert_eq!(renewed["page"]["done"], false);
    assert_eq!(plane.project_search.sessions.len(), 1);
}

#[test]
fn a07_added_files_and_total_cap_do_not_repeat_results_or_claim_coverage() {
    let mut plane = plane(); init(&mut plane);
    let project = temp_project("cap");
    for i in 0..2_005 { write(&project.join(format!("file-{i:05}.txt")), "nothing"); }
    let workspace = make_workspace(&mut plane, &project);
    let mut params = json!({"workspaceId":workspace,"query":"file-","mode":"paths","maxResults":200});
    let mut seen = std::collections::HashSet::new();
    let mut index = 0;
    loop {
        let page = call(&mut plane, "workspace/files/search", params.clone());
        assert_eq!(page["page"]["index"], index); index += 1;
        for row in page["matches"].as_array().unwrap() { assert!(seen.insert(row["path"].as_str().unwrap().to_owned())); }
        if index == 1 { write(&project.join("file-added.txt"), "new"); }
        if page["page"]["nextCursor"].is_null() {
            assert_eq!(page["matchedLimitReached"], true);
            assert_eq!(page["matchedTotal"], 2_000);
            assert_eq!(seen.len(), 2_000);
            assert_eq!(page["coverage"]["complete"], false);
            assert_eq!(page["coverage"]["unscannedEntriesKnown"], false);
            break;
        }
        params["searchId"] = page["searchId"].clone();
        params["cursor"] = page["page"]["nextCursor"].clone();
        assert!(index < 100);
    }
}
