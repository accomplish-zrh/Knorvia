use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{ErrorCategory, JSONRPC_VERSION, ProtocolError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    String(String),
    Number(i64),
}

impl RequestId {
    pub fn as_string(&self) -> String {
        match self {
            Self::String(s) => s.clone(),
            Self::Number(n) => n.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcRequest {
    pub jsonrpc: String,
    pub id: RequestId,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcSuccess {
    pub jsonrpc: String,
    pub id: RequestId,
    pub result: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcFailure {
    pub jsonrpc: String,
    pub id: RequestId,
    pub error: RpcErrorBody,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcErrorBody {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<ProtocolError>,
}

impl RpcSuccess {
    pub fn new(id: RequestId, result: Value) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_string(),
            id,
            result,
        }
    }
}

impl RpcFailure {
    pub fn from_protocol(id: RequestId, err: ProtocolError) -> Self {
        Self {
            jsonrpc: JSONRPC_VERSION.to_string(),
            id,
            error: RpcErrorBody {
                code: err.code,
                message: err.message.clone(),
                data: Some(err),
            },
        }
    }

    pub fn from_category(
        id: RequestId,
        category: ErrorCategory,
        message: impl Into<String>,
    ) -> Self {
        Self::from_protocol(id, ProtocolError::new(category, message))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtocolVersion {
    pub major: u32,
    pub minor: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol: ProtocolVersion,
    pub client: ClientInfo,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub locale: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerIdentity {
    pub name: String,
    pub product: String,
    pub version: String,
    pub user_agent: String,
    pub telemetry_namespace: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol: ProtocolVersion,
    pub server: ServerIdentity,
    pub session_id: String,
    pub capabilities: Vec<String>,
    pub preview_capabilities: Vec<String>,
    pub resume_supported: bool,
    pub max_frame_bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutateMeta {
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub idempotency_key: Option<String>,
    #[serde(default)]
    pub expected_revision: Option<u64>,
    #[serde(default)]
    pub trace_id: Option<String>,
    #[serde(default)]
    pub actor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope {
    pub event_id: String,
    pub stream_id: String,
    pub seq: u64,
    pub emitted_at: String,
    #[serde(default)]
    pub causation_id: Option<String>,
    #[serde(default)]
    pub correlation_id: Option<String>,
    pub schema_version: u32,
    pub kind: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub title: String,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Goal {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub status: String,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
    /// Durable completion criteria. `completed` is only reachable when this is
    /// set, so a finished Goal always states what "done" meant.
    #[serde(default)]
    pub success_criteria: Option<String>,
    /// Standing constraints the work must respect (scope, safety, budget).
    #[serde(default)]
    pub constraints: Option<String>,
    /// The single next atomic action, kept current across Turns and restarts.
    #[serde(default)]
    pub next_action: Option<String>,
    /// RFC 3339 timestamp of the most recent checkpoint write.
    #[serde(default)]
    pub last_checkpoint_at: Option<String>,
    /// Human acceptance tied to this exact criterion and a durable output from
    /// a completed, linked real Turn. This is not inferred from model prose.
    #[serde(default)]
    pub completion_evidence: Option<GoalCompletionEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalCompletionEvidence {
    pub criteria: String,
    pub summary: String,
    pub turn_id: String,
    pub item_id: String,
    pub recorded_at: String,
}

/// One durable Goal execution batch. Created atomically with its first
/// Turn projection so a retry with the same `request_key` can only ever
/// observe (never re-execute) the batch it names.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalExecution {
    pub id: String,
    pub goal_id: String,
    pub workspace_id: String,
    pub thread_id: String,
    /// Caller-chosen idempotency key. Reuse with different parameters is a
    /// typed conflict; reuse with the same parameters returns this batch.
    pub request_key: String,
    /// Digest of every admission parameter that changes execution, so key
    /// reuse is validated against the original input.
    pub input_digest: String,
    pub input_preview: String,
    /// running | waitingUser | paused | completed | failed | interrupted | cancelled
    pub status: String,
    /// Why the batch stopped: roundsExhausted | deadlineReached | waitingUser
    /// | cancelled | failed | interrupted | completed
    #[serde(default)]
    pub stop_reason: Option<String>,
    pub attempt: u32,
    pub rounds: Vec<GoalRound>,
    /// The structured continuous-advance policy in force, echoed verbatim
    /// for idempotent queries. Absent for single-round batches.
    #[serde(default)]
    pub advance: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub terminal_at: Option<String>,
}

/// One Turn inside a Goal execution batch. Status mirrors the durable Turn
/// record; it is never inferred.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalRound {
    pub index: u32,
    pub turn_id: String,
    /// running | completed | failed | interrupted | cancelled
    pub status: String,
    #[serde(default)]
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub workspace_id: String,
    #[serde(default)]
    pub goal_id: Option<String>,
    pub title: String,
    pub status: String,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    pub id: String,
    pub workspace_id: String,
    #[serde(default)]
    pub goal_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    pub title: String,
    pub status: String,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub thread_id: String,
    pub status: String,
    pub created_at: String,
    #[serde(default)]
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub kind: String,
    pub status: String,
    pub seq: u64,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub workspace_id: String,
    pub r#type: String,
    pub title: String,
    pub lifecycle: String,
    #[serde(default)]
    pub current_revision: Option<String>,
    pub revision: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRevision {
    pub id: String,
    pub artifact_id: String,
    #[serde(default)]
    pub parent_ids: Vec<String>,
    pub content_ref: String,
    pub created_at: String,
    pub author: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub workspace_id: String,
    pub r#type: String,
    pub status: String,
    pub attempt: u32,
    #[serde(default)]
    pub checkpoint: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub action: String,
    pub digest: String,
    pub status: String,
    pub created_at: String,
}

/// How one parsed `@` token resolved against the room's bots (A12). The
/// outcome is the dispatch decision: only `resolved` may ever start a turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MentionOutcome {
    Resolved,
    Ambiguous,
    Unresolved,
}

/// Which grammar produced the identity claim. An explicit bot id never
/// re-resolves through display text, so renaming a bot cannot move an
/// already-written mention to a different agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MentionSource {
    /// `@bot:<id>` or `@[label](bot:<id>)`.
    ExplicitId,
    /// `@[Display name]` — supports spaces and other non-ASCII labels.
    BracketedName,
    /// `@Name` — single-token display name with boundary rules.
    BareName,
}

impl MentionSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ExplicitId => "explicitId",
            Self::BracketedName => "bracketedName",
            Self::BareName => "bareName",
        }
    }
}

/// A bot that a parsed mention could refer to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MentionCandidate {
    pub bot_id: String,
    pub name: String,
    /// False for a bot outside this room: it is only reachable through the
    /// explicit cross-room routing rules, never by name-collision luck.
    pub member: bool,
}

/// One parsed mention and why it resolved (or did not).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mention {
    /// The literal token as the user typed it.
    pub text: String,
    /// Byte offset of the token inside the message content.
    pub offset: usize,
    pub source: MentionSource,
    pub outcome: MentionOutcome,
    /// Machine-readable reason (`resolved`, `duplicateName`, `notFound`,
    /// `unknownBotId`, `crossRoomNotPermitted`, `overMentionCap`, …).
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_id: Option<String>,
    #[serde(default)]
    pub member: bool,
    /// Every bot this token could name — the candidates an operator can
    /// disambiguate with an explicit id.
    #[serde(default)]
    pub candidates: Vec<MentionCandidate>,
}

/// The full resolution of one message. `room/send` admits dispatch from this
/// plan; `room/mentions` returns it as a dry run without dispatching.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MentionPlan {
    pub mentions: Vec<Mention>,
    /// Mentioned members in member order, ready to dispatch.
    pub resolved_member_bot_ids: Vec<String>,
    /// Mentioned bots outside the room that the cross-room route may carry.
    pub resolved_external_bot_ids: Vec<String>,
    #[serde(default)]
    pub ambiguous: Vec<Mention>,
    #[serde(default)]
    pub unresolved: Vec<Mention>,
    /// True when the member list was truncated by the per-message cap.
    #[serde(default)]
    pub truncated: bool,
}

impl MentionPlan {
    pub fn is_empty(&self) -> bool {
        self.resolved_member_bot_ids.is_empty() && self.resolved_external_bot_ids.is_empty()
    }
}

pub const STABLE_CAPABILITIES: &[&str] = &[
    "thread",
    "artifact",
    "job",
    "approval",
    "reconnect",
    "workspace",
    "project-context",
    "automation",
    "goal",
    "task",
    "activity",
    "provider",
    "model",
    "skills",
    "migration",
    "bot",
    "room",
    "session-binding",
];
