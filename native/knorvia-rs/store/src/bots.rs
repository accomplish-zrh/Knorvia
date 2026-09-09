//! Bot profiles, rooms (groups and DMs), and durable session bindings.
//!
//! The social domain is the persistent coordination layer above the Kernel.
//! Bots are named profiles with a versioned Soul; rooms are conversations
//! with stable ids — display names are never keys; a SessionBinding pins one
//! (bot, conversation, backend) tuple to exactly one execution session per
//! binding generation. Every projection here lives on a single `bot-social`
//! event stream so a binding-key repoint and both binding generations commit
//! as one recoverable transaction, and no second stream can ever own these
//! documents.

use super::durable::{EventDraft, ProjectionKind};
use super::{
    ProductStore, StoreError, conflict, invalid, new_id, not_found, now_rfc3339, read_json,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;

/// Stable id of the shipped default Knorvia bot. Idempotent initialization
/// reads this exact id, so two concurrent or repeated boots cannot create a
/// second default profile.
pub const DEFAULT_BOT_ID: &str = "bot_knorvia_default";
/// Event stream owning every social-domain projection and event.
pub(super) const SOCIAL_STREAM: &str = "bot-social";
/// Soul history retained per bot profile (most recent last).
const SOUL_HISTORY_LIMIT: usize = 50;
/// Group size bounds. A DM pins exactly one bot against the user.
pub const MAX_GROUP_BOTS: usize = 12;

pub const DEFAULT_KNORVIA_SOUL: &str = "You are the Knorvia bot — a calm, precise \
personal workbench companion. You help the user plan and execute real work with the \
Knorvia Kernel: tasks, research, creation and learning. You keep answers concrete, \
cite what you actually did, and never invent capabilities you do not have. Inside a \
group you speak only when addressed or when you can move the task forward, and you \
never repeat another member's answer just to be seen.";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SoulRevisionEntry {
    pub revision: u64,
    pub soul: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BotProfile {
    pub id: String,
    pub name: String,
    pub soul: String,
    pub soul_revision: u64,
    #[serde(default)]
    pub soul_history: Vec<SoulRevisionEntry>,
    /// "kernel" (in-process Knorvia Kernel) or "cli" (external CLI adapter).
    pub backend_kind: String,
    /// Backend identity this bot executes on (e.g. "kernel" or a CLI binding id).
    pub backend_binding_id: Option<String>,
    pub is_default: bool,
    pub created_at: String,
    pub updated_at: String,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoomMember {
    pub bot_id: String,
    pub role: String,
    pub added_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    pub id: String,
    /// "group" or "dm".
    pub kind: String,
    /// Display title only — never an anchor key.
    pub title: String,
    pub members: Vec<RoomMember>,
    pub created_at: String,
    pub updated_at: String,
    pub revision: u64,
    #[serde(default)]
    pub read_seq: u64,
    #[serde(default)]
    pub checkpoints: Vec<RoomCheckpoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RoomCheckpoint {
    pub version: u64,
    pub through_seq: u64,
    pub summary: String,
    pub created_at: String,
}

/// One durable anchor of a (bot, conversation, backend) tuple to one
/// execution session. `binding_generation` increments whenever the identity
/// behind the anchor changes or the session is lost; superseded generations
/// are retained so history stays attributable.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionBinding {
    pub id: String,
    pub bot_id: String,
    pub conversation_id: String,
    pub backend_binding_id: String,
    pub binding_generation: u64,
    pub knorvia_thread_id: Option<String>,
    pub external_session_id: Option<String>,
    pub host_id: Option<String>,
    /// Fingerprint of the backend account — never a raw credential.
    pub account_fingerprint: Option<String>,
    pub canonical_cwd: Option<String>,
    pub backend_version: Option<String>,
    /// Highest room-message sequence delivered into this binding's session.
    pub last_delivered_seq: u64,
    /// "active" | "orphaned" | "superseded".
    pub status: String,
    pub lost_reason: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub revision: u64,
}

/// Locator from a binding key hash to the current binding id. It is a real
/// projection so the repoint commits atomically with the new generation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct BindingKey {
    binding_id: String,
}

/// Identity facts a caller asserts for a binding resolution. `None` means
/// "not observed this time" and never forces a regeneration by itself.
#[derive(Debug, Clone, Default)]
pub struct BindingIdentity<'a> {
    pub host_id: Option<&'a str>,
    pub account_fingerprint: Option<&'a str>,
    pub canonical_cwd: Option<&'a str>,
    pub backend_version: Option<&'a str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BindingAction {
    /// First binding for this (bot, conversation, backend).
    Created,
    /// Existing active binding matched all observed identity facts.
    Reused,
    /// Identity changed or the session was lost: a new generation started.
    Regenerated,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedBinding {
    pub binding: SessionBinding,
    pub action: BindingAction,
}

fn bot_id_new() -> String {
    new_id("bot")
}
fn room_id_new() -> String {
    new_id("room")
}
fn binding_id_new() -> String {
    new_id("bnd")
}

/// Stable hash of a binding's unique lookup key. The natural-key inputs are
/// never used as file names directly so unusual ids stay safe components.
fn binding_key_hash(bot_id: &str, conversation_id: &str, backend_binding_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bot_id.as_bytes());
    hasher.update([0u8]);
    hasher.update(conversation_id.as_bytes());
    hasher.update([0u8]);
    hasher.update(backend_binding_id.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn validate_non_empty(field: &str, value: &str) -> Result<(), StoreError> {
    if value.trim().is_empty() {
        return Err(invalid(format!("{field} must not be empty")));
    }
    Ok(())
}

fn validate_backend_kind(kind: &str) -> Result<(), StoreError> {
    match kind {
        "kernel" | "cli" => Ok(()),
        other => Err(invalid(format!(
            "backendKind must be \"kernel\" or \"cli\", not {other:?}"
        ))),
    }
}

impl ProductStore {
    pub(super) fn bot_path(&self, id: &str) -> PathBuf {
        self.product_dir().join("bots").join(format!("{id}.json"))
    }
    pub(super) fn room_path(&self, id: &str) -> PathBuf {
        self.product_dir().join("rooms").join(format!("{id}.json"))
    }
    pub(super) fn binding_path(&self, id: &str) -> PathBuf {
        self.product_dir()
            .join("session-bindings")
            .join(format!("{id}.json"))
    }
    pub(super) fn chat_message_path(
        &self,
        conversation_id: &str,
        seq: Option<u64>,
        id: &str,
    ) -> PathBuf {
        let name = match seq {
            Some(seq) => format!("{seq:020}-{id}.json"),
            None => format!("{id}.json"),
        };
        self.product_dir()
            .join("room-chat")
            .join(conversation_id)
            .join(name)
    }
    pub(super) fn binding_key_path(&self, key_hash: &str) -> PathBuf {
        self.product_dir()
            .join("bot-binding-keys")
            .join(format!("{key_hash}.json"))
    }

    // ---------------------------------------------------------------- bots

    /// Read-or-create the default Knorvia bot. Safe to call on every boot:
    /// the second call observes the durable profile and changes nothing.
    pub fn ensure_default_bot(&self) -> Result<BotProfile, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        if let Ok(existing) = self.read_bot_locked(DEFAULT_BOT_ID) {
            return Ok(existing);
        }
        let now = now_rfc3339();
        let bot = BotProfile {
            id: DEFAULT_BOT_ID.to_string(),
            name: "Knorvia".to_string(),
            soul: DEFAULT_KNORVIA_SOUL.to_string(),
            soul_revision: 1,
            soul_history: Vec::new(),
            backend_kind: "kernel".to_string(),
            backend_binding_id: Some("kernel".to_string()),
            is_default: true,
            created_at: now.clone(),
            updated_at: now,
            revision: 1,
        };
        let write = self.projection_write(ProjectionKind::Bot, &bot.id, &bot)?;
        self.commit_transaction_locked(
            SOCIAL_STREAM,
            "bot.created",
            serde_json::to_value(&bot)?,
            None,
            vec![write],
        )?;
        Ok(bot)
    }

    pub fn create_bot(
        &self,
        name: &str,
        soul: &str,
        backend_kind: &str,
        backend_binding_id: Option<&str>,
    ) -> Result<BotProfile, StoreError> {
        validate_non_empty("name", name)?;
        validate_non_empty("soul", soul)?;
        validate_backend_kind(backend_kind)?;
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let now = now_rfc3339();
        let bot = BotProfile {
            id: bot_id_new(),
            name: name.trim().to_string(),
            soul: soul.to_string(),
            soul_revision: 1,
            soul_history: Vec::new(),
            backend_kind: backend_kind.to_string(),
            backend_binding_id: backend_binding_id.map(str::to_string),
            is_default: false,
            created_at: now.clone(),
            updated_at: now,
            revision: 1,
        };
        let write = self.projection_write(ProjectionKind::Bot, &bot.id, &bot)?;
        self.commit_transaction_locked(
            SOCIAL_STREAM,
            "bot.created",
            serde_json::to_value(&bot)?,
            None,
            vec![write],
        )?;
        Ok(bot)
    }

    /// Names are display labels: renaming never touches session anchors.
    pub fn rename_bot(
        &self,
        bot_id: &str,
        name: &str,
        expected_revision: Option<u64>,
    ) -> Result<BotProfile, StoreError> {
        validate_non_empty("name", name)?;
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut bot = self.read_bot_locked(bot_id)?;
        Self::check_revision(bot.revision, expected_revision, "bot")?;
        bot.name = name.trim().to_string();
        bot.revision += 1;
        bot.updated_at = now_rfc3339();
        let write = self.projection_write(ProjectionKind::Bot, &bot.id, &bot)?;
        self.commit_transaction_locked(
            SOCIAL_STREAM,
            "bot.renamed",
            serde_json::to_value(&bot)?,
            None,
            vec![write],
        )?;
        Ok(bot)
    }

    /// Publish a new Soul revision. History is retained on the profile so an
    /// older revision can always be inspected after the edit.
    pub fn update_bot_soul(
        &self,
        bot_id: &str,
        soul: &str,
        expected_revision: Option<u64>,
    ) -> Result<BotProfile, StoreError> {
        validate_non_empty("soul", soul)?;
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut bot = self.read_bot_locked(bot_id)?;
        Self::check_revision(bot.revision, expected_revision, "bot")?;
        let previous_revision = bot.soul_revision;
        bot.soul_history.push(SoulRevisionEntry {
            revision: previous_revision,
            soul: bot.soul.clone(),
            updated_at: bot.updated_at.clone(),
        });
        bot.soul_revision += 1;
        let history_start = bot.soul_history.len().saturating_sub(SOUL_HISTORY_LIMIT);
        bot.soul_history.drain(..history_start);
        bot.soul = soul.to_string();
        bot.revision += 1;
        bot.updated_at = now_rfc3339();
        let write = self.projection_write(ProjectionKind::Bot, &bot.id, &bot)?;
        self.commit_transaction_locked(
            SOCIAL_STREAM,
            "bot.soulUpdated",
            serde_json::to_value(&bot)?,
            None,
            vec![write],
        )?;
        Ok(bot)
    }

    pub fn read_bot(&self, bot_id: &str) -> Result<BotProfile, StoreError> {
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        self.read_bot_locked(bot_id)
    }

    pub fn list_bots(&self) -> Result<Vec<BotProfile>, StoreError> {
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        self.list_bots_locked()
    }

    pub(super) fn read_bot_locked(&self, bot_id: &str) -> Result<BotProfile, StoreError> {
        let path = self.bot_path(bot_id);
        match fs::read(&path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Err(not_found("bot", bot_id))
            }
            Err(error) => Err(error.into()),
        }
    }

    fn list_bots_locked(&self) -> Result<Vec<BotProfile>, StoreError> {
        let dir = self.product_dir().join("bots");
        let mut bots: Vec<BotProfile> = Vec::new();
        if dir.exists() {
            for entry in fs::read_dir(dir)? {
                let entry = entry?;
                if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                bots.push(read_json(&entry.path())?);
            }
        }
        bots.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(bots)
    }

    // --------------------------------------------------------------- rooms

    /// Create a group conversation. Members must be existing bots; display
    /// names are never deduplicated — every call yields a fresh identity.
    pub fn create_room(
        &self,
        kind: &str,
        title: &str,
        bot_ids: &[String],
    ) -> Result<Room, StoreError> {
        match kind {
            "group" | "dm" => {}
            other => {
                return Err(invalid(format!(
                    "room kind must be \"group\" or \"dm\", not {other:?}"
                )));
            }
        }
        validate_non_empty("title", title)?;
        if bot_ids.is_empty() {
            return Err(invalid("a room needs at least one bot member"));
        }
        if kind == "dm" && bot_ids.len() != 1 {
            return Err(invalid("a DM pins exactly one bot member"));
        }
        if kind == "group" && bot_ids.len() > MAX_GROUP_BOTS {
            return Err(invalid(format!(
                "a group holds at most {MAX_GROUP_BOTS} bots"
            )));
        }
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        for bot_id in bot_ids {
            self.read_bot_locked(bot_id)?;
        }
        let now = now_rfc3339();
        let room = Room {
            id: room_id_new(),
            read_seq: 0,
            checkpoints: Vec::new(),
            kind: kind.to_string(),
            title: title.trim().to_string(),
            members: bot_ids
                .iter()
                .map(|bot_id| RoomMember {
                    bot_id: bot_id.clone(),
                    role: "member".to_string(),
                    added_at: now.clone(),
                })
                .collect(),
            created_at: now.clone(),
            updated_at: now,
            revision: 1,
        };
        let write = self.projection_write(ProjectionKind::Room, &room.id, &room)?;
        self.commit_transaction_locked(
            SOCIAL_STREAM,
            "room.created",
            serde_json::to_value(&room)?,
            None,
            vec![write],
        )?;
        Ok(room)
    }

    /// Read-or-create the user's direct conversation with one bot. The DM is
    /// keyed by the bot's id — repeated calls return the same conversation,
    /// and a deleted bot's DM is never silently recreated around a stale id.
    pub fn ensure_dm(&self, bot_id: &str) -> Result<Room, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        self.read_bot_locked(bot_id)?;
        for room in self.list_rooms_locked()? {
            if room.kind == "dm" && room.members.len() == 1 && room.members[0].bot_id == bot_id {
                return Ok(room);
            }
        }
        let bot = self.read_bot_locked(bot_id)?;
        let now = now_rfc3339();
        let room = Room {
            id: room_id_new(),
            read_seq: 0,
            checkpoints: Vec::new(),
            kind: "dm".to_string(),
            title: format!("DM · {}", bot.name),
            members: vec![RoomMember {
                bot_id: bot_id.to_string(),
                role: "member".to_string(),
                added_at: now.clone(),
            }],
            created_at: now.clone(),
            updated_at: now,
            revision: 1,
        };
        let write = self.projection_write(ProjectionKind::Room, &room.id, &room)?;
        self.commit_transaction_locked(
            SOCIAL_STREAM,
            "room.created",
            serde_json::to_value(&room)?,
            None,
            vec![write],
        )?;
        Ok(room)
    }

    /// Rename a room. This deliberately cannot affect any session anchor:
    /// bindings key on the stable conversation id, never the title.
    pub fn rename_room(
        &self,
        conversation_id: &str,
        title: &str,
        expected_revision: Option<u64>,
    ) -> Result<Room, StoreError> {
        validate_non_empty("title", title)?;
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut room = self.read_room_locked(conversation_id)?;
        Self::check_revision(room.revision, expected_revision, "room")?;
        room.title = title.trim().to_string();
        room.revision += 1;
        room.updated_at = now_rfc3339();
        let write = self.projection_write(ProjectionKind::Room, &room.id, &room)?;
        self.commit_transaction_locked(
            SOCIAL_STREAM,
            "room.renamed",
            serde_json::to_value(&room)?,
            None,
            vec![write],
        )?;
        Ok(room)
    }

    pub fn add_room_member(
        &self,
        conversation_id: &str,
        bot_id: &str,
        expected_revision: Option<u64>,
    ) -> Result<Room, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut room = self.read_room_locked(conversation_id)?;
        Self::check_revision(room.revision, expected_revision, "room")?;
        if room.members.iter().any(|m| m.bot_id == bot_id) {
            return Err(conflict(format!(
                "bot {bot_id} is already in {conversation_id}"
            )));
        }
        if room.kind == "dm" {
            return Err(conflict("a DM cannot take additional members"));
        }
        if room.members.len() >= MAX_GROUP_BOTS {
            return Err(invalid(format!(
                "a group holds at most {MAX_GROUP_BOTS} bots"
            )));
        }
        self.read_bot_locked(bot_id)?;
        room.members.push(RoomMember {
            bot_id: bot_id.to_string(),
            role: "member".to_string(),
            added_at: now_rfc3339(),
        });
        room.revision += 1;
        room.updated_at = now_rfc3339();
        let write = self.projection_write(ProjectionKind::Room, &room.id, &room)?;
        self.commit_transaction_locked(
            SOCIAL_STREAM,
            "room.memberAdded",
            serde_json::to_value(&room)?,
            None,
            vec![write],
        )?;
        Ok(room)
    }

    pub fn remove_room_member(
        &self,
        conversation_id: &str,
        bot_id: &str,
        expected_revision: Option<u64>,
    ) -> Result<Room, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut room = self.read_room_locked(conversation_id)?;
        Self::check_revision(room.revision, expected_revision, "room")?;
        let before = room.members.len();
        room.members.retain(|m| m.bot_id != bot_id);
        if room.members.len() == before {
            return Err(not_found("room member", bot_id));
        }
        if room.members.is_empty() {
            return Err(conflict("the last bot member cannot leave a room"));
        }
        room.revision += 1;
        room.updated_at = now_rfc3339();
        let write = self.projection_write(ProjectionKind::Room, &room.id, &room)?;
        self.commit_transaction_locked(
            SOCIAL_STREAM,
            "room.memberRemoved",
            serde_json::to_value(&room)?,
            None,
            vec![write],
        )?;
        Ok(room)
    }

    pub fn read_room(&self, conversation_id: &str) -> Result<Room, StoreError> {
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        self.read_room_locked(conversation_id)
    }

    pub fn list_rooms(&self) -> Result<Vec<Room>, StoreError> {
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        self.list_rooms_locked()
    }

    pub(super) fn read_room_locked(&self, conversation_id: &str) -> Result<Room, StoreError> {
        let path = self.room_path(conversation_id);
        match fs::read(&path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Err(not_found("room", conversation_id))
            }
            Err(error) => Err(error.into()),
        }
    }

    pub(super) fn list_rooms_locked(&self) -> Result<Vec<Room>, StoreError> {
        let dir = self.product_dir().join("rooms");
        let mut rooms: Vec<Room> = Vec::new();
        if dir.exists() {
            for entry in fs::read_dir(dir)? {
                let entry = entry?;
                if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                rooms.push(read_json(&entry.path())?);
            }
        }
        rooms.sort_by(|a, b| {
            a.created_at
                .cmp(&b.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(rooms)
    }

    // ---------------------------------------------------- session bindings

    /// Resolve the durable anchor for one (bot, conversation, backend).
    ///
    /// Reuses the active binding when every observed identity fact matches;
    /// starts a new generation when the host, account, cwd or backend version
    /// changed, or when the previous session was marked lost. A regenerated
    /// binding never inherits the previous thread ids: the caller attaches a
    /// freshly created session, so a stale "most recent" conversation can
    /// never be silently resumed.
    pub fn resolve_session_binding(
        &self,
        bot_id: &str,
        conversation_id: &str,
        backend_binding_id: &str,
        identity: BindingIdentity<'_>,
    ) -> Result<ResolvedBinding, StoreError> {
        validate_non_empty("backendBindingId", backend_binding_id)?;
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        self.read_bot_locked(bot_id)?;
        self.read_room_locked(conversation_id)?;

        let key_hash = binding_key_hash(bot_id, conversation_id, backend_binding_id);
        let key_path = self.binding_key_path(&key_hash);
        let mut current: Option<SessionBinding> = match fs::read(&key_path) {
            Ok(bytes) => {
                let key: BindingKey = serde_json::from_slice(&bytes)?;
                match self.read_binding_locked(&key.binding_id) {
                    Ok(binding) => Some(binding),
                    Err(_) => None,
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };

        let had_current = current.is_some();
        if let Some(binding) = current.as_ref().filter(|b| b.status == "active") {
            let identity_matches = [
                (identity.host_id, &binding.host_id),
                (identity.account_fingerprint, &binding.account_fingerprint),
                (identity.canonical_cwd, &binding.canonical_cwd),
                (identity.backend_version, &binding.backend_version),
            ]
            .into_iter()
            .all(|(observed, stored)| match observed {
                None => true,
                Some(observed) => stored.as_deref() == Some(observed),
            });
            if identity_matches {
                return Ok(ResolvedBinding {
                    binding: binding.clone(),
                    action: BindingAction::Reused,
                });
            }
        }

        let now = now_rfc3339();
        let generation = current.as_ref().map(|b| b.binding_generation).unwrap_or(0) + 1;
        let reason = if had_current {
            "identity changed".to_string()
        } else {
            "first binding".to_string()
        };
        let binding = SessionBinding {
            id: binding_id_new(),
            bot_id: bot_id.to_string(),
            conversation_id: conversation_id.to_string(),
            backend_binding_id: backend_binding_id.to_string(),
            binding_generation: generation,
            knorvia_thread_id: None,
            external_session_id: None,
            host_id: identity.host_id.map(str::to_string),
            account_fingerprint: identity.account_fingerprint.map(str::to_string),
            canonical_cwd: identity.canonical_cwd.map(str::to_string),
            backend_version: identity.backend_version.map(str::to_string),
            last_delivered_seq: 0,
            status: "active".to_string(),
            lost_reason: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            revision: 1,
        };

        // One transaction: supersede the old generation (if any), write the
        // new one and repoint the key. (clone above keeps `now` usable for
        // the superseded record below.) A crash mid-way recovers all three
        // facts together, so the key never dangles on an uncommitted binding.
        let mut writes = Vec::new();
        let mut events = Vec::new();
        if let Some(old) = current.take() {
            let mut old = old;
            if old.status == "active" {
                old.status = "superseded".to_string();
                old.lost_reason = Some(reason.clone());
                old.updated_at = now.clone();
                old.revision += 1;
                writes.push(self.projection_write(
                    ProjectionKind::SessionBinding,
                    &old.id,
                    &old,
                )?);
                events.push(EventDraft::new(
                    "binding.superseded",
                    serde_json::to_value(&old)?,
                ));
            }
        }
        writes.push(self.projection_write(
            ProjectionKind::SessionBinding,
            &binding.id,
            &binding,
        )?);
        writes.push(self.projection_write(
            ProjectionKind::BindingKey,
            &key_hash,
            &BindingKey {
                binding_id: binding.id.clone(),
            },
        )?);
        events.push(EventDraft::new(
            "binding.resolved",
            serde_json::json!({
                "binding": binding,
                "action": if had_current { "regenerated" } else { "created" },
            }),
        ));
        self.commit_transaction_batch_locked(SOCIAL_STREAM, events, writes)?;
        let action = if had_current {
            BindingAction::Regenerated
        } else {
            BindingAction::Created
        };
        Ok(ResolvedBinding { binding, action })
    }

    /// Anchor a resolved binding to a concrete execution session. Attach is
    /// single-shot per generation: an already-attached binding refuses a
    /// different thread id instead of quietly moving the anchor.
    pub fn attach_binding_session(
        &self,
        binding_id: &str,
        knorvia_thread_id: &str,
        external_session_id: Option<&str>,
        expected_revision: Option<u64>,
    ) -> Result<SessionBinding, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut binding = self.read_binding_locked(binding_id)?;
        Self::check_revision(binding.revision, expected_revision, "binding")?;
        if binding.status != "active" {
            return Err(conflict(format!(
                "binding {binding_id} is {status}, not active; resolve a new generation first",
                status = binding.status
            )));
        }
        if let Some(existing) = binding.knorvia_thread_id.as_deref() {
            if existing == knorvia_thread_id {
                match (binding.external_session_id.as_deref(), external_session_id) {
                    (Some(old), Some(new)) if old != new => {
                        return Err(conflict(
                            "external CLI session cannot move within a binding generation",
                        ));
                    }
                    (None, Some(_)) => {}
                    _ => return Ok(binding),
                }
            } else {
                return Err(conflict(format!(
                    "binding {binding_id} is already anchored to thread {existing}"
                )));
            }
        }
        binding.knorvia_thread_id = Some(knorvia_thread_id.to_string());
        binding.external_session_id = external_session_id.map(str::to_string);
        binding.revision += 1;
        binding.updated_at = now_rfc3339();
        let write = self.projection_write(ProjectionKind::SessionBinding, &binding.id, &binding)?;
        self.commit_transaction_locked(
            SOCIAL_STREAM,
            "binding.attached",
            serde_json::to_value(&binding)?,
            None,
            vec![write],
        )?;
        Ok(binding)
    }

    /// Record that a session loss was observed (crash, CLI upgrade, account
    /// switch, explicit unbind). The binding stops being reusable; the next
    /// resolution starts a clean generation. The previous thread id stays on
    /// the orphaned record for forensics, never for fallback.
    pub fn mark_binding_lost(
        &self,
        binding_id: &str,
        reason: &str,
        expected_revision: Option<u64>,
    ) -> Result<SessionBinding, StoreError> {
        validate_non_empty("reason", reason)?;
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut binding = self.read_binding_locked(binding_id)?;
        Self::check_revision(binding.revision, expected_revision, "binding")?;
        if binding.status != "active" {
            return Ok(binding);
        }
        binding.status = "orphaned".to_string();
        binding.lost_reason = Some(reason.to_string());
        binding.revision += 1;
        binding.updated_at = now_rfc3339();
        let write = self.projection_write(ProjectionKind::SessionBinding, &binding.id, &binding)?;
        self.commit_transaction_locked(
            SOCIAL_STREAM,
            "binding.lost",
            serde_json::to_value(&binding)?,
            None,
            vec![write],
        )?;
        Ok(binding)
    }

    /// Advance the delivery watermark for a binding. Monotonic: a stale
    /// sequence cannot roll the watermark back, and the room scheduler uses
    /// it to recompute exactly the un-delivered suffix after a crash.
    pub fn record_binding_delivery(
        &self,
        binding_id: &str,
        seq: u64,
        expected_revision: Option<u64>,
    ) -> Result<SessionBinding, StoreError> {
        let _mutations = self.lock_mutations()?;
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let mut binding = self.read_binding_locked(binding_id)?;
        Self::check_revision(binding.revision, expected_revision, "binding")?;
        if seq <= binding.last_delivered_seq {
            return Ok(binding);
        }
        binding.last_delivered_seq = seq;
        binding.revision += 1;
        binding.updated_at = now_rfc3339();
        let write = self.projection_write(ProjectionKind::SessionBinding, &binding.id, &binding)?;
        self.commit_transaction_locked(
            SOCIAL_STREAM,
            "binding.delivered",
            serde_json::to_value(&binding)?,
            None,
            vec![write],
        )?;
        Ok(binding)
    }

    pub fn read_binding(&self, binding_id: &str) -> Result<SessionBinding, StoreError> {
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        self.read_binding_locked(binding_id)
    }

    /// List bindings, optionally scoped to one bot and/or conversation.
    /// Newest generation first so callers see the current anchor up front.
    pub fn list_bindings(
        &self,
        bot_id: Option<&str>,
        conversation_id: Option<&str>,
    ) -> Result<Vec<SessionBinding>, StoreError> {
        let _journal = self.lock_journal()?;
        self.recover_durable_state_locked()?;
        let dir = self.product_dir().join("session-bindings");
        let mut bindings = Vec::new();
        if dir.exists() {
            for entry in fs::read_dir(dir)? {
                let entry = entry?;
                if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                let binding: SessionBinding = read_json(&entry.path())?;
                if let Some(bot_id) = bot_id
                    && binding.bot_id != bot_id
                {
                    continue;
                }
                if let Some(conversation_id) = conversation_id
                    && binding.conversation_id != conversation_id
                {
                    continue;
                }
                bindings.push(binding);
            }
        }
        bindings.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| b.id.cmp(&a.id))
        });
        Ok(bindings)
    }

    fn read_binding_locked(&self, binding_id: &str) -> Result<SessionBinding, StoreError> {
        let path = self.binding_path(binding_id);
        match fs::read(&path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Err(not_found("session binding", binding_id))
            }
            Err(error) => Err(error.into()),
        }
    }

    fn check_revision(current: u64, expected: Option<u64>, kind: &str) -> Result<(), StoreError> {
        match expected {
            Some(expected) if expected != current => Err(conflict(format!(
                "{kind} revision {current} != expected {expected}"
            ))),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
#[path = "bots_tests.rs"]
mod bots_tests;
