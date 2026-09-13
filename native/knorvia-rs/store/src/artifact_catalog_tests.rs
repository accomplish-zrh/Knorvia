//! P02 catalog fixtures: 20 workspaces / 2,000 synthetic artifacts, stable
//! keyset pagination, filters, and corrupt-metadata isolation.

use super::*;
use knorvia_platform_paths::layout;
use std::time::{SystemTime, UNIX_EPOCH};

fn tmp_store() -> ProductStore {
    let base = std::env::temp_dir().join(format!(
        "knorvia-artcat-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&base).unwrap();
    ProductStore::open(layout(base)).unwrap()
}

fn seed(store: &ProductStore, workspaces: usize, per_workspace: usize) -> Vec<Artifact> {
    let mut all = Vec::new();
    for w in 0..workspaces {
        let ws = store.create_workspace(&format!("ws-{w}")).unwrap();
        for i in 0..per_workspace {
            all.push(
                store
                    .create_artifact(&ws.id, "text/markdown", &format!("Output {w}-{i:03}"))
                    .unwrap(),
            );
        }
    }
    all
}

fn collect_all(
    store: &ProductStore,
    query: ArtifactCatalogQuery<'_>,
    limit: usize,
) -> Vec<Artifact> {
    let mut rows = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = store
            .list_artifacts_catalog(query.clone(), cursor.as_deref(), limit)
            .unwrap();
        let done = page.next_cursor.is_none();
        rows.extend(page.artifacts);
        if done {
            break;
        }
        cursor = page.next_cursor;
    }
    rows
}

#[test]
fn catalog_paginates_2000_artifacts_across_20_workspaces_without_repeat_or_loss() {
    let store = tmp_store();
    let seeded = seed(&store, 20, 100);
    assert_eq!(seeded.len(), 2000);
    let rows = collect_all(&store, ArtifactCatalogQuery::default(), 64);
    assert_eq!(rows.len(), 2000, "every artifact appears exactly once");
    let ids: std::collections::HashSet<&str> = rows.iter().map(|a| a.id.as_str()).collect();
    assert_eq!(ids.len(), 2000, "no duplicates across pages");
    // Sorted newest-first by (updated_at, id).
    for pair in rows.windows(2) {
        let a = &pair[0];
        let b = &pair[1];
        assert!(
            a.updated_at > b.updated_at || (a.updated_at == b.updated_at && a.id > b.id),
            "sort order violated: {} {} vs {} {}",
            a.updated_at,
            a.id,
            b.updated_at,
            b.id
        );
    }
    // First page honors the limit and reports the global total.
    let first = store
        .list_artifacts_catalog(ArtifactCatalogQuery::default(), None, 64)
        .unwrap();
    assert_eq!(first.artifacts.len(), 64);
    assert_eq!(first.total_matching, 2000);
    assert!(first.next_cursor.is_some());
}

#[test]
fn catalog_filters_by_workspace_title_and_type() {
    let store = tmp_store();
    let ws_a = store.create_workspace("A").unwrap();
    let ws_b = store.create_workspace("B").unwrap();
    for i in 0..5 {
        store
            .create_artifact(&ws_a.id, "text/markdown", &format!("Brief alpha {i}"))
            .unwrap();
        store
            .create_artifact(
                &ws_b.id,
                "application/vnd.knorvia.media+json",
                &format!("Clip beta {i}"),
            )
            .unwrap();
    }
    let ws_only = store
        .list_artifacts_catalog(
            ArtifactCatalogQuery {
                workspace_id: Some(&ws_a.id),
                ..Default::default()
            },
            None,
            500,
        )
        .unwrap();
    assert_eq!(ws_only.total_matching, 5);
    assert!(ws_only.artifacts.iter().all(|a| a.workspace_id == ws_a.id));

    let title = store
        .list_artifacts_catalog(
            ArtifactCatalogQuery {
                title_contains: Some("ALPHA"),
                ..Default::default()
            },
            None,
            500,
        )
        .unwrap();
    assert_eq!(title.total_matching, 5);
    assert!(title.artifacts.iter().all(|a| a.title.contains("alpha")));

    let media = store
        .list_artifacts_catalog(
            ArtifactCatalogQuery {
                artifact_type: Some("application/vnd.knorvia.media+json"),
                ..Default::default()
            },
            None,
            500,
        )
        .unwrap();
    assert_eq!(media.total_matching, 5);
}

#[test]
fn catalog_skips_corrupt_metadata_and_still_serves_healthy_outputs() {
    let store = tmp_store();
    let ws = store.create_workspace("ws").unwrap();
    for i in 0..3 {
        store
            .create_artifact(&ws.id, "text/markdown", &format!("healthy {i}"))
            .unwrap();
    }
    let bad_dir = store.paths().state.join("product/artifacts");
    std::fs::write(bad_dir.join("corrupt.json"), "{not json at all").unwrap();
    std::fs::write(bad_dir.join("notes.txt"), "not catalogued").unwrap();
    let page = store
        .list_artifacts_catalog(ArtifactCatalogQuery::default(), None, 500)
        .unwrap();
    assert_eq!(page.total_matching, 3, "healthy artifacts remain visible");
    assert_eq!(page.artifacts.len(), 3);
    assert_eq!(
        page.skipped_unreadable, 1,
        "corrupt metadata counted, not hidden"
    );
}

#[test]
fn catalog_cursor_survives_new_insertions_without_repeat_or_skip() {
    let store = tmp_store();
    let ws = store.create_workspace("ws").unwrap();
    let mut first_page_ids = Vec::new();
    for i in 0..15 {
        let artifact = store
            .create_artifact(&ws.id, "text/markdown", &format!("row {i}"))
            .unwrap();
        first_page_ids.push(artifact.id);
    }
    let page1 = store
        .list_artifacts_catalog(ArtifactCatalogQuery::default(), None, 10)
        .unwrap();
    assert_eq!(page1.artifacts.len(), 10);
    let cursor = page1.next_cursor.clone().unwrap();
    // Newer artifacts land while the reader is between pages.
    for i in 0..5 {
        store
            .create_artifact(&ws.id, "text/markdown", &format!("new {i}"))
            .unwrap();
    }
    let page2 = store
        .list_artifacts_catalog(ArtifactCatalogQuery::default(), Some(&cursor), 10)
        .unwrap();
    let seen: std::collections::HashSet<&str> =
        page1.artifacts.iter().map(|a| a.id.as_str()).collect();
    for artifact in &page2.artifacts {
        assert!(
            !seen.contains(artifact.id.as_str()),
            "row repeated across pages"
        );
    }
    assert_eq!(page2.artifacts.len(), 5, "original rows are not skipped");
    let _ = first_page_ids;
}

#[test]
fn catalog_rejects_bad_limits_and_cursors() {
    let store = tmp_store();
    let ws = store.create_workspace("ws").unwrap();
    store
        .create_artifact(&ws.id, "text/markdown", "one")
        .unwrap();
    let zero = store
        .list_artifacts_catalog(ArtifactCatalogQuery::default(), None, 0)
        .unwrap_err();
    assert!(zero.to_string().contains("greater than zero"));
    let bad_cursor = store
        .list_artifacts_catalog(ArtifactCatalogQuery::default(), Some("garbage"), 10)
        .unwrap_err();
    assert!(bad_cursor.to_string().contains("cursor"));
    let empty = store
        .list_artifacts_catalog(ArtifactCatalogQuery::default(), None, 10)
        .unwrap();
    assert_eq!(empty.total_matching, 1);
}
