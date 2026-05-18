//! SSE → canonical `StreamEvent` translator for DeepSeek's
//! OpenAI-compatible `/v1/chat/completions` streaming variant.
//!
//! ## Wire format
//!
//! Each line is a `data: ...` payload; events are separated by blank lines.
//! There is no `event:` prefix (unlike Anthropic). Terminator is the
//! literal `data: [DONE]` line.
//!
//! ```text
//! data: {"id":"chatcmpl-x","model":"deepseek-chat","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}
//!
//! data: {"id":"chatcmpl-x","choices":[{"index":0,"delta":{"content":"Hi"}}]}
//!
//! data: {"id":"chatcmpl-x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Read","arguments":""}}]}}]}
//!
//! data: {"id":"chatcmpl-x","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":"}}]}}]}
//!
//! data: {"id":"chatcmpl-x","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}
//!
//! data: [DONE]
//! ```
//!
//! ## Synthesis
//!
//! DeepSeek doesn't emit explicit `content_block_start`/`stop` markers, so
//! the parser keeps a `StreamState` that tracks the currently-open
//! canonical block and synthesizes start/stop events when the chunk shape
//! switches (e.g. content → tool_calls). Tool-call indices in the wire
//! stream are stable per-call, so we map them to canonical block indices
//! and route subsequent argument deltas accordingly.

use crate::deepseek::wire::WireUsage;
use crate::error::{LlmError, LlmResult};
use crate::response::StopReason;
use crate::stream::{ContentBlockStart, ContentDelta, StreamEvent};
use bytes::Bytes;
use futures::stream::{BoxStream, Stream, StreamExt};
use serde::Deserialize;
use std::collections::HashMap;

// ---------------- wire chunks ----------------

#[derive(Debug, Clone, Deserialize)]
pub struct ChatStreamChunk {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub choices: Vec<StreamChoice>,
    #[serde(default)]
    pub usage: Option<WireUsage>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)] // `index` mirrors the wire format but isn't consumed.
pub struct StreamChoice {
    #[serde(default)]
    pub index: u32,
    #[serde(default)]
    pub delta: StreamDelta,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct StreamDelta {
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub reasoning_content: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<Vec<StreamToolCall>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StreamToolCall {
    pub index: u32,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub function: Option<StreamToolCallFunction>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct StreamToolCallFunction {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub arguments: Option<String>,
}

// ---------------- state machine ----------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActiveBlock {
    Text(u32),
    Thinking(u32),
    ToolUse {
        canonical_index: u32,
        chunk_index: u32,
    },
}

#[derive(Default)]
pub struct StreamState {
    started: bool,
    finished: bool,
    next_index: u32,
    current: Option<ActiveBlock>,
    /// Mapping from the wire's `tool_calls[k].index` to the canonical block
    /// index we assigned when we first saw it.
    tool_indices: HashMap<u32, u32>,
}

impl StreamState {
    pub fn new() -> Self {
        Self::default()
    }

    fn next_idx(&mut self) -> u32 {
        let i = self.next_index;
        self.next_index += 1;
        i
    }

    fn close_current(&mut self, out: &mut Vec<StreamEvent>) {
        if let Some(block) = self.current.take() {
            let index = match block {
                ActiveBlock::Text(i) | ActiveBlock::Thinking(i) => i,
                ActiveBlock::ToolUse {
                    canonical_index, ..
                } => canonical_index,
            };
            out.push(StreamEvent::ContentBlockStop { index });
        }
    }
}

/// Translate one wire chunk into canonical events, mutating `state`.
/// Returns the events the caller should yield in order.
pub fn process_chunk(chunk: ChatStreamChunk, state: &mut StreamState) -> Vec<StreamEvent> {
    let mut out = Vec::new();
    if state.finished {
        return out;
    }

    if !state.started {
        let id = chunk.id.clone().unwrap_or_default();
        out.push(StreamEvent::MessageStart {
            message_id: id,
            model: chunk.model.clone(),
        });
        state.started = true;
    }

    let Some(choice) = chunk.choices.into_iter().next() else {
        return out;
    };
    let delta = choice.delta;

    // 1. reasoning_content (DeepSeek-R1 chain-of-thought stream)
    if let Some(reasoning) = delta.reasoning_content {
        if !reasoning.is_empty() {
            ensure_thinking(state, &mut out);
            if let Some(ActiveBlock::Thinking(idx)) = state.current {
                out.push(StreamEvent::ContentBlockDelta {
                    index: idx,
                    delta: ContentDelta::Thinking { text: reasoning },
                });
            }
        }
    }

    // 2. content (the visible text the user sees)
    if let Some(text) = delta.content {
        if !text.is_empty() {
            ensure_text(state, &mut out);
            if let Some(ActiveBlock::Text(idx)) = state.current {
                out.push(StreamEvent::ContentBlockDelta {
                    index: idx,
                    delta: ContentDelta::Text { text },
                });
            }
        }
    }

    // 3. tool_calls — each call's wire index maps to a canonical block.
    if let Some(calls) = delta.tool_calls {
        for tc in calls {
            let canonical = match state.tool_indices.get(&tc.index) {
                Some(&idx) => idx,
                None => {
                    // First time we've seen this tool call → start a new block.
                    state.close_current(&mut out);
                    let idx = state.next_idx();
                    state.tool_indices.insert(tc.index, idx);
                    state.current = Some(ActiveBlock::ToolUse {
                        canonical_index: idx,
                        chunk_index: tc.index,
                    });
                    let id = tc.id.clone().unwrap_or_default();
                    let name = tc
                        .function
                        .as_ref()
                        .and_then(|f| f.name.clone())
                        .unwrap_or_default();
                    out.push(StreamEvent::ContentBlockStart {
                        index: idx,
                        block: ContentBlockStart::ToolUse { id, name },
                    });
                    idx
                }
            };
            // Re-anchor the active block to this tool call so subsequent
            // chunks within the same one don't re-open it. If a different
            // call interleaves, ensure_* will close the previous one.
            state.current = Some(ActiveBlock::ToolUse {
                canonical_index: canonical,
                chunk_index: tc.index,
            });
            if let Some(args) = tc.function.and_then(|f| f.arguments) {
                if !args.is_empty() {
                    out.push(StreamEvent::ContentBlockDelta {
                        index: canonical,
                        delta: ContentDelta::ToolInputJson { partial_json: args },
                    });
                }
            }
        }
    }

    // 4. finish_reason → terminal events
    if let Some(reason) = choice.finish_reason {
        state.close_current(&mut out);
        let stop_reason = Some(map_stop_reason(&reason));
        let usage = chunk.usage.map(Into::into);
        out.push(StreamEvent::MessageDelta { stop_reason, usage });
        out.push(StreamEvent::MessageStop);
        state.finished = true;
    }

    out
}

fn ensure_text(state: &mut StreamState, out: &mut Vec<StreamEvent>) {
    if matches!(state.current, Some(ActiveBlock::Text(_))) {
        return;
    }
    state.close_current(out);
    let idx = state.next_idx();
    state.current = Some(ActiveBlock::Text(idx));
    out.push(StreamEvent::ContentBlockStart {
        index: idx,
        block: ContentBlockStart::Text,
    });
}

fn ensure_thinking(state: &mut StreamState, out: &mut Vec<StreamEvent>) {
    if matches!(state.current, Some(ActiveBlock::Thinking(_))) {
        return;
    }
    state.close_current(out);
    let idx = state.next_idx();
    state.current = Some(ActiveBlock::Thinking(idx));
    out.push(StreamEvent::ContentBlockStart {
        index: idx,
        block: ContentBlockStart::Thinking,
    });
}

fn map_stop_reason(s: &str) -> StopReason {
    match s {
        "stop" => StopReason::EndTurn,
        "length" => StopReason::MaxTokens,
        "tool_calls" | "function_call" => StopReason::ToolUse,
        "stop_sequence" => StopReason::StopSequence,
        other => StopReason::Other(other.to_string()),
    }
}

/// Drive a byte stream through line buffering, parse each `data: {json}`
/// payload as a [`ChatStreamChunk`], and emit canonical
/// [`StreamEvent`]s. Terminates cleanly on `data: [DONE]`.
pub fn parse_byte_stream<S>(input: S) -> BoxStream<'static, LlmResult<StreamEvent>>
where
    S: Stream<Item = LlmResult<Bytes>> + Send + 'static,
{
    let stream = async_stream::try_stream! {
        let mut buf = String::new();
        let mut state = StreamState::new();
        let mut input = std::pin::pin!(input);

        'outer: while let Some(chunk) = input.next().await {
            let chunk = chunk?;
            buf.push_str(&String::from_utf8_lossy(&chunk));

            while let Some(nl) = buf.find('\n') {
                let mut line = buf[..nl].to_string();
                buf.drain(..=nl);
                if line.ends_with('\r') {
                    line.pop();
                }

                let Some(payload) = line.strip_prefix("data:") else {
                    continue;
                };
                let payload = payload.trim_start();

                if payload == "[DONE]" {
                    // Some servers emit `[DONE]` without a preceding
                    // finish_reason chunk. Make sure callers always see a
                    // MessageStop in that case.
                    if state.started && !state.finished {
                        if state.current.is_some() {
                            state.close_current(&mut Vec::new()); // discard — we want to yield via stream
                        }
                        // We can't push from inside try_stream! after the
                        // loop ends; emit a synthesized MessageStop here.
                        yield StreamEvent::MessageStop;
                        state.finished = true;
                    }
                    break 'outer;
                }

                let parsed: ChatStreamChunk = serde_json::from_str(payload).map_err(|e| {
                    LlmError::MalformedResponse(format!(
                        "invalid SSE chunk: {e}; payload={payload}"
                    ))
                })?;
                for ev in process_chunk(parsed, &mut state) {
                    yield ev;
                }
            }
        }

        // End of stream without `[DONE]` — synthesize MessageStop if we
        // emitted MessageStart.
        if state.started && !state.finished {
            yield StreamEvent::MessageStop;
        }
    };
    Box::pin(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn from_json(v: serde_json::Value) -> ChatStreamChunk {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn first_chunk_emits_message_start() {
        let mut state = StreamState::new();
        let chunk = from_json(json!({
            "id": "chat_1",
            "model": "deepseek-chat",
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}}]
        }));
        let events = process_chunk(chunk, &mut state);
        assert!(matches!(events[0], StreamEvent::MessageStart { .. }));
    }

    #[test]
    fn text_deltas_accumulate_into_one_block() {
        let mut state = StreamState::new();
        process_chunk(
            from_json(json!({
                "id": "x",
                "choices": [{"index": 0, "delta": {"content": "Hi"}}]
            })),
            &mut state,
        );
        let events = process_chunk(
            from_json(json!({
                "id": "x",
                "choices": [{"index": 0, "delta": {"content": " there"}}]
            })),
            &mut state,
        );
        // Second chunk sees an open text block; only emits a delta.
        assert_eq!(events.len(), 1);
        match &events[0] {
            StreamEvent::ContentBlockDelta {
                index: 0,
                delta: ContentDelta::Text { text },
            } => assert_eq!(text, " there"),
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn reasoning_then_content_closes_thinking_block() {
        let mut state = StreamState::new();
        process_chunk(
            from_json(json!({
                "id": "x",
                "choices": [{"index": 0, "delta": {"reasoning_content": "let me think"}}]
            })),
            &mut state,
        );
        let events = process_chunk(
            from_json(json!({
                "id": "x",
                "choices": [{"index": 0, "delta": {"content": "answer"}}]
            })),
            &mut state,
        );
        // Should close the Thinking block and open a Text block.
        assert!(matches!(events[0], StreamEvent::ContentBlockStop { index: 0 }));
        assert!(matches!(
            events[1],
            StreamEvent::ContentBlockStart {
                index: 1,
                block: ContentBlockStart::Text
            }
        ));
    }

    #[test]
    fn tool_call_with_args_streamed_in_pieces() {
        let mut state = StreamState::new();
        // Header: id + name, no args yet.
        let evs = process_chunk(
            from_json(json!({
                "id": "x",
                "choices": [{
                    "index": 0,
                    "delta": {
                        "tool_calls": [{
                            "index": 0,
                            "id": "call_1",
                            "type": "function",
                            "function": {"name": "Read", "arguments": ""}
                        }]
                    }
                }]
            })),
            &mut state,
        );
        // Expect MessageStart + ContentBlockStart(ToolUse) — no delta because args empty.
        assert!(evs.iter().any(|e| matches!(
            e,
            StreamEvent::ContentBlockStart {
                block: ContentBlockStart::ToolUse { id, name },
                ..
            } if id == "call_1" && name == "Read"
        )));

        // Args streamed in two pieces.
        let evs = process_chunk(
            from_json(json!({
                "id": "x",
                "choices": [{
                    "index": 0,
                    "delta": {
                        "tool_calls": [{"index": 0, "function": {"arguments": "{\"path\":"}}]
                    }
                }]
            })),
            &mut state,
        );
        assert_eq!(evs.len(), 1);
        assert!(matches!(
            &evs[0],
            StreamEvent::ContentBlockDelta {
                delta: ContentDelta::ToolInputJson { partial_json },
                ..
            } if partial_json == "{\"path\":"
        ));

        let evs = process_chunk(
            from_json(json!({
                "id": "x",
                "choices": [{
                    "index": 0,
                    "delta": {
                        "tool_calls": [{"index": 0, "function": {"arguments": "\"a\"}"}}]
                    }
                }]
            })),
            &mut state,
        );
        assert!(matches!(
            &evs[0],
            StreamEvent::ContentBlockDelta {
                delta: ContentDelta::ToolInputJson { partial_json },
                ..
            } if partial_json == "\"a\"}"
        ));
    }

    #[test]
    fn finish_reason_emits_message_delta_and_stop() {
        let mut state = StreamState::new();
        process_chunk(
            from_json(json!({
                "id": "x",
                "choices": [{"index": 0, "delta": {"content": "hi"}}]
            })),
            &mut state,
        );
        let evs = process_chunk(
            from_json(json!({
                "id": "x",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 1, "total_tokens": 6}
            })),
            &mut state,
        );
        // Expect: ContentBlockStop + MessageDelta + MessageStop
        assert_eq!(evs.len(), 3);
        assert!(matches!(evs[0], StreamEvent::ContentBlockStop { .. }));
        match &evs[1] {
            StreamEvent::MessageDelta { stop_reason, usage } => {
                assert_eq!(*stop_reason, Some(StopReason::EndTurn));
                let u = usage.as_ref().unwrap();
                assert_eq!(u.input_tokens, 5);
            }
            other => panic!("got {other:?}"),
        }
        assert!(matches!(evs[2], StreamEvent::MessageStop));
        assert!(state.finished);
    }

    fn collect_events(bytes: &[u8]) -> Vec<StreamEvent> {
        use futures::executor::block_on;
        use futures::stream;
        let owned: Vec<u8> = bytes.to_vec();
        let s = stream::once(async move { Ok::<_, LlmError>(Bytes::from(owned)) });
        block_on(async {
            parse_byte_stream(s)
                .filter_map(|r| async { r.ok() })
                .collect::<Vec<_>>()
                .await
        })
    }

    #[test]
    fn end_to_end_byte_stream_terminated_by_done() {
        let raw = b"\
data: {\"id\":\"x\",\"model\":\"deepseek-chat\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}\n\
\n\
data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hi\"}}]}\n\
\n\
data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" there\"}}]}\n\
\n\
data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2,\"total_tokens\":7}}\n\
\n\
data: [DONE]\n\
\n";
        let events = collect_events(raw);
        // start, block_start(text), delta("Hi"), delta(" there"), block_stop, message_delta, stop
        assert_eq!(events.len(), 7, "got {events:#?}");
        assert!(matches!(events[0], StreamEvent::MessageStart { .. }));
        assert!(matches!(
            events[1],
            StreamEvent::ContentBlockStart {
                block: ContentBlockStart::Text,
                ..
            }
        ));
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
    fn split_chunk_mid_data_line_resumes_correctly() {
        use futures::executor::block_on;
        use futures::stream;

        let part_a =
            b"data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"content";
        let part_b = b"\":\"Hi\"}}]}\n\ndata: [DONE]\n\n";
        let s = stream::iter(vec![
            Ok::<_, LlmError>(Bytes::from(part_a.to_vec())),
            Ok(Bytes::from(part_b.to_vec())),
        ]);
        let events: Vec<StreamEvent> = block_on(async {
            parse_byte_stream(s)
                .filter_map(|r| async { r.ok() })
                .collect()
                .await
        });
        assert!(matches!(events[0], StreamEvent::MessageStart { .. }));
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
        assert_eq!(text, "Hi");
        // [DONE] forced a synthetic MessageStop.
        assert!(matches!(events.last(), Some(StreamEvent::MessageStop)));
    }
}
