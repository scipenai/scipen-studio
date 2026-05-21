//! Correlates outbound `context.request` IDs with incoming `context.respond`.
//!
//! Why a separate module: the dispatcher only handles host → SNACA
//! requests / notifications. The lone reverse direction
//! (SNACA → host `context.request` → host → SNACA `context.respond`) is
//! a JSON-RPC `Response` whose `id` matches the request we sent. Those
//! frames never go through `Dispatcher::process_line` (it ignores
//! `Response`s by design); we intercept them in `main.rs` and route here.
//!
//! State shape: one shared `HashMap<id, oneshot::Sender<...>>`. Sender
//! is taken on receipt and the receiver future resolves with the parsed
//! `ContextRespondParams`. Senders that never get hit (because the host
//! went silent) drop when the registering task aborts — a manual
//! `unregister` is exposed so timed-out callers can clean up too.
//!
//! Multi-correlator instances are explicitly NOT supported. The
//! singleton lives next to the OutboundWriter and is shared via Arc.

use snaca_editor_protocol::jsonrpc::{JsonRpcRequestId, JsonRpcResponse};
use snaca_editor_protocol::messages::context_req::ContextRespondParams;
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::oneshot;

#[derive(Debug, Default)]
pub struct ContextCorrelator {
    pending: Mutex<HashMap<String, oneshot::Sender<ContextRespondParams>>>,
}

impl ContextCorrelator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a pending request. Caller awaits the returned receiver
    /// until the host replies or a timeout fires.
    ///
    /// If the same `id` is registered twice (shouldn't happen — IDs
    /// come from `OutboundWriter::fresh_request_id`) the old sender is
    /// dropped, which wakes the previous awaiter with `RecvError`.
    pub fn register(&self, id: &JsonRpcRequestId) -> oneshot::Receiver<ContextRespondParams> {
        let (tx, rx) = oneshot::channel();
        let key = id_to_string(id);
        if let Ok(mut map) = self.pending.lock() {
            map.insert(key, tx);
        }
        rx
    }

    /// Cancel a previously-registered request, dropping the sender so
    /// the awaiter sees `RecvError`. Idempotent.
    pub fn unregister(&self, id: &JsonRpcRequestId) {
        let key = id_to_string(id);
        if let Ok(mut map) = self.pending.lock() {
            map.remove(&key);
        }
    }

    /// Try to fulfill a pending request from a host-sent JSON-RPC
    /// `Response`. Returns `true` if it matched a known id (caller can
    /// short-circuit further routing); `false` if the id is unknown
    /// (stale response, or never registered — caller should log).
    pub fn complete(&self, resp: &JsonRpcResponse) -> bool {
        let key = id_to_string(&resp.id);
        let Some(sender) = self.pending.lock().ok().and_then(|mut m| m.remove(&key)) else {
            return false;
        };

        // Translate JSON-RPC Response into ContextRespondParams. Host
        // always returns the params shape under `result`; an
        // `error`-shaped response means SNACA's outbound request was
        // malformed (very unlikely in practice — we control both ends).
        let params = match resp.result.as_ref() {
            Some(value) => match serde_json::from_value::<ContextRespondParams>(value.clone()) {
                Ok(p) => p,
                Err(err) => {
                    // Synthesize an ok=false reply so the awaiter sees
                    // a useful error instead of channel-closed.
                    ContextRespondParams {
                        request_id: key.clone(),
                        ok: false,
                        payload: None,
                        error: Some(format!("malformed context.respond payload: {err}")),
                    }
                }
            },
            None => ContextRespondParams {
                request_id: key.clone(),
                ok: false,
                payload: None,
                error: resp
                    .error
                    .as_ref()
                    .map(|e| e.message.clone())
                    .or_else(|| Some("empty context.respond".into())),
            },
        };
        // Sender::send only fails if the receiver was dropped — that's
        // a legitimate state (caller timed out), nothing to do.
        let _ = sender.send(params);
        true
    }

    /// Count pending requests — useful for tests and shutdown checks.
    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        self.pending.lock().map(|m| m.len()).unwrap_or(0)
    }
}

fn id_to_string(id: &JsonRpcRequestId) -> String {
    match id {
        JsonRpcRequestId::String(s) => s.clone(),
        JsonRpcRequestId::Number(n) => n.to_string(),
        JsonRpcRequestId::Null => "null".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use snaca_editor_protocol::jsonrpc::JsonRpcResponse;

    fn make_resp(id: &str, payload_kind: &str) -> JsonRpcResponse {
        JsonRpcResponse::ok(
            JsonRpcRequestId::String(id.into()),
            json!({
                "request_id": id,
                "ok": true,
                "payload": {
                    "kind": payload_kind,
                    "results": []
                }
            }),
        )
    }

    #[tokio::test]
    async fn register_then_complete_resolves_receiver() {
        let c = ContextCorrelator::new();
        let id = JsonRpcRequestId::String("r1".into());
        let rx = c.register(&id);
        assert_eq!(c.pending_count(), 1);

        let resp = make_resp("r1", "zotero_search");
        assert!(c.complete(&resp));
        assert_eq!(c.pending_count(), 0);

        let params = rx.await.expect("sender dropped");
        assert!(params.ok);
        assert_eq!(params.request_id, "r1");
    }

    #[tokio::test]
    async fn complete_unknown_id_returns_false() {
        let c = ContextCorrelator::new();
        let resp = make_resp("does-not-exist", "zotero_search");
        assert!(!c.complete(&resp));
    }

    #[tokio::test]
    async fn unregister_drops_sender() {
        let c = ContextCorrelator::new();
        let id = JsonRpcRequestId::String("r2".into());
        let rx = c.register(&id);
        c.unregister(&id);

        // Awaiter sees channel closed.
        assert!(rx.await.is_err());
    }

    #[tokio::test]
    async fn malformed_payload_synthesizes_err_response() {
        let c = ContextCorrelator::new();
        let id = JsonRpcRequestId::String("r3".into());
        let rx = c.register(&id);

        // Result has wrong shape — missing `ok` field.
        let resp = JsonRpcResponse::ok(
            JsonRpcRequestId::String("r3".into()),
            json!({ "nonsense": true }),
        );
        assert!(c.complete(&resp));

        let params = rx.await.unwrap();
        assert!(!params.ok);
        assert!(params.error.as_deref().unwrap_or("").contains("malformed"));
    }
}
