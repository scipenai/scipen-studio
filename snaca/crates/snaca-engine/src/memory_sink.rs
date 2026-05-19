//! Sink called by the engine when it writes a memory entry. Used by
//! `snaca-editor` to forward the change as a `memory.updated` notification
//! over the JSON-RPC wire so the host's MemoryViewer can refresh without
//! polling.
//!
//! Engine is decoupled from the editor crate, so this lives as a trait
//! the editor side implements and injects via `Engine::with_memory_sink`.

use std::sync::Arc;

pub use snaca_memory::MemoryScope;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryAction {
    Created,
    Updated,
    Deleted,
}

pub trait MemoryEventSink: Send + Sync {
    /// Best-effort notification. Implementations must not panic; failures
    /// (e.g. closed transport) should be logged and swallowed so the
    /// background extractor can keep writing the next proposal.
    fn on_memory_changed(&self, scope: MemoryScope, name: &str, action: MemoryAction);
}

pub type SharedMemorySink = Arc<dyn MemoryEventSink>;

/// Convenience no-op sink for tests / environments without a host.
pub struct NoopMemorySink;

impl MemoryEventSink for NoopMemorySink {
    fn on_memory_changed(&self, _scope: MemoryScope, _name: &str, _action: MemoryAction) {}
}
