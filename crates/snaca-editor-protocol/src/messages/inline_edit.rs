//! `inline_edit.start` — the Ctrl+K path. Does not enter the turn loop.

use crate::types::{InlineEditContext, Range};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InlineEditStartParams {
    pub session_id: String,
    /// Optional: when present, the edit is recorded in this thread's history.
    /// Absent → ephemeral, not persisted to SQLite.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    /// Absolute file path. Selection is `range` within this file.
    pub file: String,
    pub range: Range,
    pub instruction: String,
    pub context: InlineEditContext,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InlineEditStartResult {
    pub turn_id: String,
    /// Pre-allocated so host can render the ghost-text widget immediately,
    /// even before the first `edit.propose_delta` arrives.
    pub proposal_id: String,
}
