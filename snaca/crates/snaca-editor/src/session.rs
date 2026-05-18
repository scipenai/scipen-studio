//! Session and thread state (in-memory; SQLite persistence comes later).
//!
//! Several fields and variants are protocol-stored data that handlers in
//! later phases consume (`InflightTurn.kind` for routing, `Session.project_id`
//! for memory paths, etc.). Keeping them silenced here avoids ping-pong
//! removals when the next phase lands.

#![allow(dead_code)]

use chrono::{DateTime, Utc};
use snaca_core::Message;
use snaca_editor_protocol::messages::session::ThreadSummary;
use snaca_editor_protocol::types::context::ProjectType;
use std::collections::HashMap;
use std::path::PathBuf;
use tokio::task::AbortHandle;

#[derive(Debug)]
pub struct Session {
    pub session_id: String,
    pub project_id: String,
    pub workspace_root: PathBuf,
    pub metadata_root: PathBuf,
    pub shared_metadata_root: Option<PathBuf>,
    pub display_name: String,
    pub project_type: ProjectType,
    pub threads: HashMap<String, ThreadState>,
    pub active_thread_id: Option<String>,
    pub inflight: Option<InflightTurn>,
    pub created_at: DateTime<Utc>,
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
    ) -> Self {
        Self {
            session_id,
            project_id,
            workspace_root,
            metadata_root,
            shared_metadata_root,
            display_name,
            project_type,
            threads: HashMap::new(),
            active_thread_id: None,
            inflight: None,
            created_at: Utc::now(),
        }
    }

    pub fn thread_summary(&self, thread_id: &str) -> Option<ThreadSummary> {
        self.threads.get(thread_id).map(|t| t.summary())
    }

    pub fn list_thread_summaries(&self) -> Vec<ThreadSummary> {
        let mut v: Vec<_> = self.threads.values().map(|t| t.summary()).collect();
        v.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
        v
    }
}

#[derive(Debug, Clone)]
pub struct ThreadState {
    pub thread_id: String,
    pub title: String,
    pub created_at: DateTime<Utc>,
    pub last_active_at: DateTime<Utc>,
    pub turn_count: u32,
    /// In-memory conversation history. SQLite persistence lands in a later
    /// phase; on restart this is empty.
    pub messages: Vec<Message>,
}

impl ThreadState {
    pub fn new(thread_id: String, title: String) -> Self {
        let now = Utc::now();
        Self {
            thread_id,
            title,
            created_at: now,
            last_active_at: now,
            turn_count: 0,
            messages: Vec::new(),
        }
    }

    pub fn touch(&mut self) {
        self.last_active_at = Utc::now();
        self.turn_count = self.turn_count.saturating_add(1);
    }

    /// Append a message and return its sequence position. Caller is
    /// responsible for the role / content shape; this only stores.
    pub fn append_message(&mut self, msg: Message) {
        self.messages.push(msg);
    }

    /// Snapshot of the most recent `limit` messages (caps unbounded growth
    /// before SQLite + compaction land).
    pub fn recent_messages(&self, limit: usize) -> Vec<Message> {
        if self.messages.len() <= limit {
            self.messages.clone()
        } else {
            self.messages[self.messages.len() - limit..].to_vec()
        }
    }

    pub fn summary(&self) -> ThreadSummary {
        ThreadSummary {
            thread_id: self.thread_id.clone(),
            title: self.title.clone(),
            created_at: self.created_at.to_rfc3339(),
            last_active_at: self.last_active_at.to_rfc3339(),
            turn_count: self.turn_count,
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
