//! SSE → canonical `StreamEvent` translator for Anthropic's
//! `POST /v1/messages` streaming variant.
//!
//! Anthropic's SSE wire format:
//!
//! ```text
//! event: message_start
//! data: {"type":"message_start","message":{"id":"...","model":"...","content":[],...}}
//!
//! event: content_block_start
//! data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
//!
//! event: content_block_delta
//! data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}
//!
//! event: content_block_stop
//! data: {"type":"content_block_stop","index":0}
//!
//! event: message_delta
//! data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}
//!
//! event: message_stop
//! data: {"type":"message_stop"}
//! ```
//!
//! Plus periodic `event: ping` keepalives we silently drop, and an
//! occasional `event: error` envelope we forward as `StreamEvent::Error`.
//!
//! The translator is split into:
//! - [`translate_event`]: pure function (event_type, data_json) → Option<StreamEvent>;
//!   unit-testable, no IO.
//! - [`parse_byte_stream`]: drives a byte stream through line buffering
//!   and dispatches each completed event to `translate_event`.

use crate::error::{LlmError, LlmResult};
use crate::response::StopReason;
use crate::stream::{ContentBlockStart, ContentDelta, StreamEvent};
use bytes::Bytes;
use futures::stream::{BoxStream, Stream, StreamExt};
use serde_json::Value;
use snaca_core::Usage;

/// Translate one Anthropic SSE event (already split into `event:` line
/// and accumulated `data:` payload) into a canonical [`StreamEvent`].
/// Returns `Ok(None)` for events we deliberately drop (`ping`,
/// `signature_delta`, unknown types).
pub fn translate_event(event_type: &str, data: &str) -> LlmResult<Option<StreamEvent>> {
    if data.is_empty() {
        return Ok(None);
    }
    match event_type {
        "ping" | "" => Ok(None),
        "message_start" => {
            let v: Value = parse_json(data)?;
            let message = v.get("message").ok_or_else(|| {
                LlmError::MalformedResponse("message_start missing `message`".into())
            })?;
            Ok(Some(StreamEvent::MessageStart {
                message_id: as_str(message, "id").unwrap_or_default(),
                model: as_str(message, "model"),
            }))
        }
        "content_block_start" => {
            let v: Value = parse_json(data)?;
            let index = as_u32(&v, "index").unwrap_or(0);
            let block = v.get("content_block").ok_or_else(|| {
                LlmError::MalformedResponse("content_block_start missing `content_block`".into())
            })?;
            let kind = as_str(block, "type").unwrap_or_default();
            let start = match kind.as_str() {
                "text" => ContentBlockStart::Text,
                "thinking" | "redacted_thinking" => ContentBlockStart::Thinking,
                "tool_use" => ContentBlockStart::ToolUse {
                    id: as_str(block, "id").unwrap_or_default(),
                    name: as_str(block, "name").unwrap_or_default(),
                },
                _ => return Ok(None),
            };
            Ok(Some(StreamEvent::ContentBlockStart {
                index,
                block: start,
            }))
        }
        "content_block_delta" => {
            let v: Value = parse_json(data)?;
            let index = as_u32(&v, "index").unwrap_or(0);
            let delta = v.get("delta").ok_or_else(|| {
                LlmError::MalformedResponse("content_block_delta missing `delta`".into())
            })?;
            let kind = as_str(delta, "type").unwrap_or_default();
            let canonical = match kind.as_str() {
                "text_delta" => ContentDelta::Text {
                    text: as_str(delta, "text").unwrap_or_default(),
                },
                "thinking_delta" => ContentDelta::Thinking {
                    text: as_str(delta, "thinking").unwrap_or_default(),
                },
                "input_json_delta" => ContentDelta::ToolInputJson {
                    partial_json: as_str(delta, "partial_json").unwrap_or_default(),
                },
                // signature_delta carries the encrypted signature for an
                // extended-thinking block; useful for replaying a turn but
                // not interesting for the engine's deltas. Drop silently.
                "signature_delta" => return Ok(None),
                _ => return Ok(None),
            };
            Ok(Some(StreamEvent::ContentBlockDelta {
                index,
                delta: canonical,
            }))
        }
        "content_block_stop" => {
            let v: Value = parse_json(data)?;
            let index = as_u32(&v, "index").unwrap_or(0);
            Ok(Some(StreamEvent::ContentBlockStop { index }))
        }
        "message_delta" => {
            let v: Value = parse_json(data)?;
            let stop_reason = v
                .get("delta")
                .and_then(|d| d.get("stop_reason"))
                .and_then(Value::as_str)
                .map(map_stop_reason);
            let usage = v.get("usage").map(parse_usage);
            Ok(Some(StreamEvent::MessageDelta { stop_reason, usage }))
        }
        "message_stop" => Ok(Some(StreamEvent::MessageStop)),
        "error" => {
            let v: Value = parse_json(data)?;
            let message = v
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("unknown anthropic error")
                .to_string();
            Ok(Some(StreamEvent::Error { message }))
        }
        _ => Ok(None),
    }
}

fn parse_json(data: &str) -> LlmResult<Value> {
    serde_json::from_str(data).map_err(|e| {
        LlmError::MalformedResponse(format!("invalid SSE data payload: {e}; data={data}"))
    })
}

fn as_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(String::from)
}

fn as_u32(v: &Value, key: &str) -> Option<u32> {
    v.get(key).and_then(Value::as_u64).map(|n| n as u32)
}

fn parse_usage(v: &Value) -> Usage {
    Usage {
        input_tokens: v
            .get("input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        output_tokens: v
            .get("output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        cache_creation_input_tokens: v
            .get("cache_creation_input_tokens")
            .and_then(Value::as_u64),
        cache_read_input_tokens: v
            .get("cache_read_input_tokens")
            .and_then(Value::as_u64),
    }
}

fn map_stop_reason(s: &str) -> StopReason {
    match s {
        "end_turn" => StopReason::EndTurn,
        "max_tokens" => StopReason::MaxTokens,
        "tool_use" => StopReason::ToolUse,
        "stop_sequence" => StopReason::StopSequence,
        other => StopReason::Other(other.to_string()),
    }
}

/// Drive a byte stream of SSE chunks through line buffering and produce
/// canonical [`StreamEvent`]s. Each SSE "event" is the run of `event:` /
/// `data:` lines up to the next blank line; multi-line `data:` fields are
/// concatenated with `\n` per the SSE spec.
pub fn parse_byte_stream<S>(input: S) -> BoxStream<'static, LlmResult<StreamEvent>>
where
    S: Stream<Item = LlmResult<Bytes>> + Send + 'static,
{
    let stream = async_stream::try_stream! {
        let mut buf = String::new();
        let mut event_type = String::new();
        let mut event_data = String::new();
        let mut input = std::pin::pin!(input);

        while let Some(chunk) = input.next().await {
            let chunk = chunk?;
            // Lossy is fine: SSE is required to be UTF-8, and even if a
            // byte-split chunk lands mid-codepoint we recover on the next
            // chunk because the line we care about is fully buffered.
            buf.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(nl) = buf.find('\n') {
                let mut line = buf[..nl].to_string();
                buf.drain(..=nl);
                if line.ends_with('\r') {
                    line.pop();
                }

                if line.is_empty() {
                    if !event_data.is_empty() {
                        if let Some(ev) = translate_event(&event_type, &event_data)? {
                            yield ev;
                        }
                    }
                    event_type.clear();
                    event_data.clear();
                } else if let Some(rest) = line.strip_prefix("event:") {
                    event_type = rest.trim_start().to_string();
                } else if let Some(rest) = line.strip_prefix("data:") {
                    if !event_data.is_empty() {
                        event_data.push('\n');
                    }
                    event_data.push_str(rest.trim_start());
                }
                // Lines starting with `:` are SSE comments; everything
                // else (id:, retry:) is irrelevant for our usage.
            }
        }

        // Stream ended mid-event — flush whatever we've accumulated.
        if !event_data.is_empty() {
            if let Some(ev) = translate_event(&event_type, &event_data)? {
                yield ev;
            }
        }
    };
    Box::pin(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn translate_message_start() {
        let data = json!({
            "type": "message_start",
            "message": {"id": "msg_01", "model": "claude-test"}
        })
        .to_string();
        let ev = translate_event("message_start", &data).unwrap().unwrap();
        match ev {
            StreamEvent::MessageStart { message_id, model } => {
                assert_eq!(message_id, "msg_01");
                assert_eq!(model.as_deref(), Some("claude-test"));
            }
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn translate_text_delta() {
        let data =
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}"#;
        let ev = translate_event("content_block_delta", data).unwrap().unwrap();
        match ev {
            StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::Text { text },
            } => assert_eq!(text, "Hi"),
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn translate_thinking_delta_uses_thinking_field() {
        let data = r#"{"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"hmm"}}"#;
        let ev = translate_event("content_block_delta", data).unwrap().unwrap();
        match ev {
            StreamEvent::ContentBlockDelta {
                index: 1,
                delta: ContentDelta::Thinking { text },
            } => assert_eq!(text, "hmm"),
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn translate_tool_use_start_and_input_json() {
        let start = r#"{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu_1","name":"Read"}}"#;
        let ev = translate_event("content_block_start", start)
            .unwrap()
            .unwrap();
        match ev {
            StreamEvent::ContentBlockStart {
                index: 2,
                block: ContentBlockStart::ToolUse { id, name },
            } => {
                assert_eq!(id, "tu_1");
                assert_eq!(name, "Read");
            }
            other => panic!("got {other:?}"),
        }

        let delta = r#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}"#;
        let ev = translate_event("content_block_delta", delta).unwrap().unwrap();
        match ev {
            StreamEvent::ContentBlockDelta {
                index: 2,
                delta: ContentDelta::ToolInputJson { partial_json },
            } => assert_eq!(partial_json, "{\"path\":"),
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn translate_message_delta_carries_stop_reason_and_usage() {
        let data = r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}"#;
        let ev = translate_event("message_delta", data).unwrap().unwrap();
        match ev {
            StreamEvent::MessageDelta { stop_reason, usage } => {
                assert_eq!(stop_reason, Some(StopReason::EndTurn));
                assert_eq!(usage.unwrap().output_tokens, 5);
            }
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn translate_error_event() {
        let data =
            r#"{"type":"error","error":{"type":"overloaded_error","message":"server is busy"}}"#;
        let ev = translate_event("error", data).unwrap().unwrap();
        match ev {
            StreamEvent::Error { message } => assert!(message.contains("busy")),
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn ping_and_signature_delta_are_dropped() {
        assert!(translate_event("ping", "{}").unwrap().is_none());
        let sig = r#"{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}}"#;
        assert!(translate_event("content_block_delta", sig).unwrap().is_none());
    }

    fn collect_events(bytes: &[u8]) -> Vec<StreamEvent> {
        use futures::executor::block_on;
        use futures::stream;
        let owned: Vec<u8> = bytes.to_vec();
        let s =
            stream::once(async move { Ok::<_, LlmError>(Bytes::from(owned)) });
        block_on(async {
            let parsed = parse_byte_stream(s);
            parsed
                .filter_map(|r| async { r.ok() })
                .collect::<Vec<_>>()
                .await
        })
    }

    #[test]
    fn end_to_end_byte_stream() {
        let raw = b"\
event: message_start\n\
data: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\",\"model\":\"c\"}}\n\
\n\
event: content_block_start\n\
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\"}}\n\
\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi\"}}\n\
\n\
event: content_block_delta\n\
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" there\"}}\n\
\n\
event: content_block_stop\n\
data: {\"type\":\"content_block_stop\",\"index\":0}\n\
\n\
event: message_delta\n\
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\
\n\
event: message_stop\n\
data: {\"type\":\"message_stop\"}\n\
\n";
        let events = collect_events(raw);
        // Expected sequence: start, block_start, 2x delta, block_stop, message_delta, stop.
        assert_eq!(events.len(), 7, "got {events:#?}");
        assert!(matches!(events[0], StreamEvent::MessageStart { .. }));
        assert!(matches!(events[1], StreamEvent::ContentBlockStart { .. }));
        assert!(matches!(events[2], StreamEvent::ContentBlockDelta { .. }));
        assert!(matches!(events[3], StreamEvent::ContentBlockDelta { .. }));
        assert!(matches!(events[4], StreamEvent::ContentBlockStop { .. }));
        assert!(matches!(events[5], StreamEvent::MessageDelta { .. }));
        assert!(matches!(events[6], StreamEvent::MessageStop));

        // Concatenated text matches the model output.
        let text: String = events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::ContentBlockDelta {
                    delta: ContentDelta::Text { text },
                    ..
                } => Some(text.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(text, "Hi there");
    }

    #[test]
    fn split_chunks_assemble_correctly() {
        // Same payload as above but split into two chunks mid-line.
        use futures::executor::block_on;
        use futures::stream;

        let part_1 = b"event: message_start\ndata: {\"type\":\"message_start\",\"messa";
        let part_2 = b"ge\":{\"id\":\"m1\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
        let s = stream::iter(vec![
            Ok::<_, LlmError>(Bytes::from(part_1.to_vec())),
            Ok(Bytes::from(part_2.to_vec())),
        ]);
        let events: Vec<StreamEvent> = block_on(async {
            parse_byte_stream(s)
                .filter_map(|r| async { r.ok() })
                .collect::<Vec<_>>()
                .await
        });
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], StreamEvent::MessageStart { .. }));
        assert!(matches!(events[1], StreamEvent::MessageStop));
    }

    #[test]
    fn malformed_data_propagates_error() {
        use futures::executor::block_on;
        use futures::stream;

        let bad = b"event: message_start\ndata: {not valid json\n\n";
        let s = stream::once(async move { Ok::<_, LlmError>(Bytes::from(bad.to_vec())) });
        let events: Vec<LlmResult<StreamEvent>> = block_on(async {
            parse_byte_stream(s).collect::<Vec<_>>().await
        });
        assert_eq!(events.len(), 1);
        assert!(matches!(
            events.into_iter().next().unwrap(),
            Err(LlmError::MalformedResponse(_))
        ));
    }
}
