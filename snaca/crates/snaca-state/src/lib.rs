//! `snaca-state` — SQLite persistence via sqlx.
//!
//! Single-file SQLite database. M1 single-tenant; multi-tenant rows
//! filterable by `tenant_id` columns from the start so the schema is
//! forward-compatible.
//!
//! Tables (M1):
//! - `threads`              — one row per IM conversation thread
//! - `messages`             — assistant/user/tool messages, ordered by created_at
//! - `tool_calls`           — tool invocation audit (input/output/error/timing)
//! - `chat_session_binding` — (chat_id, user_id) → project_id routing
//!
//! Future (M2): `tenants`, `checkpoints`, indexes for cross-tenant queries.

pub mod db;
pub mod error;
pub mod models;

pub use db::Database;
pub use error::{StateError, StateResult};
pub use models::{
    ChatBinding, MemoryVector, MessageRow, NewMessage, NewOutboxEntry, NewScheduledTask,
    NewThread, OutboxKind, OutboxRow, OutboxStatus, PersistedDecision, ScheduledTask,
    StoredApprovalDecision, ThreadCompaction, ThreadRow, ToolCallRow,
};
