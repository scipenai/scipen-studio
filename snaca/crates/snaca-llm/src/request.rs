//! Request shapes — what the engine hands to a provider for one round trip.
//!
//! Provider-agnostic on purpose; concrete provider implementations
//! transform these into their wire format at the boundary.

use serde::{Deserialize, Serialize};
use snaca_core::Message;

/// One slice of the system prompt, with a hint about whether the slice
/// is stable enough to benefit from prompt caching.
///
/// Providers that support per-segment caching (Anthropic) mark the
/// `cacheable` segments with `cache_control: ephemeral`; providers
/// without an opt-in cache (DeepSeek's transparent cache, OpenAI)
/// concatenate everything and ignore the flag.
#[derive(Debug, Clone)]
pub struct SystemSegment {
    pub text: String,
    pub cacheable: bool,
}

impl SystemSegment {
    pub fn cacheable(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            cacheable: true,
        }
    }

    pub fn volatile(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            cacheable: false,
        }
    }
}

/// One LLM round trip's input.
///
/// `system` is kept separate from `messages` because providers handle it
/// differently — Anthropic exposes a top-level `system` parameter; OpenAI
/// uses a `role: "system"` message. Engine builds a single canonical form
/// here; providers split as needed.
#[derive(Debug, Clone)]
pub struct MessageRequest {
    pub model: String,

    /// Legacy single-string system prompt. Kept for callers that don't
    /// care about cache segmentation (tests, summarisation). Mutually
    /// exclusive with `system_segments` — providers prefer the segments
    /// when both are populated.
    pub system: Option<String>,

    /// Segmented system prompt. Each segment is rendered as its own
    /// provider block (Anthropic) or concatenated back (DeepSeek /
    /// OpenAI). Empty vec = use `system` instead.
    pub system_segments: Vec<SystemSegment>,

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
            system_segments: Vec::new(),
            messages: Vec::new(),
            tools: Vec::new(),
            max_tokens: None,
            temperature: None,
            stop_sequences: Vec::new(),
        }
    }

    pub fn with_system(mut self, system: impl Into<String>) -> Self {
        self.system = Some(system.into());
        self.system_segments.clear();
        self
    }

    /// Provide the system prompt as ordered segments. Each `cacheable`
    /// segment may benefit from prompt caching on providers that
    /// support it; `!cacheable` segments are always sent fresh.
    /// Setting this clears any prior single-string `system`.
    pub fn with_system_segments(mut self, segments: Vec<SystemSegment>) -> Self {
        self.system_segments = segments;
        self.system = None;
        self
    }

    /// Flatten the system into a single string, regardless of whether
    /// it was set via `with_system` or `with_system_segments`. Used by
    /// providers without segmented system support.
    pub fn flat_system(&self) -> Option<String> {
        if !self.system_segments.is_empty() {
            let mut out = String::new();
            for (i, seg) in self.system_segments.iter().enumerate() {
                if i > 0 {
                    out.push_str("\n\n");
                }
                out.push_str(&seg.text);
            }
            Some(out)
        } else {
            self.system.clone()
        }
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
