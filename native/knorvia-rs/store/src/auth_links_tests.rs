//! A04 acceptance: PKCE secret lifecycle — retention control on terminal,
//! expired and disconnected ops, state-validated callback progress, bounded
//! startup sweep, and owner-only record permissions.

use super::*;

const URL: &str = "https://auth.openai.com/oauth/authorize?state=fresh";

fn temp_state() -> (PathBuf, AuthLinkStore) {
    let dir = std::env::temp_dir().join(format!(
        "knorvia-auth-a04-{}-{}",
        std::process::id(),
        now_ms() + AUTH_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    (dir.clone(), AuthLinkStore::open(&dir))
}

fn op_file(state_root: &Path, op_id: &str) -> PathBuf {
    state_root
        .join("product")
        .join("auth")
        .join("ops")
        .join(format!("{op_id}.json"))
}

fn read_op(state_root: &Path, op_id: &str) -> AuthConnectOp {
    serde_json::from_slice(&std::fs::read(op_file(state_root, op_id)).unwrap()).unwrap()
}

#[test]
fn terminal_ops_leave_no_pkce_verifier_state_or_authorize_url() {
    let (root, store) = temp_state();
    store
        .ensure_link("codex", "oauth", "ChatGPT / Codex", "subscription")
        .unwrap();
    let op = store
        .connect_start(
            "codex",
            "https://auth.openai.com/oauth/authorize?state=abc&code_challenge=def",
            Some(1455),
            Some("state-value".into()),
            Some("verifier-value".into()),
            300_000,
        )
        .unwrap();
    // While live, the durable record carries the secrets server-side only.
    assert_eq!(
        read_op(&root, &op.id).pkce_verifier.as_deref(),
        Some("verifier-value")
    );

    // Cancel (a terminal outcome): the record is scrubbed on disk.
    store
        .connect_finish(&op.id, "cancelled", None, None, Some("user cancelled"))
        .unwrap();
    let on_disk = read_op(&root, &op.id);
    assert_eq!(on_disk.state, "cancelled");
    assert!(
        on_disk.pkce_verifier.is_none(),
        "verifier must not survive a terminal op"
    );
    assert!(
        on_disk.oauth_state.is_none(),
        "state must not survive a terminal op"
    );
    assert!(
        on_disk.authorize_url.is_none(),
        "state-bearing URL must not survive"
    );
    assert!(on_disk.redirect_port.is_none());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn callback_requires_the_exact_recorded_state_once() {
    let (root, store) = temp_state();
    store
        .ensure_link("codex", "oauth", "ChatGPT / Codex", "subscription")
        .unwrap();
    let op = store
        .connect_start(
            "codex",
            "https://auth.openai.com/oauth/authorize?state=abc",
            Some(1455),
            Some("s3cret-state".into()),
            Some("v".into()),
            300_000,
        )
        .unwrap();

    // Wrong state: typed rejection, op stays `waiting`.
    let err = store.connect_callback("codex", "wrong-state").unwrap_err();
    assert_eq!(err.kind, AuthLinkErrorKind::InvalidArgument, "{err}");
    assert_eq!(read_op(&root, &op.id).state, "waiting");

    // Correct state: waiting → exchanging exactly once.
    let progressed = store.connect_callback("codex", "s3cret-state").unwrap();
    assert_eq!(progressed.state, "exchanging");

    // Duplicate/replayed callback: conflict, never a second progress.
    let err = store.connect_callback("codex", "s3cret-state").unwrap_err();
    assert_eq!(err.kind, AuthLinkErrorKind::Conflict, "{err}");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn auth_diagnostics_are_sanitized_before_disk_and_on_legacy_read_list() {
    let (root, store) = temp_state();
    store
        .ensure_link("fixture", "cli", "Fixture CLI", "unknown")
        .unwrap();
    let synthetic = ["sk-secret", "tiny-token", "client-short", "alias-sk-secret"];
    let updated = store
        .apply_detection(
            "fixture",
            None,
            serde_json::json!({
                "installed": true,
                "authenticated": false,
                "version": "sk-secret",
                "token": "tiny-token",
                "nested": {"clientSecret": "client-short", "accountAlias": "alias-sk-secret"}
            }),
            None,
            Some("Authorization: Bearer detail-short host api.example.com"),
        )
        .unwrap();
    let rendered = serde_json::to_string(&updated).unwrap();
    let disk = std::fs::read_to_string(store.link_path("fixture")).unwrap();
    for secret in synthetic.into_iter().chain(["detail-short"]) {
        assert!(!rendered.contains(secret), "RPC projection leaked {secret}: {rendered}");
        assert!(!disk.contains(secret), "disk projection leaked {secret}: {disk}");
    }
    assert!(rendered.contains("api.example.com"));
    let op = store
        .connect_start("fixture", URL, None, None, None, 60_000)
        .unwrap();
    store
        .connect_finish(
            &op.id,
            "connected",
            Some("sk-completion-alias"),
            None,
            Some("status 200 登录成功"),
        )
        .unwrap();
    let disk = std::fs::read_to_string(store.link_path("fixture")).unwrap();
    assert!(!disk.contains("sk-completion-alias"), "{disk}");
    assert!(disk.contains("登录成功"), "{disk}");

    let at = now_ms();
    let legacy = AuthLinkRecord {
        id: "legacy".into(),
        revision: 1,
        kind: "cli".into(),
        display_name: "Legacy CLI".into(),
        status: "error".into(),
        quota_type: "unknown".into(),
        account_alias: Some("sk-legacy-alias".into()),
        capabilities: Some(serde_json::json!({
            "version": "sk-legacy-version",
            "apiKey": "old-short",
            "nested": {"Authorization": "Basic old-basic"}
        })),
        detail: Some("state=old-state 中文诊断 status 401".into()),
        login_url: None,
        login_expires_at_ms: None,
        updated_at_ms: at,
        recorded_at_ms: at,
    };
    AuthLinkStore::write_json(&store.link_path("legacy"), &legacy).unwrap();
    for projection in [
        serde_json::to_string(&store.read_link("legacy").unwrap().unwrap()).unwrap(),
        serde_json::to_string(&store.list_links().unwrap()).unwrap(),
    ] {
        for secret in [
            "sk-legacy-alias",
            "sk-legacy-version",
            "old-short",
            "old-basic",
            "old-state",
        ] {
            assert!(!projection.contains(secret), "legacy RPC leaked {secret}: {projection}");
        }
        assert!(projection.contains("中文诊断"));
        assert!(projection.contains("401"));
    }
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn expired_ops_are_swept_and_scrubbed_even_without_a_live_caller() {
    let (root, store) = temp_state();
    store
        .ensure_link("codex", "oauth", "ChatGPT / Codex", "subscription")
        .unwrap();
    // A live op and one that expired while no process was running.
    let live = store
        .connect_start(
            "codex",
            "https://auth.openai.com/oauth/authorize?state=a",
            Some(1455),
            Some("st-live".into()),
            Some("vv-live".into()),
            300_000,
        )
        .unwrap();
    let stale_id = "authop_stale_0000000000000_0001";
    let stale = AuthConnectOp {
        id: stale_id.into(),
        link_id: "codex".into(),
        state: "waiting".into(),
        authorize_url: Some("https://auth.openai.com/oauth/authorize?state=st-stale".into()),
        redirect_port: Some(1455),
        oauth_state: Some("st-stale".into()),
        pkce_verifier: Some("vv-stale".into()),
        created_at_ms: now_ms() - 10_000,
        expires_at_ms: now_ms() - 5_000,
        updated_at_ms: now_ms() - 10_000,
    };
    std::fs::write(
        op_file(&root, stale_id),
        serde_json::to_vec_pretty(&stale).unwrap(),
    )
    .unwrap();

    // Startup/list sweep: the stale op expires + scrubs, the live op stays.
    let (swept, links) = store.sweep_expired().unwrap();
    assert_eq!(swept, 1, "exactly the stale op");
    assert_eq!(links, vec!["codex".to_string()]);
    let stale_on_disk = read_op(&root, stale_id);
    assert_eq!(stale_on_disk.state, "expired");
    assert!(stale_on_disk.pkce_verifier.is_none());
    assert!(stale_on_disk.oauth_state.is_none());
    assert!(stale_on_disk.authorize_url.is_none());
    assert_eq!(read_op(&root, &live.id).state, "waiting");
    assert_eq!(
        read_op(&root, &live.id).pkce_verifier.as_deref(),
        Some("vv-live")
    );

    // Expiring an older operation must not alter the newer live operation.
    let link = store.read_link("codex").unwrap().unwrap();
    assert_eq!(link.status, "needs-user");
    assert_eq!(
        link.login_url.as_deref(),
        Some("https://auth.openai.com/oauth/authorize?state=a")
    );

    // Sweep is idempotent.
    assert_eq!(store.sweep_expired().unwrap(), (0, Vec::new()));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn start_interrupted_between_pair_writes_repairs_on_reopen() {
    let (root, store) = temp_state();
    store
        .ensure_link("codex", "oauth", "ChatGPT / Codex", "subscription")
        .unwrap();
    set_auth_fail_stage(2);
    let error = store
        .connect_start(
            "codex",
            "https://auth.openai.com/oauth/authorize?state=start-secret",
            Some(1455),
            Some("start-secret".into()),
            Some("start-verifier".into()),
            300_000,
        )
        .unwrap_err();
    assert_eq!(error.kind, AuthLinkErrorKind::Io);

    let reopened = AuthLinkStore::open(&root);
    let link = reopened.read_link("codex").unwrap().unwrap();
    let op = reopened.live_op("codex").unwrap().unwrap();
    assert_eq!(link.status, "needs-user");
    assert_eq!(link.login_url, op.authorize_url);
    assert_eq!(link.login_expires_at_ms, Some(op.expires_at_ms));
    assert!(reopened.intents_dir().read_dir().unwrap().next().is_none());
    // Recovery is idempotent and does not create a second operation.
    assert_eq!(reopened.live_op("codex").unwrap().unwrap().id, op.id);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn finish_interrupted_between_pair_writes_is_terminal_and_scrubbed_after_reopen() {
    let (root, store) = temp_state();
    store
        .ensure_link("codex", "oauth", "ChatGPT / Codex", "subscription")
        .unwrap();
    let op = store
        .connect_start(
            "codex",
            "https://auth.openai.com/oauth/authorize?state=finish-secret",
            Some(1455),
            Some("finish-secret".into()),
            Some("finish-verifier".into()),
            300_000,
        )
        .unwrap();
    set_auth_fail_stage(2);
    assert!(
        store
            .connect_finish(&op.id, "failed", None, None, Some("provider rejected"))
            .is_err()
    );

    let reopened = AuthLinkStore::open(&root);
    assert_eq!(
        reopened.read_link("codex").unwrap().unwrap().status,
        "error"
    );
    let terminal = read_op(&root, &op.id);
    assert_eq!(terminal.state, "failed");
    assert!(terminal.oauth_state.is_none());
    assert!(terminal.pkce_verifier.is_none());
    assert!(terminal.authorize_url.is_none());
    assert!(reopened.live_op("codex").unwrap().is_none());
    assert!(reopened.intents_dir().read_dir().unwrap().next().is_none());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn expiry_interrupted_between_pair_writes_repairs_and_direct_reconnect_works() {
    let (root, store) = temp_state();
    store
        .ensure_link("codex", "oauth", "ChatGPT / Codex", "subscription")
        .unwrap();
    let op = store
        .connect_start(
            "codex",
            "https://auth.openai.com/oauth/authorize?state=expire-secret",
            Some(1455),
            Some("expire-secret".into()),
            Some("expire-verifier".into()),
            1,
        )
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(5));
    set_auth_fail_stage(2);
    assert!(store.live_op("codex").is_err());

    let reopened = AuthLinkStore::open(&root);
    assert_eq!(
        reopened.read_link("codex").unwrap().unwrap().status,
        "expired"
    );
    let terminal = read_op(&root, &op.id);
    assert_eq!(terminal.state, "expired");
    assert!(terminal.oauth_state.is_none() && terminal.pkce_verifier.is_none());
    assert!(
        reopened
            .connect_start("codex", URL, None, None, None, 300_000)
            .is_ok(),
        "timeout recovery must free the slot without listing first"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn orphaned_unknown_completion_fails_closed_instead_of_claiming_connected() {
    let (root, store) = temp_state();
    store
        .ensure_link("codex", "oauth", "ChatGPT / Codex", "subscription")
        .unwrap();
    let mut op = store
        .connect_start(
            "codex",
            "https://auth.openai.com/oauth/authorize?state=unknown",
            Some(1455),
            Some("unknown".into()),
            Some("verifier".into()),
            300_000,
        )
        .unwrap();
    // Simulate an old implementation which wrote a terminal op without a
    // recoverable intent or corresponding link result.
    op.state = "completed".into();
    AuthLinkStore::scrub_op(&mut op);
    AuthLinkStore::write_json(&op_file(&root, &op.id), &op).unwrap();

    let reopened = AuthLinkStore::open(&root);
    let link = reopened.read_link("codex").unwrap().unwrap();
    assert_eq!(link.status, "error");
    assert_ne!(link.status, "connected");
    assert!(link.login_url.is_none());
    assert!(
        reopened
            .connect_start("codex", URL, None, None, None, 300_000)
            .is_ok()
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn auth_records_are_owner_only() {
    let (root, store) = temp_state();
    store
        .ensure_link("codex", "oauth", "ChatGPT / Codex", "subscription")
        .unwrap();
    let op = store
        .connect_start(
            "codex",
            "https://auth.openai.com/oauth/authorize?state=a",
            Some(1455),
            Some("s".into()),
            Some("v".into()),
            300_000,
        )
        .unwrap();
    let path = op_file(&root, &op.id);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "auth op files must be owner-only");
    }
    #[cfg(windows)]
    {
        // On Windows the owner-only DACL is enforced by the filesystem; std
        // does not expose ACL queries, so assert the record is at least
        // readable back and non-empty (ACL policy is covered by the
        // CreateFileW SDDL path shared with the daemon endpoint file).
        assert!(std::fs::metadata(&path).unwrap().len() > 0);
    }
    let _ = std::fs::remove_dir_all(root);
}
