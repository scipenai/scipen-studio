//! Mock IM plugin — speaks the SNACA channel-protocol on stdio.
//!
//! Used in two ways:
//! 1. **Protocol probing.** Run interactively and paste JSON-RPC lines on
//!    stdin to see how the protocol layer responds.
//! 2. **Integration tests.** Spawned by `snaca-channel-host` tests as a
//!    deterministic plugin that completes initialize, answers ping, and
//!    optionally echoes outbound `message.send` back as inbound
//!    `event.message_received`.
//!
//! Modes:
//! - default — passive: only answers requests, never sends inbound.
//! - `--auto-echo` — whenever the host calls `message.send`, immediately
//!   send an inbound `event.message_received` carrying the same content
//!   (useful for end-to-end smoke tests).

use anyhow::{Context, Result};
use chrono::Utc;
use clap::Args;
use serde_json::json;
use snaca_channel_protocol::{
    codec,
    errors::ErrorCode,
    jsonrpc::{JsonRpcError, JsonRpcMessage, JsonRpcRequest, JsonRpcResponse, RequestId},
    manifest::{ChannelCapabilities, PluginInfo, PluginManifest},
    methods::{
        host_to_plugin, plugin_to_host, InitializeParams, MessageReceivedParams,
        MessageSendParams, MessageSendResult,
    },
    PROTOCOL_VERSION,
};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tracing::{debug, warn};

#[derive(Debug, Args, Clone)]
pub struct MockPluginArgs {
    /// Echo any host `message.send` back as an inbound `event.message_received`.
    #[arg(long)]
    pub auto_echo: bool,

    /// After `initialize` succeeds, immediately push one
    /// `event.message_received` to the host with this string as content.
    /// Useful as a one-shot synthetic user message in e2e smoke tests.
    #[arg(long)]
    pub auto_inject: Option<String>,

    /// Tenant id stamped on the synthetic event. Defaults to `"mock-tenant"`.
    /// Multi-tenant e2e tests use this to drive the same SNACA server with
    /// two `--auto-inject` plugins, one per tenant.
    #[arg(long, default_value = "mock-tenant")]
    pub inject_tenant_id: String,

    /// Chat id stamped on the synthetic event. Defaults to `"mock-chat"`.
    /// Multi-tenant e2e tests give each tenant a distinct chat id so the
    /// dispatcher routes them to separate threads.
    #[arg(long, default_value = "mock-chat")]
    pub inject_chat_id: String,

    /// On every `approval.present` from the host, automatically reply with
    /// the given decision via `event.approval_callback`. Supported values:
    /// `allow`, `deny`, `allow_once`, `allow_always`. Used by e2e tests to
    /// exercise the cross-process approval pipeline without a human in the
    /// loop.
    #[arg(long, value_parser = parse_decision)]
    pub auto_approval: Option<MockDecision>,

    /// Plugin display name returned in `initialize`. Lets multiple mock
    /// instances coexist for testing routing.
    #[arg(long, default_value = "mock")]
    pub name: String,

    /// Bake a synthetic attachment into the auto-injected event. Format:
    /// `<file_id>:<filename>:<inline-content>`. The mock then responds
    /// to `file.download(file_id)` with the inlined bytes. Used in
    /// attachment-import e2e tests.
    #[arg(long)]
    pub inject_attachment: Option<String>,

    /// Override the manifest to advertise `update_message: true`. The
    /// real-world default is `false` (the typewriter behaviour creates
    /// noise on plain-text channels — Lark plain text can't be edited
    /// at all). Tests that exercise the typewriter path enable it
    /// explicitly to match a card-capable channel.
    #[arg(long)]
    pub update_supported: bool,

    /// After `initialize` succeeds, send `tool.advertise` for a synthetic
    /// tool with this name. The tool is read-only and on `tool.invoke`
    /// echoes back its `arguments` field. Used by tests that exercise
    /// the plugin-tool engine integration without a real OpenClaw plugin.
    #[arg(long)]
    pub advertise_tool: Option<String>,

    /// After `initialize` succeeds, send `command.advertise` for a synthetic
    /// IM command with this name. On `command.invoke` the plugin replies
    /// with `pong: <arguments>`. Used to exercise the dispatcher's slash-
    /// command routing.
    #[arg(long)]
    pub advertise_command: Option<String>,
}

/// Parsed shape of `--inject-attachment`. Stored on `State` so
/// `file.download` can serve the bytes after the auto-inject fires.
#[derive(Debug, Clone)]
struct CannedAttachment {
    file_id: String,
    filename: String,
    bytes: Vec<u8>,
}

fn parse_canned_attachment(raw: &str) -> Option<CannedAttachment> {
    let mut parts = raw.splitn(3, ':');
    let id = parts.next()?.trim();
    let name = parts.next()?.trim();
    let body = parts.next()?;
    if id.is_empty() || name.is_empty() {
        return None;
    }
    Some(CannedAttachment {
        file_id: id.to_string(),
        filename: name.to_string(),
        bytes: body.as_bytes().to_vec(),
    })
}

/// CLI-friendly mirror of `protocol::ApprovalDecision`. Kept separate so we
/// can derive Clone for clap; the conversion happens at call site.
#[derive(Debug, Clone, Copy)]
pub enum MockDecision {
    Allow,
    Deny,
    AllowOnce,
    AllowAlways,
}

fn parse_decision(s: &str) -> Result<MockDecision, String> {
    match s {
        "allow" => Ok(MockDecision::Allow),
        "deny" => Ok(MockDecision::Deny),
        "allow_once" => Ok(MockDecision::AllowOnce),
        "allow_always" => Ok(MockDecision::AllowAlways),
        other => Err(format!(
            "invalid decision {other:?}; expected one of allow/deny/allow_once/allow_always"
        )),
    }
}

impl MockDecision {
    fn to_protocol(self) -> snaca_channel_protocol::methods::ApprovalDecision {
        use snaca_channel_protocol::methods::ApprovalDecision;
        match self {
            MockDecision::Allow => ApprovalDecision::Allow,
            MockDecision::Deny => ApprovalDecision::Deny,
            MockDecision::AllowOnce => ApprovalDecision::AllowOnce,
            MockDecision::AllowAlways => ApprovalDecision::AllowAlways,
        }
    }
}

pub async fn run(args: MockPluginArgs) -> Result<()> {
    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin).lines();
    let mut stdout = tokio::io::stdout();

    let canned_attachment = args
        .inject_attachment
        .as_deref()
        .and_then(parse_canned_attachment);

    let mut state = State {
        initialized: false,
        auto_echo: args.auto_echo,
        plugin_name: args.name,
        auto_inject_once: args.auto_inject,
        inject_tenant_id: args.inject_tenant_id,
        inject_chat_id: args.inject_chat_id,
        auto_approval: args.auto_approval,
        canned_attachment,
        update_supported: args.update_supported,
        advertise_tool_once: args.advertise_tool,
        advertise_command_once: args.advertise_command,
        next_outgoing_id: 100_000,
    };

    while let Some(line) = reader
        .next_line()
        .await
        .context("read stdin")?
    {
        let msg = match codec::decode(line.as_bytes()) {
            Ok(m) => m,
            Err(codec::CodecError::EmptyFrame) => continue,
            Err(e) => {
                warn!(error=%e, "failed to decode frame; ignoring");
                continue;
            }
        };

        match msg {
            JsonRpcMessage::Request(req) => {
                let (response, after) = state.handle_request(req).await;
                write_msg(&mut stdout, &response).await?;
                for extra in after.echo {
                    write_msg(&mut stdout, &extra).await?;
                }
                if after.shutdown {
                    debug!("shutdown requested; exiting");
                    break;
                }
            }
            JsonRpcMessage::Notification(n) => {
                debug!(method=%n.method, "ignoring inbound notification");
            }
            JsonRpcMessage::Response(_) => {
                // mock plugin does not issue requests; any incoming response
                // is unsolicited and dropped.
            }
        }
    }
    Ok(())
}

struct State {
    initialized: bool,
    auto_echo: bool,
    plugin_name: String,
    /// One-shot synthetic user message to inject after the initialize handshake
    /// — `Some` once, `None` after we've fired it.
    auto_inject_once: Option<String>,
    /// Tenant id stamped on the auto-injected event. Defaults to `"mock-tenant"`.
    inject_tenant_id: String,
    /// Chat id stamped on the auto-injected event. Defaults to `"mock-chat"`.
    inject_chat_id: String,
    /// Decision to send for every incoming `approval.present`. None = no
    /// auto behaviour (real plugin would render a card and wait for user).
    auto_approval: Option<MockDecision>,
    /// File served by `file.download` calls. None = `file.download` returns
    /// `MethodNotFound`. Set via `--inject-attachment`. The same canned
    /// payload is also stamped onto the auto-injected `event.message_received`
    /// in `Attachment` form, so the dispatcher will actually fetch it.
    canned_attachment: Option<CannedAttachment>,
    /// Tweak `manifest.capabilities.update_message` so streaming tests
    /// can opt into the typewriter pathway. Real plugins set this based
    /// on the underlying channel's edit-message support.
    update_supported: bool,
    /// One-shot tool name to advertise after `initialize` completes.
    /// Used by tests that exercise the engine's plugin-tool integration.
    advertise_tool_once: Option<String>,
    /// One-shot command name to advertise after initialize. Same purpose
    /// as `advertise_tool_once` but for `command.advertise`.
    advertise_command_once: Option<String>,
    /// Counter for plugin -> host request ids. Kept far from any host id
    /// the protocol might reasonably emit (host uses small monotonic ids).
    next_outgoing_id: u64,
}

#[derive(Default)]
struct AfterAction {
    /// Extra messages to send after the response (used by --auto-echo,
    /// --auto-inject, --advertise-tool). Sent in order.
    echo: Vec<JsonRpcMessage>,
    /// Stop reading further frames and exit.
    shutdown: bool,
}

impl State {
    async fn handle_request(&mut self, req: JsonRpcRequest) -> (JsonRpcMessage, AfterAction) {
        let id = req.id.clone();
        match req.method.as_str() {
            host_to_plugin::INITIALIZE => self.handle_initialize(id, req),
            host_to_plugin::HEALTH_PING => (
                JsonRpcMessage::Response(JsonRpcResponse::ok(id, json!({"pong": true}))),
                AfterAction::default(),
            ),
            host_to_plugin::MESSAGE_SEND => self.handle_message_send(id, req),
            host_to_plugin::ACKNOWLEDGE => (
                JsonRpcMessage::Response(JsonRpcResponse::ok(id, json!({}))),
                AfterAction::default(),
            ),
            host_to_plugin::APPROVAL_PRESENT => self.handle_approval_present(id, req),
            host_to_plugin::MESSAGE_UPDATE => self.handle_message_update(id, req),
            host_to_plugin::FILE_DOWNLOAD => self.handle_file_download(id, req),
            host_to_plugin::TOOL_INVOKE => self.handle_tool_invoke(id, req),
            host_to_plugin::COMMAND_INVOKE => self.handle_command_invoke(id, req),
            host_to_plugin::SHUTDOWN => (
                JsonRpcMessage::Response(JsonRpcResponse::ok(id, json!({}))),
                AfterAction {
                    shutdown: true,
                    ..AfterAction::default()
                },
            ),
            other => {
                debug!(method=%other, "unsupported method in mock plugin");
                (
                    JsonRpcMessage::Response(JsonRpcResponse::err(
                        id,
                        JsonRpcError::new(ErrorCode::MethodNotFound.as_i32(), "method_not_found"),
                    )),
                    AfterAction::default(),
                )
            }
        }
    }

    fn handle_initialize(
        &mut self,
        id: RequestId,
        req: JsonRpcRequest,
    ) -> (JsonRpcMessage, AfterAction) {
        // Best-effort parse of params for diagnostics; we don't fail
        // initialize if config is missing — this is a mock.
        if let Some(params) = req.params.clone() {
            if let Ok(p) = serde_json::from_value::<InitializeParams>(params) {
                debug!(
                    host_protocol=%p.protocol_version,
                    "mock plugin initializing"
                );
            }
        }
        let manifest = PluginManifest {
            protocol_version: PROTOCOL_VERSION.to_string(),
            plugin: PluginInfo {
                name: self.plugin_name.clone(),
                version: env!("CARGO_PKG_VERSION").to_string(),
            },
            tenant_id_format: Some("mock".to_string()),
            capabilities: {
                let mut c = ChannelCapabilities::minimal();
                c.update_message = self.update_supported;
                // When `--auto-approval` is set, the mock can answer
                // `approval.present` requests — advertise the matching
                // capability so the engine's gate goes through the
                // normal `request_approval` path instead of the
                // no-card fallback.
                if self.auto_approval.is_some() {
                    c.interactive_card = true;
                }
                c
            },
        };
        self.initialized = true;

        let mut after = AfterAction::default();
        if let Some(content) = self.auto_inject_once.take() {
            let token = std::env::var("SNACA_PLUGIN_TOKEN").unwrap_or_default();
            // Stamp the canned attachment onto the auto-inject event
            // so the dispatcher knows to fetch it. The bytes themselves
            // stay in `state.canned_attachment` and only get served
            // when the host calls `file.download(file_id)`.
            let attachments: Vec<snaca_channel_protocol::methods::Attachment> = self
                .canned_attachment
                .as_ref()
                .map(|c| {
                    vec![snaca_channel_protocol::methods::Attachment {
                        id: c.file_id.clone(),
                        filename: c.filename.clone(),
                        mime_type: "application/octet-stream".to_string(),
                        size: c.bytes.len() as u64,
                    }]
                })
                .unwrap_or_default();
            let inject = MessageReceivedParams {
                auth: token,
                tenant_id: self.inject_tenant_id.clone(),
                chat_id: self.inject_chat_id.clone(),
                user_id: "mock-user".to_string(),
                message_id: format!("inject-{}", uuid_short()),
                content,
                mentions: vec![],
                attachments,
                reply_to: None,
                received_at: Utc::now().to_rfc3339(),
            };
            let notif = snaca_channel_protocol::jsonrpc::JsonRpcNotification::new(
                plugin_to_host::EVENT_MESSAGE_RECEIVED,
                Some(serde_json::to_value(inject).expect("inject params serialise")),
            );
            after.echo.push(JsonRpcMessage::Notification(notif));
        }

        // If --advertise-command was passed, send command.advertise.
        if let Some(cmd_name) = self.advertise_command_once.take() {
            let token = std::env::var("SNACA_PLUGIN_TOKEN").unwrap_or_default();
            let req_id = self.next_outgoing_id;
            self.next_outgoing_id += 1;
            let advertise = snaca_channel_protocol::methods::CommandAdvertiseParams {
                auth: token,
                name: cmd_name.clone(),
                description: format!("Mock plugin command /{cmd_name}; replies pong + args"),
                argument_hint: Some("[anything]".into()),
            };
            let req = snaca_channel_protocol::jsonrpc::JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: snaca_channel_protocol::jsonrpc::RequestId::Number(req_id as i64),
                method: plugin_to_host::COMMAND_ADVERTISE.to_string(),
                params: Some(serde_json::to_value(advertise).expect("advertise serialises")),
            };
            after.echo.push(JsonRpcMessage::Request(req));
        }

        // If --advertise-tool was passed, send a tool.advertise request.
        // The host should ack with `{}`; we don't bother matching the
        // response on our side (it's a fire-and-forget for the mock).
        if let Some(tool_name) = self.advertise_tool_once.take() {
            let token = std::env::var("SNACA_PLUGIN_TOKEN").unwrap_or_default();
            let req_id = self.next_outgoing_id;
            self.next_outgoing_id += 1;
            let advertise = snaca_channel_protocol::methods::ToolAdvertiseParams {
                auth: token,
                name: tool_name.clone(),
                description: format!("Mock plugin tool {tool_name}; echoes its arguments back"),
                input_schema: json!({
                    "type": "object",
                    "properties": {"echo": {"type": "string"}},
                    "additionalProperties": true,
                }),
                is_read_only: true,
            };
            let req = snaca_channel_protocol::jsonrpc::JsonRpcRequest {
                jsonrpc: "2.0".into(),
                id: snaca_channel_protocol::jsonrpc::RequestId::Number(req_id as i64),
                method: plugin_to_host::TOOL_ADVERTISE.to_string(),
                params: Some(serde_json::to_value(advertise).expect("advertise serialises")),
            };
            after.echo.push(JsonRpcMessage::Request(req));
        }

        (
            JsonRpcMessage::Response(JsonRpcResponse::ok(
                id,
                serde_json::to_value(manifest).expect("manifest serialises"),
            )),
            after,
        )
    }

    /// Reply `pong: <args>`. Used by tests that drive the dispatcher's
    /// slash-command routing.
    fn handle_command_invoke(
        &mut self,
        id: RequestId,
        req: JsonRpcRequest,
    ) -> (JsonRpcMessage, AfterAction) {
        if !self.initialized {
            return (
                JsonRpcMessage::Response(JsonRpcResponse::err(
                    id,
                    JsonRpcError::new(ErrorCode::NotInitialized.as_i32(), "not_initialized"),
                )),
                AfterAction::default(),
            );
        }
        let params: snaca_channel_protocol::methods::CommandInvokeParams =
            match req.params.and_then(|v| serde_json::from_value(v).ok()) {
                Some(p) => p,
                None => {
                    return (
                        JsonRpcMessage::Response(JsonRpcResponse::err(
                            id,
                            JsonRpcError::new(
                                ErrorCode::InvalidParams.as_i32(),
                                "invalid command.invoke params",
                            ),
                        )),
                        AfterAction::default(),
                    );
                }
            };
        let reply = if params.arguments.is_empty() {
            "pong".to_string()
        } else {
            format!("pong: {}", params.arguments)
        };
        let result = snaca_channel_protocol::methods::CommandInvokeResult {
            reply,
            is_error: false,
        };
        (
            JsonRpcMessage::Response(JsonRpcResponse::ok(
                id,
                serde_json::to_value(result).expect("command.invoke result serialises"),
            )),
            AfterAction::default(),
        )
    }

    /// Echo the input back as a stringified JSON. Used by the
    /// `plugin_tool_engine_integration` test in snaca-server.
    fn handle_tool_invoke(
        &mut self,
        id: RequestId,
        req: JsonRpcRequest,
    ) -> (JsonRpcMessage, AfterAction) {
        if !self.initialized {
            return (
                JsonRpcMessage::Response(JsonRpcResponse::err(
                    id,
                    JsonRpcError::new(ErrorCode::NotInitialized.as_i32(), "not_initialized"),
                )),
                AfterAction::default(),
            );
        }
        let params: snaca_channel_protocol::methods::ToolInvokeParams =
            match req.params.and_then(|v| serde_json::from_value(v).ok()) {
                Some(p) => p,
                None => {
                    return (
                        JsonRpcMessage::Response(JsonRpcResponse::err(
                            id,
                            JsonRpcError::new(
                                ErrorCode::InvalidParams.as_i32(),
                                "invalid tool.invoke params",
                            ),
                        )),
                        AfterAction::default(),
                    );
                }
            };
        let content = serde_json::to_string(&params.arguments).unwrap_or_else(|_| "{}".to_string());
        let result = snaca_channel_protocol::methods::ToolInvokeResult {
            content,
            is_error: false,
        };
        (
            JsonRpcMessage::Response(JsonRpcResponse::ok(
                id,
                serde_json::to_value(result).expect("tool.invoke result serialises"),
            )),
            AfterAction::default(),
        )
    }

    fn handle_message_send(
        &mut self,
        id: RequestId,
        req: JsonRpcRequest,
    ) -> (JsonRpcMessage, AfterAction) {
        if !self.initialized {
            return (
                JsonRpcMessage::Response(JsonRpcResponse::err(
                    id,
                    JsonRpcError::new(ErrorCode::NotInitialized.as_i32(), "not_initialized"),
                )),
                AfterAction::default(),
            );
        }
        let params: MessageSendParams = match req.params {
            Some(v) => match serde_json::from_value(v) {
                Ok(p) => p,
                Err(e) => {
                    return (
                        JsonRpcMessage::Response(JsonRpcResponse::err(
                            id,
                            JsonRpcError::new(
                                ErrorCode::InvalidParams.as_i32(),
                                format!("invalid_params: {e}"),
                            ),
                        )),
                        AfterAction::default(),
                    )
                }
            },
            None => {
                return (
                    JsonRpcMessage::Response(JsonRpcResponse::err(
                        id,
                        JsonRpcError::new(ErrorCode::InvalidParams.as_i32(), "missing params"),
                    )),
                    AfterAction::default(),
                )
            }
        };

        let result = MessageSendResult {
            message_id: format!("mock-{}", uuid_short()),
        };
        let response = JsonRpcResponse::ok(
            id,
            serde_json::to_value(&result).expect("send result serialises"),
        );

        // Optional: append the send to a JSONL file for e2e smoke tests.
        if let Ok(path) = std::env::var("SNACA_MOCK_RECORD_SENDS") {
            record_send(&path, &params);
        }

        let mut after = AfterAction::default();
        if self.auto_echo {
            // Echo as inbound event.message_received with same content.
            let token = std::env::var("SNACA_PLUGIN_TOKEN").unwrap_or_default();
            let echo = MessageReceivedParams {
                auth: token,
                tenant_id: params.tenant_id,
                chat_id: params.chat_id,
                user_id: "mock-user".to_string(),
                message_id: result.message_id.clone(),
                content: params.content,
                mentions: vec![],
                attachments: vec![],
                reply_to: None,
                received_at: Utc::now().to_rfc3339(),
            };
            let notif = snaca_channel_protocol::jsonrpc::JsonRpcNotification::new(
                plugin_to_host::EVENT_MESSAGE_RECEIVED,
                Some(serde_json::to_value(echo).expect("echo params serialise")),
            );
            after.echo.push(JsonRpcMessage::Notification(notif));
        }

        (JsonRpcMessage::Response(response), after)
    }

    fn handle_message_update(
        &mut self,
        id: RequestId,
        req: JsonRpcRequest,
    ) -> (JsonRpcMessage, AfterAction) {
        if !self.initialized {
            return (
                JsonRpcMessage::Response(JsonRpcResponse::err(
                    id,
                    JsonRpcError::new(ErrorCode::NotInitialized.as_i32(), "not_initialized"),
                )),
                AfterAction::default(),
            );
        }
        let params: snaca_channel_protocol::methods::MessageUpdateParams =
            match req.params.and_then(|v| serde_json::from_value(v).ok()) {
                Some(p) => p,
                None => {
                    return (
                        JsonRpcMessage::Response(JsonRpcResponse::err(
                            id,
                            JsonRpcError::new(
                                ErrorCode::InvalidParams.as_i32(),
                                "invalid message.update params",
                            ),
                        )),
                        AfterAction::default(),
                    );
                }
            };

        if let Ok(path) = std::env::var("SNACA_MOCK_RECORD_UPDATES") {
            record_update(&path, &params);
        }

        (
            JsonRpcMessage::Response(JsonRpcResponse::ok(id, json!({}))),
            AfterAction::default(),
        )
    }

    fn handle_file_download(
        &mut self,
        id: RequestId,
        req: JsonRpcRequest,
    ) -> (JsonRpcMessage, AfterAction) {
        if !self.initialized {
            return (
                JsonRpcMessage::Response(JsonRpcResponse::err(
                    id,
                    JsonRpcError::new(ErrorCode::NotInitialized.as_i32(), "not_initialized"),
                )),
                AfterAction::default(),
            );
        }
        let params: snaca_channel_protocol::methods::FileDownloadParams =
            match req.params.and_then(|v| serde_json::from_value(v).ok()) {
                Some(p) => p,
                None => {
                    return (
                        JsonRpcMessage::Response(JsonRpcResponse::err(
                            id,
                            JsonRpcError::new(
                                ErrorCode::InvalidParams.as_i32(),
                                "invalid file.download params",
                            ),
                        )),
                        AfterAction::default(),
                    );
                }
            };
        let canned = match self.canned_attachment.as_ref() {
            Some(c) if c.file_id == params.file_id => c,
            _ => {
                return (
                    JsonRpcMessage::Response(JsonRpcResponse::err(
                        id,
                        JsonRpcError::new(
                            ErrorCode::InvalidParams.as_i32(),
                            format!(
                                "no canned attachment for file_id={:?}",
                                params.file_id
                            ),
                        ),
                    )),
                    AfterAction::default(),
                );
            }
        };
        let result = snaca_channel_protocol::methods::FileDownloadResult {
            bytes_base64: data_encoding::BASE64.encode(&canned.bytes),
            filename: canned.filename.clone(),
            mime_type: "application/octet-stream".to_string(),
        };
        (
            JsonRpcMessage::Response(JsonRpcResponse::ok(
                id,
                serde_json::to_value(result).expect("file.download result serialises"),
            )),
            AfterAction::default(),
        )
    }

    fn handle_approval_present(
        &mut self,
        id: RequestId,
        req: JsonRpcRequest,
    ) -> (JsonRpcMessage, AfterAction) {
        if !self.initialized {
            return (
                JsonRpcMessage::Response(JsonRpcResponse::err(
                    id,
                    JsonRpcError::new(ErrorCode::NotInitialized.as_i32(), "not_initialized"),
                )),
                AfterAction::default(),
            );
        }

        let params: snaca_channel_protocol::methods::ApprovalPresentParams =
            match req.params.and_then(|v| serde_json::from_value(v).ok()) {
                Some(p) => p,
                None => {
                    return (
                        JsonRpcMessage::Response(JsonRpcResponse::err(
                            id,
                            JsonRpcError::new(
                                ErrorCode::InvalidParams.as_i32(),
                                "invalid approval.present params",
                            ),
                        )),
                        AfterAction::default(),
                    );
                }
            };

        // Always ack the present call so the host knows we received it.
        let response = JsonRpcResponse::ok(
            id,
            json!({"message_id": format!("approval-card-{}", uuid_short())}),
        );

        let mut after = AfterAction::default();
        if let Some(decision) = self.auto_approval {
            let token = std::env::var("SNACA_PLUGIN_TOKEN").unwrap_or_default();
            let cb = snaca_channel_protocol::methods::ApprovalCallbackParams {
                auth: token,
                callback_token: params.callback_token.clone(),
                decision: decision.to_protocol(),
                user_id: "mock-user".into(),
                decided_at: Utc::now().to_rfc3339(),
            };
            let notif = snaca_channel_protocol::jsonrpc::JsonRpcNotification::new(
                plugin_to_host::EVENT_APPROVAL_CALLBACK,
                Some(serde_json::to_value(cb).expect("approval callback serialises")),
            );
            after.echo.push(JsonRpcMessage::Notification(notif));
        } else {
            // Without auto_approval, the host's request_approval will time
            // out — useful for negative tests.
            debug!(
                token = %params.callback_token,
                "approval.present received with no auto_approval; host will time out"
            );
        }

        (JsonRpcMessage::Response(response), after)
    }
}

fn uuid_short() -> String {
    use uuid::Uuid;
    Uuid::new_v4().simple().to_string()[..12].to_string()
}

fn record_send(path: &str, params: &MessageSendParams) {
    use std::io::Write;
    let line = serde_json::json!({
        "tenant_id": params.tenant_id,
        "chat_id": params.chat_id,
        "content": params.content,
    });
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
    {
        let _ = writeln!(f, "{line}");
    }
}

fn record_update(path: &str, params: &snaca_channel_protocol::methods::MessageUpdateParams) {
    use std::io::Write;
    let line = serde_json::json!({
        "tenant_id": params.tenant_id,
        "message_id": params.message_id,
        "content": params.content,
    });
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
    {
        let _ = writeln!(f, "{line}");
    }
}

async fn write_msg<W>(writer: &mut W, msg: &JsonRpcMessage) -> Result<()>
where
    W: AsyncWriteExt + Unpin,
{
    let bytes = codec::encode(msg).context("encode jsonrpc")?;
    writer.write_all(&bytes).await.context("write stdout")?;
    writer.flush().await.context("flush stdout")?;
    Ok(())
}
