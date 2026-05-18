//! Response shapes returned by `LlmClient::create_message`.

use snaca_core::{Message, Usage};

#[derive(Debug, Clone)]
pub struct MessageResponse {
    /// Provider-assigned message id (e.g. `chatcmpl-xxx`). Useful for
    /// dedup / audit; not interpreted by the engine.
    pub id: String,

    /// The assistant message produced by the model. Always `Role::Assistant`.
    /// `content` may contain a mix of `Text`, `Thinking`, and `ToolUse`
    /// blocks — engine decides what to surface to the IM channel and what
    /// to treat as internal.
    pub message: Message,

    pub usage: Usage,

    pub stop_reason: StopReason,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopReason {
    /// Model finished naturally.
    EndTurn,
    /// Hit the `max_tokens` cap before finishing.
    MaxTokens,
    /// Model is asking for one or more tool calls; engine should run the
    /// tools and submit `ToolResult` blocks in the next request.
    ToolUse,
    /// Hit one of the custom `stop_sequences`.
    StopSequence,
    /// Anything else — provider-specific verbatim.
    Other(String),
}

impl StopReason {
    pub fn is_tool_use(&self) -> bool {
        matches!(self, StopReason::ToolUse)
    }

    pub fn is_terminal(&self) -> bool {
        !matches!(self, StopReason::ToolUse)
    }
}
