use super::super::{BindingAction, BindingIdentity, ProductStore};
use super::*;
use knorvia_platform_paths::KnorviaPaths;

fn crash_home(tag: &str) -> KnorviaPaths {
    let home = std::env::temp_dir().join(format!("knorvia-crash-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    knorvia_platform_paths::layout(home)
}

fn outcome_meta(binding_id: &str, up_to_seq: u64) -> Value {
    serde_json::json!({"bindingId": binding_id, "upToSeq": up_to_seq, "turnId": "turn_seed"})
}

#[test]
fn delivery_window_lookup_matches_only_the_exact_suffix() {
    let store = setup2("window-lookup");
    let bot = store.ensure_default_bot().unwrap();
    let room = store
        .create_room("group", "crash", &[bot.id.clone()])
        .unwrap();
    let resolved = store
        .resolve_session_binding(&bot.id, &room.id, "kernel", BindingIdentity::default())
        .unwrap();
    let binding_id = resolved.binding.id.clone();

    let user = store
        .append_room_message(&room.id, RoomMessageInput::user_message("hello"))
        .unwrap();

    // No outcome yet: a crashed dispatch must look like "needs a turn".
    assert!(
        store
            .find_dispatch_outcome(&room.id, &binding_id, user.seq)
            .unwrap()
            .is_none()
    );

    // An outcome for a different window must not satisfy this one.
    store
        .append_room_message(
            &room.id,
            RoomMessageInput {
                sender: "bot",
                bot_id: Some(&bot.id),
                content: "older answer",
                reply_to_message_id: None,
                correlation_id: None,
                source_room_id: None,
                target_bot_id: None,
                artifact_refs: vec![],
                hop_count: 0,
                transfer_message_id: None,
                meta: outcome_meta(&binding_id, user.seq - 1),
            },
        )
        .unwrap();
    assert!(
        store
            .find_dispatch_outcome(&room.id, &binding_id, user.seq)
            .unwrap()
            .is_none()
    );

    // Seed the outcome for the exact window, as a dispatch would right
    // before the (simulated) crash that prevented the watermark advance.
    store
        .append_room_message(
            &room.id,
            RoomMessageInput {
                sender: "bot",
                bot_id: Some(&bot.id),
                content: "answer for this window",
                reply_to_message_id: None,
                correlation_id: None,
                source_room_id: None,
                target_bot_id: None,
                artifact_refs: vec![],
                hop_count: 0,
                transfer_message_id: None,
                meta: outcome_meta(&binding_id, user.seq),
            },
        )
        .unwrap();
    let found = store
        .find_dispatch_outcome(&room.id, &binding_id, user.seq)
        .unwrap()
        .expect("the seeded outcome must be found");
    assert_eq!(found.content, "answer for this window");

    // A different binding's outcome for the same window does not match.
    let other = store
        .resolve_session_binding(
            &bot.id,
            &room.id,
            "kernel",
            BindingIdentity {
                canonical_cwd: Some("D:/elsewhere"),
                ..BindingIdentity::default()
            },
        )
        .unwrap();
    assert!(
        store
            .find_dispatch_outcome(&room.id, &other.binding.id, user.seq)
            .unwrap()
            .is_none()
    );
}

#[test]
fn watermark_crash_windows_recover_without_replaying_completed_deliveries() {
    let paths = crash_home("reopen");
    std::fs::create_dir_all(&paths.home).unwrap();
    let store = ProductStore::open(paths.clone()).unwrap();
    let bot = store.ensure_default_bot().unwrap();
    let room = store
        .create_room("group", "crash", &[bot.id.clone()])
        .unwrap();
    let resolved = store
        .resolve_session_binding(&bot.id, &room.id, "kernel", BindingIdentity::default())
        .unwrap();
    let binding_id = resolved.binding.id.clone();
    let user = store
        .append_room_message(&room.id, RoomMessageInput::user_message("hello"))
        .unwrap();

    // Window A: crash BEFORE any outcome — the suffix stays un-consumed and
    // the recovery dispatch sees the full suffix again.
    let head_before = store.room_chat_head(&room.id).unwrap();
    assert_eq!(
        store.read_binding(&binding_id).unwrap().last_delivered_seq,
        0
    );

    // Window B: outcome persisted, crash BEFORE watermark advance. Recovery:
    // the exact-window lookup finds the outcome, so the dispatcher skips the
    // turn and only advances the watermark. The completed delivery is not
    // replayed and no second answer appears.
    store
        .append_room_message(
            &room.id,
            RoomMessageInput {
                sender: "bot",
                bot_id: Some(&bot.id),
                content: "the one answer",
                reply_to_message_id: None,
                correlation_id: None,
                source_room_id: None,
                target_bot_id: None,
                artifact_refs: vec![],
                hop_count: 0,
                transfer_message_id: None,
                meta: outcome_meta(&binding_id, user.seq),
            },
        )
        .unwrap();
    let reopened = ProductStore::open(paths.clone()).unwrap();
    assert!(
        reopened
            .find_dispatch_outcome(&room.id, &binding_id, user.seq)
            .unwrap()
            .is_some()
    );
    // Recovery advances the watermark to the transcript head (the dispatcher
    // consumes everything visible, including the answer it just recorded);
    // the transcript keeps exactly one answer.
    let head = reopened.room_chat_head(&room.id).unwrap();
    reopened
        .record_binding_delivery(&binding_id, head, Some(resolved.binding.revision))
        .unwrap();
    assert_eq!(
        reopened
            .read_binding(&binding_id)
            .unwrap()
            .last_delivered_seq,
        head
    );
    assert_eq!(reopened.room_chat_head(&room.id).unwrap(), head_before + 1);

    // Window C: watermark persisted, crash afterwards — a fresh dispatch
    // resolves an empty suffix and must not produce anything.
    let next = reopened
        .resolve_session_binding(&bot.id, &room.id, "kernel", BindingIdentity::default())
        .unwrap();
    assert_eq!(next.action, BindingAction::Reused);
    let suffix = reopened
        .list_room_messages(&room.id, next.binding.last_delivered_seq + 1, 200)
        .unwrap();
    assert!(suffix.is_empty());
}

fn setup2(tag: &str) -> ProductStore {
    let paths = crash_home(tag);
    std::fs::create_dir_all(&paths.home).unwrap();
    ProductStore::open(paths).unwrap()
}
