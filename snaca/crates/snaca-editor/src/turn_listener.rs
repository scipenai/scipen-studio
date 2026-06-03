//! Bridges engine `StreamEvent` → editor-protocol `turn.delta`. Tool
//! blocks emit a single `tool_use` delta on `ContentBlockStop` after
//! accumulating `ToolInputJson` fragments.

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
    /// Shared with run_engine_turn so the Done event keeps seq monotonic.
    seq: Arc<AtomicU64>,
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
                let block = self.tool_blocks.lock().unwrap().remove(index);
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
            // MessageStart/Delta/Stop/Error are emitted by run_engine_turn
            // after the listener returns to preserve total order.
            _ => {}
        }
    }
}
