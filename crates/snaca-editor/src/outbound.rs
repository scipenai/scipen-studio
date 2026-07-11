//! Thread-safe stdout writer.
//!
//! Stdout carries JSON-RPC frames (one per line); stderr carries logs.
//! Multiple async tasks may emit concurrently (e.g. several streamed
//! `turn.delta` events from one in-flight turn while a sibling `chat.send`
//! response is also racing back). The internal `Mutex` serializes writes
//! at the byte boundary so frames never interleave.
//!
//! Most `emit_*` helpers below are scaffolding for the next phases —
//! handler.rs only uses `emit_turn_delta` and `emit_usage_update` in P0.
//! The rest stay as part of the documented surface so call sites in the
//! next phase don't have to add new methods.

#![allow(dead_code)]

use crate::context_correlator::ContextCorrelator;
use serde::Serialize;
use snaca_editor_protocol::codec;
use snaca_editor_protocol::jsonrpc::{JsonRpcNotification, JsonRpcRequest, JsonRpcRequestId};
use snaca_editor_protocol::messages::snaca_to_host as p;
use snaca_editor_protocol::messages::{
    context_req::{ContextPayload, ContextRequestParams, ContextRequestPayload},
    edit::*,
    error_notif::ErrorNotificationParams,
    log::LogWriteParams,
    memory::MemoryUpdatedParams,
    plan::PlanUpdateParams,
    tool::ToolApprovalRequestParams,
    turn::TurnDeltaParams,
    usage::UsageUpdateParams,
};
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncWriteExt, Stdout};
use tokio::sync::Mutex;

/// Per-call budget for one `context.request` round-trip. Mirrors the
/// host's `Agent_ContextZoteroRequest` 5s parking timeout so neither
/// side parks longer than the other.
pub const CONTEXT_REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// AskUserQuestion waits on a *human*, not a fast host lookup, so it
/// gets a far longer budget than [`CONTEXT_REQUEST_TIMEOUT`]. The tool
/// also races this against the turn's cancellation token, so an
/// abandoned card is reclaimed promptly on turn abort regardless.
pub const QUESTION_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, thiserror::Error)]
pub enum ContextCallError {
    #[error("context.request timed out after {0:?}")]
    Timeout(Duration),
    #[error("host returned ok=false: {0}")]
    HostError(String),
    #[error("io error writing context.request: {0}")]
    Io(#[from] io::Error),
    #[error("correlator channel closed without response")]
    Closed,
}

pub struct OutboundWriter {
    stdout: Mutex<Stdout>,
    /// Monotonic counter for SNACA → host **requests** (only used for
    /// `context.request`, which is the lone reverse-RPC method).
    next_request_id: AtomicU64,
    /// Awaits responses for outstanding `context.request` calls. Wired
    /// from `main.rs` which pre-decodes Response frames and routes them
    /// here.
    correlator: Arc<ContextCorrelator>,
}

impl OutboundWriter {
    pub fn new(stdout: Stdout) -> Self {
        Self {
            stdout: Mutex::new(stdout),
            next_request_id: AtomicU64::new(1),
            correlator: Arc::new(ContextCorrelator::new()),
        }
    }

    /// Borrow the correlator so the binary's reader loop can route
    /// inbound `Response` frames into it.
    pub fn correlator(&self) -> Arc<ContextCorrelator> {
        self.correlator.clone()
    }

    /// Allocate a fresh JSON-RPC id for SNACA-originated requests.
    /// Crate-private so the id allocation only happens inside
    /// [`call_context`]; that's the one place we can guarantee the id
    /// gets registered with the correlator before the request leaves.
    fn fresh_request_id(&self) -> JsonRpcRequestId {
        let n = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        JsonRpcRequestId::String(format!("snaca-req-{n}"))
    }

    /// Write an already-serialized frame (used for dispatcher responses).
    pub async fn write_raw(&self, bytes: &[u8]) -> io::Result<()> {
        let mut guard = self.stdout.lock().await;
        guard.write_all(bytes).await?;
        guard.flush().await
    }

    /// Encode + write any serializable value as one NDJSON line.
    pub async fn write_value<T: Serialize>(&self, value: &T) -> io::Result<()> {
        let bytes = codec::encode(value).map_err(|e| io::Error::other(e.to_string()))?;
        self.write_raw(&bytes).await
    }

    /// Emit a typed notification (SNACA → host, no id).
    pub async fn emit_notification<P: Serialize>(
        &self,
        method: &str,
        params: P,
    ) -> io::Result<()> {
        let params_val = serde_json::to_value(params).map_err(io::Error::other)?;
        let notif = JsonRpcNotification::new(method, Some(params_val));
        self.write_value(&notif).await
    }

    /// Write one JSON-RPC Request with a caller-supplied id. Crate-
    /// private: any reverse-RPC must go through [`call_context`] so id
    /// allocation and correlator registration stay atomic.
    async fn write_request<P: Serialize>(
        &self,
        id: JsonRpcRequestId,
        method: &str,
        params: P,
    ) -> io::Result<()> {
        let params_val = serde_json::to_value(params).map_err(io::Error::other)?;
        let req = JsonRpcRequest::new(id, method, Some(params_val));
        self.write_value(&req).await
    }

    // ---------------- Typed convenience emitters ----------------
    //
    // These wrap the common `turn.delta`, `edit.propose`, etc. patterns so
    // call sites in `handler.rs` stay readable.

    pub async fn emit_turn_delta(&self, params: TurnDeltaParams) -> io::Result<()> {
        self.emit_notification(p::TURN_DELTA, params).await
    }

    pub async fn emit_edit_propose(&self, params: EditProposeParams) -> io::Result<()> {
        self.emit_notification(p::EDIT_PROPOSE, params).await
    }

    pub async fn emit_edit_propose_delta(
        &self,
        params: EditProposeDeltaParams,
    ) -> io::Result<()> {
        self.emit_notification(p::EDIT_PROPOSE_DELTA, params).await
    }

    pub async fn emit_edit_propose_complete(
        &self,
        params: EditProposeCompleteParams,
    ) -> io::Result<()> {
        self.emit_notification(p::EDIT_PROPOSE_COMPLETE, params)
            .await
    }

    pub async fn emit_plan_update(&self, params: PlanUpdateParams) -> io::Result<()> {
        self.emit_notification(p::PLAN_UPDATE, params).await
    }

    pub async fn emit_tool_approval_request(
        &self,
        params: ToolApprovalRequestParams,
    ) -> io::Result<()> {
        self.emit_notification(p::TOOL_APPROVAL_REQUEST, params)
            .await
    }

    pub async fn emit_usage_update(&self, params: UsageUpdateParams) -> io::Result<()> {
        self.emit_notification(p::USAGE_UPDATE, params).await
    }

    pub async fn emit_memory_updated(&self, params: MemoryUpdatedParams) -> io::Result<()> {
        self.emit_notification(p::MEMORY_UPDATED, params).await
    }

    pub async fn emit_error(&self, params: ErrorNotificationParams) -> io::Result<()> {
        self.emit_notification(p::ERROR, params).await
    }

    pub async fn emit_log(&self, params: LogWriteParams) -> io::Result<()> {
        self.emit_notification(p::LOG_WRITE, params).await
    }

    /// Round-trip helper: emit `context.request`, await the matching
    /// `context.respond`, return the host's payload. Only supported way
    /// to make a reverse-RPC — guarantees the wire id equals the
    /// correlator key (split ids previously caused 5 s timeouts).
    pub async fn call_context(
        &self,
        turn_id: impl Into<String>,
        payload: ContextRequestPayload,
    ) -> Result<ContextPayload, ContextCallError> {
        self.call_with_timeout(turn_id, payload, CONTEXT_REQUEST_TIMEOUT)
            .await
    }

    /// Like [`call_context`] but with the long [`QUESTION_TIMEOUT`] —
    /// used by the AskUserQuestion gate, which waits on a human answer
    /// rather than a fast host lookup.
    pub async fn call_question(
        &self,
        turn_id: impl Into<String>,
        payload: ContextRequestPayload,
    ) -> Result<ContextPayload, ContextCallError> {
        self.call_with_timeout(turn_id, payload, QUESTION_TIMEOUT)
            .await
    }

    async fn call_with_timeout(
        &self,
        turn_id: impl Into<String>,
        payload: ContextRequestPayload,
        timeout: Duration,
    ) -> Result<ContextPayload, ContextCallError> {
        let request_id = self.fresh_request_id();
        let request_id_str = crate::context_correlator::id_to_string(&request_id);

        // Register *before* writing — otherwise an extremely fast host
        // could land a Response before we register and we'd miss it.
        let rx = self.correlator.register(&request_id);

        let params = ContextRequestParams {
            request_id: request_id_str,
            turn_id: turn_id.into(),
            req: payload,
        };
        if let Err(io_err) = self
            .write_request(request_id.clone(), p::CONTEXT_REQUEST, params)
            .await
        {
            // Clean up the pending entry so the slot doesn't leak.
            self.correlator.unregister(&request_id);
            return Err(ContextCallError::Io(io_err));
        }

        let respond = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => return Err(ContextCallError::Closed),
            Err(_) => {
                self.correlator.unregister(&request_id);
                return Err(ContextCallError::Timeout(timeout));
            }
        };

        if !respond.ok {
            return Err(ContextCallError::HostError(
                respond.error.unwrap_or_else(|| "unspecified".into()),
            ));
        }
        respond
            .payload
            .ok_or_else(|| ContextCallError::HostError("ok=true with no payload".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context_correlator::id_to_string;
    use snaca_editor_protocol::jsonrpc::JsonRpcResponse;
    use snaca_editor_protocol::messages::context_req::{
        ContextPayload, ContextRequestPayload, ZoteroSearchParams,
    };

    /// Regression: the wire JSON-RPC `id` must equal the correlator
    /// key. A prior split (one id for register, another for emit) made
    /// every reverse-RPC time out because the response id never matched
    /// any pending entry.
    #[tokio::test]
    async fn call_context_id_matches_correlator_key() {
        let outbound = std::sync::Arc::new(OutboundWriter::new(tokio::io::stdout()));
        let correlator = outbound.correlator();
        let predicted_id_str = "snaca-req-1";

        let outbound_task = outbound.clone();
        let handle = tokio::spawn(async move {
            outbound_task
                .call_context(
                    "turn-1",
                    ContextRequestPayload::ZoteroSearch {
                        params: ZoteroSearchParams {
                            query: "x".into(),
                            limit: None,
                        },
                    },
                )
                .await
        });

        // Let call_context register before we feed the response.
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;

        let resp = JsonRpcResponse::ok(
            JsonRpcRequestId::String(predicted_id_str.into()),
            serde_json::json!({
                "request_id": predicted_id_str,
                "ok": true,
                "payload": { "kind": "zotero_search", "results": [] }
            }),
        );
        assert!(
            correlator.complete(&resp),
            "wire id drifted from correlator key — call_context allocated \
             a fresh id during write instead of reusing the registered one"
        );

        let payload = handle.await.expect("task panicked").expect("call_context errored");
        match payload {
            ContextPayload::ZoteroSearch { results } => assert!(results.is_empty()),
            other => panic!("unexpected payload kind: {other:?}"),
        }
    }

    /// Id format guard — keep `fresh_request_id` and `id_to_string` in
    /// lockstep so host-side response routing keeps working.
    #[test]
    fn fresh_id_serializes_to_correlator_key() {
        let ob = OutboundWriter::new(tokio::io::stdout());
        let id = ob.fresh_request_id();
        assert!(id_to_string(&id).starts_with("snaca-req-"));
    }
}
