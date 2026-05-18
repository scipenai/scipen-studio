//! Tool output — what gets surfaced back to the LLM after a tool call.
//!
//! Tools return text, structured JSON, or a list of pre-built
//! `ContentBlock`s. The engine wraps [`ToolOutput`] into a
//! `ContentBlock::ToolResult` before sending it back to the LLM;
//! this layer is provider-agnostic.

use serde_json::Value;
use snaca_core::ContentBlock;

#[derive(Debug, Clone)]
pub enum ToolOutput {
    /// Plain text content. Most tools default to this.
    Text(String),

    /// Structured data. Engine renders this as JSON when packing into a
    /// ContentBlock; downstream consumers may inspect it directly.
    Json(Value),

    /// Pre-built `ContentBlock` list. Used when a tool wants to return
    /// a mix of text + image (Read on a `.png`), or several structured
    /// fragments. The engine passes these straight through as the
    /// content of the `ToolResult` — no flattening, no re-wrapping.
    /// Empty list is allowed but semantically odd; prefer `Text("")`.
    Blocks(Vec<ContentBlock>),
}

impl ToolOutput {
    pub fn text(t: impl Into<String>) -> Self {
        ToolOutput::Text(t.into())
    }

    pub fn json(v: Value) -> Self {
        ToolOutput::Json(v)
    }

    pub fn blocks(blocks: Vec<ContentBlock>) -> Self {
        ToolOutput::Blocks(blocks)
    }

    /// Render as a single string suitable for embedding into an LLM-visible
    /// `ToolResult`. JSON values are pretty-printed (cheap; tool results are
    /// rarely >100 KB). Block lists collapse to their text content;
    /// non-text blocks (images) render as a `<image …>` placeholder so
    /// callers that haven't migrated to the block-aware engine path still
    /// get a meaningful string.
    pub fn render_text(&self) -> String {
        match self {
            ToolOutput::Text(t) => t.clone(),
            ToolOutput::Json(v) => serde_json::to_string_pretty(v)
                .unwrap_or_else(|_| v.to_string()),
            ToolOutput::Blocks(bs) => {
                let mut out = String::new();
                for b in bs {
                    match b {
                        ContentBlock::Text { text } => {
                            if !out.is_empty() && !out.ends_with('\n') {
                                out.push('\n');
                            }
                            out.push_str(text);
                        }
                        ContentBlock::Image { source } => {
                            if !out.is_empty() && !out.ends_with('\n') {
                                out.push('\n');
                            }
                            let media = match source {
                                snaca_core::ImageSource::Url { .. } => "url",
                                snaca_core::ImageSource::Base64 { media_type, .. } => {
                                    media_type.as_str()
                                }
                            };
                            out.push_str(&format!("<image: {media}>"));
                        }
                        _ => {
                            // Other variants (ToolUse / ToolResult /
                            // Thinking) shouldn't appear as a tool's
                            // return value; if they do, fall back to
                            // a debug-style placeholder so the LLM
                            // still sees something.
                            if !out.is_empty() && !out.ends_with('\n') {
                                out.push('\n');
                            }
                            out.push_str("<non-textual block>");
                        }
                    }
                }
                out
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn text_render_is_passthrough() {
        assert_eq!(ToolOutput::text("hi").render_text(), "hi");
    }

    #[test]
    fn json_render_is_pretty() {
        let out = ToolOutput::json(json!({"a": 1}));
        let s = out.render_text();
        assert!(s.contains("\n"));
        assert!(s.contains("\"a\""));
    }

    #[test]
    fn blocks_render_concatenates_text_with_image_placeholder() {
        let out = ToolOutput::blocks(vec![
            ContentBlock::text("page 1"),
            ContentBlock::Image {
                source: snaca_core::ImageSource::Base64 {
                    media_type: "image/png".into(),
                    data: "AAA".into(),
                },
            },
            ContentBlock::text("page 2"),
        ]);
        let s = out.render_text();
        assert!(s.contains("page 1"));
        assert!(s.contains("<image: image/png>"));
        assert!(s.contains("page 2"));
    }
}
