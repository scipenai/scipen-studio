//! Method enum, [`MessageHandler`] trait, and [`Dispatcher`].
//!
//! `Dispatcher::process_line` is the single entry point a stdio reader
//! calls per inbound line. It parses NDJSON, validates JSON-RPC shape,
//! resolves the method, deserializes params, calls the trait method, and
//! serializes a response (for requests) or returns `None` (for notifications).
//!
//! Notifications never produce output. Requests with unknown methods
//! produce `-32601 method_not_found`. Malformed input produces
//! `-32700 parse_error` or `-32600 invalid_request` with `id: null`.

use crate::codec;
use crate::error::{ErrorCode, ProtocolError};
use crate::jsonrpc::{
    JsonRpcError, JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcRequestId,
    JsonRpcResponse,
};
use crate::messages::{
    chat::*, composer::*, context_req::*, edit::*, init::*, inline_edit::*, memory::*,
    session::*, skills::*, tool::*, turn::*,
};
use async_trait::async_trait;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;

/// Strongly-typed method enum. Useful for routing & logging.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    // host → SNACA
    Init,
    Shutdown,
    HealthPing,
    ConfigReload,
    SessionOpen,
    SessionClose,
    SessionListThreads,
    SessionNewThread,
    SessionSwitchThread,
    SessionDeleteThread,
    SessionRenameThread,
    SessionGetMessages,
    ChatSend,
    InlineEditStart,
    ComposerStart,
    PlanConfirm,
    TurnCancel,
    EditConfirm,
    ToolConfirm,
    ContextRespond,
    MemoryList,
    MemoryGet,
    MemoryWrite,
    MemoryDelete,
    MemoryReveal,
    SkillsList,
    SkillsGet,
    SkillsReload,
    // SNACA → host (for handler symmetry; rarely needed by Dispatcher)
    TurnDelta,
    EditPropose,
    EditProposeDelta,
    EditProposeComplete,
    PlanUpdate,
    ContextRequest,
    ToolApprovalRequest,
    UsageUpdate,
    MemoryUpdated,
    Error,
    LogWrite,
}

impl Method {
    pub fn from_str(s: &str) -> Option<Self> {
        use crate::messages::{host_to_snaca as h, snaca_to_host as p};
        Some(match s {
            // host → SNACA
            x if x == h::INIT => Method::Init,
            x if x == h::SHUTDOWN => Method::Shutdown,
            x if x == h::HEALTH_PING => Method::HealthPing,
            x if x == h::CONFIG_RELOAD => Method::ConfigReload,
            x if x == h::SESSION_OPEN => Method::SessionOpen,
            x if x == h::SESSION_CLOSE => Method::SessionClose,
            x if x == h::SESSION_LIST_THREADS => Method::SessionListThreads,
            x if x == h::SESSION_NEW_THREAD => Method::SessionNewThread,
            x if x == h::SESSION_SWITCH_THREAD => Method::SessionSwitchThread,
            x if x == h::SESSION_DELETE_THREAD => Method::SessionDeleteThread,
            x if x == h::SESSION_RENAME_THREAD => Method::SessionRenameThread,
            x if x == h::SESSION_GET_MESSAGES => Method::SessionGetMessages,
            x if x == h::CHAT_SEND => Method::ChatSend,
            x if x == h::INLINE_EDIT_START => Method::InlineEditStart,
            x if x == h::COMPOSER_START => Method::ComposerStart,
            x if x == h::PLAN_CONFIRM => Method::PlanConfirm,
            x if x == h::TURN_CANCEL => Method::TurnCancel,
            x if x == h::EDIT_CONFIRM => Method::EditConfirm,
            x if x == h::TOOL_CONFIRM => Method::ToolConfirm,
            x if x == h::CONTEXT_RESPOND => Method::ContextRespond,
            x if x == h::MEMORY_LIST => Method::MemoryList,
            x if x == h::MEMORY_GET => Method::MemoryGet,
            x if x == h::MEMORY_WRITE => Method::MemoryWrite,
            x if x == h::MEMORY_DELETE => Method::MemoryDelete,
            x if x == h::MEMORY_REVEAL => Method::MemoryReveal,
            x if x == h::SKILLS_LIST => Method::SkillsList,
            x if x == h::SKILLS_GET => Method::SkillsGet,
            x if x == h::SKILLS_RELOAD => Method::SkillsReload,
            // SNACA → host
            x if x == p::TURN_DELTA => Method::TurnDelta,
            x if x == p::EDIT_PROPOSE => Method::EditPropose,
            x if x == p::EDIT_PROPOSE_DELTA => Method::EditProposeDelta,
            x if x == p::EDIT_PROPOSE_COMPLETE => Method::EditProposeComplete,
            x if x == p::PLAN_UPDATE => Method::PlanUpdate,
            x if x == p::CONTEXT_REQUEST => Method::ContextRequest,
            x if x == p::TOOL_APPROVAL_REQUEST => Method::ToolApprovalRequest,
            x if x == p::USAGE_UPDATE => Method::UsageUpdate,
            x if x == p::MEMORY_UPDATED => Method::MemoryUpdated,
            x if x == p::ERROR => Method::Error,
            x if x == p::LOG_WRITE => Method::LogWrite,
            _ => return None,
        })
    }
}

/// Trait the SNACA side implements. Only host → SNACA methods are
/// represented; SNACA → host events are emitted via a separate outbound
/// writer in the binary, not through this trait.
///
/// All methods are async. Notifications return `()`; requests return
/// typed results or `ProtocolError`. Default implementations return
/// `MethodNotFound` so a partial implementation compiles cleanly while
/// development is in progress.
#[async_trait]
pub trait MessageHandler: Send + Sync {
    // ---------------- Lifecycle ----------------

    async fn handle_init(&self, _params: InitParams) -> Result<InitResult, ProtocolError> {
        Err(ProtocolError::method_not_found("init"))
    }

    async fn handle_shutdown(
        &self,
        _params: ShutdownParams,
    ) -> Result<ShutdownResult, ProtocolError> {
        Err(ProtocolError::method_not_found("shutdown"))
    }

    async fn handle_health_ping(
        &self,
        _params: HealthPingParams,
    ) -> Result<HealthPingResult, ProtocolError> {
        Err(ProtocolError::method_not_found("health.ping"))
    }

    async fn handle_config_reload(
        &self,
        _params: ConfigReloadParams,
    ) -> Result<ConfigReloadResult, ProtocolError> {
        Err(ProtocolError::method_not_found("config.reload"))
    }

    // ---------------- Session ----------------

    async fn handle_session_open(
        &self,
        _params: SessionOpenParams,
    ) -> Result<SessionOpenResult, ProtocolError> {
        Err(ProtocolError::method_not_found("session.open"))
    }

    async fn handle_session_close(
        &self,
        _params: SessionCloseParams,
    ) -> Result<SessionCloseResult, ProtocolError> {
        Err(ProtocolError::method_not_found("session.close"))
    }

    async fn handle_session_list_threads(
        &self,
        _params: SessionListThreadsParams,
    ) -> Result<SessionListThreadsResult, ProtocolError> {
        Err(ProtocolError::method_not_found("session.list_threads"))
    }

    async fn handle_session_new_thread(
        &self,
        _params: SessionNewThreadParams,
    ) -> Result<SessionNewThreadResult, ProtocolError> {
        Err(ProtocolError::method_not_found("session.new_thread"))
    }

    async fn handle_session_switch_thread(
        &self,
        _params: SessionSwitchThreadParams,
    ) -> Result<SessionSwitchThreadResult, ProtocolError> {
        Err(ProtocolError::method_not_found("session.switch_thread"))
    }

    async fn handle_session_delete_thread(
        &self,
        _params: SessionDeleteThreadParams,
    ) -> Result<SessionDeleteThreadResult, ProtocolError> {
        Err(ProtocolError::method_not_found("session.delete_thread"))
    }

    async fn handle_session_rename_thread(
        &self,
        _params: SessionRenameThreadParams,
    ) -> Result<SessionRenameThreadResult, ProtocolError> {
        Err(ProtocolError::method_not_found("session.rename_thread"))
    }

    async fn handle_session_get_messages(
        &self,
        _params: SessionGetMessagesParams,
    ) -> Result<SessionGetMessagesResult, ProtocolError> {
        Err(ProtocolError::method_not_found("session.get_messages"))
    }

    // ---------------- Agent surfaces ----------------

    async fn handle_chat_send(
        &self,
        _params: ChatSendParams,
    ) -> Result<ChatSendResult, ProtocolError> {
        Err(ProtocolError::method_not_found("chat.send"))
    }

    async fn handle_inline_edit_start(
        &self,
        _params: InlineEditStartParams,
    ) -> Result<InlineEditStartResult, ProtocolError> {
        Err(ProtocolError::method_not_found("inline_edit.start"))
    }

    async fn handle_composer_start(
        &self,
        _params: ComposerStartParams,
    ) -> Result<ComposerStartResult, ProtocolError> {
        Err(ProtocolError::method_not_found("composer.start"))
    }

    async fn handle_plan_confirm(
        &self,
        _params: PlanConfirmParams,
    ) -> Result<PlanConfirmResult, ProtocolError> {
        Err(ProtocolError::method_not_found("plan.confirm"))
    }

    // ---------------- Control ----------------

    /// `turn.cancel` is notification-style (no response).
    async fn handle_turn_cancel(&self, _params: TurnCancelParams) {
        // default: silently ignore
    }

    async fn handle_edit_confirm(
        &self,
        _params: EditConfirmParams,
    ) -> Result<EditConfirmResult, ProtocolError> {
        Err(ProtocolError::method_not_found("edit.confirm"))
    }

    async fn handle_tool_confirm(
        &self,
        _params: ToolConfirmParams,
    ) -> Result<ToolConfirmResult, ProtocolError> {
        Err(ProtocolError::method_not_found("tool.confirm"))
    }

    /// `context.respond` looks like a response from the wire perspective —
    /// it correlates to a SNACA-originated `context.request`. This trait
    /// method is invoked when host sends it back as a separate request
    /// (a few hosts may model it that way). The standard JSON-RPC flow
    /// is that host replies to the `context.request` directly using its
    /// `id`; that branch goes through the outbound correlator, not this
    /// trait method. Default returns OK.
    async fn handle_context_respond(
        &self,
        _params: ContextRespondParams,
    ) -> Result<ContextRespondResult, ProtocolError> {
        Ok(ContextRespondResult { ok: true })
    }

    // ---------------- Memory viewer ----------------

    async fn handle_memory_list(
        &self,
        _params: MemoryListParams,
    ) -> Result<MemoryListResult, ProtocolError> {
        Err(ProtocolError::method_not_found("memory.list"))
    }

    async fn handle_memory_get(
        &self,
        _params: MemoryGetParams,
    ) -> Result<MemoryGetResult, ProtocolError> {
        Err(ProtocolError::method_not_found("memory.get"))
    }

    async fn handle_memory_write(
        &self,
        _params: MemoryWriteParams,
    ) -> Result<MemoryWriteResult, ProtocolError> {
        Err(ProtocolError::method_not_found("memory.write"))
    }

    async fn handle_memory_delete(
        &self,
        _params: MemoryDeleteParams,
    ) -> Result<MemoryDeleteResult, ProtocolError> {
        Err(ProtocolError::method_not_found("memory.delete"))
    }

    async fn handle_memory_reveal(
        &self,
        _params: MemoryRevealParams,
    ) -> Result<MemoryRevealResult, ProtocolError> {
        Err(ProtocolError::method_not_found("memory.reveal"))
    }

    // ---------------- Skills viewer ----------------

    async fn handle_skills_list(
        &self,
        _params: SkillsListParams,
    ) -> Result<SkillsListResult, ProtocolError> {
        Err(ProtocolError::method_not_found("skills.list"))
    }

    async fn handle_skills_get(
        &self,
        _params: SkillsGetParams,
    ) -> Result<SkillsGetResult, ProtocolError> {
        Err(ProtocolError::method_not_found("skills.get"))
    }

    async fn handle_skills_reload(
        &self,
        _params: SkillsReloadParams,
    ) -> Result<SkillsReloadResult, ProtocolError> {
        Err(ProtocolError::method_not_found("skills.reload"))
    }
}

/// Generic dispatcher that wraps a [`MessageHandler`].
///
/// One instance per snaca-editor process. `Arc`-cloneable so spawned
/// tokio tasks can each hold a handle. Cloning the dispatcher is cheap
/// (one `Arc::clone`); we hand-impl `Clone` so the bound doesn't require
/// `H: Clone` — the handler itself stays inside the `Arc`.
pub struct Dispatcher<H: MessageHandler> {
    handler: std::sync::Arc<H>,
}

impl<H: MessageHandler> Clone for Dispatcher<H> {
    fn clone(&self) -> Self {
        Self {
            handler: self.handler.clone(),
        }
    }
}

impl<H: MessageHandler> Dispatcher<H> {
    pub fn new(handler: H) -> Self {
        Self {
            handler: std::sync::Arc::new(handler),
        }
    }

    pub fn from_arc(handler: std::sync::Arc<H>) -> Self {
        Self { handler }
    }

    /// Parse one NDJSON line and produce a response line, or `None`
    /// for notifications / parse errors against notifications.
    pub async fn process_line(&self, line: &[u8]) -> Option<Vec<u8>> {
        let msg = match codec::decode(line) {
            Ok(m) => m,
            Err(codec::CodecError::EmptyFrame) => return None,
            Err(err) => {
                // Parse error: id is unknown, JSON-RPC says respond with id=null.
                let resp = JsonRpcResponse::err(
                    JsonRpcRequestId::Null,
                    JsonRpcError::new(ErrorCode::ParseError.as_i32(), err.to_string()),
                );
                return codec::encode(&resp).ok();
            }
        };

        match msg {
            JsonRpcMessage::Request(req) => self.handle_request(req).await,
            JsonRpcMessage::Notification(notif) => {
                self.handle_notification(notif).await;
                None
            }
            JsonRpcMessage::Response(_) => {
                // host should never send bare Response to SNACA (only to
                // correlate `context.request`); the outbound side handles
                // those via a separate correlator. Ignore here.
                None
            }
        }
    }

    async fn handle_request(&self, req: JsonRpcRequest) -> Option<Vec<u8>> {
        let id = req.id.clone();
        let result = self.dispatch_request(&req).await;
        let resp = match result {
            Ok(value) => JsonRpcResponse::ok(id, value),
            Err(err) => JsonRpcResponse::err(id, err.into()),
        };
        codec::encode(&resp).ok()
    }

    async fn dispatch_request(&self, req: &JsonRpcRequest) -> Result<Value, ProtocolError> {
        let method = Method::from_str(&req.method)
            .ok_or_else(|| ProtocolError::method_not_found(&req.method))?;
        let params = req.params.clone().unwrap_or(Value::Null);

        match method {
            Method::Init => call_typed(self.handler.as_ref(), params, H::handle_init).await,
            Method::Shutdown => {
                call_typed(self.handler.as_ref(), params, H::handle_shutdown).await
            }
            Method::HealthPing => {
                call_typed(self.handler.as_ref(), params, H::handle_health_ping).await
            }
            Method::ConfigReload => {
                call_typed(self.handler.as_ref(), params, H::handle_config_reload).await
            }
            Method::SessionOpen => {
                call_typed(self.handler.as_ref(), params, H::handle_session_open).await
            }
            Method::SessionClose => {
                call_typed(self.handler.as_ref(), params, H::handle_session_close).await
            }
            Method::SessionListThreads => {
                call_typed(
                    self.handler.as_ref(),
                    params,
                    H::handle_session_list_threads,
                )
                .await
            }
            Method::SessionNewThread => {
                call_typed(self.handler.as_ref(), params, H::handle_session_new_thread).await
            }
            Method::SessionSwitchThread => {
                call_typed(
                    self.handler.as_ref(),
                    params,
                    H::handle_session_switch_thread,
                )
                .await
            }
            Method::SessionDeleteThread => {
                call_typed(
                    self.handler.as_ref(),
                    params,
                    H::handle_session_delete_thread,
                )
                .await
            }
            Method::SessionRenameThread => {
                call_typed(
                    self.handler.as_ref(),
                    params,
                    H::handle_session_rename_thread,
                )
                .await
            }
            Method::SessionGetMessages => {
                call_typed(
                    self.handler.as_ref(),
                    params,
                    H::handle_session_get_messages,
                )
                .await
            }
            Method::ChatSend => {
                call_typed(self.handler.as_ref(), params, H::handle_chat_send).await
            }
            Method::InlineEditStart => {
                call_typed(self.handler.as_ref(), params, H::handle_inline_edit_start).await
            }
            Method::ComposerStart => {
                call_typed(self.handler.as_ref(), params, H::handle_composer_start).await
            }
            Method::PlanConfirm => {
                call_typed(self.handler.as_ref(), params, H::handle_plan_confirm).await
            }
            Method::EditConfirm => {
                call_typed(self.handler.as_ref(), params, H::handle_edit_confirm).await
            }
            Method::ToolConfirm => {
                call_typed(self.handler.as_ref(), params, H::handle_tool_confirm).await
            }
            Method::ContextRespond => {
                call_typed(self.handler.as_ref(), params, H::handle_context_respond).await
            }
            Method::MemoryList => {
                call_typed(self.handler.as_ref(), params, H::handle_memory_list).await
            }
            Method::MemoryGet => {
                call_typed(self.handler.as_ref(), params, H::handle_memory_get).await
            }
            Method::MemoryWrite => {
                call_typed(self.handler.as_ref(), params, H::handle_memory_write).await
            }
            Method::MemoryDelete => {
                call_typed(self.handler.as_ref(), params, H::handle_memory_delete).await
            }
            Method::MemoryReveal => {
                call_typed(self.handler.as_ref(), params, H::handle_memory_reveal).await
            }
            Method::SkillsList => {
                call_typed(self.handler.as_ref(), params, H::handle_skills_list).await
            }
            Method::SkillsGet => {
                call_typed(self.handler.as_ref(), params, H::handle_skills_get).await
            }
            Method::SkillsReload => {
                call_typed(self.handler.as_ref(), params, H::handle_skills_reload).await
            }
            // SNACA → host methods should never arrive as host → SNACA requests
            _ => Err(ProtocolError::method_not_found(&req.method)),
        }
    }

    async fn handle_notification(&self, notif: JsonRpcNotification) {
        let method = match Method::from_str(&notif.method) {
            Some(m) => m,
            None => return, // silently drop unknown notifications
        };
        let params = notif.params.unwrap_or(Value::Null);

        match method {
            Method::TurnCancel => {
                if let Ok(p) = serde_json::from_value::<TurnCancelParams>(params) {
                    self.handler.handle_turn_cancel(p).await;
                }
            }
            // All other notifications are SNACA → host; ignore on receive.
            _ => {}
        }
    }
}

/// Helper: deserialize params into the request type for the handler, call
/// the handler, then serialize the result back to JSON.
async fn call_typed<'h, H, F, P, R, Fut>(
    handler: &'h H,
    params: Value,
    method: F,
) -> Result<Value, ProtocolError>
where
    H: MessageHandler + 'h,
    P: DeserializeOwned,
    R: Serialize,
    F: FnOnce(&'h H, P) -> Fut,
    Fut: std::future::Future<Output = Result<R, ProtocolError>>,
{
    let typed: P = serde_json::from_value(params)
        .map_err(|e| ProtocolError::invalid_params(format!("invalid params: {e}")))?;
    let res = method(handler, typed).await?;
    serde_json::to_value(res).map_err(|e| ProtocolError::internal(format!("serialize: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct StubHandler;

    #[async_trait]
    impl MessageHandler for StubHandler {
        async fn handle_health_ping(
            &self,
            _: HealthPingParams,
        ) -> Result<HealthPingResult, ProtocolError> {
            Ok(HealthPingResult {
                pong: true,
                engine_uptime_secs: 42,
            })
        }
    }

    fn d() -> Dispatcher<StubHandler> {
        Dispatcher::new(StubHandler)
    }

    #[test]
    fn method_lookup() {
        assert_eq!(Method::from_str("chat.send"), Some(Method::ChatSend));
        assert_eq!(Method::from_str("turn.delta"), Some(Method::TurnDelta));
        assert_eq!(Method::from_str("nonsense"), None);
    }

    #[tokio::test]
    async fn ping_roundtrip() {
        let line = serde_json::to_vec(&json!({
            "jsonrpc": "2.0", "id": 1, "method": "health.ping", "params": {}
        }))
        .unwrap();
        let out = d().process_line(&line).await.unwrap();
        let resp: JsonRpcResponse = serde_json::from_slice(out.trim_ascii_end()).unwrap();
        assert!(resp.is_ok());
        assert_eq!(resp.id, JsonRpcRequestId::Number(1));
        assert_eq!(resp.result.unwrap()["pong"], true);
    }

    #[tokio::test]
    async fn unknown_method_errors() {
        let line = serde_json::to_vec(&json!({
            "jsonrpc": "2.0", "id": 9, "method": "no.such.thing"
        }))
        .unwrap();
        let out = d().process_line(&line).await.unwrap();
        let resp: JsonRpcResponse = serde_json::from_slice(out.trim_ascii_end()).unwrap();
        assert!(!resp.is_ok());
        assert_eq!(resp.error.unwrap().code, -32601);
    }

    #[tokio::test]
    async fn default_handler_returns_method_not_found_for_unimplemented() {
        let line = serde_json::to_vec(&json!({
            "jsonrpc": "2.0", "id": 2, "method": "chat.send",
            "params": {
                "session_id": "s", "thread_id": "t",
                "content": "hi", "context": {}
            }
        }))
        .unwrap();
        let out = d().process_line(&line).await.unwrap();
        let resp: JsonRpcResponse = serde_json::from_slice(out.trim_ascii_end()).unwrap();
        assert_eq!(resp.error.unwrap().code, -32601);
    }

    #[tokio::test]
    async fn malformed_params_yield_invalid_params() {
        // chat.send with wrong types
        let line = serde_json::to_vec(&json!({
            "jsonrpc": "2.0", "id": 3, "method": "chat.send",
            "params": { "session_id": 12345 }
        }))
        .unwrap();
        let out = d().process_line(&line).await.unwrap();
        let resp: JsonRpcResponse = serde_json::from_slice(out.trim_ascii_end()).unwrap();
        assert_eq!(resp.error.unwrap().code, -32602);
    }

    #[tokio::test]
    async fn notification_produces_no_response() {
        let line = serde_json::to_vec(&json!({
            "jsonrpc": "2.0", "method": "turn.cancel",
            "params": {"turn_id": "tu-1"}
        }))
        .unwrap();
        assert!(d().process_line(&line).await.is_none());
    }

    #[tokio::test]
    async fn parse_error_yields_null_id_response() {
        let line = b"not json";
        let out = d().process_line(line).await.unwrap();
        let resp: JsonRpcResponse = serde_json::from_slice(out.trim_ascii_end()).unwrap();
        assert_eq!(resp.id, JsonRpcRequestId::Null);
        assert_eq!(resp.error.unwrap().code, -32700);
    }
}
