//! Session and in-flight turn state. Thread / message persistence lives
//! in `snaca-state` (SQLite); this module only holds session-level runtime
//! handles (paths, project metadata, the DB handle, and the currently
//! running turn). The DB is per-project — see [`SessionManager::open`].

#![allow(dead_code)]

use chrono::{DateTime, Utc};
use snaca_core::{ProjectId, TenantId};
use snaca_editor_protocol::types::context::ProjectType;
use snaca_engine::Engine;
use snaca_state::Database;
use snaca_workspace::WorkspaceLayout;
use std::path::PathBuf;
use std::sync::Arc;
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
    /// Agentic turn runner — built lazily at session open with the
    /// current LLM client, project workspace, and the per-project DB.
    /// `Option` so a session can exist before Phase B wires `handle_chat_send`
    /// to use it (P1 chat path bypasses Engine entirely).
    pub engine: Option<Arc<Engine>>,
    /// Read-only bundled-skills dir (from `SnacaConfig`); lowest-priority scope.
    pub bundled_skills_dir: Option<PathBuf>,
}

impl Session {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        session_id: String,
        project_id: String,
        workspace_root: PathBuf,
        metadata_root: PathBuf,
        shared_metadata_root: Option<PathBuf>,
        display_name: String,
        project_type: ProjectType,
        db: Database,
        engine: Option<Arc<Engine>>,
        bundled_skills_dir: Option<PathBuf>,
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
            engine,
            bundled_skills_dir,
        }
    }

    /// `<metadata_root>/local/projects/<project_id>/memory/`. Matches the
    /// path `Engine::spawn_memory_extraction` writes to via
    /// `WorkspaceLayout::memory_dir` so host reads see exactly what the
    /// background extractor produces. Falls back to a path under
    /// `metadata_root` even when the layout can't be built — every caller
    /// already tolerates a missing directory.
    pub fn memory_dir(&self) -> PathBuf {
        let tenant = TenantId::new(crate::session_manager::STUDIO_TENANT_ID);
        let project = ProjectId::from_raw(&self.project_id);
        WorkspaceLayout::new(&self.metadata_root)
            .map(|l| l.memory_dir(&tenant, &project))
            .unwrap_or_else(|_| {
                self.metadata_root
                    .join(crate::session_manager::STUDIO_TENANT_ID)
                    .join("projects")
                    .join(&self.project_id)
                    .join("memory")
            })
    }

    /// `<metadata_root>/local/projects/<project_id>/skills/`.
    pub fn project_skills_dir(&self) -> PathBuf {
        let tenant = TenantId::new(crate::session_manager::STUDIO_TENANT_ID);
        let project = ProjectId::from_raw(&self.project_id);
        WorkspaceLayout::new(&self.metadata_root)
            .map(|l| l.project_skills_dir(&tenant, &project))
            .unwrap_or_else(|_| {
                self.metadata_root
                    .join(crate::session_manager::STUDIO_TENANT_ID)
                    .join("projects")
                    .join(&self.project_id)
                    .join("skills")
            })
    }

    /// `<metadata_root>/local/skills/`. Shared across all projects under
    /// the same tenant.
    pub fn tenant_skills_dir(&self) -> PathBuf {
        let tenant = TenantId::new(crate::session_manager::STUDIO_TENANT_ID);
        WorkspaceLayout::new(&self.metadata_root)
            .map(|l| l.tenant_skills_dir(&tenant))
            .unwrap_or_else(|_| {
                self.metadata_root
                    .join(crate::session_manager::STUDIO_TENANT_ID)
                    .join("skills")
            })
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
