//! OpenAI-compatible wire types for DeepSeek's `/v1/chat/completions`.
//!
//! These structs mirror what DeepSeek expects/returns on the network. The
//! engine never sees them directly — `convert.rs` translates to/from the
//! provider-agnostic `MessageRequest` / `MessageResponse`.
//!
//! Some fields are deserialized but never consumed — they exist so the
//! structs accept whatever DeepSeek sends and stay round-trippable.
//! Suppress `dead_code` at the module level rather than annotating each.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<WireMessage>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<WireTool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop: Option<Vec<String>>,
    pub stream: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireMessage {
    pub role: String,
    /// `null` is meaningful here (assistant message with only tool calls);
    /// keep the `Option` distinct from "missing field".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Echoed back on assistant messages when the prior turn included a
    /// chain-of-thought trace. DeepSeek's thinking models (V3.1+, V4) require
    /// the previous `reasoning_content` to be replayed in history; omitting it
    /// produces `invalid_request_error: The reasoning_content in the thinking
    /// mode must be passed back to the API`. Non-thinking models tolerate the
    /// extra field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<WireToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// `name` field on tool result messages; some providers want it. Optional
    /// so we don't break round-trips.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireToolCall {
    pub id: String,
    #[serde(rename = "type")]
    pub call_type: String,
    pub function: WireToolCallFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireToolCallFunction {
    pub name: String,
    /// Arguments are a JSON-encoded *string*, not an object. Matches
    /// OpenAI/DeepSeek convention even though it's awkward.
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WireTool {
    #[serde(rename = "type")]
    pub tool_type: String,
    pub function: WireToolDefinition,
}

#[derive(Debug, Clone, Serialize)]
pub struct WireToolDefinition {
    pub name: String,
    pub description: String,
    /// JSON Schema describing the tool's input.
    pub parameters: serde_json::Value,
}

// -------------------- responses --------------------

#[derive(Debug, Clone, Deserialize)]
pub struct ChatResponse {
    pub id: String,
    #[serde(default)]
    pub model: String,
    pub choices: Vec<WireChoice>,
    #[serde(default)]
    pub usage: Option<WireUsage>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WireChoice {
    #[serde(default)]
    pub index: u32,
    pub message: WireResponseMessage,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WireResponseMessage {
    #[serde(default)]
    pub role: Option<String>,
    /// May be null when the assistant only made tool calls.
    #[serde(default)]
    pub content: Option<String>,
    /// DeepSeek-R1 only: chain-of-thought trace.
    #[serde(default)]
    pub reasoning_content: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<Vec<WireToolCall>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct WireUsage {
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
    #[serde(default)]
    pub total_tokens: u64,
    /// DeepSeek context-cache hit count (analogue to Anthropic's
    /// `cache_read_input_tokens`). Tracked separately so we can surface it.
    #[serde(default)]
    pub prompt_cache_hit_tokens: Option<u64>,
    #[serde(default)]
    pub prompt_cache_miss_tokens: Option<u64>,
}

impl From<WireUsage> for snaca_core::Usage {
    fn from(w: WireUsage) -> Self {
        snaca_core::Usage {
            input_tokens: w.prompt_tokens,
            output_tokens: w.completion_tokens,
            cache_creation_input_tokens: w.prompt_cache_miss_tokens,
            cache_read_input_tokens: w.prompt_cache_hit_tokens,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct WireErrorEnvelope {
    pub error: WireError,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WireError {
    pub message: String,
    #[serde(default)]
    #[serde(rename = "type")]
    pub error_type: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
}
