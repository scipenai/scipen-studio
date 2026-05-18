//! Provider-agnostic streaming events.
//!
//! Engines (and IM channels with a `update_message` capability) consume a
//! stream of these events as the model generates output, rather than
//! waiting for the whole response. The shape mirrors Anthropic's
//! `message_start` / `content_block_start` / `content_block_delta` SSE
//! events because that vocabulary maps cleanly onto canonical
//! `ContentBlock`s; DeepSeek (OpenAI-style chunks) is translated into the
//! same shape at the wire layer so the engine sees one model.

use crate::error::{LlmError, LlmResult};
use crate::response::{MessageResponse, StopReason};
use snaca_core::{ContentBlock, Message, MessageId, Role, ToolUseId, Usage};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    /// First event of the stream — carries the message id and (optionally)
    /// the model the provider used.
    MessageStart {
        message_id: String,
        model: Option<String>,
    },

    /// A new content block began. `index` matches subsequent
    /// `ContentBlockDelta` / `ContentBlockStop` events.
    ContentBlockStart {
        index: u32,
        block: ContentBlockStart,
    },

    /// Incremental update inside a content block. For text and thinking
    /// blocks the deltas concatenate; for tool_use blocks the
    /// `ToolInputJson` deltas concatenate into the final JSON object the
    /// model is building.
    ContentBlockDelta { index: u32, delta: ContentDelta },

    ContentBlockStop {
        index: u32,
    },

    /// Final stop_reason + usage update. Some providers emit this in a
    /// separate event from `MessageStop`; we keep both for parity.
    MessageDelta {
        stop_reason: Option<StopReason>,
        usage: Option<Usage>,
    },

    MessageStop,

    /// Provider-side error mid-stream. Caller should treat as terminal:
    /// any partial blocks already emitted are still valid, but the model
    /// will not produce more.
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum ContentBlockStart {
    Text,
    Thinking,
    /// Same id/name shape as `ContentBlock::ToolUse` so engine code that
    /// assembles partial blocks can route by id.
    ToolUse {
        id: String,
        name: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum ContentDelta {
    Text { text: String },
    Thinking { text: String },
    /// Anthropic / DeepSeek both stream tool-call arguments as a sequence
    /// of JSON-string fragments (`partial_json`); the engine concatenates
    /// them to recover the full input object.
    ToolInputJson { partial_json: String },
}

/// Convert a non-streaming `MessageResponse` into a synthetic event
/// sequence that is observationally equivalent to one a streaming
/// provider would have produced (modulo per-token granularity). Default
/// `LlmClient::create_message_stream` uses this to expose a stream API
/// even on providers we haven't yet wired up streaming for.
pub fn synthesize_events(resp: MessageResponse) -> Vec<StreamEvent> {
    let mut events = Vec::with_capacity(2 + resp.message.content.len() * 3);
    events.push(StreamEvent::MessageStart {
        message_id: resp.id,
        model: None,
    });

    for (idx, block) in resp.message.content.into_iter().enumerate() {
        let index = idx as u32;
        let (start, delta) = match block {
            ContentBlock::Text { text } => (
                ContentBlockStart::Text,
                Some(ContentDelta::Text { text }),
            ),
            ContentBlock::Thinking { text, .. } => (
                ContentBlockStart::Thinking,
                Some(ContentDelta::Thinking { text }),
            ),
            ContentBlock::ToolUse { id, name, input } => (
                ContentBlockStart::ToolUse {
                    id: id.as_str().to_string(),
                    name,
                },
                Some(ContentDelta::ToolInputJson {
                    partial_json: serde_json::to_string(&input).unwrap_or_default(),
                }),
            ),
            // ToolResult / Image don't appear in assistant responses.
            _ => continue,
        };
        events.push(StreamEvent::ContentBlockStart { index, block: start });
        if let Some(d) = delta {
            events.push(StreamEvent::ContentBlockDelta { index, delta: d });
        }
        events.push(StreamEvent::ContentBlockStop { index });
    }

    events.push(StreamEvent::MessageDelta {
        stop_reason: Some(resp.stop_reason),
        usage: Some(resp.usage),
    });
    events.push(StreamEvent::MessageStop);
    events
}

/// Reassembles a stream of [`StreamEvent`]s back into a non-streaming
/// [`MessageResponse`]. Lets the engine consume `create_message_stream` as
/// its primary call path while still surfacing a single final response to
/// callers — and lets unit tests assert "stream X collapses to response Y"
/// without round-tripping a real LLM.
///
/// Usage:
/// ```ignore
/// let mut acc = StreamAccumulator::new();
/// let mut stream = client.create_message_stream(req).await?;
/// while let Some(ev) = stream.next().await {
///     acc.ingest(ev?);
/// }
/// let response = acc.finalize()?;
/// ```
#[derive(Default)]
pub struct StreamAccumulator {
    message_id: Option<String>,
    /// Wire-reported model name (if any). Discarded on finalize since
    /// `MessageResponse` doesn't carry it; kept here for callers who want
    /// to inspect it before finalize.
    model: Option<String>,
    /// `index → partial block` keyed by the wire-level block index so
    /// out-of-order deltas (rare but legal) reassemble correctly.
    blocks: BTreeMap<u32, PartialBlock>,
    stop_reason: Option<StopReason>,
    usage: Option<Usage>,
    /// First mid-stream `Error` event seen — finalize turns it into an
    /// `LlmError::Provider`.
    error: Option<String>,
}

#[derive(Debug, Clone)]
enum PartialBlock {
    Text(String),
    Thinking { text: String, signature: Option<String> },
    ToolUse {
        id: String,
        name: String,
        /// Concatenated JSON-string fragments from `ToolInputJson` deltas.
        args: String,
    },
}

impl PartialBlock {
    fn from_start(start: ContentBlockStart) -> Self {
        match start {
            ContentBlockStart::Text => PartialBlock::Text(String::new()),
            ContentBlockStart::Thinking => PartialBlock::Thinking {
                text: String::new(),
                signature: None,
            },
            ContentBlockStart::ToolUse { id, name } => PartialBlock::ToolUse {
                id,
                name,
                args: String::new(),
            },
        }
    }

    fn ingest_delta(&mut self, delta: ContentDelta) {
        match (self, delta) {
            (PartialBlock::Text(buf), ContentDelta::Text { text }) => buf.push_str(&text),
            (PartialBlock::Thinking { text: buf, .. }, ContentDelta::Thinking { text }) => {
                buf.push_str(&text)
            }
            (
                PartialBlock::ToolUse { args, .. },
                ContentDelta::ToolInputJson { partial_json },
            ) => args.push_str(&partial_json),
            // Mismatched (e.g. text delta on a thinking block) — ignored.
            // Providers don't do this in practice; if they did, dropping
            // is safer than panicking.
            _ => {}
        }
    }

    fn into_content_block(self, stop_reason: Option<&StopReason>) -> LlmResult<ContentBlock> {
        match self {
            PartialBlock::Text(text) => Ok(ContentBlock::text(text)),
            PartialBlock::Thinking { text, signature } => {
                Ok(ContentBlock::Thinking { text, signature })
            }
            PartialBlock::ToolUse { id, name, args } => {
                let input = if args.trim().is_empty() {
                    serde_json::Value::Object(Default::default())
                } else {
                    serde_json::from_str(&args).map_err(|e| {
                        // A truncation in the middle of a streamed tool
                        // call almost always means the model hit its
                        // output budget mid-argument. Surface that as
                        // the cause — the parse error alone leaves the
                        // operator guessing.
                        let max_tokens_hit =
                            matches!(stop_reason, Some(StopReason::MaxTokens));
                        let preview = preview_args(&args);
                        let hint = if max_tokens_hit {
                            " (stop_reason=max_tokens — raise engine.max_tokens \
                             or have the model write smaller chunks)"
                        } else {
                            ""
                        };
                        LlmError::MalformedResponse(format!(
                            "tool '{name}' streamed invalid JSON arguments \
                             (args_len={len} chars): {e}{hint}; raw_preview={preview}",
                            len = args.chars().count()
                        ))
                    })?
                };
                Ok(ContentBlock::ToolUse {
                    id: ToolUseId::new(id),
                    name,
                    input,
                })
            }
        }
    }
}

/// Compact the raw tool-args blob for inclusion in error messages: a
/// 16 KB Chinese `content` string would otherwise swamp the log. Show
/// the head and tail so the truncation point is visible.
fn preview_args(args: &str) -> String {
    const HEAD: usize = 200;
    const TAIL: usize = 200;
    let len = args.chars().count();
    if len <= HEAD + TAIL + 32 {
        return args.to_string();
    }
    let head: String = args.chars().take(HEAD).collect();
    let tail: String = args.chars().skip(len - TAIL).collect();
    format!("{head}…[{trimmed} chars elided]…{tail}", trimmed = len - HEAD - TAIL)
}

impl StreamAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn message_id(&self) -> Option<&str> {
        self.message_id.as_deref()
    }

    pub fn model(&self) -> Option<&str> {
        self.model.as_deref()
    }

    pub fn ingest(&mut self, event: StreamEvent) {
        match event {
            StreamEvent::MessageStart { message_id, model } => {
                self.message_id = Some(message_id);
                self.model = model;
            }
            StreamEvent::ContentBlockStart { index, block } => {
                self.blocks.insert(index, PartialBlock::from_start(block));
            }
            StreamEvent::ContentBlockDelta { index, delta } => {
                if let Some(block) = self.blocks.get_mut(&index) {
                    block.ingest_delta(delta);
                }
                // Delta for an unknown index is silently dropped — providers
                // either always send `ContentBlockStart` first, or include
                // enough context in the delta itself (DeepSeek tool_calls)
                // for the caller to have already seeded the block via
                // `process_chunk` before invoking the accumulator.
            }
            StreamEvent::ContentBlockStop { .. } => {
                // No-op — finalize() reads the accumulated state.
            }
            StreamEvent::MessageDelta { stop_reason, usage } => {
                if let Some(reason) = stop_reason {
                    self.stop_reason = Some(reason);
                }
                if let Some(u) = usage {
                    // Some providers send usage in MessageDelta, others in
                    // a final chunk; merge by replacement (last write wins).
                    self.usage = Some(u);
                }
            }
            StreamEvent::MessageStop => {}
            StreamEvent::Error { message } => {
                if self.error.is_none() {
                    self.error = Some(message);
                }
            }
        }
    }

    pub fn finalize(self) -> LlmResult<MessageResponse> {
        if let Some(message) = self.error {
            return Err(LlmError::Provider {
                code: "stream_error".to_string(),
                message,
            });
        }
        let id = self.message_id.unwrap_or_default();
        let mut content = Vec::with_capacity(self.blocks.len());
        for (_idx, block) in self.blocks {
            // Pass stop_reason so a truncated tool-args parse can name
            // max_tokens as the likely cause instead of dumping a bare
            // "EOF while parsing a string at column N".
            content.push(block.into_content_block(self.stop_reason.as_ref())?);
        }
        // No stop_reason → fall back to inferring from content (parity with
        // the non-streaming response converters).
        let stop_reason = self.stop_reason.unwrap_or_else(|| {
            if content
                .iter()
                .any(|b| matches!(b, ContentBlock::ToolUse { .. }))
            {
                StopReason::ToolUse
            } else {
                StopReason::EndTurn
            }
        });
        Ok(MessageResponse {
            id,
            message: Message {
                id: MessageId::new(),
                role: Role::Assistant,
                content,
                created_at: chrono::Utc::now(),
            },
            usage: self.usage.unwrap_or_default(),
            stop_reason,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resp(content: Vec<ContentBlock>, stop: StopReason) -> MessageResponse {
        MessageResponse {
            id: "m1".into(),
            message: Message {
                id: MessageId::new(),
                role: Role::Assistant,
                content,
                created_at: chrono::Utc::now(),
            },
            usage: Usage::default(),
            stop_reason: stop,
        }
    }

    #[test]
    fn synthesize_text_only() {
        let events = synthesize_events(resp(
            vec![ContentBlock::text("hello")],
            StopReason::EndTurn,
        ));
        assert!(matches!(events[0], StreamEvent::MessageStart { .. }));
        assert!(matches!(
            &events[1],
            StreamEvent::ContentBlockStart { index: 0, block: ContentBlockStart::Text }
        ));
        assert!(matches!(
            &events[2],
            StreamEvent::ContentBlockDelta { delta: ContentDelta::Text { text }, .. } if text == "hello"
        ));
        assert!(matches!(
            events[3],
            StreamEvent::ContentBlockStop { index: 0 }
        ));
        assert!(matches!(
            events[4],
            StreamEvent::MessageDelta { stop_reason: Some(StopReason::EndTurn), .. }
        ));
        assert!(matches!(events[5], StreamEvent::MessageStop));
    }

    #[test]
    fn accumulator_text_only_round_trip() {
        let mut acc = StreamAccumulator::new();
        let resp_in = resp(
            vec![ContentBlock::text("Hello world")],
            StopReason::EndTurn,
        );
        let id = resp_in.id.clone();
        let synthesized = synthesize_events(resp_in);
        for ev in synthesized {
            acc.ingest(ev);
        }
        let resp = acc.finalize().unwrap();
        assert_eq!(resp.id, id);
        assert_eq!(resp.stop_reason, StopReason::EndTurn);
        match &resp.message.content[0] {
            ContentBlock::Text { text } => assert_eq!(text, "Hello world"),
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn accumulator_concatenates_text_deltas() {
        let mut acc = StreamAccumulator::new();
        acc.ingest(StreamEvent::MessageStart {
            message_id: "m1".into(),
            model: None,
        });
        acc.ingest(StreamEvent::ContentBlockStart {
            index: 0,
            block: ContentBlockStart::Text,
        });
        for piece in ["He", "llo, ", "world"] {
            acc.ingest(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::Text {
                    text: piece.to_string(),
                },
            });
        }
        acc.ingest(StreamEvent::ContentBlockStop { index: 0 });
        acc.ingest(StreamEvent::MessageDelta {
            stop_reason: Some(StopReason::EndTurn),
            usage: Some(Usage {
                input_tokens: 7,
                output_tokens: 3,
                ..Default::default()
            }),
        });
        acc.ingest(StreamEvent::MessageStop);

        let resp = acc.finalize().unwrap();
        assert_eq!(resp.id, "m1");
        assert_eq!(resp.usage.output_tokens, 3);
        match &resp.message.content[0] {
            ContentBlock::Text { text } => assert_eq!(text, "Hello, world"),
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn accumulator_assembles_tool_use_args_from_fragments() {
        let mut acc = StreamAccumulator::new();
        acc.ingest(StreamEvent::MessageStart {
            message_id: "m".into(),
            model: None,
        });
        acc.ingest(StreamEvent::ContentBlockStart {
            index: 0,
            block: ContentBlockStart::ToolUse {
                id: "tu_1".into(),
                name: "Read".into(),
            },
        });
        for piece in ["{\"path\":", "\"src/lib.rs\"", "}"] {
            acc.ingest(StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::ToolInputJson {
                    partial_json: piece.to_string(),
                },
            });
        }
        acc.ingest(StreamEvent::ContentBlockStop { index: 0 });
        acc.ingest(StreamEvent::MessageDelta {
            stop_reason: Some(StopReason::ToolUse),
            usage: None,
        });
        acc.ingest(StreamEvent::MessageStop);

        let resp = acc.finalize().unwrap();
        assert_eq!(resp.stop_reason, StopReason::ToolUse);
        match &resp.message.content[0] {
            ContentBlock::ToolUse { id, name, input } => {
                assert_eq!(id.as_str(), "tu_1");
                assert_eq!(name, "Read");
                assert_eq!(input, &serde_json::json!({"path": "src/lib.rs"}));
            }
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn accumulator_thinking_then_text_preserves_order() {
        let mut acc = StreamAccumulator::new();
        acc.ingest(StreamEvent::MessageStart {
            message_id: "m".into(),
            model: None,
        });
        acc.ingest(StreamEvent::ContentBlockStart {
            index: 0,
            block: ContentBlockStart::Thinking,
        });
        acc.ingest(StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::Thinking {
                text: "weighing options".into(),
            },
        });
        acc.ingest(StreamEvent::ContentBlockStop { index: 0 });
        acc.ingest(StreamEvent::ContentBlockStart {
            index: 1,
            block: ContentBlockStart::Text,
        });
        acc.ingest(StreamEvent::ContentBlockDelta {
            index: 1,
            delta: ContentDelta::Text {
                text: "answer".into(),
            },
        });
        acc.ingest(StreamEvent::ContentBlockStop { index: 1 });
        acc.ingest(StreamEvent::MessageStop);
        let resp = acc.finalize().unwrap();
        assert_eq!(resp.message.content.len(), 2);
        assert!(matches!(
            &resp.message.content[0],
            ContentBlock::Thinking { text, .. } if text == "weighing options"
        ));
        assert!(matches!(
            &resp.message.content[1],
            ContentBlock::Text { text } if text == "answer"
        ));
    }

    #[test]
    fn accumulator_error_event_propagates_to_finalize() {
        let mut acc = StreamAccumulator::new();
        acc.ingest(StreamEvent::MessageStart {
            message_id: "m".into(),
            model: None,
        });
        acc.ingest(StreamEvent::Error {
            message: "overloaded".into(),
        });
        let err = acc.finalize().unwrap_err();
        match err {
            LlmError::Provider { code, message } => {
                assert_eq!(code, "stream_error");
                assert!(message.contains("overloaded"));
            }
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn accumulator_invalid_tool_args_fails_finalize() {
        let mut acc = StreamAccumulator::new();
        acc.ingest(StreamEvent::MessageStart {
            message_id: "m".into(),
            model: None,
        });
        acc.ingest(StreamEvent::ContentBlockStart {
            index: 0,
            block: ContentBlockStart::ToolUse {
                id: "tu".into(),
                name: "X".into(),
            },
        });
        acc.ingest(StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::ToolInputJson {
                partial_json: "{not json".into(),
            },
        });
        acc.ingest(StreamEvent::MessageStop);
        let err = acc.finalize().unwrap_err();
        assert!(matches!(err, LlmError::MalformedResponse(_)));
    }

    #[test]
    fn accumulator_infers_tool_use_when_stop_reason_missing() {
        let mut acc = StreamAccumulator::new();
        acc.ingest(StreamEvent::MessageStart {
            message_id: "m".into(),
            model: None,
        });
        acc.ingest(StreamEvent::ContentBlockStart {
            index: 0,
            block: ContentBlockStart::ToolUse {
                id: "tu".into(),
                name: "X".into(),
            },
        });
        acc.ingest(StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::ToolInputJson {
                partial_json: "{}".into(),
            },
        });
        acc.ingest(StreamEvent::MessageStop);
        let resp = acc.finalize().unwrap();
        assert_eq!(resp.stop_reason, StopReason::ToolUse);
    }

    #[test]
    fn synthesize_tool_use() {
        let events = synthesize_events(resp(
            vec![ContentBlock::ToolUse {
                id: ToolUseId::new("tu_1"),
                name: "Read".into(),
                input: serde_json::json!({"path": "x"}),
            }],
            StopReason::ToolUse,
        ));
        let start = events
            .iter()
            .find(|e| matches!(e, StreamEvent::ContentBlockStart { .. }))
            .unwrap();
        match start {
            StreamEvent::ContentBlockStart {
                block: ContentBlockStart::ToolUse { id, name },
                ..
            } => {
                assert_eq!(id, "tu_1");
                assert_eq!(name, "Read");
            }
            _ => panic!(),
        }
    }
}
