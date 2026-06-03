//! MCP integration errors.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum McpError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    /// Failure during MCP handshake (initialize / list_tools).
    #[error("mcp server `{server}` initialization failed: {reason}")]
    Initialization { server: String, reason: String },

    #[error("mcp server `{server}` is not connected")]
    NotConnected { server: String },

    /// `tools/call` returned an error or unexpected payload.
    #[error("mcp tool `{tool}` on `{server}` failed: {reason}")]
    ToolCall {
        server: String,
        tool: String,
        reason: String,
    },

    /// Per-RPC timeout fired before the server replied. Surfaced
    /// separately from `ToolCall` so the tool wrapper can report a
    /// terse, actionable message ("timed out after Ns") instead of a
    /// generic "tool failed". Engine treats it like any other tool
    /// error — the model gets one tool_result block describing the
    /// timeout and decides whether to retry.
    #[error("mcp tool `{tool}` on `{server}` timed out after {timeout_secs}s")]
    Timeout {
        server: String,
        tool: String,
        timeout_secs: u64,
    },

    /// Active health probe (re-issuing `tools/list` against a cached
    /// connection) failed. Surfaced separately from `Initialization`
    /// so the pool can attribute the dead-connection eviction to a
    /// probe rather than a fresh spawn.
    #[error("mcp server `{server}` health probe failed: {reason}")]
    HealthCheckFailed { server: String, reason: String },

    /// `client_for` short-circuited because the pool is in
    /// exponential backoff for this `(tenant, project)`. Surfaces to
    /// the caller (engine `tools_for`) which logs and proceeds
    /// without MCP tools for that turn.
    #[error("mcp server `{server}` in backoff for {retry_in_ms}ms (after {failures} failures)")]
    Backoff {
        server: String,
        failures: u32,
        retry_in_ms: u64,
    },

    #[error("invalid mcp tool name `{0}` (must be `mcp__<server>__<tool>`)")]
    InvalidToolName(String),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    /// Anything else surfaced from the rmcp SDK.
    #[error("mcp client error: {0}")]
    Rmcp(String),

    #[error("{0}")]
    Other(String),
}

pub type McpResult<T> = Result<T, McpError>;
