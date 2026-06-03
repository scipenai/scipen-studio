//! Anthropic Messages API wire types — `POST /v1/messages`.
//!
//! Notable shapes vs. OpenAI:
//! - `system` is a top-level field, not a message.
//! - Tool results are `user` messages whose `content` array contains
//!   `{"type":"tool_result", ...}` blocks (not `role:"tool"`).
//! - `content` can be a single string OR an array of blocks. We always
//!   serialize as an array of blocks for assistant messages so we never
//!   surprise the API.
//! - `stop_reason` enum is literal: `end_turn`, `max_tokens`, `tool_use`,
//!   `stop_sequence`.
//!
//! Some fields are deserialized but never consumed — they exist to mirror
//! the wire shape so the structs accept any payload Anthropic sends, and
//! so future code can read them without re-shaping the type. Suppress
//! `dead_code` at the module level rather than annotating each field.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
pub struct MessagesRequest {
    pub model: String,
    pub max_tokens: u32,
    pub messages: Vec<WireMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<SystemField>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<WireTool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_sequences: Option<Vec<String>>,
    #[serde(skip_serializing_if = "is_false")]
    pub stream: bool,
}

/// `system` is allowed in two shapes: a bare string (legacy / simple
/// case) or an array of text blocks (required to attach
/// `cache_control` to one of them). `serde(untagged)` lets us emit
/// whichever shape suits the current request without surprising the
/// API.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum SystemField {
    Text(String),
    Blocks(Vec<SystemBlock>),
}

#[derive(Debug, Clone, Serialize)]
pub struct SystemBlock {
    #[serde(rename = "type")]
    pub block_type: &'static str,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_control: Option<CacheControl>,
}

impl SystemBlock {
    pub fn text(text: String) -> Self {
        Self {
            block_type: "text",
            text,
            cache_control: None,
        }
    }

    pub fn with_cache_control(mut self, cc: CacheControl) -> Self {
        self.cache_control = Some(cc);
        self
    }
}

/// Anthropic prompt-cache marker. The API supports `type: "ephemeral"`
/// — the only variant in production at time of writing. Attach this
/// to the last block of stable content (system prompt tail, tool
/// schema tail) and the API will write that prefix to a 5-minute
/// cache; subsequent requests with the same prefix get billed at the
/// reduced cache-read rate.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct CacheControl {
    #[serde(rename = "type")]
    pub kind: &'static str,
}

pub const EPHEMERAL_CACHE: CacheControl = CacheControl {
    kind: "ephemeral",
};

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireMessage {
    pub role: String,
    pub content: Vec<WireContentBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WireContentBlock {
    Text {
        text: String,
    },
    Thinking {
        // Anthropic's extended-thinking blocks use `thinking` for the prose,
        // not `text`. Keep the canonical Rust field name as `text` for
        // symmetry with the rest of the codebase, rename only on the wire.
        #[serde(rename = "thinking")]
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    RedactedThinking {
        /// Encrypted blob from Anthropic; we pass it through opaquely so
        /// follow-up turns can return it.
        data: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        /// API allows a string or an array of blocks; we always send an
        /// array of `text` blocks for symmetry with `WireContentBlock`.
        content: Vec<WireContentBlock>,
        #[serde(default, skip_serializing_if = "is_false")]
        is_error: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct WireTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    /// Attach to the last tool in the list to cache the entire tool
    /// schema array under a single ephemeral breakpoint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_control: Option<CacheControl>,
}

// ---------------- responses ----------------

#[derive(Debug, Clone, Deserialize)]
pub struct MessagesResponse {
    pub id: String,
    #[serde(default)]
    #[serde(rename = "type")]
    pub message_type: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    pub content: Vec<WireContentBlock>,
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub stop_sequence: Option<String>,
    #[serde(default)]
    pub usage: Option<WireUsage>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct WireUsage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: Option<u64>,
    #[serde(default)]
    pub cache_read_input_tokens: Option<u64>,
}

impl From<WireUsage> for snaca_core::Usage {
    fn from(w: WireUsage) -> Self {
        snaca_core::Usage {
            input_tokens: w.input_tokens,
            output_tokens: w.output_tokens,
            cache_creation_input_tokens: w.cache_creation_input_tokens,
            cache_read_input_tokens: w.cache_read_input_tokens,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct WireErrorEnvelope {
    #[serde(default)]
    #[serde(rename = "type")]
    pub envelope_type: Option<String>,
    pub error: WireError,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WireError {
    pub message: String,
    #[serde(default)]
    #[serde(rename = "type")]
    pub error_type: Option<String>,
}
