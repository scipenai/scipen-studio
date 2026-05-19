//! `memory.*` RPC handlers — implements the host-driven CRUD against the
//! per-project memory tree. All paths flow through `Session::memory_dir()`
//! so the host sees exactly what `Engine::spawn_memory_extraction` writes.
//!
//! Writes emit a `memory.updated` notification so MemoryViewer can refresh
//! without re-polling.

use crate::outbound::OutboundWriter;
use crate::session_manager::SessionManager;
use snaca_editor_protocol::error::{ErrorCode, ProtocolError};
use snaca_editor_protocol::messages::memory::{
    MemoryAction as WireAction, MemoryDeleteParams, MemoryDeleteResult, MemoryEntrySummary,
    MemoryGetParams, MemoryGetResult, MemoryListParams, MemoryListResult, MemoryRevealParams,
    MemoryRevealResult, MemoryScope as WireScope, MemoryUpdatedParams, MemoryWriteParams,
    MemoryWriteResult,
};
use snaca_memory::{MemoryError, MemoryScope, MemoryStore};
use std::path::PathBuf;
use std::sync::Arc;
use tracing::warn;

const PREVIEW_MAX_CHARS: usize = 200;

pub(crate) fn scope_to_store(s: WireScope) -> MemoryScope {
    match s {
        WireScope::User => MemoryScope::User,
        WireScope::Feedback => MemoryScope::Feedback,
        WireScope::Project => MemoryScope::Project,
        WireScope::Reference => MemoryScope::Reference,
    }
}

pub(crate) fn scope_to_wire(s: MemoryScope) -> WireScope {
    match s {
        MemoryScope::User => WireScope::User,
        MemoryScope::Feedback => WireScope::Feedback,
        MemoryScope::Project => WireScope::Project,
        MemoryScope::Reference => WireScope::Reference,
    }
}

pub(crate) fn engine_action_to_wire(a: snaca_engine::MemoryAction) -> WireAction {
    match a {
        snaca_engine::MemoryAction::Created => WireAction::Created,
        snaca_engine::MemoryAction::Updated => WireAction::Updated,
        snaca_engine::MemoryAction::Deleted => WireAction::Deleted,
    }
}

async fn require_session_dir(
    sessions: &SessionManager,
    session_id: &str,
) -> Result<PathBuf, ProtocolError> {
    let dir = sessions.memory_dir_for(session_id).await?;
    Ok(dir)
}

pub async fn handle_memory_list(
    sessions: &SessionManager,
    params: MemoryListParams,
) -> Result<MemoryListResult, ProtocolError> {
    let dir = require_session_dir(sessions, &params.session_id).await?;
    let store = MemoryStore::new(&dir);
    let scopes: Vec<MemoryScope> = match params.scope {
        Some(s) => vec![scope_to_store(s)],
        None => MemoryScope::all().to_vec(),
    };
    let mut entries = Vec::new();
    for scope in scopes {
        let names = match store.list(scope).await {
            Ok(v) => v,
            Err(MemoryError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(memory_err(e)),
        };
        for name in names {
            let summary = summarize_entry(&dir, scope, &name).await;
            entries.push(summary);
        }
    }
    Ok(MemoryListResult { entries })
}

async fn summarize_entry(memory_dir: &PathBuf, scope: MemoryScope, name: &str) -> MemoryEntrySummary {
    let path = memory_dir.join(scope.dir_name()).join(format!("{name}.md"));
    let last_modified = match tokio::fs::metadata(&path).await {
        Ok(md) => md
            .modified()
            .ok()
            .and_then(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339().into())
            .unwrap_or_default(),
        Err(_) => String::new(),
    };
    let preview = match tokio::fs::read_to_string(&path).await {
        Ok(content) => preview_of(&content),
        Err(_) => String::new(),
    };
    MemoryEntrySummary {
        scope: scope_to_wire(scope),
        name: name.to_string(),
        last_modified,
        preview,
    }
}

fn preview_of(content: &str) -> String {
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let stripped = line.trim_start_matches('#').trim();
        return stripped.chars().take(PREVIEW_MAX_CHARS).collect();
    }
    String::new()
}

pub async fn handle_memory_get(
    sessions: &SessionManager,
    params: MemoryGetParams,
) -> Result<MemoryGetResult, ProtocolError> {
    let dir = require_session_dir(sessions, &params.session_id).await?;
    let store = MemoryStore::new(&dir);
    let scope = scope_to_store(params.scope);
    let entry = store.read(scope, &params.name).await.map_err(memory_err)?;
    let path = dir.join(scope.dir_name()).join(format!("{}.md", entry.name));
    let last_modified = tokio::fs::metadata(&path)
        .await
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
        .unwrap_or_default();
    Ok(MemoryGetResult {
        scope: params.scope,
        name: entry.name,
        content: entry.content,
        last_modified,
    })
}

pub async fn handle_memory_write(
    sessions: &SessionManager,
    outbound: &Arc<OutboundWriter>,
    params: MemoryWriteParams,
) -> Result<MemoryWriteResult, ProtocolError> {
    let dir = require_session_dir(sessions, &params.session_id).await?;
    let store = MemoryStore::new(&dir);
    let scope = scope_to_store(params.scope);

    let existed = matches!(store.read(scope, &params.name).await, Ok(_));
    store
        .write(scope, &params.name, &params.content)
        .await
        .map_err(memory_err)?;
    let action = if existed {
        WireAction::Updated
    } else {
        WireAction::Created
    };

    let session_id = params.session_id.clone();
    let name = params.name.clone();
    let outbound = outbound.clone();
    tokio::spawn(async move {
        if let Err(e) = outbound
            .emit_memory_updated(MemoryUpdatedParams {
                session_id,
                scope: params.scope,
                name,
                action,
            })
            .await
        {
            warn!(error = %e, "emit memory.updated failed");
        }
    });

    Ok(MemoryWriteResult { action })
}

pub async fn handle_memory_delete(
    sessions: &SessionManager,
    outbound: &Arc<OutboundWriter>,
    params: MemoryDeleteParams,
) -> Result<MemoryDeleteResult, ProtocolError> {
    let dir = require_session_dir(sessions, &params.session_id).await?;
    let store = MemoryStore::new(&dir);
    let scope = scope_to_store(params.scope);

    let existed = matches!(store.read(scope, &params.name).await, Ok(_));
    store
        .delete(scope, &params.name)
        .await
        .map_err(memory_err)?;

    if existed {
        let session_id = params.session_id.clone();
        let name = params.name.clone();
        let outbound = outbound.clone();
        tokio::spawn(async move {
            if let Err(e) = outbound
                .emit_memory_updated(MemoryUpdatedParams {
                    session_id,
                    scope: params.scope,
                    name,
                    action: WireAction::Deleted,
                })
                .await
            {
                warn!(error = %e, "emit memory.updated (deleted) failed");
            }
        });
    }

    Ok(MemoryDeleteResult { deleted: existed })
}

pub async fn handle_memory_reveal(
    sessions: &SessionManager,
    params: MemoryRevealParams,
) -> Result<MemoryRevealResult, ProtocolError> {
    let dir = require_session_dir(sessions, &params.session_id).await?;
    let path = match (params.scope, params.name) {
        (Some(scope), Some(name)) => {
            let scope = scope_to_store(scope);
            let safe = snaca_memory::sanitize_name(&name).map_err(|e| memory_err(e))?;
            dir.join(scope.dir_name()).join(format!("{safe}.md"))
        }
        _ => dir,
    };
    Ok(MemoryRevealResult {
        path: path.to_string_lossy().into_owned(),
    })
}

fn memory_err(e: MemoryError) -> ProtocolError {
    match e {
        MemoryError::InvalidName { name, reason } => ProtocolError::new(
            ErrorCode::InvalidParams,
            format!("invalid memory entry name {name:?}: {reason}"),
        ),
        MemoryError::NotFound { scope, name } => ProtocolError::new(
            ErrorCode::NotFound,
            format!("memory entry not found: {scope}/{name}"),
        ),
        MemoryError::Io(e) => {
            ProtocolError::new(ErrorCode::InternalError, format!("memory io: {e}"))
        }
        MemoryError::ExternalExtractorRequired { kind, filename } => ProtocolError::new(
            ErrorCode::InternalError,
            format!("external extractor required for {kind} {filename:?}"),
        ),
    }
}

/// `EditorMemorySink` — bridges `snaca_engine::MemoryEventSink` to the
/// outbound JSON-RPC channel so the background extractor's writes show
/// up in MemoryViewer live.
pub struct EditorMemorySink {
    pub outbound: Arc<OutboundWriter>,
    pub session_id: String,
}

impl snaca_engine::MemoryEventSink for EditorMemorySink {
    fn on_memory_changed(
        &self,
        scope: MemoryScope,
        name: &str,
        action: snaca_engine::MemoryAction,
    ) {
        let outbound = self.outbound.clone();
        let session_id = self.session_id.clone();
        let name = name.to_string();
        // Background extractor runs on a tokio task, so we're inside a
        // runtime — spawn a detached task instead of blocking it on IO.
        tokio::spawn(async move {
            if let Err(e) = outbound
                .emit_memory_updated(MemoryUpdatedParams {
                    session_id,
                    scope: scope_to_wire(scope),
                    name,
                    action: engine_action_to_wire(action),
                })
                .await
            {
                warn!(error = %e, "engine memory sink emit failed");
            }
        });
    }
}
