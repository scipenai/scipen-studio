//! `EditorTurnListener` — bridges `snaca-engine`'s per-turn LLM event
//! stream into editor-protocol `turn.delta` events on the host outbound.
//!
//! Engine's `TurnEventListener` sees the raw `snaca_llm::StreamEvent`
//! flow during a turn:
//!   - `ContentBlockDelta(Text{...})` → host renders streaming text
//!   - `ContentBlockDelta(Thinking{...})` → host renders folded thinking
//!   - `ContentBlockStart(ToolUse) → ContentBlockDelta(ToolInputJson) →
//!     ContentBlockStop` → host renders one tool-call card per block
//!
//! The editor protocol is coarser: a single `turn.delta` with
//! `kind=tool_use { tool_call_id, tool, args }`. We accumulate the
//! `ToolInputJson` fragments per block index, then emit one ToolUse
//! event when the block closes.
//!
//! `seq` is monotonic within a turn; it's shared with the Done /
//! Error tail event emitted by `run_engine_turn` after the listener
//! returns control, so the host can preserve total order on the wire.

use crate::outbound::OutboundWriter;
use async_trait::async_trait;
use snaca_editor_protocol::messages::turn::{TurnDeltaKind, TurnDeltaParams};
use snaca_engine::TurnEventListener;
use snaca_llm::{ContentBlockStart, ContentDelta, StreamEvent};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub struct EditorTurnListener {
    outbound: Arc<OutboundWriter>,
    turn_id: String,
    /// Shared with the run_engine_turn tail emitter so Done's `seq`
    /// continues from the last delta's value.
    seq: Arc<AtomicU64>,
    /// block_index -> (tool_call_id, tool_name, accumulated_args_json).
    /// Mutex is acquired briefly per event so the engine's stream loop
    /// isn't blocked across awaits.
    tool_blocks: Mutex<HashMap<u32, ToolBlock>>,
}

struct ToolBlock {
    id: String,
    name: String,
    args_buf: String,
}

impl EditorTurnListener {
    pub fn new(outbound: Arc<OutboundWriter>, turn_id: String, seq: Arc<AtomicU64>) -> Self {
        Self {
            outbound,
            turn_id,
            seq,
            tool_blocks: Mutex::new(HashMap::new()),
        }
    }

    async fn emit(&self, kind: TurnDeltaKind) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        let _ = self
            .outbound
            .emit_turn_delta(TurnDeltaParams {
                turn_id: self.turn_id.clone(),
                seq,
                kind,
            })
            .await;
    }
}

#[async_trait]
impl TurnEventListener for EditorTurnListener {
    async fn on_event(&self, event: &StreamEvent) {
        match event {
            StreamEvent::ContentBlockStart {
                index,
                block: ContentBlockStart::ToolUse { id, name },
            } => {
                let mut blocks = self.tool_blocks.lock().unwrap();
                blocks.insert(
                    *index,
                    ToolBlock {
                        id: id.clone(),
                        name: name.clone(),
                        args_buf: String::new(),
                    },
                );
            }
            StreamEvent::ContentBlockDelta {
                delta: ContentDelta::Text { text },
                ..
            } => {
                self.emit(TurnDeltaKind::Text { text: text.clone() }).await;
            }
            StreamEvent::ContentBlockDelta {
                delta: ContentDelta::Thinking { text },
                ..
            } => {
                self.emit(TurnDeltaKind::Thinking { text: text.clone() })
                    .await;
            }
            StreamEvent::ContentBlockDelta {
                index,
                delta: ContentDelta::ToolInputJson { partial_json },
            } => {
                let mut blocks = self.tool_blocks.lock().unwrap();
                if let Some(b) = blocks.get_mut(index) {
                    b.args_buf.push_str(partial_json);
                }
            }
            StreamEvent::ContentBlockStop { index } => {
                // Take the block out of the map so a second Stop on the
                // same index (shouldn't happen but stays cheap) doesn't
                // double-emit.
                let block = {
                    let mut blocks = self.tool_blocks.lock().unwrap();
                    blocks.remove(index)
                };
                if let Some(b) = block {
                    let args: serde_json::Value = if b.args_buf.trim().is_empty() {
                        serde_json::Value::Object(Default::default())
                    } else {
                        serde_json::from_str(&b.args_buf)
                            .unwrap_or_else(|_| serde_json::Value::String(b.args_buf.clone()))
                    };
                    self.emit(TurnDeltaKind::ToolUse {
                        tool_call_id: b.id,
                        tool: b.name,
                        args,
                    })
                    .await;
                }
            }
            _ => {
                // MessageStart / MessageDelta / MessageStop / Error are
                // handled by run_engine_turn from the TurnOutcome / error
                // path so the protocol-level `done` ordering stays after
                // any final text/tool deltas.
            }
        }
    }
}
