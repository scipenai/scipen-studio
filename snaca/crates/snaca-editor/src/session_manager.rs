//! `SessionManager` — owns all active `Session`s, enforces single-active.
//!
//! The `session_count` helper and `SessionManagerArc` alias are kept as
//! diagnostic / public-API anchors for the next phase's wiring (Studio
//! IPC + integration tests). Silenced in P0.

#![allow(dead_code)]

use crate::session::{InflightTurn, Session, ThreadState, TurnKind};
use snaca_core::{ContentBlock, Message, Role};
use snaca_editor_protocol::error::{ErrorCode, ProtocolError};
use snaca_editor_protocol::messages::session::{ThreadMessage, ThreadMessageRole, ThreadSummary};
use snaca_editor_protocol::types::context::ProjectType;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task::AbortHandle;
use uuid::Uuid;

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

    /// Opens a new session. Returns the assigned `session_id` plus a fresh
    /// default thread (`New conversation`) so the host has something to
    /// route `chat.send` against immediately.
    pub async fn open(
        &self,
        project_id: String,
        workspace_root: PathBuf,
        metadata_root: PathBuf,
        shared_metadata_root: Option<PathBuf>,
        display_name: String,
        project_type: ProjectType,
    ) -> Result<(String, Vec<ThreadSummary>), ProtocolError> {
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

        let session_id = Uuid::new_v4().to_string();
        let mut session = Session::new(
            session_id.clone(),
            project_id,
            workspace_root,
            metadata_root,
            shared_metadata_root,
            display_name,
            project_type,
        );

        // Bootstrap one default thread so chat.send has somewhere to go.
        let thread_id = Uuid::new_v4().to_string();
        let thread = ThreadState::new(thread_id.clone(), "New conversation".to_string());
        session.threads.insert(thread_id.clone(), thread);
        session.active_thread_id = Some(thread_id);

        let summaries = session.list_thread_summaries();

        let mut inner = self.inner.lock().await;
        inner.sessions.insert(session_id.clone(), session);

        Ok((session_id, summaries))
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
        let all = session.list_thread_summaries();
        let total = all.len() as u32;
        let off = offset.unwrap_or(0) as usize;
        let lim = limit.map(|l| l as usize).unwrap_or(all.len());
        let page = all.into_iter().skip(off).take(lim).collect();
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
        let title = title.unwrap_or_else(|| "New conversation".to_string());
        let thread = ThreadState::new(thread_id.clone(), title.clone());
        session.threads.insert(thread_id.clone(), thread);
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
        if !session.threads.contains_key(thread_id) {
            return Err(ProtocolError::thread_not_found(thread_id));
        }
        session.active_thread_id = Some(thread_id.to_string());
        Ok(session.thread_summary(thread_id).unwrap())
    }

    pub async fn delete_thread(
        &self,
        session_id: &str,
        thread_id: &str,
    ) -> Result<(), ProtocolError> {
        let mut inner = self.inner.lock().await;
        let session = inner
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| ProtocolError::session_not_found(session_id))?;
        if session.inflight.is_some() {
            return Err(ProtocolError::inflight_turn_busy());
        }
        let removed = session.threads.remove(thread_id);
        if removed.is_none() {
            return Err(ProtocolError::thread_not_found(thread_id));
        }
        if session.active_thread_id.as_deref() == Some(thread_id) {
            // Promote any other thread as active, or clear.
            session.active_thread_id = session.threads.keys().next().cloned();
        }
        Ok(())
    }

    pub async fn rename_thread(
        &self,
        session_id: &str,
        thread_id: &str,
        title: String,
    ) -> Result<(), ProtocolError> {
        let mut inner = self.inner.lock().await;
        let session = inner
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| ProtocolError::session_not_found(session_id))?;
        let thread = session
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| ProtocolError::thread_not_found(thread_id))?;
        thread.title = title;
        Ok(())
    }

    /// Reserves an inflight slot, returning the allocated turn id. Caller
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
        if !session.threads.contains_key(thread_id) {
            return Err(ProtocolError::thread_not_found(thread_id));
        }
        if session.inflight.is_some() {
            return Err(ProtocolError::inflight_turn_busy());
        }
        let turn_id = Uuid::new_v4().to_string();
        // Placeholder abort handle — replaced via set_abort once task is spawned.
        // We construct one via a no-op task purely to satisfy the type;
        // it will be overwritten immediately.
        let placeholder = tokio::spawn(async {}).abort_handle();
        session.inflight = Some(InflightTurn {
            turn_id: turn_id.clone(),
            thread_id: thread_id.to_string(),
            kind,
            abort: placeholder,
            started_at: chrono::Utc::now(),
        });
        // Touch thread.
        if let Some(t) = session.threads.get_mut(thread_id) {
            t.touch();
        }
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
                // Mismatch — put it back. (Shouldn't normally happen.)
                session.inflight = other;
                None
            }
        }
    }

    /// Append a message to the thread history.
    pub async fn append_message(
        &self,
        session_id: &str,
        thread_id: &str,
        msg: Message,
    ) -> Result<(), ProtocolError> {
        let mut inner = self.inner.lock().await;
        let session = inner
            .sessions
            .get_mut(session_id)
            .ok_or_else(|| ProtocolError::session_not_found(session_id))?;
        let thread = session
            .threads
            .get_mut(thread_id)
            .ok_or_else(|| ProtocolError::thread_not_found(thread_id))?;
        thread.append_message(msg);
        Ok(())
    }

    /// Snapshot the most recent `limit` messages from a thread (returns empty
    /// vec if the thread is unknown — caller typically already validated via
    /// `begin_turn`).
    pub async fn recent_messages(
        &self,
        session_id: &str,
        thread_id: &str,
        limit: usize,
    ) -> Vec<Message> {
        let inner = self.inner.lock().await;
        inner
            .sessions
            .get(session_id)
            .and_then(|s| s.threads.get(thread_id))
            .map(|t| t.recent_messages(limit))
            .unwrap_or_default()
    }

    /// Render a thread's history into wire-friendly `ThreadMessage`s for
    /// `session.get_messages`. Returns `(messages, total)` where total counts
    /// only renderable messages (system messages and tool calls are skipped
    /// from history rendering — they were already played live via
    /// `turn.delta`).
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
        let thread = session
            .threads
            .get(thread_id)
            .ok_or_else(|| ProtocolError::thread_not_found(thread_id))?;

        let rendered: Vec<ThreadMessage> = thread
            .messages
            .iter()
            .filter_map(render_history_message)
            .collect();
        let total = rendered.len() as u32;
        let messages = match limit {
            Some(n) if (n as usize) < rendered.len() => {
                rendered.into_iter().rev().take(n as usize).rev().collect()
            }
            _ => rendered,
        };
        Ok((messages, total))
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

/// Convert a `snaca_core::Message` into the flat wire shape returned by
/// `session.get_messages`. Returns `None` for messages that should not appear
/// in the rendered history (tool-only, image-only, etc.).
fn render_history_message(msg: &Message) -> Option<ThreadMessage> {
    let role = match msg.role {
        Role::User => ThreadMessageRole::User,
        Role::Assistant => ThreadMessageRole::Assistant,
        // System / Tool messages aren't part of the user-visible history —
        // system prompt was injected by chat.send, tool results were played
        // live via turn.delta.
        Role::System | Role::Tool => return None,
    };
    let mut text = String::new();
    for block in &msg.content {
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
    // snaca_core::Message has no `created_at`; the SQLite persistence layer
    // owns timestamps. For the in-memory path we fall back to "now" — Studio
    // only uses ts for relative ordering, and the messages here are already
    // ordered by Vec position.
    Some(ThreadMessage {
        role,
        text,
        ts: chrono::Utc::now().to_rfc3339(),
    })
}
