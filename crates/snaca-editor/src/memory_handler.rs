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

/// Map a provider scope string (`user`/`feedback`/`project`/`reference`)
/// to the wire scope. Returns `None` for an unknown scope.
fn wire_scope_from_str(scope: &str) -> Option<WireScope> {
    match scope {
        "user" => Some(WireScope::User),
        "feedback" => Some(WireScope::Feedback),
        "project" => Some(WireScope::Project),
        "reference" => Some(WireScope::Reference),
        _ => None,
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
        // 0.2.7 added size/threat/import guards + external-drift detection.
        // The editor's CRUD surfaces them as generic invalid-params /
        // internal errors — the messages carry the specifics.
        other => ProtocolError::new(ErrorCode::InvalidParams, format!("memory error: {other}")),
    }
}

/// `EditorMemoryProvider` — wraps the built-in `FileTreeMemoryProvider`
/// (0.2.7 replaced the old `MemoryEventSink` seam with the `MemoryProvider`
/// trait) and forwards a `memory.updated` notification to the editor host
/// whenever the engine's background extractor writes an entry, so
/// MemoryViewer refreshes live without polling. All CRUD delegates to the
/// inner provider unchanged.
pub struct EditorMemoryProvider {
    inner: Arc<dyn snaca_agent_api::MemoryProvider>,
    outbound: Arc<OutboundWriter>,
    session_id: String,
}

impl EditorMemoryProvider {
    pub fn new(
        inner: Arc<dyn snaca_agent_api::MemoryProvider>,
        outbound: Arc<OutboundWriter>,
        session_id: String,
    ) -> Self {
        Self {
            inner,
            outbound,
            session_id,
        }
    }
}

#[async_trait::async_trait]
impl snaca_agent_api::MemoryProvider for EditorMemoryProvider {
    async fn index(
        &self,
        request: snaca_agent_api::MemoryIndexRequest,
    ) -> Result<String, snaca_agent_api::MemoryProviderError> {
        self.inner.index(request).await
    }

    async fn list(
        &self,
        request: snaca_agent_api::MemoryListRequest,
    ) -> Result<Vec<String>, snaca_agent_api::MemoryProviderError> {
        self.inner.list(request).await
    }

    async fn write(
        &self,
        request: snaca_agent_api::MemoryWriteRequest,
    ) -> Result<snaca_agent_api::MemoryEntryData, snaca_agent_api::MemoryProviderError> {
        self.inner.write(request).await
    }

    async fn read(
        &self,
        request: snaca_agent_api::MemoryReadRequest,
    ) -> Result<snaca_agent_api::MemoryEntryData, snaca_agent_api::MemoryProviderError> {
        self.inner.read(request).await
    }

    async fn on_pre_compact(
        &self,
        ctx: &snaca_agent_api::PreCompactCtx,
    ) -> Result<(), snaca_agent_api::MemoryProviderError> {
        self.inner.on_pre_compact(ctx).await
    }

    async fn on_session_switch(
        &self,
        ctx: &snaca_agent_api::SessionSwitchCtx,
    ) -> Result<(), snaca_agent_api::MemoryProviderError> {
        self.inner.on_session_switch(ctx).await
    }

    async fn on_memory_write(
        &self,
        ctx: &snaca_agent_api::MemoryWriteCtx,
    ) -> Result<(), snaca_agent_api::MemoryProviderError> {
        // Delegate to the inner provider (may maintain caches). Log rather
        // than swallow its error, but don't gate the host notification on it:
        // the on-disk write already landed before this hook runs, so the host
        // must be told regardless of the inner post-write bookkeeping.
        if let Err(e) = self.inner.on_memory_write(ctx).await {
            warn!(error = %e, "inner memory provider on_memory_write failed");
        }
        // Notify the host on a DETACHED task. The engine awaits this hook
        // inline in its per-proposal extractor loop, and the emit locks the
        // shared stdout mutex + flushes — so awaiting it here would gate the
        // extractor on host I/O. The trait contract also says this hook must
        // not block. Spawning matches the original EditorMemorySink design.
        if let Some(scope) = wire_scope_from_str(&ctx.scope) {
            let outbound = self.outbound.clone();
            let params = MemoryUpdatedParams {
                session_id: self.session_id.clone(),
                scope,
                name: ctx.name.clone(),
                // The write ctx doesn't distinguish create vs update; the
                // host only needs to know something changed (it ignores the
                // action field and re-reads the entry).
                action: WireAction::Updated,
            };
            tokio::spawn(async move {
                if let Err(e) = outbound.emit_memory_updated(params).await {
                    warn!(error = %e, "engine memory provider notify failed");
                }
            });
        }
        Ok(())
    }
}
