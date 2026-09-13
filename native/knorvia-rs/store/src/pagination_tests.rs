//! A08: bounded replay pages, offset index integrity and frozen snapshots.

use super::super::atomic_write;
use super::*;
use crate::StoreProtocolError;
use knorvia_platform_paths::layout;
use std::fs;
use std::io::Write as _;
use std::time::{SystemTime, UNIX_EPOCH};

fn tmp_store() -> (ProductStore, std::path::PathBuf) {
    let base = std::env::temp_dir().join(format!(
        "knorvia-replay-page-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&base).unwrap();
    (ProductStore::open(layout(base.clone())).unwrap(), base)
}

fn journal_path(store: &ProductStore, stream: &str) -> std::path::PathBuf {
    store
        .paths
        .state
        .join("events")
        .join(format!("{stream}.jsonl"))
}

/// Write `count` events with padded payloads through the durable commit
/// path (WAL + projection + JSONL append).
fn write_events(store: &ProductStore, stream: &str, count: usize, filler: usize) {
    for index in 0..count {
        store
            .append_event(
                stream,
                "test.appended",
                serde_json::json!({
                    "index": index,
                    "filler": "x".repeat(filler),
                }),
                None,
            )
            .unwrap();
    }
}

#[test]
fn oversized_streams_reassemble_exactly_through_bounded_pages() {
    let (store, home) = tmp_store();
    let stream = "thread_big";
    write_events(&store, stream, 400, 24_000);
    let durable = store.replay(stream, 0).unwrap();
    let journal_bytes = fs::metadata(journal_path(&store, stream)).unwrap().len();
    assert!(
        journal_bytes > 8 * 1024 * 1024,
        "fixture must exceed the 8 MiB frame limit, got {journal_bytes}"
    );

    let mut cursor = 0u64;
    let mut seen: Vec<EventEnvelope> = Vec::new();
    let mut pages = 0;
    loop {
        let page = store.replay_ready(stream, cursor, 100, 512 * 1024).unwrap();
        assert!(page.events.len() <= 100);
        assert_eq!(page.upper_seq, durable.last().unwrap().seq);
        for (position, event) in page.events.iter().enumerate() {
            let absolute = seen.len() + position;
            assert_eq!(event.seq, durable[absolute].seq);
            assert_eq!(event.payload, durable[absolute].payload);
        }
        seen.extend(page.events.iter().cloned());
        cursor = page.next_seq;
        pages += 1;
        if !page.has_more {
            break;
        }
        assert!(pages < 500, "paging made no progress");
    }
    assert_eq!(seen.len(), durable.len());
    assert!(pages > 1, "an oversized stream must span several pages");
    let _ = fs::remove_dir_all(home);
}

#[test]
fn a_late_page_stops_parsing_the_prefix() {
    let (store, home) = tmp_store();
    let stream = "thread_late";
    write_events(&store, stream, 60, 12_000);
    // Warm the offset index with one full pass.
    store.replay_ready(stream, 0, 50, 512 * 1024).unwrap();
    let head = store.replay(stream, 0).unwrap().last().unwrap().seq;
    let page = store.replay_ready(stream, head - 6, 2, 256 * 1024).unwrap();
    assert_eq!(page.events.len(), 2);
    assert!(
        store.page_lines_parsed() <= page.events.len() as u64,
        "a late page must parse only its own lines, parsed {}",
        store.page_lines_parsed()
    );
    let _ = fs::remove_dir_all(home);
}

#[test]
fn concurrent_appends_arrive_after_the_frozen_snapshot() {
    let (store, home) = tmp_store();
    let stream = "thread_freeze";
    write_events(&store, stream, 5, 32);
    let first = store.replay_ready(stream, 0, 3, 512 * 1024).unwrap();
    assert_eq!(first.events.len(), 3);
    assert!(first.has_more);
    assert_eq!(first.upper_seq, 5);

    // The next page opens after the new events committed, so its frozen
    // snapshot is the new head 8: it returns everything past the cursor
    // exactly once and reports the catch-up honestly.
    write_events(&store, stream, 3, 32);
    let second = store
        .replay_ready(stream, first.next_seq, 500, 512 * 1024)
        .unwrap();
    assert_eq!(
        second.events.len(),
        5,
        "no event between cursor and head is lost"
    );
    assert_eq!(second.events.first().unwrap().seq, 4);
    assert_eq!(second.upper_seq, 8);
    assert!(!second.has_more);

    // Catch-up completed; a further read over the same frozen head is empty
    // instead of duplicating events or inventing progress.
    let third = store
        .replay_ready(stream, second.next_seq, 500, 512 * 1024)
        .unwrap();
    assert!(third.events.is_empty());
    assert_eq!(third.upper_seq, 8);
    assert_eq!(third.next_seq, second.next_seq);
    assert!(!third.has_more);
    let _ = fs::remove_dir_all(home);
}

#[test]
fn an_oversized_event_is_a_typed_error_and_never_skipped() {
    let (store, home) = tmp_store();
    let stream = "thread_huge";
    write_events(&store, stream, 1, 32);
    write_events(&store, stream, 1, 2 * 1024 * 1024);
    write_events(&store, stream, 1, 32);
    // The first page returns what fits and stops before the oversized event.
    let first = store.replay_ready(stream, 0, 10, 512 * 1024).unwrap();
    assert_eq!(first.events.len(), 1);
    assert_eq!(first.next_seq, 1);
    assert!(first.has_more);

    // A page whose FIRST event cannot fit the budget fails with a typed
    // resource-limit diagnostic instead of skipping the event.
    let error = store
        .replay_ready(stream, first.next_seq, 10, 512 * 1024)
        .unwrap_err();
    match error {
        StoreError::Protocol(StoreProtocolError(protocol)) => {
            assert_eq!(protocol.category, ErrorCategory::ResourceExhausted);
            assert!(protocol.message.starts_with("event_exceeds_page_budget"));
        }
        other => panic!("expected a typed resource-limit error, got {other:?}"),
    }

    // Raising the budget returns the oversized event intact; nothing was
    // skipped or truncated.
    let page = store.replay_ready(stream, 1, 10, 3 * 1024 * 1024).unwrap();
    assert_eq!(page.events.len(), 2);
    assert_eq!(page.events[0].seq, 2);
    assert_eq!(page.next_seq, 3);
    assert!(!page.has_more);
    assert_eq!(
        page.events[0].payload["filler"].as_str().unwrap().len(),
        2 * 1024 * 1024
    );
    let _ = fs::remove_dir_all(home);
}

#[test]
fn the_offset_index_is_rebuildable_after_loss_or_corruption() {
    let (store, home) = tmp_store();
    let stream = "thread_index";
    write_events(&store, stream, 40, 4_000);
    let expected = store.replay_ready(stream, 0, 500, 6 * 1024 * 1024).unwrap();
    let index_path = store.replay_index_path(stream);
    assert!(index_path.exists());

    // Deleted index: rebuilt transparently.
    fs::remove_file(&index_path).unwrap();
    let after_delete = store.replay_ready(stream, 0, 500, 6 * 1024 * 1024).unwrap();
    assert_eq!(after_delete.next_seq, expected.next_seq);
    assert_eq!(after_delete.events.len(), expected.events.len());

    // Corrupt index: rebuilt transparently.
    fs::write(&index_path, b"{ not an index").unwrap();
    let after_corrupt = store.replay_ready(stream, 0, 500, 6 * 1024 * 1024).unwrap();
    assert_eq!(after_corrupt.next_seq, expected.next_seq);

    // Same-length offset edits cannot authenticate as a different event.
    let mut raw = fs::read(&index_path).unwrap();
    raw[..8].copy_from_slice(&u64::MAX.to_le_bytes());
    atomic_write(&index_path, &raw).unwrap();
    let repaired = store.replay_ready(stream, 0, 500, 6 * 1024 * 1024).unwrap();
    assert_eq!(repaired.next_seq, expected.next_seq);
    assert_eq!(repaired.events[0].seq, 1);
    let _ = fs::remove_dir_all(home);
}

#[test]
fn a_broken_journal_tail_is_recovered_with_evidence_before_paging() {
    let (store, home) = tmp_store();
    let stream = "thread_tail";
    write_events(&store, stream, 5, 2_000);
    // Out-of-band corruption: a torn write fragment after the last line.
    let mut journal = fs::OpenOptions::new()
        .append(true)
        .open(journal_path(&store, stream))
        .unwrap();
    journal.write_all(b"{\"truncated even").unwrap();
    drop(journal);

    // The store fails closed: a torn tail it cannot rebuild from durable
    // facts is a typed corruption error, never a silent partial history.
    let error = store
        .replay_ready(stream, 0, 500, 6 * 1024 * 1024)
        .unwrap_err();
    match &error {
        StoreError::Corrupt(message) => {
            assert!(message.contains("trailing journal fragment"), "{message}");
        }
        other => panic!("expected a typed corrupt-tail error, got {other:?}"),
    }
    // The torn fragment was preserved for diagnosis, not discarded.
    let recovery_dir = store.paths.state.join("store-recovery");
    assert!(
        fs::read_dir(&recovery_dir).unwrap().next().is_some(),
        "recovery evidence must be preserved"
    );
    let _ = fs::remove_dir_all(home);
}

#[test]
fn a_cross_stream_cursor_reads_nothing_it_should_not() {
    let (store, home) = tmp_store();
    write_events(&store, "stream_a", 3, 32);
    // Cursor from a different stream points past this stream's head.
    assert!(
        store
            .replay_ready("stream_a", 9_999, 10, 512 * 1024)
            .is_err()
    );
    let _ = fs::remove_dir_all(home);
}

#[test]
fn replay_page_compat_api_still_pages_small_histories() {
    let (store, home) = tmp_store();
    write_events(&store, "stream_compat", 7, 32);
    let page = store.replay_page("stream_compat", Some(0), 3).unwrap();
    assert_eq!(page.data.len(), 3);
    assert_eq!(page.next_cursor, Some(3));
    let page = store
        .replay_page("stream_compat", page.next_cursor, 3)
        .unwrap();
    assert_eq!(page.data.len(), 3);
    let tail = store
        .replay_page("stream_compat", page.next_cursor, 3)
        .unwrap();
    assert_eq!(tail.data.len(), 1);
    assert_eq!(tail.next_cursor, None);
    let _ = fs::remove_dir_all(home);
}

impl ProductStore {
    fn replay_ready(
        &self,
        stream: &str,
        after: u64,
        limit: usize,
        bytes: usize,
    ) -> Result<EventReplayPage, StoreError> {
        for _ in 0..1000 {
            match self.replay_page_bounded(stream, after, limit, bytes) {
                Err(StoreError::Protocol(StoreProtocolError(ref e)))
                    if e.message.starts_with("replay_index_building:") =>
                {
                    assert!(self.page_bytes_read() <= crate::replay_index::BUILD_BYTES as u64);
                }
                result => return result,
            }
        }
        panic!("index did not finish in bounded slices")
    }
}

#[test]
fn cold_rebuild_and_appending_late_pages_account_for_all_io() {
    let (store, _home) = tmp_store();
    write_events(&store, "bounded", 12, 1024 * 1024);
    let started = std::time::Instant::now();
    let error = store
        .replay_page_bounded("bounded", 11, 1, 2 * 1024 * 1024)
        .unwrap_err();
    assert!(error.to_string().contains("replay_index_building:"));
    assert!(store.page_bytes_read() <= crate::replay_index::BUILD_BYTES as u64);
    assert_eq!(store.page_lines_parsed(), 0);
    assert!(started.elapsed() < std::time::Duration::from_secs(1));
    store
        .replay_ready("bounded", 11, 1, 2 * 1024 * 1024)
        .unwrap();
    write_events(&store, "bounded", 1, 64);
    let page = store.replay_page_bounded("bounded", 12, 1, 4096).unwrap();
    assert_eq!(page.next_seq, 13);
    assert!(
        store.page_bytes_read() < 4096,
        "append must index only newly committed bytes"
    );
    assert_eq!(store.page_lines_parsed(), 1);
}

#[test]
fn snapshot_cursor_binds_foreign_stream_and_preserves_upper_during_append() {
    let (store, _home) = tmp_store();
    write_events(&store, "left", 5, 32);
    write_events(&store, "right", 5, 32);
    let first = store.replay_ready("left", 0, 2, 4096).unwrap();
    write_events(&store, "left", 3, 32);
    assert!(
        store
            .replay_page_snapshot("right", 2, 100, 4096, Some(5), Some(&first.next_cursor))
            .is_err()
    );
    let last = store
        .replay_page_snapshot("left", 2, 100, 4096, Some(5), Some(&first.next_cursor))
        .unwrap();
    assert_eq!(
        last.events.iter().map(|e| e.seq).collect::<Vec<_>>(),
        vec![3, 4, 5]
    );
    assert_eq!(last.upper_seq, 5);
    assert!(!last.has_more);
    let new = store.replay_ready("left", 5, 100, 4096).unwrap();
    assert_eq!(
        new.events.iter().map(|e| e.seq).collect::<Vec<_>>(),
        vec![6, 7, 8]
    );
}

#[test]
fn normalized_legacy_rows_fit_the_actual_rpc_encoding() {
    let (store, _home) = tmp_store();
    write_events(&store, "old", 30, 32);
    let mut raw = Vec::new();
    for event in store.replay("old", 0).unwrap() {
        let mut row = serde_json::to_value(event).unwrap();
        row.as_object_mut().unwrap().remove("causationId");
        row.as_object_mut().unwrap().remove("correlationId");
        serde_json::to_writer(&mut raw, &row).unwrap();
        raw.push(b'\n');
    }
    fs::write(journal_path(&store, "old"), raw).unwrap();
    let page = store.replay_ready("old", 0, 100, 4096).unwrap();
    let response = knorvia_protocol::RpcSuccess::new(
        knorvia_protocol::RequestId::String("x".repeat(120)),
        serde_json::to_value(page).unwrap(),
    );
    let encoded = serde_json::to_string(&response).unwrap();
    assert!(encoded.len() <= 4096, "actual bytes: {}", encoded.len());
    let mut wire = Vec::new();
    knorvia_protocol::write_frame(&mut wire, &encoded).unwrap();
    assert_eq!(
        knorvia_protocol::read_frame(std::io::Cursor::new(wire)).unwrap(),
        encoded
    );
}

#[test]
fn binary_sidecar_deletions_zero_heads_and_overflows_never_skip_events() {
    let (store, _home) = tmp_store();
    write_events(&store, "tamper", 5, 64);
    for mode in 0..5 {
        store.replay_ready("tamper", 0, 100, 4096).unwrap();
        let path = store.replay_index_path("tamper");
        let mut raw = fs::read(&path).unwrap();
        match mode {
            0 => {
                raw.drain(..48);
            }
            1 => {
                raw.drain(96..144);
            }
            2 => {
                raw.fill(0);
            }
            3 => {
                raw[8..16].copy_from_slice(&1u64.to_le_bytes());
            }
            _ => {
                raw[..8].copy_from_slice(&u64::MAX.to_le_bytes());
            }
        }
        fs::write(&path, raw).unwrap();
        let page = store.replay_ready("tamper", 2, 100, 4096).unwrap();
        assert_eq!(
            page.events.iter().map(|e| e.seq).collect::<Vec<_>>(),
            vec![3, 4, 5]
        );
        assert_eq!(page.upper_seq, 5);
        assert!(!page.has_more);
    }
}
