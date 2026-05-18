//! Session and in-flight turn state. Thread / message persistence lives
//! in `snaca-state` (SQLite); this module only holds session-level runtime
//! handles (paths, project metadata, the DB handle, and the currently
//! running turn). The DB is per-project — see [`SessionManager::open`].

#![allow(dead_code)]

use chrono::{DateTime, Utc};
use snaca_editor_protocol::types::context::ProjectType;
use snaca_state::Database;
use std::path::PathBuf;
use tokio::task::AbortHandle;

// Session intentionally does NOT derive `Debug` — its `db: Database` field
// wraps a `SqlitePool` that doesn't implement `Debug`. No tracing site
// currently formats a Session, so we keep things simple instead of
// hand-rolling a Debug impl that would mask the actual connection state.
pub struct Session {
    pub session_id: String,
    pub project_id: String,
    pub workspace_root: PathBuf,
    pub metadata_root: PathBuf,
    pub shared_metadata_root: Option<PathBuf>,
    pub display_name: String,
    pub project_type: ProjectType,
    /// Id of the thread currently being addressed by the host. Persisted
    /// in memory only — the DB stores the thread rows themselves.
    pub active_thread_id: Option<String>,
    pub inflight: Option<InflightTurn>,
    pub created_at: DateTime<Utc>,
    /// Per-project SQLite handle (cheap to clone — wraps an `Arc<SqlitePool>`).
    pub db: Database,
}

impl Session {
    pub fn new(
        session_id: String,
        project_id: String,
        workspace_root: PathBuf,
        metadata_root: PathBuf,
        shared_metadata_root: Option<PathBuf>,
        display_name: String,
        project_type: ProjectType,
        db: Database,
    ) -> Self {
        Self {
            session_id,
            project_id,
            workspace_root,
            metadata_root,
            shared_metadata_root,
            display_name,
            project_type,
            active_thread_id: None,
            inflight: None,
            created_at: Utc::now(),
            db,
        }
    }
}

/// In-flight turn metadata. `abort` is invoked on `turn.cancel` to stop the
/// spawned task.
#[derive(Debug)]
pub struct InflightTurn {
    pub turn_id: String,
    pub thread_id: String,
    pub kind: TurnKind,
    pub abort: AbortHandle,
    pub started_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnKind {
    Chat,
    InlineEdit,
    Composer,
}
