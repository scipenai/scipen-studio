//! Provider-agnostic content blocks.
//!
//! [`ContentBlock`] is the canonical form SNACA uses internally. Each LLM
//! provider implementation in `snaca-llm` is responsible for losslessly
//! converting between provider-native shapes and these variants. Anthropic
//! supports `Thinking`/`signature`; DeepSeek does not — `snaca-llm` strips or
//! merges as appropriate when converting.

use crate::ids::ToolUseId;
use serde::{Deserialize, Serialize};

/// A single block within a [`crate::Message`]'s content.
///
/// `serde` tagging matches Anthropic's `type` field convention so JSON
/// payloads round-trip cleanly when going to/from the Anthropic backend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    /// Plain text. The most common block.
    Text { text: String },

    /// Reasoning trace from a thinking-capable model. `signature` is
    /// Anthropic's redacted-thinking signature; `None` for DeepSeek R1.
    Thinking {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },

    /// Model is requesting a tool call.
    ToolUse {
        id: ToolUseId,
        name: String,
        input: serde_json::Value,
    },

    /// Result of a previously requested tool call. `content` may itself
    /// contain text/image blocks — providers that don't support nested
    /// content (e.g. DeepSeek) get the text concatenated at conversion time.
    ToolResult {
        tool_use_id: ToolUseId,
        content: Vec<ContentBlock>,
        #[serde(default, skip_serializing_if = "is_false")]
        is_error: bool,
    },

    /// Image content, either as URL or inline base64 (mirrors Anthropic's
    /// `source` shape).
    Image { source: ImageSource },
}

/// Image source — either an external URL or inline base64 bytes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ImageSource {
    Url {
        url: String,
    },
    Base64 {
        media_type: String,
        data: String,
    },
}

fn is_false(b: &bool) -> bool {
    !*b
}

impl ContentBlock {
    pub fn text(s: impl Into<String>) -> Self {
        ContentBlock::Text { text: s.into() }
    }

    pub fn thinking(s: impl Into<String>) -> Self {
        ContentBlock::Thinking {
            text: s.into(),
            signature: None,
        }
    }

    pub fn tool_use(
        id: impl Into<String>,
        name: impl Into<String>,
        input: serde_json::Value,
    ) -> Self {
        ContentBlock::ToolUse {
            id: ToolUseId::new(id.into()),
            name: name.into(),
            input,
        }
    }

    pub fn tool_result(tool_use_id: ToolUseId, content: Vec<ContentBlock>) -> Self {
        ContentBlock::ToolResult {
            tool_use_id,
            content,
            is_error: false,
        }
    }

    pub fn tool_error(tool_use_id: ToolUseId, message: impl Into<String>) -> Self {
        ContentBlock::ToolResult {
            tool_use_id,
            content: vec![ContentBlock::text(message)],
            is_error: true,
        }
    }

    /// Whether this block carries no user-visible signal (used by IM
    /// formatters that suppress thinking traces by default).
    pub fn is_internal(&self) -> bool {
        matches!(self, ContentBlock::Thinking { .. })
    }

    /// Concatenate the `Text` blocks in a slice, separating consecutive
    /// runs with `\n`. Non-text blocks (thinking, tool use/result, image)
    /// are skipped — they have no flat string representation.
    pub fn collect_text(blocks: &[ContentBlock]) -> String {
        let mut out = String::new();
        for b in blocks {
            if let ContentBlock::Text { text } = b {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(text);
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn text_roundtrips() {
        let b = ContentBlock::text("hello");
        let s = serde_json::to_string(&b).unwrap();
        assert_eq!(s, r#"{"type":"text","text":"hello"}"#);
        let back: ContentBlock = serde_json::from_str(&s).unwrap();
        assert_eq!(b, back);
    }

    #[test]
    fn tool_use_roundtrips() {
        let b = ContentBlock::tool_use("toolu_01", "Read", json!({"path": "/tmp/x"}));
        let s = serde_json::to_string(&b).unwrap();
        let back: ContentBlock = serde_json::from_str(&s).unwrap();
        assert_eq!(b, back);
    }

    #[test]
    fn tool_result_omits_is_error_when_false() {
        let id = ToolUseId::new("toolu_01");
        let b = ContentBlock::tool_result(id.clone(), vec![ContentBlock::text("done")]);
        let s = serde_json::to_string(&b).unwrap();
        assert!(!s.contains("is_error"), "is_error must be omitted by default; got {s}");
    }

    #[test]
    fn tool_error_serialises_is_error_true() {
        let id = ToolUseId::new("toolu_01");
        let b = ContentBlock::tool_error(id, "boom");
        let s = serde_json::to_string(&b).unwrap();
        assert!(s.contains(r#""is_error":true"#));
    }

    #[test]
    fn thinking_internal_is_marked() {
        assert!(ContentBlock::thinking("...").is_internal());
        assert!(!ContentBlock::text("...").is_internal());
    }
}
