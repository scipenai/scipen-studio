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

use serde::Serialize;
use snaca_editor_protocol::codec;
use snaca_editor_protocol::jsonrpc::{JsonRpcNotification, JsonRpcRequest, JsonRpcRequestId};
use snaca_editor_protocol::messages::snaca_to_host as p;
use snaca_editor_protocol::messages::{
    context_req::ContextRequestParams, edit::*, error_notif::ErrorNotificationParams,
    log::LogWriteParams, memory::MemoryUpdatedParams, plan::PlanUpdateParams,
    tool::ToolApprovalRequestParams, turn::TurnDeltaParams, usage::UsageUpdateParams,
};
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncWriteExt, Stdout};
use tokio::sync::Mutex;

pub struct OutboundWriter {
    stdout: Mutex<Stdout>,
    /// Monotonic counter for SNACA → host **requests** (only used for
    /// `context.request`, which is the lone reverse-RPC method).
    next_request_id: AtomicU64,
}

impl OutboundWriter {
    pub fn new(stdout: Stdout) -> Self {
        Self {
            stdout: Mutex::new(stdout),
            next_request_id: AtomicU64::new(1),
        }
    }

    /// Allocate a fresh JSON-RPC id for SNACA-originated requests (used
    /// by the binary's reverse-RPC correlator when implementing
    /// `context.request`). The string form matches what hosts will echo
    /// back in their `context.respond.request_id`.
    pub fn fresh_request_id(&self) -> JsonRpcRequestId {
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

    /// Emit a SNACA-originated request (currently only `context.request`).
    pub async fn emit_request<P: Serialize>(
        &self,
        method: &str,
        params: P,
    ) -> io::Result<JsonRpcRequestId> {
        let params_val = serde_json::to_value(params).map_err(io::Error::other)?;
        let id = self.fresh_request_id();
        let req = JsonRpcRequest::new(id.clone(), method, Some(params_val));
        self.write_value(&req).await?;
        Ok(id)
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

    /// Initiates a `context.request` reverse-RPC. Returns the allocated
    /// request id; caller should await a matching `context.respond` via
    /// its correlator (not implemented in P0 — placeholder for next phase).
    pub async fn emit_context_request(
        &self,
        params: ContextRequestParams,
    ) -> io::Result<JsonRpcRequestId> {
        self.emit_request(p::CONTEXT_REQUEST, params).await
    }
}
