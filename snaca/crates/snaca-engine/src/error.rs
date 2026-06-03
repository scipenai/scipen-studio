//! Engine error type — wraps everything that can go wrong inside one turn.

use snaca_llm::LlmError;
use snaca_state::StateError;
use snaca_tools_api::ToolError;
use snaca_workspace::WorkspaceError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum EngineError {
    #[error("state error: {0}")]
    State(#[from] StateError),

    #[error("workspace error: {0}")]
    Workspace(#[from] WorkspaceError),

    #[error("llm error: {0}")]
    Llm(#[from] LlmError),

    /// The model exceeded `max_iterations` without reaching a terminal stop
    /// reason. Surface to the caller; do not silently truncate.
    #[error("turn loop exceeded {0} iterations without terminating")]
    MaxIterationsExceeded(usize),

    /// LoopGuard tripped: the model invoked the same tool with the same
    /// input more than the configured threshold within a single turn. We
    /// abort rather than burn iterations on what is clearly a stuck loop.
    #[error("loop guard tripped: tool '{tool}' was called {count} times with identical input")]
    LoopGuardTripped { tool: String, count: usize },

    /// The approval gate failed to produce a decision (timeout, channel
    /// closed, etc.). The current turn cannot proceed.
    #[error("approval gate error: {0}")]
    Approval(#[from] crate::approval::ApprovalError),

    /// Internal protocol error — the model produced a tool call we cannot
    /// route (vs. a tool that just errored, which is a normal result).
    #[error("tool '{0}' is not registered")]
    UnknownTool(String),

    /// Surfaces tool-invocation infrastructure failures (DB write, etc.) —
    /// distinct from `ToolError`, which is a tool-level error returned to
    /// the LLM.
    #[error("tool dispatch error: {0}")]
    ToolDispatch(String),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    /// Turn was cancelled externally — admin HTTP abort, IM recall
    /// event, or process shutdown. Distinct from `TurnTimeout` so
    /// callers can tell user-initiated abort from system-imposed
    /// budget expiry.
    #[error("turn aborted")]
    Aborted,

    /// Turn ran past `EngineConfig.turn_timeout_secs`. The token was
    /// cancelled via the same path as `Aborted`; we surface a
    /// separate variant so logs / metrics can attribute the cause.
    #[error("turn exceeded wall-clock budget of {0}s")]
    TurnTimeout(u64),

    #[error("{0}")]
    Other(String),
}

pub type EngineResult<T> = Result<T, EngineError>;

impl From<ToolError> for EngineError {
    fn from(e: ToolError) -> Self {
        EngineError::ToolDispatch(e.to_string())
    }
}
