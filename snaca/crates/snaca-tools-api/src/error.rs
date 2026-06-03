//! Tool execution errors.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ToolError {
    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("permission denied: {0}")]
    PermissionDenied(String),

    /// Path resolution rejected the input — e.g. it escaped the project
    /// workspace root. Distinct from `PermissionDenied` because this is a
    /// hard policy violation, not a runtime auth check.
    #[error("path outside workspace: {0}")]
    PathOutsideWorkspace(String),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// Generic execution failure (command exited non-zero, regex compile
    /// failed, etc.). Surfaces verbatim into the LLM-visible tool result.
    #[error("execution failed: {0}")]
    Execution(String),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    /// Tool gave up mid-execution because the turn's cancellation
    /// token was tripped. Reserved for tools that explicitly poll
    /// `ctx.is_cancelled()` between long iterations; the engine's
    /// outer `select!` already covers the common case by dropping the
    /// tool's future on cancel.
    #[error("tool cancelled")]
    Cancelled,

    #[error("{0}")]
    Other(String),
}

pub type ToolResult = Result<crate::output::ToolOutput, ToolError>;
