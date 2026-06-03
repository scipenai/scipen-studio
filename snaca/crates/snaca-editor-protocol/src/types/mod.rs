//! Shared protocol payload types.
//!
//! Imported by `messages::*` and re-exported from the crate root via
//! the public modules. Keep this module free of method-specific shapes.

pub mod capabilities;
pub mod config;
pub mod context;
pub mod hunk;
pub mod range;

pub use capabilities::{HostCapabilities, SnacaCapabilities};
pub use config::{
    EngineConfig, LlmConfig, LlmProvider, LoggingConfig, McpServerConfig, McpTransport,
    ApprovalMode, RetryConfig, SnacaConfig,
};
pub use context::{
    ActiveFileContext, Attachment, ChatContext, DiagnosticItem, DiagnosticSeverity,
    InlineEditContext, Mention, OpenTab, ProjectMeta, RecentEdit, SelectionInfo,
    VisibleRange,
};
pub use hunk::LineHunk;
pub use range::{Position, Range};
