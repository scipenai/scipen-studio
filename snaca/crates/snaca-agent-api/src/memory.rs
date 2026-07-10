//! Memory provider contracts for embeddable agent runtimes.

use async_trait::async_trait;
use snaca_core::{ProjectId, TenantId};
use std::sync::Arc;
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct MemoryWriteRequest {
    pub tenant_id: TenantId,
    pub project_id: ProjectId,
    /// Provider-defined scope name. The built-in provider accepts
    /// `user`, `project`, `reference`, and `feedback`.
    pub scope: String,
    pub name: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct MemoryReadRequest {
    pub tenant_id: TenantId,
    pub project_id: ProjectId,
    pub scope: String,
    pub name: String,
}

#[derive(Debug, Clone)]
pub struct MemoryIndexRequest {
    pub tenant_id: TenantId,
    pub project_id: ProjectId,
}

#[derive(Debug, Clone)]
pub struct MemoryListRequest {
    pub tenant_id: TenantId,
    pub project_id: ProjectId,
    pub scope: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MemoryEntryData {
    pub scope: String,
    pub name: String,
    pub content: String,
}

/// Why the memory provider is being notified about a context
/// compaction. Compaction can be triggered by the per-turn input
/// budget or by a `prompt_too_long` shrink-retry mid-turn — both
/// fire the same hook so providers don't have to special-case.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactReason {
    /// The thread crossed the configured input-token budget after
    /// a successful turn. Run on a background task.
    InputBudgetExceeded,
    /// The current turn errored with a context-overflow signal and
    /// the engine is about to retry with a shrunk tail.
    ContextOverflowRetry,
}

/// Context for a `MemoryProvider::on_pre_compact` invocation. The
/// provider gets a snapshot of the messages that are about to be
/// rolled into a summary so it can mine durable facts before they
/// disappear from the live transcript.
#[derive(Debug, Clone)]
pub struct PreCompactCtx {
    pub tenant_id: TenantId,
    pub project_id: ProjectId,
    /// Opaque thread identifier — the same string the provider
    /// would see in `MemoryProvider::on_session_switch`.
    pub thread_id: String,
    pub reason: CompactReason,
    /// Best-effort plain-text rendering of the messages about to
    /// be compacted. The provider can consume it for an LLM-based
    /// extraction call without re-implementing the renderer.
    pub transcript_excerpt: String,
}

/// Context for a `MemoryProvider::on_session_switch` invocation.
/// Fired when the engine considers the thread session reset (e.g.
/// a hypothetical `/reset` slash command, or the future post-
/// compaction session-id roll). Today the engine doesn't fire it;
/// the hook exists so providers can wire it preemptively.
#[derive(Debug, Clone)]
pub struct SessionSwitchCtx {
    pub tenant_id: TenantId,
    pub project_id: ProjectId,
    /// Thread that's switching. Provider implementations typically
    /// invalidate any per-thread cache they hold against this id.
    pub thread_id: String,
    /// `Some(id)` when the engine knows the previous session id
    /// (e.g. compaction is rolling forward), `None` for the
    /// generic "drop everything you cached" case.
    pub previous_session_id: Option<String>,
    pub reset: bool,
    pub rewound: bool,
}

/// Action the engine just performed against memory. Surfaced via
/// `on_memory_write` as a fire-and-forget event so observers can
/// emit metrics, mirror to an external store, or invalidate
/// caches. The provider must not block on this; the engine calls
/// it after the on-disk write has already landed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryWriteAction {
    /// A `MemoryWrite` tool call (LLM-driven).
    Tool,
    /// A post-turn `MemoryExtractor` proposal.
    Extractor,
    /// A bulk import via `import_one` / `import_bundle`.
    Import,
    /// A staged write that an operator approved via the CLI.
    ApprovedFromPending,
}

/// Context for a `MemoryProvider::on_memory_write` invocation.
#[derive(Debug, Clone)]
pub struct MemoryWriteCtx {
    pub tenant_id: TenantId,
    pub project_id: ProjectId,
    pub action: MemoryWriteAction,
    pub scope: String,
    pub name: String,
}

#[derive(Debug, Error)]
pub enum MemoryProviderError {
    #[error("invalid memory scope {0}")]
    InvalidScope(String),

    #[error("memory entry not found: {scope}/{name}")]
    NotFound { scope: String, name: String },

    #[error("memory provider io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("memory provider failed: {0}")]
    Other(String),
}

#[async_trait]
pub trait MemoryProvider: Send + Sync {
    async fn index(&self, request: MemoryIndexRequest) -> Result<String, MemoryProviderError>;

    async fn list(&self, request: MemoryListRequest) -> Result<Vec<String>, MemoryProviderError>;

    async fn write(
        &self,
        request: MemoryWriteRequest,
    ) -> Result<MemoryEntryData, MemoryProviderError>;

    async fn read(
        &self,
        request: MemoryReadRequest,
    ) -> Result<MemoryEntryData, MemoryProviderError>;

    /// Called by the engine right before a thread compaction (or a
    /// shrink-retry on context overflow). Default impl is a no-op
    /// — providers that want to mine durable facts from the
    /// soon-to-be-discarded messages override this. Errors are
    /// logged and discarded by the engine; the hook must not block
    /// the compaction.
    async fn on_pre_compact(&self, _ctx: &PreCompactCtx) -> Result<(), MemoryProviderError> {
        Ok(())
    }

    /// Called when the engine resets a thread session (e.g. an
    /// operator-driven reset, or the future post-compaction
    /// session-id roll). Default impl is a no-op; the built-in
    /// provider overrides this to invalidate its frozen-snapshot
    /// cache for the thread. Errors are logged and discarded.
    async fn on_session_switch(&self, _ctx: &SessionSwitchCtx) -> Result<(), MemoryProviderError> {
        Ok(())
    }

    /// Fire-and-forget notification that a memory write just
    /// landed. Default impl is a no-op. Providers can use this to
    /// emit metrics, mirror writes to an external store, or
    /// invalidate caches. The engine ignores the return value; the
    /// hook must not block the write path.
    async fn on_memory_write(&self, _ctx: &MemoryWriteCtx) -> Result<(), MemoryProviderError> {
        Ok(())
    }
}

/// Sized wrapper used to stash an `Arc<dyn MemoryProvider>` in an opaque
/// `Arc<dyn Any>` slot. This mirrors `QuestionGateSlot` and keeps
/// `snaca-tools-api` free of higher-level runtime dependencies.
pub struct MemoryProviderSlot(pub Arc<dyn MemoryProvider>);

impl MemoryProviderSlot {
    pub fn new(provider: Arc<dyn MemoryProvider>) -> Self {
        Self(provider)
    }

    pub fn provider(&self) -> Arc<dyn MemoryProvider> {
        self.0.clone()
    }
}
