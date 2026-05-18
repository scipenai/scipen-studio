//! `memory.updated` — fire-and-forget signal that a memory file changed.
//!
//! Host listens to refresh MemoryViewer UI without re-querying.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryUpdatedParams {
    pub session_id: String,
    pub scope: MemoryScope,
    /// File slug (without `.md` extension).
    pub name: String,
    pub action: MemoryAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryScope {
    User,
    Feedback,
    Project,
    Reference,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryAction {
    Created,
    Updated,
    Deleted,
}
