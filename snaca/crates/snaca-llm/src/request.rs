//! Request shapes — what the engine hands to a provider for one round trip.
//!
//! Provider-agnostic on purpose; concrete provider implementations
//! transform these into their wire format at the boundary.

use serde::{Deserialize, Serialize};
use snaca_core::Message;

/// One LLM round trip's input.
///
/// `system` is kept separate from `messages` because providers handle it
/// differently — Anthropic exposes a top-level `system` parameter; OpenAI
/// uses a `role: "system"` message. Engine builds a single canonical form
/// here; providers split as needed.
#[derive(Debug, Clone)]
pub struct MessageRequest {
    pub model: String,

    /// Optional global system prompt. The engine assembles this from
    /// `MEMORY.md` excerpts, project guidance, etc.
    pub system: Option<String>,

    /// Conversation history. Newest message is last. The engine's job to
    /// truncate / compact before sending.
    pub messages: Vec<Message>,

    /// Tools the model may call. Empty = no tool use possible.
    pub tools: Vec<ToolSchema>,

    /// Hard ceiling on response tokens. None = let the provider use its
    /// default.
    pub max_tokens: Option<u32>,

    /// Sampling temperature in `[0, 2]`. None = provider default.
    pub temperature: Option<f32>,

    /// Custom stop sequences (provider-specific support).
    pub stop_sequences: Vec<String>,
}

impl MessageRequest {
    pub fn new(model: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            system: None,
            messages: Vec::new(),
            tools: Vec::new(),
            max_tokens: None,
            temperature: None,
            stop_sequences: Vec::new(),
        }
    }

    pub fn with_system(mut self, system: impl Into<String>) -> Self {
        self.system = Some(system.into());
        self
    }

    pub fn with_messages(mut self, messages: Vec<Message>) -> Self {
        self.messages = messages;
        self
    }

    pub fn with_tools(mut self, tools: Vec<ToolSchema>) -> Self {
        self.tools = tools;
        self
    }

    pub fn with_max_tokens(mut self, max: u32) -> Self {
        self.max_tokens = Some(max);
        self
    }

    pub fn with_temperature(mut self, t: f32) -> Self {
        self.temperature = Some(t);
        self
    }
}

/// JSON-Schema-shaped tool description sent to the LLM.
///
/// Equivalent to `snaca_tools_api::ToolSchema`; we declare a parallel struct
/// here to avoid `snaca-llm` depending on the tools crate (engine bridges
/// the two by mapping field-for-field).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}
