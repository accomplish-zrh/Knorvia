use super::*;
use knorvia_platform_paths::KnorviaPaths;

fn chat_home(tag: &str) -> KnorviaPaths {
    let home = std::env::temp_dir().join(format!("knorvia-chat-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    knorvia_platform_paths::layout(home)
}

fn setup(tag: &str) -> ProductStore {
    let paths = chat_home(tag);
    std::fs::create_dir_all(&paths.home).unwrap();
    ProductStore::open(paths).unwrap()
}

fn room_with_bot(store: &ProductStore) -> (super::super::BotProfile, super::super::Room) {
    let bot = store.ensure_default_bot().unwrap();
    let room = store
        .create_room("group", "chat room", &[bot.id.clone()])
        .unwrap();
    (bot, room)
}

#[test]
fn room_messages_get_dense_stable_sequences_and_persist() {
    let paths = chat_home("seq-dense");
    std::fs::create_dir_all(&paths.home).unwrap();
    let store = ProductStore::open(paths.clone()).unwrap();
    let (_bot, room) = room_with_bot(&store);

    let mut seqs = Vec::new();
    for round in 0..5 {
        let message = store
            .append_room_message(
                &room.id,
                RoomMessageInput::user_message(&format!("message {round}")),
            )
            .unwrap();
        seqs.push(message.seq);
    }
    let dense: Vec<u64> = seqs
        .iter()
        .scan(1, |expected, seq| {
            let ok = *seq == *expected;
            *expected = *seq + 1;
            Some(ok as u64)
        })
        .collect();
    assert!(
        dense.iter().all(|ok| *ok == 1),
        "sequences must be dense: {seqs:?}"
    );
    assert_eq!(
        store.room_chat_head(&room.id).unwrap(),
        *seqs.last().unwrap()
    );

    // Reopen: the transcript survives with the same sequences.
    let reopened = ProductStore::open(paths).unwrap();
    let history = reopened.list_room_messages(&room.id, 0, 100).unwrap();
    assert_eq!(history.len(), 5);
    assert_eq!(history[3].content, "message 3");
    assert_eq!(reopened.room_chat_head(&room.id).unwrap(), seqs[4]);
}

#[test]
fn window_reads_resume_exactly_at_the_watermark() {
    let store = setup("window");
    let (_bot, room) = room_with_bot(&store);
    for round in 0..6 {
        store
            .append_room_message(
                &room.id,
                RoomMessageInput::user_message(&format!("m{round}")),
            )
            .unwrap();
    }
    let window = store.list_room_messages(&room.id, 4, 200).unwrap();
    assert_eq!(window.len(), 3, "fromSeq is inclusive: seqs 4,5,6");
    assert_eq!(window[0].content, "m3");
    // Window caps at the requested limit.
    let limited = store.list_room_messages(&room.id, 0, 3).unwrap();
    assert_eq!(limited.len(), 3);
    assert_eq!(limited[0].content, "m0");
}

#[test]
fn checkpoint_read_and_attention_survive_reopen_without_cross_room_leakage() {
    let paths = chat_home("checkpoint-attention");
    let store = ProductStore::open(paths.clone()).unwrap();
    let (bot, room) = room_with_bot(&store);
    let other = store
        .create_room("group", "other", &[bot.id.clone()])
        .unwrap();
    let first = store
        .append_room_message(&room.id, RoomMessageInput::user_message("decision one"))
        .unwrap();
    let pending = store
        .append_room_message(
            &room.id,
            RoomMessageInput {
                sender: "system",
                content: "attempt interrupted",
                meta: serde_json::json!({"needsUser": true}),
                ..RoomMessageInput::user_message("")
            },
        )
        .unwrap();
    assert_eq!(store.room_attention(&room.id).unwrap().0, 1);
    assert_eq!(store.room_attention(&other.id).unwrap(), (0, Vec::new()));
    assert!(
        store
            .resolve_room_attention(&other.id, &pending.id)
            .is_err()
    );
    let checkpoint = store
        .checkpoint_room(&room.id, "User approved decision", first.seq, room.revision)
        .unwrap();
    assert_eq!(checkpoint.checkpoints[0].version, 1);
    assert!(
        store
            .checkpoint_room(&room.id, "stale", first.seq, room.revision)
            .is_err()
    );
    assert!(
        store
            .checkpoint_room(&room.id, "future", 999, checkpoint.revision)
            .is_err()
    );
    let next = store
        .checkpoint_room(&room.id, "Edited decision", first.seq, checkpoint.revision)
        .unwrap();
    assert_eq!(next.checkpoints[1].version, 2);
    store.mark_room_read(&room.id, pending.seq).unwrap();
    store.mark_room_read(&room.id, first.seq).unwrap();
    let reopened = ProductStore::open(paths).unwrap();
    assert_eq!(reopened.read_room(&room.id).unwrap().read_seq, pending.seq);
    assert_eq!(reopened.read_room(&room.id).unwrap().checkpoints.len(), 2);
    let (unread, attention) = reopened.room_attention(&room.id).unwrap();
    assert_eq!(unread, 0);
    assert_eq!(
        attention.len(),
        1,
        "reading does not acknowledge unresolved work"
    );
    reopened
        .resolve_room_attention(&room.id, &pending.id)
        .unwrap();
    reopened
        .resolve_room_attention(&room.id, &pending.id)
        .unwrap();
    assert!(reopened.room_attention(&room.id).unwrap().1.is_empty());
    assert_eq!(
        reopened.list_room_messages(&room.id, 0, 200).unwrap().len(),
        2,
        "checkpoint preserves source messages"
    );
}

#[test]
fn latest_window_includes_newest_messages_after_two_hundred() {
    let store = setup("latest-window");
    let (_, room) = room_with_bot(&store);
    for index in 0..205 {
        store
            .append_room_message(
                &room.id,
                RoomMessageInput::user_message(&format!("m{index}")),
            )
            .unwrap();
    }
    let latest = store.latest_room_messages(&room.id, 3).unwrap();
    assert_eq!(
        latest
            .iter()
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>(),
        ["m202", "m203", "m204"]
    );
}

#[test]
fn transfer_envelope_lands_in_target_dm_with_hops_and_correlation() {
    let store = setup("transfer");
    let alice = store.create_bot("Alice", "soul", "kernel", None).unwrap();
    let bob = store.create_bot("Bob", "soul", "kernel", None).unwrap();
    let source_room = store
        .create_room("group", "source", &[alice.id.clone()])
        .unwrap();

    let (envelope, created) = store
        .send_room_transfer(
            &bob.id,
            "bot",
            Some(&alice.id.as_str()),
            "please summarise the artifact",
            "corr-1",
            None,
            &source_room.id,
            vec!["art_1".to_string()],
            1,
            "xfer-0001",
        )
        .unwrap();
    assert!(created);
    assert_eq!(envelope.hop_count, 1);
    assert_eq!(envelope.correlation_id.as_deref(), Some("corr-1"));
    assert_eq!(
        envelope.source_room_id.as_deref(),
        Some(source_room.id.as_str())
    );
    assert_eq!(envelope.target_bot_id.as_deref(), Some(bob.id.as_str()));
    assert_eq!(envelope.artifact_refs, vec!["art_1".to_string()]);
    assert_eq!(envelope.status, "appended");

    // Duplicate messageId: no second side effect.
    let (again, created_again) = store
        .send_room_transfer(
            &bob.id,
            "bot",
            Some(&alice.id.as_str()),
            "please summarise the artifact",
            "corr-1",
            None,
            &source_room.id,
            vec![],
            1,
            "xfer-0001",
        )
        .unwrap();
    assert!(!created_again);
    assert_eq!(again.id, envelope.id);

    // Reply path: a reply references the envelope and records the source.
    let reply = store
        .append_room_message(
            &envelope.conversation_id,
            RoomMessageInput {
                sender: "bot",
                bot_id: Some(&bob.id),
                content: "here is the summary",
                reply_to_message_id: Some(&envelope.message_id.clone().unwrap()),
                correlation_id: Some("corr-1"),
                source_room_id: None,
                target_bot_id: Some(&alice.id),
                artifact_refs: vec![],
                hop_count: envelope.hop_count,
                transfer_message_id: None,
                meta: Value::Null,
            },
        )
        .unwrap();
    assert_eq!(reply.reply_to_message_id.as_deref(), Some("xfer-0001"));

    // Receipts move forward only.
    let delivered = store
        .mark_room_message_status(&envelope.conversation_id, "xfer-0001", "delivered")
        .unwrap();
    assert_eq!(delivered.status, "delivered");
    let acked = store
        .mark_room_message_status(&envelope.conversation_id, "xfer-0001", "acked")
        .unwrap();
    assert_eq!(acked.status, "acked");
}

#[test]
fn hop_and_correlation_budgets_stop_mutual_awakening_loops() {
    let store = setup("budget");
    let alice = store.create_bot("Alice", "soul", "kernel", None).unwrap();
    let bob = store.create_bot("Bob", "soul", "kernel", None).unwrap();
    let room = store
        .create_room("group", "loop", &[alice.id.clone()])
        .unwrap();

    // Hop budget: hop_count above the ceiling refuses outright.
    assert!(
        store
            .send_room_transfer(
                &bob.id,
                "bot",
                Some(&alice.id.as_str()),
                "ping",
                "corr-loop",
                None,
                &room.id,
                vec![],
                99,
                "xfer-h99",
            )
            .is_err()
    );

    // Correlation budget: MAX_TRANSFERS_PER_CORRELATION deliveries, no more.
    for index in 0..MAX_TRANSFERS_PER_CORRELATION {
        let result = store.send_room_transfer(
            &bob.id,
            "bot",
            Some(&alice.id.as_str()),
            &format!("ping {index}"),
            "corr-budget",
            None,
            &room.id,
            vec![],
            1,
            &format!("xfer-b{index}"),
        );
        assert!(
            result.is_ok(),
            "transfer {index} should fit the budget: {result:?}"
        );
    }
    assert!(
        store
            .send_room_transfer(
                &bob.id,
                "bot",
                Some(&alice.id.as_str()),
                "one ping too many",
                "corr-budget",
                None,
                &room.id,
                vec![],
                1,
                "xfer-over",
            )
            .is_err()
    );

    // Hop count 3 is still allowed on a fresh correlation (edge, not over).
    let (deep, created) = store
        .send_room_transfer(
            &bob.id,
            "bot",
            Some(&alice.id.as_str()),
            "deep but legal",
            "corr-deep",
            None,
            &room.id,
            vec![],
            MAX_TRANSFER_HOPS,
            "xfer-deep",
        )
        .unwrap();
    assert!(created);
    assert_eq!(deep.hop_count, MAX_TRANSFER_HOPS);
}

#[test]
fn bot_messages_must_name_their_bot_and_unknown_rooms_are_rejected() {
    let store = setup("validation");
    let bot = store.ensure_default_bot().unwrap();
    let room = store.create_room("group", "v", &[bot.id.clone()]).unwrap();
    assert!(
        store
            .append_room_message(
                &room.id,
                RoomMessageInput {
                    sender: "bot",
                    bot_id: None,
                    content: "ghost",
                    reply_to_message_id: None,
                    correlation_id: None,
                    source_room_id: None,
                    target_bot_id: None,
                    artifact_refs: vec![],
                    hop_count: 0,
                    transfer_message_id: None,
                    meta: Value::Null,
                },
            )
            .is_err()
    );
    assert!(
        store
            .append_room_message(&room.id, RoomMessageInput::user_message("   "))
            .is_err()
    );
    assert!(
        store
            .append_room_message("room_missing", RoomMessageInput::user_message("hi"))
            .is_err()
    );
}
