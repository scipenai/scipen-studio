//! `session.*` methods.

use crate::types::context::ProjectType;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionOpenParams {
    pub project_id: String,
    pub workspace_root: String,
    pub metadata_root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_metadata_root: Option<String>,
    pub display_name: String,
    pub project_type: ProjectType,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionOpenResult {
    pub session_id: String,
    pub threads: Vec<ThreadSummary>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThreadSummary {
    pub thread_id: String,
    pub title: String,
    pub created_at: String,
    pub last_active_at: String,
    pub turn_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionCloseParams {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionCloseResult {
    pub closed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionListThreadsParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionListThreadsResult {
    pub threads: Vec<ThreadSummary>,
    pub total: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionNewThreadParams {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionNewThreadResult {
    pub thread_id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionSwitchThreadParams {
    pub session_id: String,
    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionSwitchThreadResult {
    pub switched: bool,
    pub thread: ThreadSummary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionDeleteThreadParams {
    pub session_id: String,
    pub thread_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionDeleteThreadResult {
    pub deleted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionRenameThreadParams {
    pub session_id: String,
    pub thread_id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionRenameThreadResult {
    pub renamed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionGetMessagesParams {
    pub session_id: String,
    pub thread_id: String,
    /// Cap on the number of messages returned. Defaults to all available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionGetMessagesResult {
    pub messages: Vec<ThreadMessage>,
    /// Total messages persisted for this thread (>= messages.len()).
    pub total: u32,
}

/// Flat wire representation of a thread message. The richer
/// `snaca_core::Message` (with structured ContentBlocks) is the on-disk
/// shape; the editor protocol downgrades to text + role for rendering.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThreadMessage {
    pub role: ThreadMessageRole,
    /// Concatenated text content (assistant `thinking` blocks are dropped
    /// from history — they were already rendered live via `turn.delta`).
    pub text: String,
    /// RFC3339 UTC timestamp; `chrono::DateTime<Utc>::to_rfc3339()`.
    pub ts: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThreadMessageRole {
    User,
    Assistant,
    System,
}
