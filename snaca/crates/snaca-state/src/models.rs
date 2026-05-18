//! Domain models — input/output shapes for `Database` operations.
//!
//! Rows mirror table layout. `New*` types are constructor inputs that
//! omit auto-populated fields (id, created_at).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use snaca_core::{ContentBlock, MessageId, ProjectId, Role, SessionId, TenantId, ThreadId, ToolUseId};

#[derive(Debug, Clone)]
pub struct NewThread {
    pub id: ThreadId,
    pub tenant_id: TenantId,
    pub project_id: ProjectId,
    /// User-facing thread title. Defaults to "New conversation" on the SQL
    /// side when omitted; callers should usually supply a value to keep the
    /// in-memory `Display` consistent.
    pub title: String,
}

#[derive(Debug, Clone)]
pub struct ThreadRow {
    pub id: ThreadId,
    pub tenant_id: TenantId,
    pub project_id: ProjectId,
    pub title: String,
    pub created_at: DateTime<Utc>,
}

/// Aggregated thread metadata for list views. `last_active_at` is the most
/// recent message timestamp (falling back to `created_at` when the thread
/// has no messages yet); `turn_count` is the number of user-role messages
/// in the thread.
#[derive(Debug, Clone)]
pub struct ThreadSummaryRow {
    pub thread: ThreadRow,
    pub last_active_at: DateTime<Utc>,
    pub turn_count: u32,
}

#[derive(Debug, Clone)]
pub struct NewMessage {
    pub thread_id: ThreadId,
    pub session_id: SessionId,
    pub role: Role,
    pub content: Vec<ContentBlock>,
}

#[derive(Debug, Clone)]
pub struct MessageRow {
    pub id: MessageId,
    pub thread_id: ThreadId,
    pub session_id: SessionId,
    pub role: Role,
    pub content: Vec<ContentBlock>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct ToolCallRow {
    pub id: ToolUseId,
    pub message_id: MessageId,
    pub tool_name: String,
    pub input: serde_json::Value,
    pub output: Option<serde_json::Value>,
    pub is_error: bool,
    pub started_at: DateTime<Utc>,
    pub completed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatBinding {
    pub chat_id: String,
    pub user_id: String,
    pub project_id: ProjectId,
    pub bound_at: DateTime<Utc>,
}

/// One row of `memory_vectors` — an embedding for one memory entry.
/// `(tenant_id, project_id, scope, name)` is the natural primary key.
#[derive(Debug, Clone)]
pub struct MemoryVector {
    pub tenant_id: TenantId,
    pub project_id: ProjectId,
    /// Stored as the lowercase scope name (`user` / `project` / `reference` / `feedback`).
    pub scope: String,
    pub name: String,
    pub model_id: String,
    pub embedding: Vec<f32>,
    pub updated_at: DateTime<Utc>,
}

/// Latest compaction record for a thread. The engine consults this on
/// `load_history` to decide whether to splice in a "earlier conversation
/// summary" preamble in place of the messages it covers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadCompaction {
    pub thread_id: ThreadId,
    pub summary: String,
    /// Id of the *last* message that was folded into `summary`. Messages
    /// with `created_at > this row's created_at` are still live history.
    pub summary_until_message_id: MessageId,
    /// First message folded into the summary. `None` means "from the
    /// beginning of the thread" — the legacy behaviour before first-N
    /// protection was added. When `Some`, messages with `id < this`
    /// (older than `summary_from_message_id`) are still surfaced
    /// verbatim by `load_history`, immediately preceding the synthetic
    /// preamble.
    pub summary_from_message_id: Option<MessageId>,
    pub msg_count_before: u32,
    pub input_tokens_before: u32,
    pub compacted_at: DateTime<Utc>,
}

/// Persisted approval decision for
/// `(tenant, project, tool_name, input_signature)`. Only "always"
/// decisions land here — `allow_once` is intentionally transient and
/// never written.
///
/// `input_signature` is a short fingerprint (blake3 of canonical JSON)
/// of the tool input as approved. Empty string ('') is the legacy
/// catch-all that pre-M5 rows used and lookups fall back to.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredApprovalDecision {
    pub tenant_id: TenantId,
    pub project_id: ProjectId,
    pub tool_name: String,
    #[serde(default)]
    pub input_signature: String,
    pub decision: PersistedDecision,
    pub decided_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PersistedDecision {
    Allow,
    Deny,
}

impl PersistedDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            PersistedDecision::Allow => "allow",
            PersistedDecision::Deny => "deny",
        }
    }
}

/// One row in `scheduled_tasks`. Fired by the in-process scheduler
/// when the wall clock reaches `next_fire_at`. After a fire, the
/// scheduler either bumps `next_fire_at` forward by `interval_secs`
/// (recurring) or sets `enabled = 0` (one-shot, when interval is None).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledTask {
    pub id: String,
    pub tenant_id: TenantId,
    pub project_id: ProjectId,
    pub chat_id: String,
    /// Which plugin owns the chat — the firing path looks up this
    /// PluginHandle to deliver the synthetic message.
    pub plugin: String,
    /// Body the scheduler injects as if a user had typed it.
    pub prompt: String,
    /// Recurrence period. `None` = one-shot. Anything else = the
    /// number of seconds to add to `next_fire_at` after each
    /// successful fire.
    pub interval_secs: Option<i64>,
    pub next_fire_at: DateTime<Utc>,
    pub last_fired_at: Option<DateTime<Utc>>,
    /// `false` = paused; the scheduler ignores it. Operators flip
    /// this rather than deleting rules they may want back later.
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
}

/// Caller-supplied payload for `Database::schedule_task`.
#[derive(Debug, Clone)]
pub struct NewScheduledTask {
    pub tenant_id: TenantId,
    pub project_id: ProjectId,
    pub chat_id: String,
    pub plugin: String,
    pub prompt: String,
    pub interval_secs: Option<i64>,
    pub next_fire_at: DateTime<Utc>,
}

/// Kind of outbound IM delivery recorded in the `outbox` table. Pinned
/// to the matching wire-protocol method on the plugin side.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboxKind {
    SendMessage,
    UpdateMessage,
    FileUpload,
}

impl OutboxKind {
    pub fn as_str(self) -> &'static str {
        match self {
            OutboxKind::SendMessage => "send_message",
            OutboxKind::UpdateMessage => "update_message",
            OutboxKind::FileUpload => "file_upload",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "send_message" => Some(OutboxKind::SendMessage),
            "update_message" => Some(OutboxKind::UpdateMessage),
            "file_upload" => Some(OutboxKind::FileUpload),
            _ => None,
        }
    }
}

/// Lifecycle state of an outbox row. Terminal states are `Delivered`
/// (success) and `Failed` (terminal error after MAX_ATTEMPTS or
/// non-retryable error class).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutboxStatus {
    Pending,
    Delivered,
    Failed,
}

impl OutboxStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            OutboxStatus::Pending => "pending",
            OutboxStatus::Delivered => "delivered",
            OutboxStatus::Failed => "failed",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(OutboxStatus::Pending),
            "delivered" => Some(OutboxStatus::Delivered),
            "failed" => Some(OutboxStatus::Failed),
            _ => None,
        }
    }
}

/// Inputs for `Db::outbox_enqueue`. The caller supplies the row id (which
/// is *also* the platform-side idempotency key, so retries dedup on Lark's
/// `?uuid=...` parameter). `next_attempt_at` controls when the worker
/// can first claim the row — callers doing an inline first-try should
/// push this into the future (cushion) so the worker doesn't race the
/// inline attempt; callers without an inline try should pass `now()`.
#[derive(Debug, Clone)]
pub struct NewOutboxEntry {
    pub id: String,
    pub plugin: String,
    pub tenant_id: String,
    pub chat_id: String,
    pub kind: OutboxKind,
    pub payload: serde_json::Value,
    pub next_attempt_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct OutboxRow {
    pub id: String,
    pub plugin: String,
    pub tenant_id: String,
    pub chat_id: String,
    pub kind: OutboxKind,
    pub payload: serde_json::Value,
    pub attempts: u32,
    pub next_attempt_at: DateTime<Utc>,
    pub status: OutboxStatus,
    pub last_error: Option<String>,
    pub platform_message_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub delivered_at: Option<DateTime<Utc>>,
}
