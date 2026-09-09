use super::*;
use knorvia_platform_paths::KnorviaPaths;

fn social_home(tag: &str) -> KnorviaPaths {
    let home = std::env::temp_dir().join(format!("knorvia-bots-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    knorvia_platform_paths::layout(home)
}

fn setup(tag: &str) -> ProductStore {
    let paths = social_home(tag);
    std::fs::create_dir_all(&paths.home).unwrap();
    ProductStore::open(paths).unwrap()
}

fn group(store: &ProductStore, bot_ids: &[String]) -> Room {
    store
        .create_room("group", "test group", bot_ids)
        .unwrap()
}

#[test]
fn default_bot_is_idempotent_and_survives_reopen() {
    let paths = social_home("default-idempotent");
    std::fs::create_dir_all(&paths.home).unwrap();
    let store = ProductStore::open(paths.clone()).unwrap();

    let first = store.ensure_default_bot().unwrap();
    assert_eq!(first.id, DEFAULT_BOT_ID);
    assert!(first.is_default);
    let second = store.ensure_default_bot().unwrap();
    assert_eq!(first, second);

    let bots = store.list_bots().unwrap();
    assert_eq!(bots.len(), 1, "two initializations must yield one default bot");

    // A fresh store over the same Home re-reads the durable profile.
    let reopened = ProductStore::open(paths).unwrap();
    let reopened_default = reopened.ensure_default_bot().unwrap();
    assert_eq!(reopened_default.id, DEFAULT_BOT_ID);
    assert_eq!(reopened_default.soul, first.soul);
    assert_eq!(reopened.list_bots().unwrap().len(), 1);
}

#[test]
fn created_bots_and_soul_revisions_persist_with_history() {
    let paths = social_home("soul-history");
    std::fs::create_dir_all(&paths.home).unwrap();
    let store = ProductStore::open(paths.clone()).unwrap();

    let bot = store
        .create_bot("Researcher", "first soul", "kernel", Some("kernel"))
        .unwrap();
    assert_eq!(bot.soul_revision, 1);

    let updated = store
        .update_bot_soul(&bot.id, "second soul", Some(bot.revision))
        .unwrap();
    assert_eq!(updated.soul, "second soul");
    assert_eq!(updated.soul_revision, 2);
    assert_eq!(updated.soul_history.len(), 1);
    assert_eq!(updated.soul_history[0].soul, "first soul");
    assert_eq!(updated.soul_history[0].revision, 1);

    // Stale revision is rejected instead of silently overwriting.
    assert!(store
        .update_bot_soul(&bot.id, "third soul", Some(bot.revision))
        .is_err());

    let renamed = store
        .rename_bot(&bot.id, "Renamed Researcher", Some(updated.revision))
        .unwrap();
    assert_eq!(renamed.name, "Renamed Researcher");
    assert_eq!(renamed.soul_revision, 2, "renaming never bumps the soul revision");

    let reopened = ProductStore::open(paths).unwrap();
    let persisted = reopened.read_bot(&bot.id).unwrap();
    assert_eq!(persisted.name, "Renamed Researcher");
    assert_eq!(persisted.soul, "second soul");
    assert_eq!(persisted.soul_revision, 2);
    assert_eq!(persisted.soul_history.len(), 1);
}

#[test]
fn same_bot_same_room_ten_resolutions_reuse_one_binding() {
    let store = setup("ten-rounds");
    let bot = store.ensure_default_bot().unwrap();
    let room = group(&store, &[bot.id.clone()]);

    let mut binding_id = String::new();
    for round in 0..10 {
        let resolved = store
            .resolve_session_binding(
                &bot.id,
                &room.id,
                "kernel",
                BindingIdentity {
                    host_id: Some("hostA"),
                    account_fingerprint: Some("fp1"),
                    canonical_cwd: Some("D:/work"),
                    backend_version: Some("1.0"),
                },
            )
            .unwrap();
        if round == 0 {
            assert_eq!(resolved.action, BindingAction::Created);
        } else {
            assert_eq!(resolved.action, BindingAction::Reused);
        }
        if round == 0 {
            binding_id = resolved.binding.id.clone();
            let attached = store
                .attach_binding_session(
                    &binding_id,
                    "thr_anchor",
                    None,
                    Some(resolved.binding.revision),
                )
                .unwrap();
            assert_eq!(attached.knorvia_thread_id.as_deref(), Some("thr_anchor"));
        } else {
            assert_eq!(resolved.binding.id, binding_id);
            assert_eq!(
                resolved.binding.knorvia_thread_id.as_deref(),
                Some("thr_anchor"),
                "every round must resolve to the same anchored session"
            );
        }
    }
    assert_eq!(
        store
            .list_bindings(Some(&bot.id), Some(&room.id))
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn two_groups_and_dm_get_fully_separate_bindings() {
    let store = setup("isolation");
    let bot = store.ensure_default_bot().unwrap();
    let g1 = group(&store, &[bot.id.clone()]);
    let g2 = group(&store, &[bot.id.clone()]);
    let dm = store.ensure_dm(&bot.id).unwrap();

    let mut anchors = Vec::new();
    for conversation in [&g1.id, &g2.id, &dm.id] {
        let resolved = store
            .resolve_session_binding(&bot.id, conversation, "kernel", BindingIdentity::default())
            .unwrap();
        assert_eq!(resolved.action, BindingAction::Created);
        let attached = store
            .attach_binding_session(
                &resolved.binding.id,
                &format!("thr_for_{conversation}"),
                None,
                Some(resolved.binding.revision),
            )
            .unwrap();
        anchors.push(attached.knorvia_thread_id.clone().unwrap());
    }
    assert_eq!(anchors.len(), 3);
    for (i, a) in anchors.iter().enumerate() {
        for b in anchors.iter().skip(i + 1) {
            assert_ne!(a, b, "each conversation must hold its own session");
        }
    }
    // Repeated DM resolution returns the same conversation, not a new one.
    let dm_again = store.ensure_dm(&bot.id).unwrap();
    assert_eq!(dm_again.id, dm.id);
}

#[test]
fn room_rename_keeps_the_binding_and_session() {
    let store = setup("rename-stable");
    let bot = store.ensure_default_bot().unwrap();
    let room = group(&store, &[bot.id.clone()]);
    let resolved = store
        .resolve_session_binding(&bot.id, &room.id, "kernel", BindingIdentity::default())
        .unwrap();
    store
        .attach_binding_session(
            &resolved.binding.id,
            "thr_before_rename",
            None,
            Some(resolved.binding.revision),
        )
        .unwrap();

    let renamed = store
        .rename_room(&room.id, "new display name", Some(room.revision))
        .unwrap();
    assert_eq!(renamed.title, "new display name");
    assert_eq!(renamed.id, room.id, "conversation id never changes on rename");

    let after = store
        .resolve_session_binding(&bot.id, &room.id, "kernel", BindingIdentity::default())
        .unwrap();
    assert_eq!(after.action, BindingAction::Reused);
    assert_eq!(after.binding.id, resolved.binding.id);
    assert_eq!(
        after.binding.knorvia_thread_id.as_deref(),
        Some("thr_before_rename")
    );
}

#[test]
fn identity_change_starts_new_generation_without_recent_session_fallback() {
    let store = setup("generation");
    let bot = store.ensure_default_bot().unwrap();
    let room = group(&store, &[bot.id.clone()]);

    let first = store
        .resolve_session_binding(
            &bot.id,
            &room.id,
            "kernel",
            BindingIdentity {
                canonical_cwd: Some("D:/old"),
                ..BindingIdentity::default()
            },
        )
        .unwrap();
    store
        .attach_binding_session(
            &first.binding.id,
            "thr_old_cwd",
            None,
            Some(first.binding.revision),
        )
        .unwrap();

    let second = store
        .resolve_session_binding(
            &bot.id,
            &room.id,
            "kernel",
            BindingIdentity {
                canonical_cwd: Some("D:/new"),
                ..BindingIdentity::default()
            },
        )
        .unwrap();
    assert_eq!(second.action, BindingAction::Regenerated);
    assert_eq!(
        second.binding.binding_generation,
        first.binding.binding_generation + 1
    );
    assert_eq!(
        second.binding.knorvia_thread_id, None,
        "a new generation must not inherit the previous session anchor"
    );
    assert_eq!(
        second.binding.canonical_cwd.as_deref(),
        Some("D:/new")
    );

    let superseded = store.read_binding(&first.binding.id).unwrap();
    assert_eq!(superseded.status, "superseded");
    assert_eq!(superseded.knorvia_thread_id.as_deref(), Some("thr_old_cwd"),
        "history stays attributable on the old generation");

    // Attaching the fresh generation, then resolving with old identity again
    // regenerates once more — the cwd change is a real fact, not reversible.
    store
        .attach_binding_session(
            &second.binding.id,
            "thr_new_cwd",
            None,
            Some(second.binding.revision),
        )
        .unwrap();
    let back = store
        .resolve_session_binding(
            &bot.id,
            &room.id,
            "kernel",
            BindingIdentity {
                canonical_cwd: Some("D:/old"),
                ..BindingIdentity::default()
            },
        )
        .unwrap();
    assert_eq!(back.action, BindingAction::Regenerated);
    assert_ne!(back.binding.id, first.binding.id);
}

#[test]
fn lost_binding_is_never_resumed_and_regenerates_clean() {
    let store = setup("lost-session");
    let bot = store.ensure_default_bot().unwrap();
    let room = group(&store, &[bot.id.clone()]);
    let first = store
        .resolve_session_binding(&bot.id, &room.id, "kernel", BindingIdentity::default())
        .unwrap();
    store
        .attach_binding_session(
            &first.binding.id,
            "thr_died",
            None,
            Some(first.binding.revision),
        )
        .unwrap();

    let lost = store
        .mark_binding_lost(&first.binding.id, "CLI upgrade removed the session", None)
        .unwrap();
    assert_eq!(lost.status, "orphaned");

    let next = store
        .resolve_session_binding(&bot.id, &room.id, "kernel", BindingIdentity::default())
        .unwrap();
    assert_eq!(next.action, BindingAction::Regenerated);
    assert_eq!(next.binding.knorvia_thread_id, None);
    assert_eq!(next.binding.status, "active");

    // idempotent lost-marking on a non-active binding is a no-op read.
    let again = store
        .mark_binding_lost(&first.binding.id, "second call", None)
        .unwrap();
    assert_eq!(again.status, "orphaned");
}

#[test]
fn attach_refuses_to_move_an_anchor_or_target_non_active_binding() {
    let store = setup("attach-guard");
    let bot = store.ensure_default_bot().unwrap();
    let room = group(&store, &[bot.id.clone()]);
    let resolved = store
        .resolve_session_binding(&bot.id, &room.id, "kernel", BindingIdentity::default())
        .unwrap();
    store
        .attach_binding_session(
            &resolved.binding.id,
            "thr_one",
            None,
            Some(resolved.binding.revision),
        )
        .unwrap();
    assert!(store
        .attach_binding_session(&resolved.binding.id, "thr_two", None, None)
        .is_err());
    // Re-attaching the same thread is idempotent.
    let same = store
        .attach_binding_session(&resolved.binding.id, "thr_one", None, None)
        .unwrap();
    assert_eq!(same.knorvia_thread_id.as_deref(), Some("thr_one"));

    store
        .mark_binding_lost(&resolved.binding.id, "test", None)
        .unwrap();
    assert!(store
        .attach_binding_session(&resolved.binding.id, "thr_three", None, None)
        .is_err());
}

#[test]
fn delivery_watermark_is_monotonic() {
    let store = setup("watermark");
    let bot = store.ensure_default_bot().unwrap();
    let room = group(&store, &[bot.id.clone()]);
    let resolved = store
        .resolve_session_binding(&bot.id, &room.id, "kernel", BindingIdentity::default())
        .unwrap();
    let advanced = store
        .record_binding_delivery(&resolved.binding.id, 7, Some(resolved.binding.revision))
        .unwrap();
    assert_eq!(advanced.last_delivered_seq, 7);
    // A stale seq is ignored and does not bump the revision.
    let stale = store
        .record_binding_delivery(&resolved.binding.id, 3, Some(advanced.revision))
        .unwrap();
    assert_eq!(stale.last_delivered_seq, 7);
    assert_eq!(stale.revision, advanced.revision);
}

#[test]
fn room_membership_validation_and_dm_rules() {
    let store = setup("membership");
    let bot = store.ensure_default_bot().unwrap();
    let other = store.create_bot("Second", "soul", "kernel", None).unwrap();

    let dm = store.ensure_dm(&bot.id).unwrap();
    assert!(store
        .add_room_member(&dm.id, &other.id, Some(dm.revision))
        .is_err());
    assert!(store.create_room("dm", "bad dm", &[bot.id.clone(), other.id.clone()]).is_err());
    assert!(store.create_room("group", "empty", &[]).is_err());
    assert!(store
        .create_room("group", "ghost", &["bot_missing".to_string()])
        .is_err());

    let room = group(&store, &[bot.id.clone()]);
    let updated = store
        .add_room_member(&room.id, &other.id, Some(room.revision))
        .unwrap();
    assert_eq!(updated.members.len(), 2);
    let removed = store
        .remove_room_member(&room.id, &other.id, Some(updated.revision))
        .unwrap();
    assert_eq!(removed.members.len(), 1);
    // Renaming a room never creates a new conversation identity.
    assert!(store.create_room("group", "  ", &[bot.id.clone()]).is_err());
}
