//! Crash-simulation helper for the Pack/Job recovery acceptance test.
//!
//! Runs as its OWN OS process (like the production daemon), opens an
//! isolated Knorvia Home, starts one pack invocation, checkpoints it, and
//! then exits WITHOUT completing it — leaving durable `running` Job and
//! Invocation records exactly as a process interruption would. The parent
//! test reopens the same Home and drives recovery + resume.

use knorvia_capability_host::PackHost;
use knorvia_platform_paths::{KnorviaPaths, layout};
use knorvia_store::ProductStore;
use serde_json::json;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 {
        eprintln!("usage: crash-helper <home-dir>");
        std::process::exit(2);
    }
    let home = std::path::PathBuf::from(&args[1]);
    let paths: KnorviaPaths = layout(home);
    let store = ProductStore::open(paths.clone()).expect("open store");
    let packs = PackHost::open(&paths).expect("open pack host");
    knorvia_packs::ensure_official(&packs).expect("ensure official packs");
    let ws = store.create_workspace("crash-recovery").expect("workspace");
    let outcome = knorvia_packs::invoke(
        &packs,
        &store,
        "media.studio",
        &ws.id,
        &json!({"prompt": "northern lights", "kind": "image"}),
        &mut knorvia_packs::InProcessRunner::new(knorvia_packs::ModelChoice::None),
    )
    .expect("invoke runs to completion normally");
    // Reopen a second invocation and interrupt it right after its durable
    // job link + checkpoint: kill this process by exiting with the records
    // still `running`. The render itself completed above as the price of a
    // deterministic helper; the recovery target is the fresh invocation
    // below, which never reaches a terminal state in this process.
    let inv = packs
        .invoke(
            "media.studio",
            json!({"prompt": "interrupted", "kind": "image"}),
        )
        .expect("invoke");
    let job = store.create_job(&ws.id, "media.studio").expect("job");
    let job = store.run_job(&job.id).expect("run job");
    packs.link_job(&inv.id, &job.id).expect("link job");
    packs
        .checkpoint(&inv.id, json!({"phase": "indexed", "step": 1}))
        .expect("checkpoint");
    store
        .checkpoint_job(&job.id, json!({"phase": "indexed", "step": 1}))
        .expect("job checkpoint");
    println!(
        "{}",
        json!({
            "invocationId": inv.id,
            "jobId": job.id,
            "workspaceId": ws.id,
            "completedInvocationId": outcome.invocation_id,
        })
    );
    // Abrupt end: no cleanup, no terminal write. stdout is flushed by println!
    // above; drop handles the way a killed process would.
    std::process::exit(0);
}
