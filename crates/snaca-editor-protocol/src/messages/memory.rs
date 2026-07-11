//! `memory.*` RPC + `memory.updated` notification.
//!
//! - `memory.list / get / write / delete / reveal` — host-driven CRUD over
//!   the per-project memory tree. Used by Studio's MemoryViewer.
//! - `memory.updated` — broadcast emitted whenever the on-disk store is
//!   mutated (by host writes *or* by the engine's background memory
//!   extractor), so the viewer can refresh without polling.

use serde::{Deserialize, Serialize};

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

// ---------------- memory.updated notification ----------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryUpdatedParams {
    pub session_id: String,
    pub scope: MemoryScope,
    /// File slug (without `.md` extension).
    pub name: String,
    pub action: MemoryAction,
}

// ---------------- memory.list ----------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryListParams {
    pub session_id: String,
    /// When `Some`, restrict to that scope. `None` returns all four.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<MemoryScope>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryListResult {
    pub entries: Vec<MemoryEntrySummary>,
}

/// Lightweight summary used to build the viewer list — full content is
/// fetched on demand via `memory.get`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryEntrySummary {
    pub scope: MemoryScope,
    pub name: String,
    /// ISO-8601 timestamp of the file's last mtime, or empty when unknown
    /// (filesystem doesn't report).
    pub last_modified: String,
    /// First non-empty line (≤ 200 chars), with the leading `# ` stripped.
    /// Helps the viewer show a one-line teaser.
    pub preview: String,
}

// ---------------- memory.get ----------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryGetParams {
    pub session_id: String,
    pub scope: MemoryScope,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryGetResult {
    pub scope: MemoryScope,
    pub name: String,
    pub content: String,
    pub last_modified: String,
}

// ---------------- memory.write ----------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryWriteParams {
    pub session_id: String,
    pub scope: MemoryScope,
    pub name: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryWriteResult {
    /// Distinguishes "new file" from "overwrote existing" — used by the
    /// viewer for optimistic UI + correct `memory.updated` action.
    pub action: MemoryAction,
}

// ---------------- memory.delete ----------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryDeleteParams {
    pub session_id: String,
    pub scope: MemoryScope,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryDeleteResult {
    pub deleted: bool,
}

// ---------------- memory.reveal ----------------

/// Returns the absolute path of the entry on disk so the host can open
/// the system file manager / shell.showItemInFolder on it. Decoupled from
/// `memory.get` so a viewer "Reveal" button doesn't pay the cost of
/// reading the file body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryRevealParams {
    pub session_id: String,
    /// When `name` is provided, return that entry's `.md` path. Otherwise
    /// return the memory directory itself so the host opens the folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<MemoryScope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MemoryRevealResult {
    /// Absolute, OS-native path.
    pub path: String,
}
