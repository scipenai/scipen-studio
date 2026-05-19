//! Wire types for OpenAI's `/v1/chat/completions`.
//!
//! These structs mirror what OpenAI (and OpenAI-compatible gateways)
//! expect/return on the network. The engine never sees them directly —
//! `convert.rs` translates to/from the provider-agnostic `MessageRequest`
//! / `MessageResponse`.
//!
//! Some fields are deserialized but never consumed — they exist so the
//! structs accept whatever the server sends and stay round-trippable.
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
    /// OpenAI convention even though it's awkward.
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
}

impl From<WireUsage> for snaca_core::Usage {
    fn from(w: WireUsage) -> Self {
        snaca_core::Usage {
            input_tokens: w.prompt_tokens,
            output_tokens: w.completion_tokens,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: None,
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
