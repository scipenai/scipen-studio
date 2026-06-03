//! Plugin subprocess supervisor.
//!
//! `PluginHandle::spawn(config)` spawns a child process, completes the
//! `initialize` handshake, and returns a handle for sending requests
//! and receiving inbound events.
//!
//! Internal architecture:
//!
//! ```text
//!     caller                                          child process
//!       │ call_method(method, params)                       │
//!       ▼                                                   │
//!   pending: HashMap<RequestId, oneshot::Sender>            │
//!       │ register pending; send via writer_tx              │
//!       ▼                                                   │
//!   writer_task ───── child stdin (newline-delim JSON) ───► │
//!                                                           │
//!   reader_task ◄─── child stdout (newline-delim JSON) ─────┤
//!       │ if Response: pending.remove(id).send(resp)        │
//!       │ if Notification: parse_inbound + auth_check       │
//!       │   → inbound_tx.send(InboundEvent)                 │
//!       │ if Request: reply method_not_found (M1)           │
//!       ▼                                                   │
//!   inbound_rx (taken once by upstream, e.g. server)        │
//!                                                           │
//!   stderr_task ◄─── child stderr (logs) ──────────────────┤
//!       │ tracing::info!(plugin=%name, "<line>")            │
//! ```

use crate::approval::ApprovalRegistry;
use crate::config::PluginConfig;
use crate::error::{ChannelError, ChannelResult};
use crate::inbound::InboundEvent;
use data_encoding::BASE64URL_NOPAD;
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use snaca_channel_protocol::{
    codec,
    errors::ErrorCode,
    jsonrpc::{JsonRpcError, JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, RequestId},
    manifest::PluginManifest,
    methods::{
        host_to_plugin, plugin_to_host, AcknowledgeParams, ApprovalCallbackParams, ApprovalDecision,
        ApprovalPresentParams, CommandAdvertiseParams, FileDownloadParams, FileDownloadResult,
        FileUploadParams, FileUploadResult, InitializeParams, LogWriteParams,
        MessageReceivedParams, MessageRecalledParams, MessageSendParams, MessageSendResult,
        MessageUpdateParams, ToolAdvertiseParams,
    },
    PROTOCOL_VERSION,
};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, Mutex, Notify};
use tokio::task::JoinHandle;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_secs(30);
const WRITER_BUFFER: usize = 256;
/// Inbound channel capacity. Bounded (rather than unbounded) so a
/// dispatcher that falls behind backpressures the plugin's stdout
/// reader, which in turn backpressures the plugin subprocess —
/// preventing the host from buffering an unbounded queue of replayed
/// events on its own heap. 256 matches WRITER_BUFFER's order of
/// magnitude and is comfortably larger than any realistic IM burst.
const INBOUND_BUFFER: usize = 256;

/// Handle to a running plugin. Cheap to clone (`Arc` inside).
#[derive(Clone)]
pub struct PluginHandle {
    inner: Arc<HandleInner>,
}

struct HandleInner {
    name: String,
    manifest: PluginManifest,
    /// Kept for future admin API surface (`/admin/plugins/<name>/info`)
    /// and so we can rotate it on planned reload. Read-only by design.
    #[allow(dead_code)]
    auth_token: String,
    next_request_id: AtomicU64,
    pending: Arc<Mutex<HashMap<RequestId, oneshot::Sender<JsonRpcResponse>>>>,
    writer_tx: mpsc::Sender<JsonRpcMessage>,
    inbound_rx: Mutex<Option<mpsc::Receiver<InboundEvent>>>,
    tasks: Mutex<Option<Vec<JoinHandle<()>>>>,
    /// Notify the [`child_observer_task`] to forcibly kill the child.
    /// Sent by [`PluginHandle::shutdown`] after the graceful-RPC window
    /// closes; the observer's `select!` arm picks it up regardless of
    /// whether the child has already exited.
    kill_signal: Arc<Notify>,
    /// Single owner of the [`Child`] handle. Spawned post-handshake;
    /// awaits the child's exit (or the kill signal), then logs the
    /// `ExitStatus` so unexpected deaths are visible in the server log.
    observer_task: Mutex<Option<JoinHandle<()>>>,
    shutdown_called: Mutex<bool>,
    /// Pairs `approval.present` calls with their `event.approval_callback`
    /// notifications. Shared with the reader task so callbacks can resolve
    /// pending approvals directly.
    approval_registry: Arc<ApprovalRegistry>,
    /// Tools advertised by the plugin via `tool.advertise`. Populated by
    /// the reader task as advertise requests arrive. Cleared on shutdown.
    /// Keyed by tool name (the plugin-side name; the *qualified* name used
    /// by the engine is constructed by the consumer).
    advertised_tools: Arc<Mutex<HashMap<String, ToolAdvertiseParams>>>,
    /// Commands advertised similarly. Same lifecycle.
    advertised_commands: Arc<Mutex<HashMap<String, CommandAdvertiseParams>>>,
}

impl PluginHandle {
    /// Spawn a plugin subprocess and complete the `initialize` handshake.
    ///
    /// Returns once the plugin has acknowledged with a [`PluginManifest`].
    /// On failure the child is killed before this function returns.
    pub async fn spawn(config: PluginConfig) -> ChannelResult<PluginHandle> {
        let auth_token = generate_token();
        let plugin_name = config.name.clone();

        let mut cmd = Command::new(&config.command);
        cmd.args(&config.args)
            .env("SNACA_PLUGIN_TOKEN", &auth_token)
            .envs(&config.env);
        if let Some(cwd) = &config.cwd {
            cmd.current_dir(cwd);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(ChannelError::Io)?;

        let stdin = child.stdin.take().ok_or_else(|| {
            ChannelError::Other("child stdin was not captured".into())
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            ChannelError::Other("child stdout was not captured".into())
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            ChannelError::Other("child stderr was not captured".into())
        })?;

        let pending = Arc::new(Mutex::new(HashMap::<RequestId, oneshot::Sender<JsonRpcResponse>>::new()));
        let (writer_tx, writer_rx) = mpsc::channel::<JsonRpcMessage>(WRITER_BUFFER);
        let (inbound_tx, inbound_rx) = mpsc::channel::<InboundEvent>(INBOUND_BUFFER);
        let approval_registry = Arc::new(ApprovalRegistry::new());
        let advertised_tools = Arc::new(Mutex::new(HashMap::<String, ToolAdvertiseParams>::new()));
        let advertised_commands = Arc::new(Mutex::new(HashMap::<String, CommandAdvertiseParams>::new()));

        let writer_handle = tokio::spawn(writer_task(stdin, writer_rx, plugin_name.clone()));
        let reader_handle = tokio::spawn(reader_task(
            stdout,
            pending.clone(),
            inbound_tx,
            writer_tx.clone(),
            auth_token.clone(),
            plugin_name.clone(),
            approval_registry.clone(),
            advertised_tools.clone(),
            advertised_commands.clone(),
        ));
        let stderr_handle = tokio::spawn(stderr_task(stderr, plugin_name.clone()));

        // Handshake: send initialize, await response within timeout.
        let manifest = match handshake(&pending, &writer_tx, config.plugin_config.clone()).await {
            Ok(m) => m,
            Err(e) => {
                error!(plugin=%plugin_name, error=%e, "handshake failed; killing child");
                let _ = child.start_kill();
                let _ = child.wait().await;
                writer_handle.abort();
                reader_handle.abort();
                stderr_handle.abort();
                return Err(e);
            }
        };

        info!(
            plugin=%plugin_name,
            advertised_name=%manifest.plugin.name,
            advertised_version=%manifest.plugin.version,
            protocol_version=%manifest.protocol_version,
            "plugin initialized"
        );

        // Spawn the single owner of `child`. It awaits the child's exit
        // (or a kill signal from `shutdown()`), then logs the exit status
        // — this is the only observability we have for "why did the
        // plugin die?" In the no-watchdog past, naturally-exiting plugins
        // were reaped only implicitly via tokio's `kill_on_drop`, and
        // their exit code was lost. Now: panic / signal / clean-exit are
        // all surfaced in the log next to the existing supervisor warns.
        let kill_signal = Arc::new(Notify::new());
        let observer_task = tokio::spawn(child_observer_task(
            child,
            plugin_name.clone(),
            kill_signal.clone(),
        ));

        Ok(PluginHandle {
            inner: Arc::new(HandleInner {
                name: plugin_name,
                manifest,
                auth_token,
                next_request_id: AtomicU64::new(1),
                pending,
                writer_tx,
                inbound_rx: Mutex::new(Some(inbound_rx)),
                tasks: Mutex::new(Some(vec![writer_handle, reader_handle, stderr_handle])),
                kill_signal,
                observer_task: Mutex::new(Some(observer_task)),
                shutdown_called: Mutex::new(false),
                approval_registry,
                advertised_tools,
                advertised_commands,
            }),
        })
    }

    pub fn name(&self) -> &str {
        &self.inner.name
    }

    pub fn manifest(&self) -> &PluginManifest {
        &self.inner.manifest
    }

    /// Take ownership of the inbound event stream. Can only be called once.
    pub async fn take_inbound(&self) -> Option<mpsc::Receiver<InboundEvent>> {
        self.inner.inbound_rx.lock().await.take()
    }

    /// Issue a typed request. Awaits the matching response, with a default
    /// 30s timeout. Use [`call_method_with_timeout`](Self::call_method_with_timeout)
    /// for longer operations (e.g. `approval.present` waits up to 5min,
    /// but the *response* to that method should still be quick — only the
    /// later `event.approval_callback` arrives slowly).
    pub async fn call_method<P, R>(&self, method: &str, params: P) -> ChannelResult<R>
    where
        P: Serialize,
        R: DeserializeOwned,
    {
        let value = serde_json::to_value(params)?;
        let result = self.call_raw(method, Some(value), DEFAULT_CALL_TIMEOUT).await?;
        let typed: R = serde_json::from_value(result)?;
        Ok(typed)
    }

    pub async fn call_method_with_timeout<P, R>(
        &self,
        method: &str,
        params: P,
        timeout: Duration,
    ) -> ChannelResult<R>
    where
        P: Serialize,
        R: DeserializeOwned,
    {
        let value = serde_json::to_value(params)?;
        let result = self.call_raw(method, Some(value), timeout).await?;
        let typed: R = serde_json::from_value(result)?;
        Ok(typed)
    }

    async fn call_raw(
        &self,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> ChannelResult<Value> {
        let id = RequestId::Number(
            self.inner.next_request_id.fetch_add(1, Ordering::Relaxed) as i64,
        );
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().await.insert(id.clone(), tx);

        let request = JsonRpcRequest::new(id.clone(), method, params);
        if self
            .inner
            .writer_tx
            .send(JsonRpcMessage::Request(request))
            .await
            .is_err()
        {
            self.inner.pending.lock().await.remove(&id);
            return Err(ChannelError::SendClosed);
        }

        let resp = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(resp)) => resp,
            Ok(Err(_)) => {
                self.inner.pending.lock().await.remove(&id);
                return Err(ChannelError::Disconnected);
            }
            Err(_) => {
                self.inner.pending.lock().await.remove(&id);
                return Err(ChannelError::Timeout);
            }
        };

        if let Some(err) = resp.error {
            return Err(ChannelError::Plugin {
                code: err.code,
                message: err.message,
            });
        }
        Ok(resp.result.unwrap_or(Value::Null))
    }

    // Convenience helpers for the common methods.

    pub async fn ping(&self) -> ChannelResult<Value> {
        self.call_raw(host_to_plugin::HEALTH_PING, None, Duration::from_secs(5))
            .await
    }

    pub async fn send_message(
        &self,
        params: MessageSendParams,
    ) -> ChannelResult<MessageSendResult> {
        self.call_method(host_to_plugin::MESSAGE_SEND, params).await
    }

    /// Update a previously-sent message in place. Used to render typing
    /// deltas as the LLM streams: the dispatcher's first delta becomes
    /// a `message.send` whose `message_id` is then fed to subsequent
    /// `update_message` calls.
    pub async fn update_message(
        &self,
        params: MessageUpdateParams,
    ) -> ChannelResult<()> {
        let _: Value = self
            .call_method(host_to_plugin::MESSAGE_UPDATE, params)
            .await?;
        Ok(())
    }

    pub async fn present_approval(
        &self,
        params: ApprovalPresentParams,
    ) -> ChannelResult<Value> {
        let value = serde_json::to_value(params)?;
        self.call_raw(
            host_to_plugin::APPROVAL_PRESENT,
            Some(value),
            DEFAULT_CALL_TIMEOUT,
        )
        .await
    }

    /// Ask the plugin for an approval decision and wait for the user's
    /// response. Returns when the plugin sends `event.approval_callback`
    /// for the matching token, or the timeout elapses.
    ///
    /// Generates a fresh `callback_token` per call; callers should not
    /// pre-set `params.callback_token` (it's overwritten).
    pub async fn request_approval(
        &self,
        tenant_id: String,
        chat_id: String,
        request_text: String,
        timeout: Duration,
    ) -> ChannelResult<ApprovalDecision> {
        let token = generate_token();
        let (tx, rx) = oneshot::channel();
        self.inner.approval_registry.register(token.clone(), tx);

        let params = ApprovalPresentParams {
            tenant_id,
            chat_id,
            request: request_text,
            options: vec![
                "allow".into(),
                "deny".into(),
                "allow_once".into(),
                "allow_always".into(),
            ],
            callback_token: token.clone(),
            timeout_sec: timeout.as_secs(),
        };

        // The response to `approval.present` is just an ack — the actual
        // decision arrives later via `event.approval_callback`. We give
        // the plugin a short window to ack the present call so we know
        // the request was at least delivered.
        let ack = self
            .call_raw(
                host_to_plugin::APPROVAL_PRESENT,
                Some(serde_json::to_value(params)?),
                Duration::from_secs(10),
            )
            .await;
        if let Err(e) = ack {
            // Plugin didn't accept the call; clean up and bubble up.
            let _ = self.inner.approval_registry.take(&token);
            return Err(e);
        }

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(decision)) => Ok(decision),
            Ok(Err(_)) => {
                let _ = self.inner.approval_registry.take(&token);
                Err(ChannelError::Disconnected)
            }
            Err(_) => {
                let _ = self.inner.approval_registry.take(&token);
                Err(ChannelError::Timeout)
            }
        }
    }

    /// Upload a file from the engine side and instruct the plugin to
    /// deliver it to the user's IM channel. Bytes are base64-encoded
    /// for JSON-RPC transit; plugins decode + call the platform's
    /// own upload/send endpoints. Returns the platform-side message
    /// id of the resulting file message.
    pub async fn file_upload(
        &self,
        tenant_id: String,
        chat_id: String,
        filename: String,
        mime_type: String,
        bytes: &[u8],
        idempotency_key: Option<String>,
    ) -> ChannelResult<FileUploadResult> {
        let params = FileUploadParams {
            tenant_id,
            chat_id,
            filename,
            mime_type,
            bytes_base64: data_encoding::BASE64.encode(bytes),
            idempotency_key,
        };
        self.call_method(host_to_plugin::FILE_UPLOAD, params).await
    }

    /// Download an attachment by id. Returns the file bytes (base64
    /// decoded), the plugin-reported filename, and MIME type. Used by
    /// the dispatcher to feed user-uploaded files into the bulk import
    /// pipeline.
    pub async fn file_download(
        &self,
        params: FileDownloadParams,
    ) -> ChannelResult<(Vec<u8>, String, String)> {
        let result: FileDownloadResult = self
            .call_method(host_to_plugin::FILE_DOWNLOAD, params)
            .await?;
        // `data-encoding::BASE64` is already in the dep graph (we use
        // it elsewhere for plugin-token gen) — reuse it instead of
        // pulling in a second base64 crate.
        let bytes = data_encoding::BASE64
            .decode(result.bytes_base64.as_bytes())
            .map_err(|e| {
                crate::error::ChannelError::Other(format!(
                    "file.download: invalid base64 payload: {e}"
                ))
            })?;
        Ok((bytes, result.filename, result.mime_type))
    }

    /// Snapshot of the tools the plugin has advertised since spawn. Cheap —
    /// clones the `ToolAdvertiseParams` set under a brief lock. Engine-side
    /// composition (`LayeredToolFactory`) calls this per turn, so plugins
    /// adding/replacing tools at runtime are picked up on the next user
    /// message without restart.
    pub async fn advertised_tools(&self) -> Vec<snaca_channel_protocol::methods::ToolAdvertiseParams> {
        self.inner.advertised_tools.lock().await.values().cloned().collect()
    }

    /// Snapshot of advertised IM commands. Engine-side command dispatch is
    /// a follow-up; this is currently surfaced via the admin API only.
    pub async fn advertised_commands(&self) -> Vec<snaca_channel_protocol::methods::CommandAdvertiseParams> {
        self.inner.advertised_commands.lock().await.values().cloned().collect()
    }

    /// Invoke a plugin-supplied tool by its plugin-side name (i.e. the
    /// unqualified name the plugin advertised, *not* the `plugin__…` qualified
    /// form the engine uses). The wrapper [`crate::plugin_tool::PluginTool`]
    /// strips the prefix before calling.
    ///
    /// Default 30s timeout; tools that do real work should advertise that
    /// expectation in their description so users tolerate latency.
    pub async fn invoke_tool(
        &self,
        name: impl Into<String>,
        arguments: Value,
    ) -> ChannelResult<snaca_channel_protocol::methods::ToolInvokeResult> {
        let params = snaca_channel_protocol::methods::ToolInvokeParams {
            name: name.into(),
            arguments,
        };
        self.call_method(host_to_plugin::TOOL_INVOKE, params).await
    }

    /// Invoke a plugin-supplied IM slash command. `arguments` is the raw
    /// text the user typed after the command name (e.g. for `/ping hello`
    /// it's `"hello"`).
    pub async fn invoke_command(
        &self,
        tenant_id: impl Into<String>,
        chat_id: impl Into<String>,
        user_id: impl Into<String>,
        name: impl Into<String>,
        arguments: impl Into<String>,
    ) -> ChannelResult<snaca_channel_protocol::methods::CommandInvokeResult> {
        let params = snaca_channel_protocol::methods::CommandInvokeParams {
            tenant_id: tenant_id.into(),
            chat_id: chat_id.into(),
            user_id: user_id.into(),
            name: name.into(),
            arguments: arguments.into(),
        };
        self.call_method(host_to_plugin::COMMAND_INVOKE, params)
            .await
    }

    pub async fn acknowledge(&self, event_id: impl Into<String>) -> ChannelResult<()> {
        let params = AcknowledgeParams {
            event_id: event_id.into(),
        };
        self.call_method::<_, Value>(host_to_plugin::ACKNOWLEDGE, params)
            .await?;
        Ok(())
    }

    /// Send `shutdown`, await ack with short timeout, then wait for the child
    /// to exit. Idempotent; subsequent calls return `Ok` immediately.
    ///
    /// Reaping is performed by the `child_observer_task` (which owns the
    /// `Child` handle): we either let the plugin exit cleanly in response
    /// to the `shutdown` RPC, or signal `kill_signal` for the observer
    /// to force-kill it, then join the observer so this method only
    /// returns once the OS has reaped the process.
    pub async fn shutdown(&self) -> ChannelResult<()> {
        {
            let mut flag = self.inner.shutdown_called.lock().await;
            if *flag {
                return Ok(());
            }
            *flag = true;
        }

        // Best-effort: send shutdown request. If plugin is already gone we
        // skip and proceed to reaping.
        let _ = self
            .call_raw(host_to_plugin::SHUTDOWN, None, Duration::from_secs(5))
            .await;

        // Drop writer_tx by aborting the writer task; this closes child stdin.
        if let Some(tasks) = self.inner.tasks.lock().await.take() {
            for t in &tasks {
                t.abort();
            }
        }

        // Signal the observer to force-kill if the child hasn't already
        // exited (Notify is a no-op when nobody's waiting, which is the
        // case if `child.wait()` already won the observer's select arm).
        self.inner.kill_signal.notify_waiters();
        if let Some(handle) = self.inner.observer_task.lock().await.take() {
            let _ = handle.await;
        }

        Ok(())
    }
}

/// Sole owner of the child `Child` handle, post-handshake. Waits for
/// the child to exit either on its own or in response to the
/// `kill_signal` from `shutdown()`. On exit, logs the `ExitStatus` —
/// the only place in the host where we see signal / exit code numbers.
async fn child_observer_task(mut child: Child, plugin: String, kill_signal: Arc<Notify>) {
    let exit_result = tokio::select! {
        // Common path: plugin died on its own (panic, exit, signal).
        r = child.wait() => r,
        // Graceful shutdown path: shutdown() asked us to force kill if
        // the child hadn't exited yet.
        _ = kill_signal.notified() => {
            let _ = child.start_kill();
            child.wait().await
        }
    };
    match exit_result {
        Ok(status) => {
            let code = status.code();
            #[cfg(unix)]
            let signal = std::os::unix::process::ExitStatusExt::signal(&status);
            #[cfg(not(unix))]
            let signal: Option<i32> = None;
            if status.success() {
                info!(
                    plugin=%plugin,
                    code=?code,
                    "plugin process exited cleanly"
                );
            } else {
                // Signal-terminated plugins (panic → SIGABRT; OOM →
                // SIGKILL; segfault → SIGSEGV) and non-zero exit codes
                // both land here. Surface both fields so an operator
                // can map e.g. signal=6 to "panic" or signal=9 to
                // "OOM-killed". Plugin's own stderr is forwarded via
                // [`stderr_task`] above — read those lines for the
                // panic backtrace / "Killed" message.
                warn!(
                    plugin=%plugin,
                    code=?code,
                    signal=?signal,
                    "plugin process exited unexpectedly — check forwarded stderr lines above for the underlying error"
                );
            }
        }
        Err(e) => {
            warn!(plugin=%plugin, error=%e, "failed to reap plugin process");
        }
    }
}

async fn handshake(
    pending: &Arc<Mutex<HashMap<RequestId, oneshot::Sender<JsonRpcResponse>>>>,
    writer_tx: &mpsc::Sender<JsonRpcMessage>,
    plugin_config: Option<Value>,
) -> ChannelResult<PluginManifest> {
    let id = RequestId::Number(0);
    let (tx, rx) = oneshot::channel();
    pending.lock().await.insert(id.clone(), tx);

    let params = InitializeParams {
        protocol_version: PROTOCOL_VERSION.to_string(),
        config: plugin_config,
    };
    let request = JsonRpcRequest::new(
        id.clone(),
        host_to_plugin::INITIALIZE,
        Some(serde_json::to_value(params)?),
    );

    writer_tx
        .send(JsonRpcMessage::Request(request))
        .await
        .map_err(|_| ChannelError::SendClosed)?;

    let resp = match tokio::time::timeout(HANDSHAKE_TIMEOUT, rx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => {
            pending.lock().await.remove(&id);
            return Err(ChannelError::Disconnected);
        }
        Err(_) => {
            pending.lock().await.remove(&id);
            return Err(ChannelError::Timeout);
        }
    };

    if let Some(err) = resp.error {
        return Err(ChannelError::Handshake(format!(
            "plugin returned error {}: {}",
            err.code, err.message
        )));
    }
    let manifest: PluginManifest = serde_json::from_value(resp.result.unwrap_or(Value::Null))
        .map_err(|e| ChannelError::Handshake(format!("malformed manifest: {e}")))?;

    if !manifest.protocol_version.starts_with("1.") {
        return Err(ChannelError::Handshake(format!(
            "unsupported plugin protocol version: {}",
            manifest.protocol_version
        )));
    }

    Ok(manifest)
}

async fn writer_task(
    mut stdin: ChildStdin,
    mut rx: mpsc::Receiver<JsonRpcMessage>,
    plugin: String,
) {
    while let Some(msg) = rx.recv().await {
        let bytes = match codec::encode(&msg) {
            Ok(b) => b,
            Err(e) => {
                error!(plugin=%plugin, error=%e, "failed to encode outbound message");
                continue;
            }
        };
        if let Err(e) = stdin.write_all(&bytes).await {
            warn!(plugin=%plugin, error=%e, "failed writing to plugin stdin");
            break;
        }
        if let Err(e) = stdin.flush().await {
            warn!(plugin=%plugin, error=%e, "failed flushing plugin stdin");
            break;
        }
    }
    debug!(plugin=%plugin, "writer task ended");
}

// 9 args is over clippy's 7 default. Threading these through a struct
// is a bigger refactor than warranted for a single internal task fn —
// the names are descriptive and there's only one call site (`spawn`).
#[allow(clippy::too_many_arguments)]
async fn reader_task(
    stdout: ChildStdout,
    pending: Arc<Mutex<HashMap<RequestId, oneshot::Sender<JsonRpcResponse>>>>,
    inbound_tx: mpsc::Sender<InboundEvent>,
    writer_tx: mpsc::Sender<JsonRpcMessage>,
    expected_token: String,
    plugin: String,
    approval_registry: Arc<ApprovalRegistry>,
    advertised_tools: Arc<Mutex<HashMap<String, ToolAdvertiseParams>>>,
    advertised_commands: Arc<Mutex<HashMap<String, CommandAdvertiseParams>>>,
) {
    let mut reader = BufReader::new(stdout).lines();
    loop {
        let line = match reader.next_line().await {
            Ok(Some(l)) => l,
            Ok(None) => {
                debug!(plugin=%plugin, "plugin stdout closed");
                break;
            }
            Err(e) => {
                warn!(plugin=%plugin, error=%e, "error reading plugin stdout");
                break;
            }
        };

        let msg = match codec::decode(line.as_bytes()) {
            Ok(m) => m,
            Err(codec::CodecError::EmptyFrame) => continue,
            Err(e) => {
                warn!(plugin=%plugin, error=%e, line=%line, "failed to decode inbound frame");
                continue;
            }
        };

        match msg {
            JsonRpcMessage::Response(resp) => {
                let mut map = pending.lock().await;
                if let Some(tx) = map.remove(&resp.id) {
                    let _ = tx.send(resp);
                } else {
                    warn!(plugin=%plugin, "response with unknown request id");
                }
            }
            JsonRpcMessage::Notification(n) => {
                // approval callbacks are routed directly to the approval
                // registry; everything else flows to the inbound stream
                // for the dispatcher.
                if n.method == plugin_to_host::EVENT_APPROVAL_CALLBACK {
                    handle_approval_callback(
                        n,
                        &expected_token,
                        &plugin,
                        &approval_registry,
                        &inbound_tx,
                    )
                    .await;
                    continue;
                }
                match parse_inbound(n, &expected_token, &plugin) {
                    Ok(event) => {
                        // Bounded send — backpressure: a slow
                        // dispatcher blocks the stdout reader,
                        // which in turn stalls plugin writes
                        // (plugin's stdout fills, kernel pushes
                        // back). Better than buffering an unbounded
                        // queue on our heap. send().is_err() means
                        // the receiver has been dropped (plugin
                        // shutdown raced with this event).
                        if inbound_tx.send(event).await.is_err() {
                            debug!(plugin=%plugin, "inbound channel closed");
                            break;
                        }
                    }
                    Err(reason) => {
                        warn!(plugin=%plugin, reason=%reason, "dropped inbound notification");
                    }
                }
            }
            JsonRpcMessage::Request(req) => {
                // Plugin -> host requests. tool.advertise / command.advertise
                // land here: we validate auth, log the registration, and ack
                // with `{}`. Engine integration (mirroring into ToolRegistry
                // / IM-command dispatcher) is a follow-up — the wire path is
                // exercised so plugin authors can develop against it now.
                let response = match req.method.as_str() {
                    plugin_to_host::TOOL_ADVERTISE => handle_tool_advertise(
                        req.clone(),
                        &expected_token,
                        &plugin,
                        &advertised_tools,
                    )
                    .await,
                    plugin_to_host::COMMAND_ADVERTISE => handle_command_advertise(
                        req.clone(),
                        &expected_token,
                        &plugin,
                        &advertised_commands,
                    )
                    .await,
                    other => {
                        debug!(plugin=%plugin, method=%other, "plugin -> host request: not implemented");
                        JsonRpcResponse::err(
                            req.id.clone(),
                            JsonRpcError::new(
                                ErrorCode::MethodNotFound.as_i32(),
                                "method_not_found",
                            ),
                        )
                    }
                };
                if writer_tx
                    .send(JsonRpcMessage::Response(response))
                    .await
                    .is_err()
                {
                    break;
                }
            }
        }
    }
    debug!(plugin=%plugin, "reader task ended");
}

async fn stderr_task(stderr: ChildStderr, plugin: String) {
    let mut reader = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = reader.next_line().await {
        info!(plugin=%plugin, "{}", line);
    }
    debug!(plugin=%plugin, "stderr task ended");
}

/// Try to resolve a pending approval; if no one is waiting for the token
/// (legitimate edge case: the host already timed out), log + ignore.
/// Drops the callback rather than forwarding to the inbound stream — the
/// dispatcher should never see resolved approvals.
async fn handle_approval_callback(
    n: JsonRpcNotification,
    expected_token: &str,
    plugin: &str,
    registry: &ApprovalRegistry,
    inbound_tx: &mpsc::Sender<InboundEvent>,
) {
    let params: ApprovalCallbackParams = match deserialize_params(n.params.clone(), &n.method) {
        Ok(p) => p,
        Err(reason) => {
            warn!(plugin=%plugin, reason=%reason, "approval callback: bad params");
            return;
        }
    };
    if check_auth(&params.auth, expected_token).is_err() {
        warn!(plugin=%plugin, "approval callback: auth token mismatch; dropping");
        return;
    }
    if let Some(tx) = registry.take(&params.callback_token) {
        // Send the decision; receiver may already be gone (turn timed out)
        // — that's fine, we still consumed the slot.
        let _ = tx.send(params.decision);
        return;
    }
    // No pending request for this token — surface as InboundEvent so an
    // operator can see it (e.g. user clicked an old card after restart).
    warn!(
        plugin=%plugin,
        token=%params.callback_token,
        "approval callback with no pending request; forwarding to inbound for visibility"
    );
    let event = InboundEvent::ApprovalCallback {
        plugin: plugin.to_string(),
        params,
    };
    let _ = inbound_tx.send(event).await;
}

fn parse_inbound(
    n: JsonRpcNotification,
    expected_token: &str,
    plugin: &str,
) -> Result<InboundEvent, String> {
    let method = n.method.clone();
    match n.method.as_str() {
        plugin_to_host::EVENT_MESSAGE_RECEIVED => {
            let params: MessageReceivedParams =
                deserialize_params(n.params, &method)?;
            check_auth(&params.auth, expected_token)?;
            Ok(InboundEvent::MessageReceived {
                plugin: plugin.to_string(),
                params,
            })
        }
        plugin_to_host::EVENT_MESSAGE_RECALLED => {
            let params: MessageRecalledParams =
                deserialize_params(n.params, &method)?;
            check_auth(&params.auth, expected_token)?;
            Ok(InboundEvent::MessageRecalled {
                plugin: plugin.to_string(),
                params,
            })
        }
        plugin_to_host::EVENT_APPROVAL_CALLBACK => {
            let params: ApprovalCallbackParams =
                deserialize_params(n.params, &method)?;
            check_auth(&params.auth, expected_token)?;
            Ok(InboundEvent::ApprovalCallback {
                plugin: plugin.to_string(),
                params,
            })
        }
        plugin_to_host::EVENT_ERROR => {
            let raw = n.params.unwrap_or(Value::Null);
            let auth = raw
                .get("auth")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            check_auth(&auth, expected_token)?;
            let severity = raw
                .get("severity")
                .and_then(Value::as_str)
                .unwrap_or("error")
                .to_string();
            let message = raw
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let data = raw.get("data").cloned();
            Ok(InboundEvent::PluginError {
                plugin: plugin.to_string(),
                severity,
                message,
                data,
            })
        }
        plugin_to_host::LOG_WRITE => {
            let params: LogWriteParams = deserialize_params(n.params, &method)?;
            check_auth(&params.auth, expected_token)?;
            Ok(InboundEvent::Log {
                plugin: plugin.to_string(),
                params,
            })
        }
        other => Ok(InboundEvent::Unknown {
            plugin: plugin.to_string(),
            method: other.to_string(),
            params: n.params,
        }),
    }
}

fn deserialize_params<T: DeserializeOwned>(
    params: Option<Value>,
    method: &str,
) -> Result<T, String> {
    let value = params.ok_or_else(|| format!("{method}: missing params"))?;
    serde_json::from_value(value).map_err(|e| format!("{method}: {e}"))
}

fn check_auth(provided: &str, expected: &str) -> Result<(), String> {
    if provided == expected {
        Ok(())
    } else {
        Err("auth_failed".into())
    }
}

/// Reply for `tool.advertise`. After auth check, store the params keyed by
/// tool name in the per-plugin advertised-tools registry. Engine reads this
/// each turn via `LayeredToolFactory` and surfaces the tool to the LLM.
/// Re-advertise of the same name overwrites — supports plugins that hot-
/// rebind tool descriptions/schemas at runtime.
async fn handle_tool_advertise(
    req: JsonRpcRequest,
    expected_token: &str,
    plugin: &str,
    storage: &Arc<Mutex<HashMap<String, ToolAdvertiseParams>>>,
) -> JsonRpcResponse {
    let id = req.id.clone();
    let params: ToolAdvertiseParams =
        match deserialize_params(req.params, plugin_to_host::TOOL_ADVERTISE) {
            Ok(p) => p,
            Err(reason) => {
                warn!(plugin=%plugin, reason=%reason, "tool.advertise: bad params");
                return JsonRpcResponse::err(
                    id,
                    JsonRpcError::new(ErrorCode::InvalidParams.as_i32(), reason),
                );
            }
        };
    if let Err(reason) = check_auth(&params.auth, expected_token) {
        warn!(plugin=%plugin, "tool.advertise: {}", reason);
        return JsonRpcResponse::err(
            id,
            JsonRpcError::new(ErrorCode::AuthFailed.as_i32(), "auth_failed"),
        );
    }
    let name = params.name.clone();
    let is_read_only = params.is_read_only;
    storage.lock().await.insert(name.clone(), params);
    info!(
        plugin = %plugin,
        tool = %name,
        is_read_only,
        "tool.advertise: registered"
    );
    JsonRpcResponse::ok(id, serde_json::json!({}))
}

/// Reply for `command.advertise`. Same shape as `tool.advertise` — engine-side
/// IM-command routing is a follow-up; we keep the registration so admin
/// surfaces (`/admin/plugins/<name>`) can list what each plugin offers.
async fn handle_command_advertise(
    req: JsonRpcRequest,
    expected_token: &str,
    plugin: &str,
    storage: &Arc<Mutex<HashMap<String, CommandAdvertiseParams>>>,
) -> JsonRpcResponse {
    let id = req.id.clone();
    let params: CommandAdvertiseParams =
        match deserialize_params(req.params, plugin_to_host::COMMAND_ADVERTISE) {
            Ok(p) => p,
            Err(reason) => {
                warn!(plugin=%plugin, reason=%reason, "command.advertise: bad params");
                return JsonRpcResponse::err(
                    id,
                    JsonRpcError::new(ErrorCode::InvalidParams.as_i32(), reason),
                );
            }
        };
    if let Err(reason) = check_auth(&params.auth, expected_token) {
        warn!(plugin=%plugin, "command.advertise: {}", reason);
        return JsonRpcResponse::err(
            id,
            JsonRpcError::new(ErrorCode::AuthFailed.as_i32(), "auth_failed"),
        );
    }
    let name = params.name.clone();
    storage.lock().await.insert(name.clone(), params);
    info!(plugin = %plugin, command = %name, "command.advertise: registered");
    JsonRpcResponse::ok(id, serde_json::json!({}))
}

/// Generate a 32-byte random token, base64url-no-pad encoded.
fn generate_token() -> String {
    // Use Uuid for cheap randomness — combine two v4 UUIDs to fill 32 bytes,
    // then base64url-no-pad. Adequate for plugin authentication; not used as
    // a key for cryptographic operations.
    let a = Uuid::new_v4();
    let b = Uuid::new_v4();
    let mut buf = [0u8; 32];
    buf[..16].copy_from_slice(a.as_bytes());
    buf[16..].copy_from_slice(b.as_bytes());
    BASE64URL_NOPAD.encode(&buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_has_expected_length() {
        let t = generate_token();
        // 32 bytes in base64url no-pad = 43 chars.
        assert_eq!(t.len(), 43);
        // No padding chars.
        assert!(!t.contains('='));
    }

    #[test]
    fn auth_check_rejects_mismatch() {
        assert!(check_auth("a", "a").is_ok());
        assert!(check_auth("a", "b").is_err());
        assert!(check_auth("", "x").is_err());
    }

    #[test]
    fn parse_inbound_recognises_message_recalled() {
        let n = JsonRpcNotification {
            jsonrpc: "2.0".into(),
            method: plugin_to_host::EVENT_MESSAGE_RECALLED.into(),
            params: Some(serde_json::json!({
                "auth": "tok",
                "tenant_id": "t",
                "chat_id": "chat-1",
                "user_id": "user-1",
                "message_id": "m-1",
                "recalled_at": "2026-05-14T10:00:00Z",
            })),
        };
        let ev = parse_inbound(n, "tok", "lark").expect("parse ok");
        match ev {
            InboundEvent::MessageRecalled { plugin, params } => {
                assert_eq!(plugin, "lark");
                assert_eq!(params.chat_id, "chat-1");
                assert_eq!(params.message_id, "m-1");
            }
            other => panic!("expected MessageRecalled, got {other:?}"),
        }
    }

    #[test]
    fn parse_inbound_rejects_recall_with_bad_auth() {
        let n = JsonRpcNotification {
            jsonrpc: "2.0".into(),
            method: plugin_to_host::EVENT_MESSAGE_RECALLED.into(),
            params: Some(serde_json::json!({
                "auth": "wrong",
                "tenant_id": "t",
                "chat_id": "chat-1",
                "user_id": "user-1",
                "message_id": "m-1",
                "recalled_at": "2026-05-14T10:00:00Z",
            })),
        };
        assert!(parse_inbound(n, "tok", "lark").is_err());
    }
}
