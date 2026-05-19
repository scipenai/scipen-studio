//! `SessionManager` — owns all active `Session`s and routes editor-protocol
//! requests to the per-project SQLite database (`snaca-state`).
//!
//! Each session owns one SQLite file under `metadata_root/state.sqlite`, so
//! project isolation is physical (separate DB per project root). Threads
//! and messages persist across SNACA restarts; only the `active_thread_id`
//! is in-memory runtime state.

#![allow(dead_code)]

use crate::session::{InflightTurn, Session, TurnKind};
use snaca_core::{ContentBlock, Message, ProjectId, Role, SessionId, TenantId, ThreadId};
use snaca_editor_protocol::error::{ErrorCode, ProtocolError};
use snaca_editor_protocol::messages::session::{ThreadMessage, ThreadMessageRole, ThreadSummary};
use snaca_editor_protocol::types::config::SnacaConfig;
use snaca_editor_protocol::types::context::ProjectType;
use snaca_engine::{Engine, EngineConfig};
use snaca_llm::LlmClient;
use snaca_state::{Database, NewMessage, NewThread};
use snaca_tools::base_tool_registry;
use snaca_workspace::WorkspaceLayout;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task::AbortHandle;
use tracing::warn;
use uuid::Uuid;

/// Sole tenant used by Studio. Forward-compatible if SNACA grows multi-tenant.
pub(crate) const STUDIO_TENANT_ID: &str = "local";

/// Default title given to bootstrap and auto-spawned threads. Matches the
/// renderer-side i18n placeholder used when SNACA returns nothing.
const DEFAULT_THREAD_TITLE: &str = "New conversation";

#[derive(Default)]
pub struct SessionManager {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, Session>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
        }
    }

    /// Opens a session backed by a per-project SQLite DB at
    /// `metadata_root/state.sqlite`. Returns
    /// `(session_id, active_thread_id, threads)` where:
    ///   * `threads` reflects every persisted thread for this project,
    ///     most-recently-active first.
    ///   * `active_thread_id` is the most-recently-active thread on disk,
    ///     or a freshly bootstrapped "New conversation" when the project
    ///     has no threads yet (first-ever open).
    #[allow(clippy::too_many_arguments)]
    pub async fn open(
        &self,
        project_id: String,
        workspace_root: PathBuf,
        metadata_root: PathBuf,
        shared_metadata_root: Option<PathBuf>,
        display_name: String,
        project_type: ProjectType,
        llm: Arc<dyn LlmClient>,
        snaca_config: &SnacaConfig,
    ) -> Result<(String, String, Vec<ThreadSummary>), ProtocolError> {
        if !workspace_root.exists() {
            return Err(ProtocolError::new(
                ErrorCode::WorkspaceInvalid,
                format!("workspace_root does not exist: {}", workspace_root.display()),
            ));
        }
        if metadata_root
            .canonicalize()
            .ok()
            .zip(workspace_root.canonicalize().ok())
            .map(|(m, w)| m.starts_with(&w))
            .unwrap_or(false)
        {
            return Err(ProtocolError::new(
                ErrorCode::WorkspaceInvalid,
                "metadata_root must not be nested inside workspace_root",
            ));
        }

        // Ensure the metadata directory exists before sqlx opens the file.
        // sqlx's `create_if_missing` only creates the DB file itself, not
        // its parent directory.
        tokio::fs::create_dir_all(&metadata_root).await.map_err(|e| {
            ProtocolError::new(
                ErrorCode::WorkspaceInvalid,
                format!(
                    "failed to create metadata_root {}: {e}",
                    metadata_root.display()
                ),
            )
        })?;

        let db_path = metadata_root.join("state.sqlite");
        let db = Database::open(&db_path).await.map_err(|e| {
            ProtocolError::internal(format!(
                "failed to open SQLite at {}: {e}",
                db_path.display()
            ))
        })?;
        db.run_migrations()
            .await
            .map_err(|e| ProtocolError::internal(format!("migrations failed: {e}")))?;

        let tenant = TenantId::new(STUDIO_TENANT_ID);
        let project = ProjectId::from_raw(&project_id);

        // Load existing threads for this project. If empty, bootstrap one.
        let mut summaries_rows = db
            .list_threads_with_stats(&tenant, &project)
            .await
            .map_err(|e| ProtocolError::internal(format!("list_threads_with_stats failed: {e}")))?;

        let active_thread_id = if summaries_rows.is_empty() {
            let thread_id = Uuid::new_v4().to_string();
            db.insert_thread(&NewThread {
                id: ThreadId::new(&thread_id),
                tenant_id: tenant.clone(),
                project_id: project.clone(),
                title: DEFAULT_THREAD_TITLE.to_string(),
            })
            .await
            .map_err(|e| ProtocolError::internal(format!("insert_thread failed: {e}")))?;
            // Re-list so the returned summaries match disk state.
            summaries_rows = db
                .list_threads_with_stats(&tenant, &project)
                .await
                .map_err(|e| {
                    ProtocolError::internal(format!("list_threads_with_stats failed: {e}"))
                })?;
            thread_id
        } else {
            // list_threads_with_stats already orders most-recently-active first.
            summaries_rows[0].thread.id.as_str().to_string()
        };

        let summaries: Vec<ThreadSummary> = summaries_rows.iter().map(row_to_summary).collect();
        let session_id = Uuid::new_v4().to_string();

        // Wire up an Engine for this session. Build is best-effort:
        // on failure the session still opens (Phase A keeps the legacy
        // chat path), but Phase B's Engine route degrades to "no engine
        // available" and chat.send must fall back.
        let engine = build_session_engine(
            &workspace_root,
            &metadata_root,
            llm,
            db.clone(),
            snaca_config,
        );

        let mut session = Session::new(
            session_id.clone(),
            project_id,
            workspace_root,
            metadata_root,
            shared_metadata_root,
            display_name,
            project_type,
            db,
            engine,
        );
        session.active_thread_id = Some(active_thread_id.clone());

        let mut inner = self.inner.lock().await;
        inner.sessions.insert(session_id.clone(), session);

        Ok((session_id, active_thread_id, summaries))
    }

    pub async fn close(&self, session_id: &str) -> Result<(), ProtocolError> {
        let mut inner = self.inner.lock().await;
        let session = inner
            .sessions
            .remove(session_id)
            .ok_or_else(|| ProtocolError::session_not_found(session_id))?;
        if let Some(turn) = session.inflight {
            turn.abort.abort();
        }
        // `db` drops with the session; SqlitePool runs its own background
        // cleanup. No explicit close needed.
        Ok(())
    }

    pub async fn list_threads(
        &self,
        session_id: &str,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<(Vec<ThreadSummary>, u32), ProtocolError> {
        let inner = self.inner.lock().await;
        let session = inner
            .sessions
            .get(session_id)
            .ok_or_else(|| ProtocolError::session_not_found(session_id))?;
        let tenant = TenantId::new(STUDIO_TENANT_ID);
        let project = ProjectId::from_raw(&session.project_id);
        let rows = session
            .db
            .list_threads_with_stats(&tenant, &project)
            .await
            .map_err(|e| ProtocolError::internal(format!("list_threads_with_stats failed: {e}")))?;
        let total = rows.len() as u32;
        let off = offset.unwrap_or(0) as usize;
        let lim = limit.map(|l| l as usize).unwrap_or(rows.len());
        let page = rows.iter().skip(off).take(lim).map(row_to_summary).collect();
        Ok((page, total))
    }

    pub async fn new_thread(
        &self,
        session_id: &str,
        title: Option<String>,
    ) -> Result<(String, String), ProtocolError> {
        let mut inner = self.inner.lock().await;
        let session = inner
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| ProtocolError::session_not_found(session_id))?;
        if session.inflight.is_some() {
            return Err(ProtocolError::inflight_turn_busy());
        }
        let thread_id = Uuid::new_v4().to_string();
        let title = title.unwrap_or_else(|| DEFAULT_THREAD_TITLE.to_string());
        session
            .db
            .insert_thread(&NewThread {
                id: ThreadId::new(&thread_id),
                tenant_id: TenantId::new(STUDIO_TENANT_ID),
                project_id: ProjectId::from_raw(&session.project_id),
                title: title.clone(),
            })
            .await
            .map_err(|e| ProtocolError::internal(format!("insert_thread failed: {e}")))?;
        session.active_thread_id = Some(thread_id.clone());
        Ok((thread_id, title))
    }

    pub async fn switch_thread(
        &self,
        session_id: &str,
        thread_id: &str,
    ) -> Result<ThreadSummary, ProtocolError> {
        let mut inner = self.inner.lock().await;
        let session = inner
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| ProtocolError::session_not_found(session_id))?;
        if session.inflight.is_some() {
            return Err(ProtocolError::inflight_turn_busy());
        }
        // Validate the thread exists for this project, then fetch its
        // up-to-date summary (last_active_at + turn_count) from disk.
        let summary = lookup_thread_summary(&session.db, &session.project_id, thread_id).await?;
        session.active_thread_id = Some(thread_id.to_string());
        Ok(summary)
    }

    /// Delete a thread. Returns the id of whatever thread becomes active
    /// after the delete — guaranteed non-empty (the manager auto-spawns a
    /// fresh "New conversation" when the deleted thread was the last
    /// surviving one).
    pub async fn delete_thread(
        &self,
        session_id: &str,
        thread_id: &str,
    ) -> Result<String, ProtocolError> {
        let mut inner = self.inner.lock().await;
        let session = inner
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| ProtocolError::session_not_found(session_id))?;
        if session.inflight.is_some() {
            return Err(ProtocolError::inflight_turn_busy());
        }

        let removed = session
            .db
            .delete_thread(&ThreadId::new(thread_id))
            .await
            .map_err(|e| ProtocolError::internal(format!("delete_thread failed: {e}")))?;
        if !removed {
            return Err(ProtocolError::thread_not_found(thread_id));
        }

        let was_active = session.active_thread_id.as_deref() == Some(thread_id);
        if !was_active {
            return Ok(session.active_thread_id.clone().unwrap_or_default());
        }

        // Promote: pick the most-recently-active surviving thread.
        let tenant = TenantId::new(STUDIO_TENANT_ID);
        let project = ProjectId::from_raw(&session.project_id);
        let survivors = session
            .db
            .list_threads_with_stats(&tenant, &project)
            .await
            .map_err(|e| ProtocolError::internal(format!("list_threads_with_stats failed: {e}")))?;

        if let Some(top) = survivors.first() {
            let next_active = top.thread.id.as_str().to_string();
            session.active_thread_id = Some(next_active.clone());
            return Ok(next_active);
        }

        // No survivors — spawn a fresh default thread so the session always
        // has somewhere to route `chat.send`.
        let fresh_id = Uuid::new_v4().to_string();
        session
            .db
            .insert_thread(&NewThread {
                id: ThreadId::new(&fresh_id),
                tenant_id: tenant,
                project_id: project,
                title: DEFAULT_THREAD_TITLE.to_string(),
            })
            .await
            .map_err(|e| ProtocolError::internal(format!("insert_thread failed: {e}")))?;
        session.active_thread_id = Some(fresh_id.clone());
        Ok(fresh_id)
    }

    pub async fn rename_thread(
        &self,
        session_id: &str,
        thread_id: &str,
        title: String,
    ) -> Result<(), ProtocolError> {
        let inner = self.inner.lock().await;
        let session = inner
            .sessions
            .get(session_id)
            .ok_or_else(|| ProtocolError::session_not_found(session_id))?;
        let updated = session
            .db
            .update_thread_title(&ThreadId::new(thread_id), &title)
            .await
            .map_err(|e| ProtocolError::internal(format!("update_thread_title failed: {e}")))?;
        if !updated {
            return Err(ProtocolError::thread_not_found(thread_id));
        }
        Ok(())
    }

    /// Reserves an inflight slot, returning the allocated turn id. Caller
    /// Take a snapshot of the per-session Engine + project_id for the
    /// turn dispatcher. Engine handle is `Arc`-cloned cheaply; falling
    /// back to `None` here is the signal that this session's engine wiring
    /// failed at `open()` and chat.send should use the legacy path.
    pub async fn engine_for(
        &self,
        session_id: &str,
    ) -> Result<(Option<Arc<Engine>>, String), ProtocolError> {
        let inner = self.inner.lock().await;
        let session = inner
            .sessions
            .get(session_id)
            .ok_or_else(|| ProtocolError::session_not_found(session_id))?;
        Ok((session.engine.clone(), session.project_id.clone()))
    }

    /// is responsible for storing the `AbortHandle` via [`Self::set_abort`]
    /// once the task is spawned.
    pub async fn begin_turn(
        &self,
        session_id: &str,
        thread_id: &str,
        kind: TurnKind,
    ) -> Result<String, ProtocolError> {
        let mut inner = self.inner.lock().await;
        let session = inner
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| ProtocolError::session_not_found(session_id))?;
        if session.inflight.is_some() {
            return Err(ProtocolError::inflight_turn_busy());
        }
        // Validate thread existence cheaply via find_thread.
        let exists = session
            .db
            .find_thread(&ThreadId::new(thread_id))
            .await
            .map_err(|e| ProtocolError::internal(format!("find_thread failed: {e}")))?
            .is_some();
        if !exists {
            return Err(ProtocolError::thread_not_found(thread_id));
        }
        let turn_id = Uuid::new_v4().to_string();
        let placeholder = tokio::spawn(async {}).abort_handle();
        session.inflight = Some(InflightTurn {
            turn_id: turn_id.clone(),
            thread_id: thread_id.to_string(),
            kind,
            abort: placeholder,
            started_at: chrono::Utc::now(),
        });
        Ok(turn_id)
    }

    pub async fn set_abort(
        &self,
        session_id: &str,
        turn_id: &str,
        abort: AbortHandle,
    ) -> Result<(), ProtocolError> {
        let mut inner = self.inner.lock().await;
        let session = inner
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| ProtocolError::session_not_found(session_id))?;
        match session.inflight.as_mut() {
            Some(t) if t.turn_id == turn_id => {
                t.abort = abort;
                Ok(())
            }
            _ => Err(ProtocolError::new(
                ErrorCode::TurnNotFound,
                format!("turn {turn_id} is not the inflight turn"),
            )),
        }
    }

    /// Marks the turn as finished and returns the [`InflightTurn`] (if any).
    pub async fn end_turn(&self, session_id: &str, turn_id: &str) -> Option<InflightTurn> {
        let mut inner = self.inner.lock().await;
        let session = inner.sessions.get_mut(session_id)?;
        match session.inflight.take() {
            Some(t) if t.turn_id == turn_id => Some(t),
            other => {
                session.inflight = other;
                None
            }
        }
    }

    /// Append a message to the thread history (persisted in SQLite).
    /// `turn_id` is optional — set it for assistant messages that came out
    /// of a turn so the host UI can re-associate thinking trace / tool
    /// calls / edit proposals after a hydrate. `None` for user messages.
    pub async fn append_message(
        &self,
        session_id: &str,
        thread_id: &str,
        msg: Message,
        turn_id: Option<String>,
    ) -> Result<(), ProtocolError> {
        let inner = self.inner.lock().await;
        let session = inner
            .sessions
            .get(session_id)
            .ok_or_else(|| ProtocolError::session_not_found(session_id))?;
        // Parse session_id as a uuid for the messages table column. SNACA
        // sessions are uuids (we generate them in `open`); we re-parse
        // instead of caching to keep `Session` allocation-free for now.
        let session_uuid = Uuid::parse_str(&session.session_id).map_err(|e| {
            ProtocolError::internal(format!("session_id is not a valid uuid: {e}"))
        })?;
        session
            .db
            .append_message(&NewMessage {
                thread_id: ThreadId::new(thread_id),
                session_id: SessionId::from_uuid(session_uuid),
                role: msg.role,
                content: msg.content,
                turn_id,
            })
            .await
            .map_err(|e| ProtocolError::internal(format!("append_message failed: {e}")))?;
        Ok(())
    }

    /// Snapshot the most recent `limit` messages from a thread (for feeding
    /// the LLM). Falls back to an empty vec if the thread is unknown so the
    /// caller's `begin_turn` validation remains authoritative.
    pub async fn recent_messages(
        &self,
        session_id: &str,
        thread_id: &str,
        limit: usize,
    ) -> Vec<Message> {
        let inner = self.inner.lock().await;
        let Some(session) = inner.sessions.get(session_id) else {
            return Vec::new();
        };
        let limit_u32 = limit.try_into().unwrap_or(u32::MAX);
        match session
            .db
            .recent_messages(&ThreadId::new(thread_id), limit_u32)
            .await
        {
            Ok(rows) => rows
                .into_iter()
                .map(|r| Message {
                    id: r.id,
                    role: r.role,
                    content: r.content,
                    created_at: r.created_at,
                })
                .collect(),
            Err(_) => Vec::new(),
        }
    }

    /// Render a thread's persisted history into wire-friendly `ThreadMessage`s
    /// for `session.get_messages`. System / Tool roles and empty-text rows
    /// are skipped — they were either injected by the engine or already
    /// played live via `turn.delta`.
    pub async fn get_messages(
        &self,
        session_id: &str,
        thread_id: &str,
        limit: Option<u32>,
    ) -> Result<(Vec<ThreadMessage>, u32), ProtocolError> {
        let inner = self.inner.lock().await;
        let session = inner
            .sessions
            .get(session_id)
            .ok_or_else(|| ProtocolError::session_not_found(session_id))?;
        // Validate the thread belongs to this session's project.
        let row = session
            .db
            .find_thread(&ThreadId::new(thread_id))
            .await
            .map_err(|e| ProtocolError::internal(format!("find_thread failed: {e}")))?;
        if row.is_none() {
            return Err(ProtocolError::thread_not_found(thread_id));
        }
        let rows = session
            .db
            .recent_messages(&ThreadId::new(thread_id), limit.unwrap_or(u32::MAX))
            .await
            .map_err(|e| ProtocolError::internal(format!("recent_messages failed: {e}")))?;
        let rendered: Vec<ThreadMessage> = rows.iter().filter_map(render_history_row).collect();
        let total = rendered.len() as u32;
        Ok((rendered, total))
    }

    /// Cancels the inflight turn matching `turn_id` if any. Returns true on hit.
    pub async fn cancel_turn(&self, turn_id: &str) -> bool {
        let inner = self.inner.lock().await;
        for session in inner.sessions.values() {
            if let Some(t) = &session.inflight {
                if t.turn_id == turn_id {
                    t.abort.abort();
                    return true;
                }
            }
        }
        false
    }

    /// Number of open sessions. Test/diagnostic helper.
    pub async fn session_count(&self) -> usize {
        self.inner.lock().await.sessions.len()
    }
}

/// Convenience for sharing across tasks.
pub type SessionManagerArc = Arc<SessionManager>;

// ---------------- private helpers ----------------

fn row_to_summary(row: &snaca_state::ThreadSummaryRow) -> ThreadSummary {
    ThreadSummary {
        thread_id: row.thread.id.as_str().to_string(),
        title: row.thread.title.clone(),
        created_at: row.thread.created_at.to_rfc3339(),
        last_active_at: row.last_active_at.to_rfc3339(),
        turn_count: row.turn_count,
    }
}

/// Fetch a thread's wire-shape summary by id; errors with `thread_not_found`
/// when the row is missing. Re-queries the stats so caller doesn't have to
/// hold a list snapshot.
async fn lookup_thread_summary(
    db: &Database,
    project_id: &str,
    thread_id: &str,
) -> Result<ThreadSummary, ProtocolError> {
    let tenant = TenantId::new(STUDIO_TENANT_ID);
    let project = ProjectId::from_raw(project_id);
    let rows = db
        .list_threads_with_stats(&tenant, &project)
        .await
        .map_err(|e| ProtocolError::internal(format!("list_threads_with_stats failed: {e}")))?;
    rows.iter()
        .find(|r| r.thread.id.as_str() == thread_id)
        .map(row_to_summary)
        .ok_or_else(|| ProtocolError::thread_not_found(thread_id))
}

fn render_history_row(row: &snaca_state::MessageRow) -> Option<ThreadMessage> {
    let role = match row.role {
        Role::User => ThreadMessageRole::User,
        Role::Assistant => ThreadMessageRole::Assistant,
        // System / Tool messages aren't part of the user-visible history.
        Role::System | Role::Tool => return None,
    };
    let mut text = String::new();
    for block in &row.content {
        if let ContentBlock::Text { text: t } = block {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(t);
        }
    }
    if text.is_empty() {
        return None;
    }
    Some(ThreadMessage {
        role,
        text,
        ts: row.created_at.to_rfc3339(),
        turn_id: row.turn_id.clone(),
    })
}

/// Construct the per-session `Engine`. `metadata_root` hosts SNACA's
/// internal data (memory tree, settings); `workspace_root` is the user's
/// real project directory and gets pinned via `with_explicit_workspace`
/// so file tools land there rather than in the multi-tenant sandbox.
///
/// Best-effort: any failure during WorkspaceLayout setup or registry
/// construction is logged and surfaced as `None`. Phase B's caller is
/// expected to fall back to the legacy `run_chat_turn` path in that
/// case rather than refuse to open the session.
fn build_session_engine(
    workspace_root: &PathBuf,
    metadata_root: &PathBuf,
    llm: Arc<dyn LlmClient>,
    db: Database,
    snaca_config: &SnacaConfig,
) -> Option<Arc<Engine>> {
    let layout = match WorkspaceLayout::new(metadata_root.clone()) {
        Ok(l) => l,
        Err(e) => {
            warn!(
                metadata_root = %metadata_root.display(),
                error = %e,
                "engine disabled: WorkspaceLayout::new failed"
            );
            return None;
        }
    };
    let layout = match layout.with_explicit_workspace(workspace_root.clone()) {
        Ok(l) => l,
        Err(e) => {
            warn!(
                workspace_root = %workspace_root.display(),
                error = %e,
                "engine disabled: explicit_workspace rejected"
            );
            return None;
        }
    };

    // Ensure the (tenant, project) subtree the engine writes into exists
    // on disk. Tenant/project ids are derived from STUDIO_TENANT_ID +
    // the wire project_id; the actual workspace dir is the explicit
    // override so this only materializes the memory subtree.
    // (We can't call ensure_project here because we don't have a stable
    //  project_id yet — engine builders pass tenant/project per turn.)

    // Phase A: per-field mapping from SnacaConfig.engine to EngineConfig
    // is deferred to Phase E. EngineConfig::default_for(model) seeds the
    // model-aware defaults (history limits, compaction thresholds, etc.).
    let engine_config = EngineConfig::default_for(snaca_config.llm.model.clone());

    let tools = base_tool_registry();
    let engine = Engine::new(llm, tools, db, layout, engine_config);
    Some(Arc::new(engine))
}
