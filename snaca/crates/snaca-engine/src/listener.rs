//! Per-turn event listener — the seam where IM channels (or anyone else)
//! plug in to receive each [`StreamEvent`] as the model produces it.
//!
//! Engine flow:
//! ```text
//! handle_turn_full(req, gate, listener)
//!   ↓
//! create_message_stream → for each event:
//!     listener.on_event(&event)   ← typing indicator forwarder hooks here
//!     accumulator.ingest(event)
//!   ↓
//! accumulator.finalize() → MessageResponse
//! ```
//!
//! The listener observes events but does NOT mutate the stream — the
//! engine still owns reassembly. Production listeners are typically
//! bound to a specific `(plugin, chat_id)` so each turn renders typing
//! deltas to the IM the user sent the request from.

use async_trait::async_trait;
use snaca_llm::StreamEvent;
use std::sync::Mutex;

#[async_trait]
pub trait TurnEventListener: Send + Sync {
    async fn on_event(&self, event: &StreamEvent);
}

/// Default listener — observes nothing. Used by `handle_turn_with_gate`
/// and tests that don't care about deltas.
pub struct NoopListener;

#[async_trait]
impl TurnEventListener for NoopListener {
    async fn on_event(&self, _event: &StreamEvent) {}
}

/// Records every event for assertion in tests. The internal mutex makes
/// it safe across concurrent listener invocations from a single turn
/// (the engine doesn't currently parallelize, but listeners may forward
/// to async sinks and we want to keep ordering observable).
pub struct RecordingListener {
    events: Mutex<Vec<StreamEvent>>,
}

impl RecordingListener {
    pub fn new() -> Self {
        Self {
            events: Mutex::new(Vec::new()),
        }
    }

    pub fn snapshot(&self) -> Vec<StreamEvent> {
        self.events.lock().unwrap().clone()
    }
}

impl Default for RecordingListener {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl TurnEventListener for RecordingListener {
    async fn on_event(&self, event: &StreamEvent) {
        self.events.lock().unwrap().push(event.clone());
    }
}
