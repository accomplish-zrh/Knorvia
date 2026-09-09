use super::durable::{DurableFailpoint, inject_failure};
use super::*;
use knorvia_platform_paths::layout;

fn store() -> ProductStore {
    ProductStore::open(layout(
        std::env::temp_dir().join(new_id("knorvia-thread-index")),
    ))
    .unwrap()
}

#[test]
fn workspace_pages_do_not_parse_foreign_records_but_corruption_is_not_hidden() {
    let store = store();
    let a = store.create_workspace("a").unwrap();
    let b = store.create_workspace("b").unwrap();
    let own = store.create_thread(&a.id, "own", None, None).unwrap();
    let other = store.create_thread(&b.id, "other", None, None).unwrap();
    fs::write(store.thread_path(&other.id), b"corrupt foreign document").unwrap();
    assert_eq!(
        serde_json::to_value(store.list_threads_page(&a.id, None, 1).unwrap()).unwrap(),
        serde_json::json!([[own], null])
    );
    assert_eq!(
        serde_json::to_value(store.list_threads_page("empty", None, 1).unwrap()).unwrap(),
        serde_json::json!([[], null])
    );
    assert!(store.list_threads_page(&b.id, None, 1).is_err());
    assert_eq!(
        fs::read(store.thread_path(&other.id)).unwrap(),
        b"corrupt foreign document"
    );
}

#[test]
fn an_uncertain_write_recovers_membership_before_the_next_page() {
    let store = store();
    let project = store.create_workspace("intent").unwrap();
    inject_failure(DurableFailpoint::AfterIntentPersisted);
    assert!(
        store
            .create_thread(&project.id, "recover me", None, None)
            .is_err()
    );
    let (threads, cursor) = store.list_threads_page(&project.id, None, 100).unwrap();
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].title, "recover me");
    assert!(cursor.is_none());
}

#[test]
fn reopened_and_invalidated_indexes_include_legacy_records_without_retaining_removed_ids() {
    let first = store();
    let project = first.create_workspace("legacy").unwrap();
    let original = first.create_thread(&project.id, "WAL", None, None).unwrap();
    let mut legacy = original.clone();
    legacy.id = new_id("thr");
    legacy.title = "legacy without WAL".into();
    fs::write(
        first.thread_path(&legacy.id),
        serde_json::to_vec(&legacy).unwrap(),
    )
    .unwrap();
    let second = ProductStore::open(first.paths.clone()).unwrap();
    let (page, _) = second.list_threads_page(&project.id, None, 100).unwrap();
    assert_eq!(page.len(), 2);
    fs::remove_file(second.thread_path(&legacy.id)).unwrap();
    second.invalidate_recovered_cache();
    assert_eq!(
        serde_json::to_value(second.list_threads_page(&project.id, None, 100).unwrap()).unwrap(),
        serde_json::json!([[original], null])
    );
}

#[test]
fn mismatched_wal_thread_identity_fails_before_replacing_the_valid_projection() {
    let store = store();
    let project = store.create_workspace("identity").unwrap();
    let thread = store
        .create_thread(&project.id, "original", None, None)
        .unwrap();
    let original = fs::read(store.thread_path(&thread.id)).unwrap();
    let mut changed = false;
    for entry in fs::read_dir(store.wal_dir()).unwrap() {
        let path = entry.unwrap().path();
        let mut transaction: Value = read_json(&path).unwrap();
        for write in transaction["writes"].as_array_mut().unwrap() {
            if write["kind"] == "thread" && write["id"] == thread.id {
                write["document"]["id"] = serde_json::json!("thr_wrong_identity");
                changed = true;
            }
        }
        if changed {
            fs::write(path, serde_json::to_vec(&transaction).unwrap()).unwrap();
            break;
        }
    }
    assert!(changed);
    assert!(matches!(
        ProductStore::open(store.paths.clone()),
        Err(StoreError::Corrupt(_))
    ));
    assert_eq!(fs::read(store.thread_path(&thread.id)).unwrap(), original);
}
