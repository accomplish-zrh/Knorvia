use super::*;
use serde_json::json;

fn job_json(job: &Job) -> serde_json::Value {
    serde_json::to_value(job).unwrap()
}

#[test]
fn listing_jobs_in_a_fresh_store_is_empty_not_an_error() {
    let root = std::env::temp_dir().join(format!(
        "knorvia-media-jobs-fresh-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let paths = knorvia_platform_paths::layout(root.clone());
    let store = ProductStore::open(paths).unwrap();
    let ws = store.create_workspace("Studio").unwrap();
    let listed = store.list_jobs(&ws.id, "media.").unwrap();
    assert!(listed.is_empty());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn media_jobs_survive_reopen_and_terminal_state_cannot_be_rewritten() {
    let root = std::env::temp_dir().join(format!(
        "knorvia-media-jobs-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let paths = knorvia_platform_paths::layout(root.clone());
    let store = ProductStore::open(paths.clone()).unwrap();
    let ws = store.create_workspace("Studio").unwrap();
    let other = store.create_workspace("Other").unwrap();
    let job = store.create_job(&ws.id, "media.video").unwrap();
    store.create_job(&other.id, "media.image").unwrap();
    store.create_job(&ws.id, "other").unwrap();
    store.run_job(&job.id).unwrap();
    let data = json!({"remote": {"id": "provider-123"}, "phase": "generating"});
    let checkpointed = store.checkpoint_job(&job.id, data).unwrap();
    assert_eq!(
        job_json(&store.run_job(&job.id).unwrap()),
        job_json(&checkpointed)
    );
    drop(store);
    let store = ProductStore::open(paths).unwrap();
    let listed = store.list_jobs(&ws.id, "media.").unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(job_json(&listed[0]), job_json(&checkpointed));
    let finished = store.finish_job(&job.id, "succeeded").unwrap();
    assert_eq!(
        job_json(&store.finish_job(&job.id, "succeeded").unwrap()),
        job_json(&finished)
    );
    assert!(store.cancel_job(&job.id).is_err());
    assert!(store.run_job(&job.id).is_err());
    assert!(store.retry_job(&job.id).is_err());
    assert!(store.checkpoint_job(&job.id, json!({})).is_err());
    assert_eq!(
        job_json(&store.read_job(&job.id).unwrap()),
        job_json(&finished)
    );
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
