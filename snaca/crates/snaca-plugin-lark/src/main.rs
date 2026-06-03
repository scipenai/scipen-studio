//! `snaca-plugin-lark` — Lark/Feishu IM channel plugin for SNACA.
//!
//! Speaks the SNACA channel-protocol (JSON-RPC 2.0 over stdio) to the
//! engine's `snaca-channel-host`; on the upstream side opens a
//! WebSocket long-poll to Lark's gateway and a reqwest pool for the
//! outbound Open API calls.
//!
//! ## Configuration
//!
//! Read entirely from environment variables stamped on the plugin by
//! the host's `[[plugins]] [plugins.env]` section in `snaca.toml`:
//!
//! - `LARK_APP_ID`        (required)
//! - `LARK_APP_SECRET`    (required)
//! - `LARK_BASE_URL`      (optional, default `https://open.feishu.cn`)
//! - `LARK_TENANT_ID`     (optional, default empty — host falls back
//!   to its configured default)
//! - `SNACA_PLUGIN_TOKEN` (injected by the host; stamped onto every
//!   plugin → host notification for auth)
//!
//! ## Architecture
//!
//! Three tasks share one stdout writer via a `mpsc::UnboundedSender`:
//!
//! 1. **stdin reader** — decodes JSON-RPC frames from stdin, dispatches
//!    `host_to_plugin` requests, writes responses through the writer.
//! 2. **stdout writer** — single consumer of the mpsc; serialises
//!    every outbound frame so two tasks can never interleave bytes
//!    on stdout.
//! 3. **Lark WS pump** — `LarkWsClient::open(...)` blocks pumping
//!    inbound payloads; for each `im.message.receive_v1` we translate
//!    to a SNACA `event.message_received` and push it through the
//!    writer.
//!
//! Logs go to **stderr only**. Stdout is reserved for protocol frames.
//!
//! ## Scope (M1 of M3-real-test)
//!
//! - Inbound: text messages from p2p + group chats. Image/file/etc
//!   are dropped with a debug log (no attachment plumbing yet).
//! - Outbound: text via `message.send`; `message.update` lands as a
//!   warning + falls back to a fresh send (Lark caps update QPS and
//!   we don't have message-id correlation wired yet).
//! - Approval cards: stub — `approval.present` returns
//!   `MethodNotFound` so the host's gate falls back to its timeout
//!   default. Cards are M2 polish.

use anyhow::{Context, Result};
use chrono::Utc;
use serde_json::{json, Value};
use snaca_channel_protocol::{
    codec,
    errors::ErrorCode,
    jsonrpc::{
        JsonRpcError, JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse,
        RequestId,
    },
    manifest::{ChannelCapabilities, PluginInfo, PluginManifest},
    methods::{
        host_to_plugin, plugin_to_host, Attachment, FileUploadParams, FileUploadResult,
        InitializeParams, MessageReceivedParams, MessageRecalledParams, MessageSendParams,
        MessageSendResult,
    },
    PROTOCOL_VERSION,
};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, OnceCell};
use tracing::{debug, error, info, warn};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    install_panic_hook();
    // rustls 0.23+ refuses to pick a CryptoProvider implicitly; install
    // ring explicitly before any TLS handshake fires (reqwest pool +
    // openlark WS both go through rustls). Idempotent — `install_default`
    // returns Err if one is already installed, which we treat as fine.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let cfg = LarkConfig::from_env().context("loading Lark config from env")?;
    info!(app_id = %cfg.app_id, base_url = %cfg.base_url, "starting snaca-plugin-lark");

    // mpsc fans every outbound frame into one writer task.
    let (tx, rx) = mpsc::unbounded_channel::<JsonRpcMessage>();
    tokio::spawn(stdout_writer(rx));

    // Wait for the host's `initialize` request before pumping the
    // Lark WS — the protocol forbids sending notifications before
    // initialize completes, and the host injects `SNACA_PLUGIN_TOKEN`
    // we need on every notification.
    wait_for_initialize(&cfg, &tx).await?;

    // Now spawn the WS pump. Errors there are logged but the plugin
    // keeps the JSON-RPC channel open so the host can still call
    // `health.ping` / `shutdown`.
    let lark_cfg = cfg.clone();
    let lark_tx = tx.clone();
    tokio::spawn(async move {
        if let Err(e) = run_lark_ws(lark_cfg, lark_tx).await {
            error!(error = %e, "Lark WS pump exited with error");
        }
    });

    // The stdin loop runs to completion — when the host closes stdin
    // (e.g. after `shutdown`) we exit cleanly.
    stdin_loop(cfg, tx).await
}

fn init_tracing() {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    // ANSI off: stderr is captured by `snaca-channel-host`'s `stderr_task`
    // and re-logged through the host's own tracing layer. Leaving colour
    // escapes in the line means the host receives raw 0x1B bytes and
    // either passes them through (showing as actual colours, or — when
    // rendered by readers that escape control chars — as literal
    // `\x1b[…m` strings). Plain text is the right default for a pipe.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr)
        .with_target(false)
        .with_ansi(false)
        .try_init();
}

/// Replace the default panic hook with one that funnels panics through
/// tracing (and therefore through the host's stderr-forwarding pipeline)
/// with structured fields. Without this, panic messages still go to
/// stderr via Rust's default writer, but as a single multi-line blob
/// that's awkward to grep alongside structured tracing output.
///
/// Default RUST_BACKTRACE is forced to "1" when unset so we always get
/// a stack trace — without backtraces, "thread panicked at <file>:<line>"
/// is the only signal we get post-mortem and that's usually not enough
/// to identify the call path.
fn install_panic_hook() {
    if std::env::var_os("RUST_BACKTRACE").is_none() {
        // SAFETY: set_var is sound during single-threaded startup, before
        // any other thread might read the env. We call this from main()
        // before tokio spawns any worker threads.
        // Newer rustc marks `std::env::set_var` as unsafe; use the cfg-gated
        // form to keep us compiling on both old and new toolchains.
        unsafe { std::env::set_var("RUST_BACKTRACE", "1") };
    }
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info
            .payload()
            .downcast_ref::<&'static str>()
            .copied()
            .or_else(|| info.payload().downcast_ref::<String>().map(|s| s.as_str()))
            .unwrap_or("<non-string panic payload>");
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown location>".to_string());
        let thread = std::thread::current()
            .name()
            .unwrap_or("<unnamed>")
            .to_string();
        // ERROR level so it's never filtered out, regardless of
        // RUST_LOG. Multi-line `payload` (rare) becomes a single-line
        // tracing field — readable enough; the full backtrace follows
        // on stderr via the chained default hook.
        tracing::error!(
            thread = %thread,
            location = %location,
            payload = %payload,
            "PANIC in snaca-plugin-lark"
        );
        // Chain to the prior hook so the default backtrace printer
        // (controlled by RUST_BACKTRACE) still runs.
        prev(info);
    }));
}

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------

#[derive(Debug, Clone)]
struct LarkConfig {
    app_id: String,
    app_secret: String,
    base_url: String,
    tenant_id: String,
    plugin_token: String,
}

impl LarkConfig {
    fn from_env() -> Result<Self> {
        let app_id = std::env::var("LARK_APP_ID")
            .context("LARK_APP_ID must be set in plugins.env")?;
        let app_secret = std::env::var("LARK_APP_SECRET")
            .context("LARK_APP_SECRET must be set in plugins.env")?;
        let base_url = std::env::var("LARK_BASE_URL")
            .unwrap_or_else(|_| "https://open.feishu.cn".to_string());
        let tenant_id = std::env::var("LARK_TENANT_ID").unwrap_or_default();
        let plugin_token = std::env::var("SNACA_PLUGIN_TOKEN").unwrap_or_default();
        Ok(Self {
            app_id,
            app_secret,
            base_url,
            tenant_id,
            plugin_token,
        })
    }
}

// ---------------------------------------------------------------------
// Stdout writer — single consumer of the mpsc.
// ---------------------------------------------------------------------

async fn stdout_writer(mut rx: mpsc::UnboundedReceiver<JsonRpcMessage>) {
    let mut stdout = tokio::io::stdout();
    while let Some(msg) = rx.recv().await {
        let bytes = match codec::encode(&msg) {
            Ok(b) => b,
            Err(e) => {
                error!(error = %e, "encode jsonrpc frame failed; dropping message");
                continue;
            }
        };
        if let Err(e) = stdout.write_all(&bytes).await {
            error!(error = %e, "write stdout failed; aborting writer");
            return;
        }
        if let Err(e) = stdout.flush().await {
            error!(error = %e, "flush stdout failed");
        }
    }
}

// ---------------------------------------------------------------------
// Initialize handshake — runs *before* the WS pump starts.
// ---------------------------------------------------------------------

async fn wait_for_initialize(
    _cfg: &LarkConfig,
    tx: &mpsc::UnboundedSender<JsonRpcMessage>,
) -> Result<()> {
    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin).lines();
    while let Some(line) = reader.next_line().await.context("read stdin")? {
        let msg = match codec::decode(line.as_bytes()) {
            Ok(m) => m,
            Err(codec::CodecError::EmptyFrame) => continue,
            Err(e) => {
                warn!(error = %e, "decode pre-init frame failed; ignoring");
                continue;
            }
        };
        let req = match msg {
            JsonRpcMessage::Request(r) => r,
            other => {
                debug!(?other, "ignoring non-request before initialize");
                continue;
            }
        };
        if req.method != host_to_plugin::INITIALIZE {
            // Reject anything else with NotInitialized so the host
            // knows to send `initialize` first.
            tx.send(JsonRpcMessage::Response(JsonRpcResponse::err(
                req.id,
                JsonRpcError::new(ErrorCode::NotInitialized.as_i32(), "not_initialized"),
            )))
            .ok();
            continue;
        }
        // Best-effort parse; missing fields don't kill init.
        if let Some(params) = req.params.clone() {
            if let Ok(p) = serde_json::from_value::<InitializeParams>(params) {
                debug!(host_protocol = %p.protocol_version, "host initialize");
            }
        }
        let manifest = PluginManifest {
            protocol_version: PROTOCOL_VERSION.to_string(),
            plugin: PluginInfo {
                name: "lark".into(),
                version: env!("CARGO_PKG_VERSION").to_string(),
            },
            tenant_id_format: Some("lark.tenant_key".into()),
            // Only what we actually support today. Cards / approval /
            // file_upload are explicitly false so the host's gate
            // degrades to a text-based fallback instead of dispatching
            // a card we'd silently fail to render.
            capabilities: ChannelCapabilities {
                send_message: true,
                // Plain text only. Lark cards CAN be edited but the
                // PATCH QPS cap (~5/sec/card) makes them too slow as
                // a streaming surface in practice. Instead we mark
                // the user's inbound with an emoji reaction (see
                // `add_inbound_reaction`) and deliver one full reply
                // via `send_message` after the turn completes.
                update_message: false,
                // We send cards specifically for approvals (interactive
                // buttons). Capability is also required so the engine's
                // gate routes through `approval.present` instead of the
                // no-card auto-allow fallback.
                send_card: true,
                interactive_card: true,
                // Outbound files via Lark `/open-apis/im/v1/files` →
                // `/open-apis/im/v1/messages` with msg_type=file. Used by
                // the SendFile tool so the agent can deliver generated
                // artefacts back through chat.
                file_upload: true,
                // We pull file/image attachments via Lark's
                // `/im/v1/messages/{id}/resources/{key}` endpoint and
                // surface them through the standard SNACA import
                // pipeline. The attachment id we hand to the dispatcher
                // encodes both the originating message id and the
                // platform-side file_key so `file.download` is stateless.
                file_download: true,
                supports_thread: false,
                supports_streaming: false,
                max_message_bytes: 30 * 1024,
            },
        };
        tx.send(JsonRpcMessage::Response(JsonRpcResponse::ok(
            req.id,
            serde_json::to_value(manifest).expect("manifest serialises"),
        )))
        .ok();
        info!("initialize handshake complete");
        return Ok(());
    }
    anyhow::bail!("stdin closed before initialize");
}

// ---------------------------------------------------------------------
// Stdin loop — runs after initialize.
// ---------------------------------------------------------------------

async fn stdin_loop(cfg: LarkConfig, tx: mpsc::UnboundedSender<JsonRpcMessage>) -> Result<()> {
    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin).lines();
    let cfg = Arc::new(cfg);
    while let Some(line) = reader.next_line().await.context("read stdin")? {
        let msg = match codec::decode(line.as_bytes()) {
            Ok(m) => m,
            Err(codec::CodecError::EmptyFrame) => continue,
            Err(e) => {
                warn!(error = %e, "decode frame failed; ignoring");
                continue;
            }
        };
        match msg {
            JsonRpcMessage::Request(req) => {
                let cfg = cfg.clone();
                let tx_resp = tx.clone();
                tokio::spawn(async move {
                    let resp = handle_request(cfg, req).await;
                    let _ = tx_resp.send(JsonRpcMessage::Response(resp));
                });
            }
            JsonRpcMessage::Notification(n) => {
                debug!(method = %n.method, "ignoring inbound notification");
            }
            JsonRpcMessage::Response(_) => {
                // We never issue requests *to* the host today; ignore
                // unsolicited responses.
            }
        }
    }
    Ok(())
}

async fn handle_request(cfg: Arc<LarkConfig>, req: JsonRpcRequest) -> JsonRpcResponse {
    let id = req.id.clone();
    match req.method.as_str() {
        host_to_plugin::HEALTH_PING => JsonRpcResponse::ok(id, json!({"pong": true})),
        host_to_plugin::SHUTDOWN => {
            // Host expects an ack; the runtime will tear us down via
            // SIGTERM if we linger.
            tokio::spawn(async {
                tokio::time::sleep(Duration::from_millis(50)).await;
                std::process::exit(0);
            });
            JsonRpcResponse::ok(id, json!({}))
        }
        host_to_plugin::ACKNOWLEDGE => JsonRpcResponse::ok(id, json!({})),
        host_to_plugin::MESSAGE_SEND => handle_message_send(cfg, id, req).await,
        host_to_plugin::MESSAGE_UPDATE => handle_message_update(cfg, id, req).await,
        host_to_plugin::APPROVAL_PRESENT => handle_approval_present(cfg, id, req).await,
        host_to_plugin::FILE_DOWNLOAD => handle_file_download(cfg, id, req).await,
        host_to_plugin::FILE_UPLOAD => handle_file_upload(cfg, id, req).await,
        other => {
            debug!(method = %other, "unsupported method");
            JsonRpcResponse::err(
                id,
                JsonRpcError::new(ErrorCode::MethodNotFound.as_i32(), "method_not_found"),
            )
        }
    }
}

async fn handle_message_send(
    cfg: Arc<LarkConfig>,
    id: RequestId,
    req: JsonRpcRequest,
) -> JsonRpcResponse {
    let params: MessageSendParams = match req.params.and_then(|v| serde_json::from_value(v).ok()) {
        Some(p) => p,
        None => {
            return JsonRpcResponse::err(
                id,
                JsonRpcError::new(
                    ErrorCode::InvalidParams.as_i32(),
                    "invalid message.send params",
                ),
            );
        }
    };
    // The dispatcher passes `chat_id` as the routing target. Lark
    // accepts open_id for p2p and chat_id for groups; we always send
    // back to whatever the inbound event gave us, so the same id is
    // the right `receive_id`. We pick the type heuristically: ids
    // starting with `oc_` are chat ids (groups + ad-hoc), `ou_` are
    // user open ids. Everything else falls back to `chat_id`.
    let receive_id = params.chat_id.clone();
    let receive_id_type = if receive_id.starts_with("ou_") {
        "open_id"
    } else {
        "chat_id"
    };
    // Routing rule:
    //   - `format = "text"`             → plain text (no rendering)
    //   - `format = "card"`             → v1 interactive card. Used by
    //     the streaming/typing path: v1 cards can be patched via
    //     `PATCH /im/v1/messages/{id}`, which is how typewriter
    //     updates work today.
    //   - `format = "markdown"` or default → v2 CardKit card. Renders
    //     `####`/`#####` headings and GFM tables natively. Two-step
    //     send (create card_id → send IM message). Not patchable via
    //     the v1 PATCH endpoint, so streaming paths must keep using
    //     `format = "card"` until v2 streaming is wired.
    let format = params.format.as_deref().unwrap_or("");
    let key = params.idempotency_key.as_deref();
    let result = match format {
        "text" => send_text(&cfg, &receive_id, receive_id_type, &params.content, key).await,
        "card" => send_card(&cfg, &receive_id, receive_id_type, &params.content, key).await,
        _ => send_card_v2(&cfg, &receive_id, receive_id_type, &params.content, key).await,
    };
    match result {
        Ok(message_id) => JsonRpcResponse::ok(
            id,
            serde_json::to_value(MessageSendResult { message_id })
                .expect("MessageSendResult serialises"),
        ),
        Err(e) => {
            warn!(error = %e, "message.send to lark failed");
            JsonRpcResponse::err(
                id,
                JsonRpcError::new(
                    ErrorCode::PlatformError.as_i32(),
                    format!("lark send failed: {e}"),
                ),
            )
        }
    }
}

async fn handle_message_update(
    cfg: Arc<LarkConfig>,
    id: RequestId,
    req: JsonRpcRequest,
) -> JsonRpcResponse {
    let params: snaca_channel_protocol::methods::MessageUpdateParams =
        match req.params.and_then(|v| serde_json::from_value(v).ok()) {
            Some(p) => p,
            None => {
                return JsonRpcResponse::err(
                    id,
                    JsonRpcError::new(
                        ErrorCode::InvalidParams.as_i32(),
                        "invalid message.update params",
                    ),
                );
            }
        };
    match patch_card(&cfg, &params.message_id, &params.content).await {
        Ok(()) => JsonRpcResponse::ok(id, json!({})),
        Err(e) => {
            warn!(error = %e, "message.update to lark failed");
            JsonRpcResponse::err(
                id,
                JsonRpcError::new(
                    ErrorCode::PlatformError.as_i32(),
                    format!("lark update failed: {e}"),
                ),
            )
        }
    }
}

// ---------------------------------------------------------------------
// Lark outbound — POST /open-apis/im/v1/messages with app token.
// ---------------------------------------------------------------------

/// Build the query-string pairs for a Lark message-send call. Lark's
/// `uuid` parameter is the platform-side dedup key — repeated POSTs with
/// the same uuid within 24h return the same `message_id` instead of
/// duplicating the message. The outbox uses its row id here so a retry
/// after a transient transport failure is exactly-once on Lark's side.
fn lark_send_query<'a>(
    receive_id_type: &'a str,
    idempotency_key: Option<&'a str>,
) -> Vec<(&'static str, &'a str)> {
    let mut q: Vec<(&'static str, &'a str)> = vec![("receive_id_type", receive_id_type)];
    if let Some(k) = idempotency_key {
        q.push(("uuid", k));
    }
    q
}

async fn send_text(
    cfg: &LarkConfig,
    receive_id: &str,
    receive_id_type: &str,
    text: &str,
    idempotency_key: Option<&str>,
) -> Result<String> {
    let token = fetch_app_access_token(cfg).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;
    let url = format!(
        "{}/open-apis/im/v1/messages",
        cfg.base_url.trim_end_matches('/')
    );
    let body = json!({
        "receive_id": receive_id,
        "msg_type": "text",
        // Lark expects the content to be a JSON-encoded string, not a nested
        // object. The text body itself goes in `{"text": "..."}`.
        "content": json!({"text": text}).to_string(),
    });
    let resp = client
        .post(url)
        .query(&lark_send_query(receive_id_type, idempotency_key))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .context("POST /im/v1/messages")?;
    let status = resp.status();
    let json: Value = resp.json().await.context("read send response")?;
    if !status.is_success() {
        anyhow::bail!("lark send failed: HTTP {status} body={json}");
    }
    let code = json.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != 0 {
        anyhow::bail!("lark send returned code {code}: {json}");
    }
    let message_id = json
        .pointer("/data/message_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("lark-{}", uuid_short()));
    Ok(message_id)
}

/// Which Lark card schema we're targeting. Affects header rendering
/// and table-conversion default. Keep in sync with [`build_text_card_v1`]
/// / [`build_text_card_v2`] choices in the send paths.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MarkdownMode {
    /// Legacy v1 card schema (`config + elements`). The `markdown`
    /// element renders **none** of `#`..`######` and **no** GFM tables.
    /// We use Unicode bar/chevron prefixes for header visual hierarchy
    /// and convert tables to bullet lists.
    V1,
    /// CardKit v2 schema (`schema: "2.0"` + `body: { elements }`).
    /// Renders `####` and `#####` as visible heading sizes, and renders
    /// GFM tables natively. We demote `# X` → `#### X`, `## X` and
    /// below → `##### X`, and leave tables alone.
    V2,
}

/// Convert standard Markdown ATX headers and GFM tables to formatting
/// the chosen Lark card schema actually renders.
///
/// `mode` selects the rendering target — see [`MarkdownMode`].
///
/// **Tables**: by default v1 converts to bullet lists, v2 keeps native
/// markdown tables. Override either side with `LARK_TABLE_MODE=list`
/// (always convert) or `LARK_TABLE_MODE=native` (always keep raw),
/// useful for debugging or for mobile clients where bullet lists scan
/// better.
///
/// Inside fenced code blocks (lines bracketed by ` ``` `) we leave
/// content untouched: `# comment` is a real shell comment, and the `|`
/// characters inside ASCII art shouldn't be reflowed.
///
/// Setext-style headers (`=====` / `-----` underlines) and lazy headers
/// without a space after `#` are left alone — rare in LLM output.
fn markdown_for_lark(input: &str, mode: MarkdownMode) -> String {
    let mut out = String::with_capacity(input.len() + 32);
    let mut in_fence = false;
    let lines: Vec<&str> = input.split_inclusive('\n').collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let body_no_eol = line.trim_end_matches('\n').trim_end_matches('\r');
        if body_no_eol.trim_start().starts_with("```") {
            in_fence = !in_fence;
            out.push_str(line);
            i += 1;
            continue;
        }
        if in_fence {
            out.push_str(line);
            i += 1;
            continue;
        }
        // Table detection: a contiguous block of `|...|` lines.
        // Two-step decision:
        //   1. Is this the start of a multi-line `|`-block? (need at
        //      least 2 lines; a single `|`-line is just text.)
        //   2. Does the block already include a GFM separator row
        //      (`|---|---|`)? If so it's a real table. If not, the
        //      LLM emitted tabular layout without one — common with
        //      multiplication-chart-style outputs — and we synthesize
        //      a separator after the first row so v2 renders it as a
        //      grid (or v1 flattens it to bullets).
        if looks_like_table_row(body_no_eol)
            && i + 1 < lines.len()
            && looks_like_table_row(
                lines[i + 1].trim_end_matches('\n').trim_end_matches('\r'),
            )
        {
            let mut end = i + 1;
            while end < lines.len() {
                let l = lines[end].trim_end_matches('\n').trim_end_matches('\r');
                if !looks_like_table_row(l) {
                    break;
                }
                end += 1;
            }
            // Take owned strings so we can splice in a synthesised
            // separator row without fighting the borrow checker.
            let mut block: Vec<String> = lines[i..end]
                .iter()
                .map(|s| {
                    s.trim_end_matches('\n').trim_end_matches('\r').to_string()
                })
                .collect();
            let has_sep = block.iter().any(|l| is_table_separator(l));
            if !has_sep {
                // Take the *widest* row as canonical column count so
                // ragged tables (multiplication-chart style) get a
                // header wide enough to cover the bottom rows.
                let cols = block
                    .iter()
                    .map(|l| split_table_row(l).len())
                    .max()
                    .unwrap_or(1)
                    .max(1);
                // Synthesise a numeric header (`| 1 | 2 | … | N |`) plus
                // the separator. Without the header, GFM would treat
                // the LLM's first row as the header, and Lark's
                // renderer fills empty header cells with literal `--`
                // placeholders — exactly the wart that prompted this
                // path. Promoting all LLM rows to body cells keeps
                // their empty entries actually empty.
                let mut hdr = String::with_capacity(cols * 6 + 1);
                hdr.push('|');
                for n in 1..=cols {
                    hdr.push(' ');
                    hdr.push_str(&n.to_string());
                    hdr.push_str(" |");
                }
                let mut sep = String::with_capacity(cols * 4 + 1);
                sep.push('|');
                for _ in 0..cols {
                    sep.push_str("---|");
                }
                block.insert(0, hdr);
                block.insert(1, sep);
            }
            let block_refs: Vec<&str> = block.iter().map(String::as_str).collect();
            if convert_tables_for_mode(mode) {
                out.push_str(&render_table_as_list(&block_refs));
            } else {
                // Native rendering — emit each row verbatim, including
                // the synthesised separator (which Lark needs for v2
                // markdown to recognise the block as a table).
                for l in &block_refs {
                    out.push_str(l);
                    out.push('\n');
                }
                // Trim one trailing newline if the original block didn't
                // end with one — matches caller expectations.
                if !lines[end - 1].ends_with('\n') && out.ends_with('\n') {
                    out.pop();
                }
            }
            // For the list-conversion path, mirror the trailing newline
            // of the original block's last line.
            if convert_tables_for_mode(mode) && lines[end - 1].ends_with('\n') {
                out.push('\n');
            }
            i = end;
            continue;
        }
        // ATX header.
        let stripped = body_no_eol.trim_start();
        let leading_ws_len = body_no_eol.len() - stripped.len();
        let hashes = stripped.chars().take_while(|c| *c == '#').count();
        let is_header =
            (1..=6).contains(&hashes) && stripped.as_bytes().get(hashes) == Some(&b' ');
        if !is_header {
            out.push_str(line);
            i += 1;
            continue;
        }
        let body = stripped[hashes + 1..].trim_end();
        if body.is_empty() {
            out.push_str(line);
            i += 1;
            continue;
        }
        out.push_str(&body_no_eol[..leading_ws_len]);
        match mode {
            MarkdownMode::V1 => {
                // v1 cards render no `#` levels at all; fall back to a
                // Unicode prefix + bold so the heading stays visually
                // distinct from inline bold elsewhere in the body.
                let prefix = match hashes {
                    1 => "▎ ",
                    2 => "▸ ",
                    _ => "",
                };
                out.push_str(prefix);
                out.push_str("**");
                out.push_str(body);
                out.push_str("**");
            }
            MarkdownMode::V2 => {
                // CardKit v2 renders `####` and `#####` as visible
                // heading sizes. Demote everything to those two so we
                // get the typography Lark provides without having to
                // emit literal hashes for unsupported levels.
                let demoted = if hashes == 1 { "#### " } else { "##### " };
                out.push_str(demoted);
                out.push_str(body);
            }
        }
        if line.ends_with('\n') {
            out.push('\n');
        }
        i += 1;
    }
    out
}

/// Decide whether to flatten markdown tables to bullet lists for the
/// given card schema. Defaults: convert in v1 (raw pipes don't render),
/// keep raw in v2 (Lark's CardKit v2 markdown renderer handles tables).
/// Operators can force either side via `LARK_TABLE_MODE=list|native` —
/// the override is mostly useful when comparing rendering on different
/// Lark client versions, or when a mobile-heavy audience prefers
/// list-style scanability even on v2.
fn convert_tables_for_mode(mode: MarkdownMode) -> bool {
    match std::env::var("LARK_TABLE_MODE").ok().as_deref() {
        Some("list") => true,
        Some("native") => false,
        _ => match mode {
            MarkdownMode::V1 => true,
            MarkdownMode::V2 => false,
        },
    }
}

/// True if the line looks like a GFM table row: starts with `|` and ends
/// with `|` (after trimming). Doesn't validate cell count — see
/// [`is_table_separator`] for the disambiguation step.
fn looks_like_table_row(line: &str) -> bool {
    let t = line.trim();
    t.starts_with('|') && t.ends_with('|') && t.len() >= 2
}

/// True if the line is a GFM table-separator row: every non-`|` cell
/// consists of `-`/`:`/whitespace only. Distinguishes a real table from
/// a `|` glyph that happens to appear at line start.
fn is_table_separator(line: &str) -> bool {
    let t = line.trim();
    // Need at least `|x|` (3 chars) to have any inner content.
    if t.len() < 3 || !t.starts_with('|') || !t.ends_with('|') {
        return false;
    }
    let inner = &t[1..t.len() - 1];
    let cells: Vec<&str> = inner.split('|').collect();
    if cells.is_empty() {
        return false;
    }
    cells.iter().all(|c| {
        let s = c.trim();
        !s.is_empty() && s.chars().all(|ch| matches!(ch, '-' | ':' | ' '))
    })
}

/// Split a `| a | b | c |` row into its cell strings, trimmed.
fn split_table_row(line: &str) -> Vec<String> {
    let t = line.trim();
    let inner = t.trim_start_matches('|').trim_end_matches('|');
    inner.split('|').map(|c| c.trim().to_string()).collect()
}

/// Convert a GFM table block (rows: header, separator, body...) into
/// Lark-friendly bullet list form.
///
/// Layout choices:
/// - **1 column**: emit each cell as its own bold line.
/// - **2 columns**: each row becomes `**{col0}**: {col1}` (compact, one
///   line per row). Common shape for "key/value" tables in LLM output.
/// - **3+ columns**: each row emits `**{col0}**` then `- {hdr[i]}: {cell[i]}`
///   bullets for the remaining columns. Reads top-down on mobile.
///
/// Empty cells become em-dashes so columns stay aligned semantically.
fn render_table_as_list(block: &[&str]) -> String {
    if block.len() < 2 {
        return block.join("\n");
    }
    let headers = split_table_row(block[0]);
    let body_rows: Vec<Vec<String>> = block[2..].iter().map(|r| split_table_row(r)).collect();
    let cols = headers.len();
    let mut out = String::new();
    if cols == 1 {
        for row in &body_rows {
            let cell = row.first().map(|s| s.as_str()).unwrap_or("");
            out.push_str("**");
            out.push_str(if cell.is_empty() { "—" } else { cell });
            out.push_str("**\n");
        }
        return out;
    }
    if cols == 2 {
        for row in &body_rows {
            let k = row.first().map(|s| s.as_str()).unwrap_or("");
            let v = row.get(1).map(|s| s.as_str()).unwrap_or("");
            out.push_str("**");
            out.push_str(if k.is_empty() { "—" } else { k });
            out.push_str("**: ");
            out.push_str(if v.is_empty() { "—" } else { v });
            out.push('\n');
        }
        return out;
    }
    // 3+ columns.
    for row in &body_rows {
        let label = row.first().map(|s| s.as_str()).unwrap_or("");
        out.push_str("**");
        out.push_str(if label.is_empty() { "—" } else { label });
        out.push_str("**\n");
        for col in 1..cols {
            let header = headers.get(col).map(|s| s.as_str()).unwrap_or("");
            let cell = row.get(col).map(|s| s.as_str()).unwrap_or("");
            out.push_str("- ");
            if !header.is_empty() {
                out.push_str(header);
                out.push_str(": ");
            }
            out.push_str(if cell.is_empty() { "—" } else { cell });
            out.push('\n');
        }
        out.push('\n');
    }
    // Trim trailing blank line we added between rows so the caller's
    // newline handling stays predictable.
    while out.ends_with("\n\n") {
        out.pop();
    }
    out
}

/// Wrap plain text into the legacy v1 interactive-card JSON.
/// One `markdown` element so basic emphasis renders. v1 doesn't render
/// `#` headers or GFM tables, so [`markdown_for_lark`] is run in
/// `MarkdownMode::V1` first to substitute Unicode prefixes and bullet
/// lists.
///
/// This shape is still used by the streaming/typing path, where the
/// `interactive` message is later patched by `message.update`. v2 cards
/// require a different update flow (CardKit PATCH); see
/// [`build_text_card_v2`] / [`send_card_v2`] for the non-streaming
/// reply path.
fn build_text_card_v1(text: &str) -> Value {
    let prepared = markdown_for_lark(text, MarkdownMode::V1);
    json!({
        "config": {"wide_screen_mode": true},
        "elements": [
            {
                "tag": "markdown",
                "content": prepared,
            }
        ]
    })
}

/// CardKit v2 schema with a single `markdown` element. v2 cards must
/// be created server-side via `/open-apis/cardkit/v1/cards` to obtain
/// a `card_id`, then referenced from an `interactive` IM message —
/// see [`send_card_v2`] for the wiring.
fn build_text_card_v2(text: &str) -> Value {
    let prepared = markdown_for_lark(text, MarkdownMode::V2);
    json!({
        "schema": "2.0",
        "config": {
            // streaming_mode = false: this is a one-shot reply, not an
            // incremental update. v2 streaming uses different APIs
            // (cardElement.content) which we'd plumb separately.
            "streaming_mode": false,
            "wide_screen_mode": true
        },
        "body": {
            "elements": [
                {"tag": "markdown", "content": prepared}
            ]
        }
    })
}

/// Send a v1 interactive card (legacy schema). Used by the streaming /
/// typing path which later issues `message.update` to patch the card —
/// v1 supports that natively via `PATCH /im/v1/messages/{id}`. New
/// non-streaming replies should prefer [`send_card_v2`].
async fn send_card(
    cfg: &LarkConfig,
    receive_id: &str,
    receive_id_type: &str,
    text: &str,
    idempotency_key: Option<&str>,
) -> Result<String> {
    let token = fetch_app_access_token(cfg).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;
    let url = format!(
        "{}/open-apis/im/v1/messages",
        cfg.base_url.trim_end_matches('/')
    );
    let body = json!({
        "receive_id": receive_id,
        "msg_type": "interactive",
        // Lark expects the card JSON as a *string*, not nested object.
        "content": build_text_card_v1(text).to_string(),
    });
    let resp = client
        .post(url)
        .query(&lark_send_query(receive_id_type, idempotency_key))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .context("POST /im/v1/messages (card)")?;
    let status = resp.status();
    let json: Value = resp.json().await.context("read card send response")?;
    if !status.is_success() {
        anyhow::bail!("lark card send failed: HTTP {status} body={json}");
    }
    let code = json.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != 0 {
        anyhow::bail!("lark card send returned code {code}: {json}");
    }
    let message_id = json
        .pointer("/data/message_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("lark-{}", uuid_short()));
    Ok(message_id)
}

/// Step 1 of CardKit v2 send: turn a v2-schema card object into a
/// `card_id` Lark can later reference from an IM message. The card_id
/// lives server-side and survives until explicitly deleted; for one-
/// shot replies that's fine.
async fn create_cardkit_card(cfg: &LarkConfig, card: &Value) -> Result<String> {
    let token = fetch_app_access_token(cfg).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;
    let url = format!(
        "{}/open-apis/cardkit/v1/cards",
        cfg.base_url.trim_end_matches('/')
    );
    let body = json!({
        "type": "card_json",
        // Same string-encoded-JSON convention as IM: the API wants a
        // serialized blob, not a nested object.
        "data": card.to_string(),
    });
    let resp = client
        .post(url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .context("POST /cardkit/v1/cards")?;
    let status = resp.status();
    let json: Value = resp.json().await.context("read cardkit create response")?;
    if !status.is_success() {
        anyhow::bail!("cardkit create failed: HTTP {status} body={json}");
    }
    let code = json.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != 0 {
        anyhow::bail!("cardkit create returned code {code}: {json}");
    }
    let card_id = json
        .pointer("/data/card_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("cardkit create missing data.card_id: {json}"))?;
    Ok(card_id.to_string())
}

/// Step 2: send an `interactive` IM message that references an
/// existing CardKit `card_id`. Returns the `om_xxx` message id Lark
/// assigns to the IM-side message (distinct from `card_id`).
async fn send_im_with_card_id(
    cfg: &LarkConfig,
    receive_id: &str,
    receive_id_type: &str,
    card_id: &str,
    idempotency_key: Option<&str>,
) -> Result<String> {
    let token = fetch_app_access_token(cfg).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;
    let url = format!(
        "{}/open-apis/im/v1/messages",
        cfg.base_url.trim_end_matches('/')
    );
    // Lark's content for a CardKit-referenced message: a tiny envelope
    // with `type: "card"` and the card_id under `data`. Still has to be
    // a stringified JSON, same as for inline v1 cards.
    let content = json!({
        "type": "card",
        "data": {"card_id": card_id}
    });
    let body = json!({
        "receive_id": receive_id,
        "msg_type": "interactive",
        "content": content.to_string(),
    });
    let resp = client
        .post(url)
        .query(&lark_send_query(receive_id_type, idempotency_key))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .context("POST /im/v1/messages (cardkit)")?;
    let status = resp.status();
    let json: Value = resp.json().await.context("read cardkit send response")?;
    if !status.is_success() {
        anyhow::bail!("lark cardkit-im send failed: HTTP {status} body={json}");
    }
    let code = json.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != 0 {
        anyhow::bail!("lark cardkit-im send returned code {code}: {json}");
    }
    let message_id = json
        .pointer("/data/message_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("lark-{}", uuid_short()));
    Ok(message_id)
}

/// Send a CardKit v2 card. Two-step: create card → send IM message
/// referencing the card_id. Headers (`#`/`##`/`###`) render as visible
/// sizes; tables render natively.
async fn send_card_v2(
    cfg: &LarkConfig,
    receive_id: &str,
    receive_id_type: &str,
    text: &str,
    idempotency_key: Option<&str>,
) -> Result<String> {
    let card = build_text_card_v2(text);
    let card_id = create_cardkit_card(cfg, &card).await?;
    send_im_with_card_id(cfg, receive_id, receive_id_type, &card_id, idempotency_key).await
}

/// Patch an existing interactive-card message's content. The message
/// id must refer to a card we sent earlier — Lark refuses PATCH on
/// plain text messages with "MessageContentInvalid".
async fn patch_card(cfg: &LarkConfig, message_id: &str, text: &str) -> Result<()> {
    patch_card_value(cfg, message_id, &build_text_card_v1(text)).await
}

/// Same as [`patch_card`] but takes an already-built v1 card JSON. Used
/// by the approval-finalize path (which needs to replace the action row
/// with a status line rather than re-wrap plain text).
async fn patch_card_value(cfg: &LarkConfig, message_id: &str, card: &Value) -> Result<()> {
    let token = fetch_app_access_token(cfg).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;
    let url = format!(
        "{}/open-apis/im/v1/messages/{}",
        cfg.base_url.trim_end_matches('/'),
        message_id
    );
    // PATCH only works for v1 cards — v2 (CardKit) cards must be patched
    // via cardkit APIs. Body wraps the card JSON as a string.
    let body = json!({
        "content": card.to_string(),
        "msg_type": "interactive",
    });
    let resp = client
        .patch(url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .context("PATCH /im/v1/messages/{id}")?;
    let status = resp.status();
    let json: Value = resp.json().await.context("read patch response")?;
    if !status.is_success() {
        anyhow::bail!("lark patch failed: HTTP {status} body={json}");
    }
    let code = json.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != 0 {
        anyhow::bail!("lark patch returned code {code}: {json}");
    }
    Ok(())
}

/// Handle a Lark `card.action.trigger` event — the user clicked a
/// button on a card we sent. Translate the click's `value` payload
/// back into a SNACA `event.approval_callback` notification keyed by
/// `callback_token`, which the host's `ApprovalRegistry` then resolves
/// to wake the pending gate request.
///
/// After dispatching the callback we PATCH the original card to remove
/// the action row and replace it with a status line — so a user who
/// glances at the chat later sees "✅ 已允许 by @X · 10:21:33" instead
/// of clickable buttons. This is best-effort: a failed PATCH is logged
/// and ignored (the engine-side decision has already gone through).
async fn handle_card_action(
    cfg: &LarkConfig,
    tx: &mpsc::UnboundedSender<JsonRpcMessage>,
    envelope: &Value,
) -> Result<()> {
    use snaca_channel_protocol::methods::{ApprovalCallbackParams, ApprovalDecision};
    // Card actions live under `event.action.value`. We only fire the
    // callback when the value carries our keys — random card buttons
    // (skill-author cards, etc.) should be ignored.
    let value = match envelope.pointer("/event/action/value") {
        Some(v) => v,
        None => {
            debug!("card.action.trigger missing event.action.value; ignoring");
            return Ok(());
        }
    };
    let token = match value.get("snaca_callback_token").and_then(|v| v.as_str()) {
        Some(t) => t.to_string(),
        None => {
            debug!("card.action.trigger not from a SNACA card; ignoring");
            return Ok(());
        }
    };
    let decision_str = value
        .get("snaca_decision")
        .and_then(|v| v.as_str())
        .unwrap_or("deny");
    let decision = match decision_str {
        "allow" | "allow_once" => ApprovalDecision::AllowOnce,
        "allow_always" => ApprovalDecision::AllowAlways,
        _ => ApprovalDecision::Deny,
    };
    let user_id = envelope
        .pointer("/event/operator/open_id")
        .or_else(|| envelope.pointer("/event/operator/user_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let decided_at = Utc::now();
    let cb = ApprovalCallbackParams {
        auth: cfg.plugin_token.clone(),
        callback_token: token.clone(),
        decision: decision.clone(),
        user_id: user_id.clone(),
        decided_at: decided_at.to_rfc3339(),
    };
    let notif = JsonRpcNotification::new(
        plugin_to_host::EVENT_APPROVAL_CALLBACK,
        Some(serde_json::to_value(cb).expect("approval callback serialises")),
    );
    if tx.send(JsonRpcMessage::Notification(notif)).is_err() {
        warn!("stdout writer closed; dropping approval callback");
    }

    // Finalize the card in chat so the user sees their decision instead
    // of clickable buttons. If the entry is missing (host already timed
    // out, plugin restarted between send and click, dedup elsewhere)
    // we just skip — the buttons stay clickable but a subsequent click
    // will only land in the warn branch of the host's registry.
    //
    // Scope the mutex guard tightly so it's dropped before any `.await`
    // — `MutexGuard` is `!Send` and would otherwise poison the future.
    let card_state = approval_card_registry()
        .lock()
        .expect("approval card registry mutex poisoned")
        .remove(&token);
    if let Some(state) = card_state {
        let finalized = build_finalized_approval_card(
            &state.request_text,
            decision,
            &user_id,
            &decided_at.format("%Y-%m-%d %H:%M:%S").to_string(),
        );
        if let Err(e) = patch_card_value(cfg, &state.message_id, &finalized).await {
            warn!(
                error = %e,
                message_id = %state.message_id,
                "approval card finalize patch failed; leaving buttons in place"
            );
        }
    } else {
        debug!(
            token = %token,
            "no approval card registry entry; skipping finalize patch"
        );
    }
    Ok(())
}

/// Pending approval cards keyed by `callback_token`. Populated when the
/// plugin sends `approval.present` and drained when the user clicks (or
/// when the host times out — we lazily evict on the next click).
#[derive(Clone)]
struct ApprovalCardState {
    message_id: String,
    request_text: String,
}

static APPROVAL_CARDS: OnceLock<StdMutex<HashMap<String, ApprovalCardState>>> = OnceLock::new();

fn approval_card_registry() -> &'static StdMutex<HashMap<String, ApprovalCardState>> {
    APPROVAL_CARDS.get_or_init(|| StdMutex::new(HashMap::new()))
}

/// Render an approval card with Allow / Deny buttons and POST it to
/// Lark. Each button carries a `value` payload with the host-supplied
/// `callback_token` and a `decision` string we'll forward verbatim
/// when the user clicks. Button click events arrive over the same
/// WebSocket as inbound messages and route through
/// [`handle_card_action`].
async fn handle_approval_present(
    cfg: Arc<LarkConfig>,
    id: RequestId,
    req: JsonRpcRequest,
) -> JsonRpcResponse {
    use snaca_channel_protocol::methods::ApprovalPresentParams;
    let params: ApprovalPresentParams =
        match req.params.and_then(|v| serde_json::from_value(v).ok()) {
            Some(p) => p,
            None => {
                return JsonRpcResponse::err(
                    id,
                    JsonRpcError::new(
                        ErrorCode::InvalidParams.as_i32(),
                        "invalid approval.present params",
                    ),
                );
            }
        };
    let receive_id = params.chat_id.clone();
    let receive_id_type = if receive_id.starts_with("ou_") {
        "open_id"
    } else {
        "chat_id"
    };
    let card = build_approval_card(&params.request, &params.callback_token);
    match post_card_message(&cfg, &receive_id, receive_id_type, &card).await {
        Ok(message_id) => {
            // Stash the (token -> message_id) pair so the click handler
            // can patch the card to its finalized state. Insert before
            // returning the response: the user could in theory click the
            // card before we ack `approval.present`.
            approval_card_registry()
                .lock()
                .expect("approval card registry mutex poisoned")
                .insert(
                    params.callback_token.clone(),
                    ApprovalCardState {
                        message_id: message_id.clone(),
                        request_text: params.request.clone(),
                    },
                );
            JsonRpcResponse::ok(id, json!({"message_id": message_id}))
        }
        Err(e) => {
            warn!(error = %e, "approval.present send failed");
            JsonRpcResponse::err(
                id,
                JsonRpcError::new(
                    ErrorCode::PlatformError.as_i32(),
                    format!("approval card send failed: {e}"),
                ),
            )
        }
    }
}

/// Build the "user has decided" version of an approval card. Same
/// header + request body as [`build_approval_card`], but the action
/// row is replaced with a single note element ("✅ 已允许 by @X ·
/// 2026-05-13 10:21:33"). Used by [`handle_card_action`] to PATCH the
/// original card after the click so it stops being interactive.
fn build_finalized_approval_card(
    request_text: &str,
    decision: snaca_channel_protocol::methods::ApprovalDecision,
    user_id: &str,
    timestamp: &str,
) -> Value {
    use snaca_channel_protocol::methods::ApprovalDecision;
    let (template, label) = match decision {
        ApprovalDecision::Allow | ApprovalDecision::AllowOnce => ("green", "✅ 已允许"),
        ApprovalDecision::AllowAlways => ("green", "✅ 已始终允许"),
        ApprovalDecision::Deny => ("red", "❌ 已拒绝"),
    };
    let actor = if user_id.is_empty() {
        String::new()
    } else {
        format!(" by <at id=\"{user_id}\"></at>")
    };
    let status_line = format!("{label}{actor} · {timestamp}");
    json!({
        "config": {"wide_screen_mode": true},
        "header": {
            "title": {"tag": "plain_text", "content": "🔐 需要确认"},
            "template": template
        },
        "elements": [
            {
                "tag": "div",
                "text": {"tag": "lark_md", "content": request_text}
            },
            {"tag": "hr"},
            {
                "tag": "note",
                "elements": [
                    {"tag": "lark_md", "content": status_line}
                ]
            }
        ]
    })
}

/// Lark interactive card JSON for an approval request. The button
/// `value` field is what comes back to us in the click event payload,
/// keyed by `callback_token` so the host can match it to a pending
/// gate request.
fn build_approval_card(request_text: &str, callback_token: &str) -> Value {
    json!({
        "config": {"wide_screen_mode": true},
        "header": {
            "title": {"tag": "plain_text", "content": "🔐 需要确认"},
            "template": "blue"
        },
        "elements": [
            {
                "tag": "div",
                "text": {"tag": "lark_md", "content": request_text}
            },
            {
                "tag": "action",
                "actions": [
                    {
                        "tag": "button",
                        "text": {"tag": "plain_text", "content": "✅ 允许"},
                        "type": "primary",
                        "value": {
                            "snaca_callback_token": callback_token,
                            "snaca_decision": "allow_once"
                        }
                    },
                    {
                        "tag": "button",
                        "text": {"tag": "plain_text", "content": "✅ 始终允许"},
                        "type": "default",
                        "value": {
                            "snaca_callback_token": callback_token,
                            "snaca_decision": "allow_always"
                        }
                    },
                    {
                        "tag": "button",
                        "text": {"tag": "plain_text", "content": "❌ 拒绝"},
                        "type": "danger",
                        "value": {
                            "snaca_callback_token": callback_token,
                            "snaca_decision": "deny"
                        }
                    }
                ]
            }
        ]
    })
}

/// Handle a `im.message.reaction.{created,deleted}_v1` event.
///
/// Reactions are visible at the chat layer but Lark's reaction event payload
/// historically did NOT carry `chat_id` — only the message id, emoji, and
/// the user who reacted. Without `chat_id` we can't synthesize a SNACA
/// inbound (the dispatcher needs a chat to route to). Newer Lark SDK
/// payloads (>=2024) sometimes do include `event.chat_id`; we read it
/// defensively.
///
/// Behaviour matrix:
///
/// - **Default**: log at INFO with structured fields. No engine
///   round-trip. The bot's chat history won't change; operators see the
///   reaction in their tracing.
/// - **`LARK_REACTION_ROUTE=true`** (opt-in env var): if `chat_id` is
///   present in the payload, synthesize an `event.message_received` with
///   content `[reaction:<emoji>]` (or `[reaction-removed:<emoji>]` for
///   deletes), `reply_to=<message_id>`. The engine then sees the
///   reaction as a regular user turn and the LLM decides what to do.
///   When `chat_id` is missing, fall back to the log-only path with a
///   one-time WARN per process.
///
/// We deliberately do NOT auto-issue a reverse Lark API call to look up
/// the chat from the message id: that's another HTTP hop on every
/// reaction (potentially many per turn) and the env-var-off default is
/// the right baseline.
async fn handle_reaction_event(
    cfg: &LarkConfig,
    tx: &mpsc::UnboundedSender<JsonRpcMessage>,
    envelope: &Value,
    event_type: &str,
) -> Result<()> {
    let event = match envelope.pointer("/event") {
        Some(e) => e,
        None => {
            debug!(event_type, "reaction event has no body; ignoring");
            return Ok(());
        }
    };
    let message_id = event
        .pointer("/message_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let emoji = event
        .pointer("/reaction_type/emoji_type")
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    let user_id = event
        .pointer("/user_id/open_id")
        .or_else(|| event.pointer("/user_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let action_time = event
        .pointer("/action_time")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let mut chat_id = event
        .pointer("/chat_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let action = if event_type.ends_with("created_v1") {
        "added"
    } else {
        "removed"
    };

    // Filter out the bot's own auto-react (we stamp `Typing` on every
    // user inbound via `add_inbound_reaction`). Lark v1 leaves
    // `user_id` empty for bot-initiated reactions — operator_type is
    // typically "app" — so the cheap check is "no user → not a user
    // action → skip." The self-id match below is defense in depth for
    // platforms that DO populate user_id with the bot's own open_id.
    let operator_type = event
        .pointer("/operator_type")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if user_id.is_empty() || operator_type == "app" {
        debug!(
            operator_type,
            emoji, message_id, "skipping non-user reaction (likely bot self-react)"
        );
        return Ok(());
    }
    if let Some(self_id) = bot_open_id(cfg).await {
        if self_id == user_id {
            debug!(
                emoji,
                message_id,
                "skipping bot's own reaction (self-id match)"
            );
            return Ok(());
        }
    }

    info!(
        action,
        emoji,
        user_id,
        message_id,
        chat_id = chat_id.as_str(),
        action_time,
        "lark reaction event"
    );

    let route_on = std::env::var("LARK_REACTION_ROUTE")
        .map(|v| matches!(v.as_str(), "1" | "true" | "yes"))
        .unwrap_or(false);
    if !route_on {
        return Ok(());
    }
    // `event.chat_id` is present on newer Lark schemas but absent on the
    // current v1 shape we observe. When missing, look it up via
    // `GET /open-apis/im/v1/messages/<id>`. Failure → log + skip; we
    // don't surface partial data to the engine.
    if chat_id.is_empty() {
        if message_id.is_empty() {
            warn!(event_type, "reaction has no chat_id and no message_id; cannot route");
            return Ok(());
        }
        match fetch_message_chat_id(cfg, message_id).await {
            Ok(c) => {
                debug!(message_id, chat_id = c.as_str(), "resolved chat_id via lookup");
                chat_id = c;
            }
            Err(e) => {
                warn!(message_id, error=%e, "reaction chat_id lookup failed; not routing");
                return Ok(());
            }
        }
    }
    let content = if action == "added" {
        format!("[reaction:{emoji}]")
    } else {
        format!("[reaction-removed:{emoji}]")
    };
    let inbound = MessageReceivedParams {
        auth: cfg_token(),
        tenant_id: tenant_id_from_env(),
        chat_id,
        user_id: user_id.to_string(),
        message_id: format!("reaction-{}-{}", action, message_id),
        content,
        mentions: Vec::new(),
        attachments: Vec::new(),
        reply_to: if message_id.is_empty() {
            None
        } else {
            Some(message_id.to_string())
        },
        received_at: if action_time.is_empty() {
            Utc::now().to_rfc3339()
        } else {
            // action_time is a unix-millis string in Lark v1; convert
            // best-effort. On parse failure fall back to "now".
            action_time
                .parse::<i64>()
                .ok()
                .and_then(chrono::DateTime::<Utc>::from_timestamp_millis)
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_else(|| Utc::now().to_rfc3339())
        },
    };
    let notif = JsonRpcNotification::new(
        plugin_to_host::EVENT_MESSAGE_RECEIVED,
        Some(serde_json::to_value(inbound).expect("inbound serialises")),
    );
    if tx.send(JsonRpcMessage::Notification(notif)).is_err() {
        warn!("stdout writer closed; dropping reaction inbound");
    }
    Ok(())
}

/// Translate Lark's `im.message.recalled_v1` event into a SNACA
/// `event.message_recalled` notification. The host's dispatcher uses
/// it to abort the in-flight turn on the matching thread (see
/// `snaca-server/src/dispatch.rs`).
///
/// Lark's recall payload carries:
/// - `event.message_id` — the message that was retracted.
/// - `event.chat_id` — the conversation.
/// - `event.recall_time` — unix-millis string.
/// - `event.recall_type` — `message_owner` / `group_owner` / etc.
///
/// What it doesn't carry: a `user_id`. The recall actor isn't always
/// the message author (a group admin can retract someone else's
/// message), and Lark doesn't surface a stable identifier here. We
/// pass an empty `user_id` — the host's `user_key_for` falls back to
/// `chat_id`, mirroring how the receive path treats missing user
/// identity in single-user DMs. For group chats this means the
/// recall targets the default project bound to the chat, which is
/// the same routing the receive path uses when no `/snaca switch`
/// binding is in place — good enough until per-message turn tracking
/// (the broader follow-up) lands.
async fn handle_recall_event(
    tx: &mpsc::UnboundedSender<JsonRpcMessage>,
    envelope: &Value,
) -> Result<()> {
    let event = match envelope.pointer("/event") {
        Some(e) => e,
        None => {
            debug!("recall event has no body; ignoring");
            return Ok(());
        }
    };
    let message_id = event
        .pointer("/message_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let chat_id = event
        .pointer("/chat_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if chat_id.is_empty() {
        // Without chat_id the host can't compute a thread_id; the
        // event would be a no-op. Older Lark schemas occasionally
        // omit chat_id on recall — log so operators can confirm
        // their tenant is on the newer payload before relying on
        // this path.
        warn!(message_id, "recall event missing chat_id; not forwarding");
        return Ok(());
    }
    // Lark's recall_time is a unix-millis string; convert best-effort.
    // Failed parse falls back to now() so the wire field stays valid.
    let recalled_at = event
        .pointer("/recall_time")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<i64>().ok())
        .and_then(chrono::DateTime::<Utc>::from_timestamp_millis)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_else(|| Utc::now().to_rfc3339());

    info!(
        message_id = message_id.as_str(),
        chat_id = chat_id.as_str(),
        "lark message recalled; signalling host to abort turn"
    );

    let params = MessageRecalledParams {
        auth: cfg_token(),
        tenant_id: tenant_id_from_env(),
        chat_id,
        // Empty — Lark recall events don't carry a stable actor id.
        user_id: String::new(),
        message_id,
        recalled_at,
    };
    let notif = JsonRpcNotification::new(
        plugin_to_host::EVENT_MESSAGE_RECALLED,
        Some(serde_json::to_value(params).expect("recall params serialise")),
    );
    if tx.send(JsonRpcMessage::Notification(notif)).is_err() {
        warn!("stdout writer closed; dropping recall notification");
    }
    Ok(())
}

fn cfg_token() -> String {
    std::env::var("SNACA_PLUGIN_TOKEN").unwrap_or_default()
}

fn tenant_id_from_env() -> String {
    // Match the value the plugin already stamps onto regular inbound
    // events. Reactions arrive with no tenant in the payload, so we
    // mirror what we'd send for a normal message.
    std::env::var("LARK_TENANT_ID").unwrap_or_default()
}

/// Send an `interactive` (card) message via Lark Open API.
async fn post_card_message(
    cfg: &LarkConfig,
    receive_id: &str,
    receive_id_type: &str,
    card: &Value,
) -> Result<String> {
    let token = fetch_app_access_token(cfg).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;
    let url = format!(
        "{}/open-apis/im/v1/messages",
        cfg.base_url.trim_end_matches('/')
    );
    let body = json!({
        "receive_id": receive_id,
        "msg_type": "interactive",
        // Lark expects the card payload as a string, not a nested object.
        "content": card.to_string(),
    });
    let resp = client
        .post(url)
        .query(&[("receive_id_type", receive_id_type)])
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .context("POST /im/v1/messages (approval card)")?;
    let status = resp.status();
    let json: Value = resp.json().await.context("read approval card response")?;
    if !status.is_success() {
        anyhow::bail!("approval card send failed: HTTP {status} body={json}");
    }
    let code = json.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != 0 {
        anyhow::bail!("approval card send returned code {code}: {json}");
    }
    Ok(json
        .pointer("/data/message_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("lark-{}", uuid_short())))
}

/// Fetch a Lark attachment's bytes. The `file_id` we surface to SNACA
/// is opaque from its point of view, but we encode enough information
/// in it to make `file.download` stateless:
/// - `file:<message_id>:<file_key>:<filename>` — generic file/audio/video
/// - `image:<image_key>:<filename>` — image (different endpoint)
async fn handle_file_download(
    cfg: Arc<LarkConfig>,
    id: RequestId,
    req: JsonRpcRequest,
) -> JsonRpcResponse {
    let params: snaca_channel_protocol::methods::FileDownloadParams =
        match req.params.and_then(|v| serde_json::from_value(v).ok()) {
            Some(p) => p,
            None => {
                return JsonRpcResponse::err(
                    id,
                    JsonRpcError::new(
                        ErrorCode::InvalidParams.as_i32(),
                        "invalid file.download params",
                    ),
                );
            }
        };
    let parsed = match parse_attachment_id(&params.file_id) {
        Some(p) => p,
        None => {
            return JsonRpcResponse::err(
                id,
                JsonRpcError::new(
                    ErrorCode::InvalidParams.as_i32(),
                    format!("unrecognised file_id format: {}", params.file_id),
                ),
            );
        }
    };
    match download_attachment(&cfg, &parsed).await {
        Ok(bytes) => {
            let result = snaca_channel_protocol::methods::FileDownloadResult {
                bytes_base64: data_encoding::BASE64.encode(&bytes),
                filename: parsed.filename.clone(),
                mime_type: guess_mime(&parsed.filename),
            };
            JsonRpcResponse::ok(
                id,
                serde_json::to_value(result).expect("FileDownloadResult serialises"),
            )
        }
        Err(e) => {
            warn!(error = %e, file_id = %params.file_id, "file.download failed");
            JsonRpcResponse::err(
                id,
                JsonRpcError::new(
                    ErrorCode::PlatformError.as_i32(),
                    format!("lark download failed: {e}"),
                ),
            )
        }
    }
}

/// Lark outbound file. Two-step:
/// 1. POST `/open-apis/im/v1/files` (multipart) → `file_key`.
/// 2. POST `/open-apis/im/v1/messages` with `msg_type: "file"` and
///    `content: {"file_key": "..."}` → message id.
///
/// Images are uploaded through the same code path as `file_type=stream`
/// and rendered as a downloadable file in chat. Inline image rendering
/// would need `/open-apis/im/v1/images` + msg_type=image; we'll add that
/// when a tool actually wants inline pictures.
async fn handle_file_upload(
    cfg: Arc<LarkConfig>,
    id: RequestId,
    req: JsonRpcRequest,
) -> JsonRpcResponse {
    let params: FileUploadParams = match req.params.and_then(|v| serde_json::from_value(v).ok()) {
        Some(p) => p,
        None => {
            return JsonRpcResponse::err(
                id,
                JsonRpcError::new(
                    ErrorCode::InvalidParams.as_i32(),
                    "invalid file.upload params",
                ),
            );
        }
    };
    let bytes = match data_encoding::BASE64.decode(params.bytes_base64.as_bytes()) {
        Ok(b) => b,
        Err(e) => {
            return JsonRpcResponse::err(
                id,
                JsonRpcError::new(
                    ErrorCode::InvalidParams.as_i32(),
                    format!("base64 decode failed: {e}"),
                ),
            );
        }
    };
    let receive_id = params.chat_id.clone();
    let receive_id_type = if receive_id.starts_with("ou_") {
        "open_id"
    } else {
        "chat_id"
    };
    match upload_and_send_file(
        &cfg,
        &receive_id,
        receive_id_type,
        &params.filename,
        &params.mime_type,
        &bytes,
        params.idempotency_key.as_deref(),
    )
    .await
    {
        Ok(message_id) => JsonRpcResponse::ok(
            id,
            serde_json::to_value(FileUploadResult { message_id })
                .expect("FileUploadResult serialises"),
        ),
        Err(e) => {
            warn!(error = %e, filename = %params.filename, "file.upload to lark failed");
            JsonRpcResponse::err(
                id,
                JsonRpcError::new(
                    ErrorCode::PlatformError.as_i32(),
                    format!("lark file.upload failed: {e}"),
                ),
            )
        }
    }
}

/// Lark file_type taxonomy: `opus / mp4 / pdf / doc / xls / ppt / stream`.
/// We map by extension and fall back to `stream`, which Lark accepts as
/// "generic file". Picking the right specific type just lets Lark show
/// a nicer icon in chat.
fn lark_file_type(filename: &str, mime: &str) -> &'static str {
    let lower = filename.to_ascii_lowercase();
    let ext = std::path::Path::new(&lower)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    match ext {
        "pdf" => "pdf",
        "doc" | "docx" => "doc",
        "xls" | "xlsx" => "xls",
        "ppt" | "pptx" => "ppt",
        "mp4" | "mov" => "mp4",
        "opus" => "opus",
        _ => {
            // Audio MIME hints can route to opus when extension didn't.
            if mime.starts_with("audio/") {
                "opus"
            } else if mime.starts_with("video/") {
                "mp4"
            } else {
                "stream"
            }
        }
    }
}

async fn upload_and_send_file(
    cfg: &LarkConfig,
    receive_id: &str,
    receive_id_type: &str,
    filename: &str,
    mime_type: &str,
    bytes: &[u8],
    idempotency_key: Option<&str>,
) -> Result<String> {
    let token = fetch_app_access_token(cfg).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()?;
    // Step 1: upload file → file_key.
    let upload_url = format!(
        "{}/open-apis/im/v1/files",
        cfg.base_url.trim_end_matches('/')
    );
    let file_type = lark_file_type(filename, mime_type);
    let part = reqwest::multipart::Part::bytes(bytes.to_vec())
        .file_name(filename.to_string())
        .mime_str(if mime_type.is_empty() {
            "application/octet-stream"
        } else {
            mime_type
        })
        .context("attach file part")?;
    let form = reqwest::multipart::Form::new()
        .text("file_type", file_type)
        .text("file_name", filename.to_string())
        .part("file", part);
    let upload_resp = client
        .post(upload_url)
        .bearer_auth(&token)
        .multipart(form)
        .send()
        .await
        .context("POST /im/v1/files")?;
    let status = upload_resp.status();
    let upload_json: Value = upload_resp.json().await.context("read /im/v1/files response")?;
    if !status.is_success() {
        anyhow::bail!("lark file upload failed: HTTP {status} body={upload_json}");
    }
    let code = upload_json
        .get("code")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);
    if code != 0 {
        anyhow::bail!("lark file upload returned code {code}: {upload_json}");
    }
    let file_key = upload_json
        .pointer("/data/file_key")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("/data/file_key missing in upload response: {upload_json}"))?
        .to_string();
    // Step 2: send a file message that references the uploaded file_key.
    let send_url = format!(
        "{}/open-apis/im/v1/messages",
        cfg.base_url.trim_end_matches('/')
    );
    let body = json!({
        "receive_id": receive_id,
        "msg_type": "file",
        "content": json!({"file_key": file_key}).to_string(),
    });
    let send_resp = client
        .post(send_url)
        .query(&lark_send_query(receive_id_type, idempotency_key))
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .context("POST /im/v1/messages (file)")?;
    let send_status = send_resp.status();
    let send_json: Value = send_resp
        .json()
        .await
        .context("read /im/v1/messages (file) response")?;
    if !send_status.is_success() {
        anyhow::bail!("lark file message send failed: HTTP {send_status} body={send_json}");
    }
    let send_code = send_json.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if send_code != 0 {
        anyhow::bail!("lark file message send returned code {send_code}: {send_json}");
    }
    Ok(send_json
        .pointer("/data/message_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("lark-{}", uuid_short())))
}

/// Encoded shape of a Lark attachment id we hand to the SNACA host.
/// Stateless — everything `file.download` needs to resolve a fetch
/// lives inside the id string.
#[derive(Debug, Clone)]
struct AttachmentRef {
    /// `Image` uses a different endpoint than `File`/`Audio`/etc.
    kind: AttachmentKind,
    /// `Some(_)` for file/audio/video (Lark needs the originating
    /// message_id alongside the file_key to authorise the fetch);
    /// `None` for images (image_key is enough).
    message_id: Option<String>,
    /// Lark-side opaque key — `file_key` or `image_key` depending on kind.
    key: String,
    /// Best-effort filename for naming the imported memory entry. For
    /// images Lark doesn't return a filename; we synthesise one from the
    /// image_key.
    filename: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttachmentKind {
    File,
    Image,
}

fn build_file_id(message_id: &str, file_key: &str, filename: &str) -> String {
    format!("file:{}:{}:{}", message_id, file_key, filename)
}

/// Coerce a JSON number-or-string-shaped field to f64. Lark sometimes
/// reports lat/long/size as bare numbers and sometimes as strings.
fn num_or_str_f64(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

// ---------------------------------------------------------------------
// Message dedup + expiry
// ---------------------------------------------------------------------

/// Drop messages older than this when they arrive (e.g. on a WS reconnect
/// after a long outage). Mirrors the official Lark plugin's default —
/// stale conversation context is rarely useful and replying to it confuses
/// users ("why is the bot answering my morning standup at 11pm?").
const MESSAGE_EXPIRY_MS: i64 = 30 * 60 * 1000; // 30 minutes

/// How long to remember message IDs we've seen, for dedup.
const DEDUP_TTL_MS: i64 = 12 * 60 * 60 * 1000; // 12 hours

/// Hard cap on dedup map size. Far above any realistic per-process
/// throughput, but bounds memory should something go wrong upstream.
const DEDUP_MAX_ENTRIES: usize = 5_000;

/// How often to sweep expired entries. Cheap operation thanks to FIFO
/// ordering — only walks the prefix that's actually expired.
const DEDUP_SWEEP_INTERVAL_MS: i64 = 5 * 60 * 1000; // 5 minutes

/// True when `create_time_ms_str` (Lark wire format: a unix-ms timestamp
/// encoded as a string) is older than [`MESSAGE_EXPIRY_MS`]. Bad input
/// (empty / non-numeric) returns `false` so we don't drop messages we
/// can't measure.
fn is_message_expired_now(create_time_ms_str: &str) -> bool {
    if create_time_ms_str.is_empty() {
        return false;
    }
    let Ok(create_ms) = create_time_ms_str.parse::<i64>() else {
        return false;
    };
    let now_ms = Utc::now().timestamp_millis();
    now_ms - create_ms > MESSAGE_EXPIRY_MS
}

/// Bounded FIFO message-id cache. WS reconnects redeliver recent
/// messages; without a dedup we'd reply twice to the same user input.
///
/// Layout:
/// - `seen` — `message_id` → insertion timestamp (ms). O(1) lookup.
/// - `order` — insertion order; we pop from the front to evict oldest.
///
/// Sweep amortises expired-entry cleanup across normal traffic; we do
/// it inline on every check that's at least [`DEDUP_SWEEP_INTERVAL_MS`]
/// past the previous sweep.
struct MessageDedup {
    seen: HashMap<String, i64>,
    order: VecDeque<String>,
    last_sweep_ms: i64,
}

impl MessageDedup {
    fn new() -> Self {
        Self {
            seen: HashMap::new(),
            order: VecDeque::new(),
            last_sweep_ms: 0,
        }
    }

    /// Record `message_id` if unseen; return `true` if it's a duplicate.
    fn check_and_record(&mut self, message_id: &str) -> bool {
        let now_ms = Utc::now().timestamp_millis();
        if now_ms - self.last_sweep_ms > DEDUP_SWEEP_INTERVAL_MS {
            self.sweep_expired(now_ms);
            self.last_sweep_ms = now_ms;
        }
        if self.seen.contains_key(message_id) {
            return true;
        }
        if self.seen.len() >= DEDUP_MAX_ENTRIES {
            if let Some(oldest) = self.order.pop_front() {
                self.seen.remove(&oldest);
            }
        }
        self.seen.insert(message_id.to_string(), now_ms);
        self.order.push_back(message_id.to_string());
        false
    }

    /// Walk `order` from the front, removing entries older than the TTL.
    /// FIFO guarantees we can stop at the first non-expired entry.
    fn sweep_expired(&mut self, now_ms: i64) {
        while let Some(front) = self.order.front() {
            let inserted = self.seen.get(front).copied().unwrap_or(now_ms);
            if now_ms - inserted > DEDUP_TTL_MS {
                let id = self.order.pop_front().expect("front existed");
                self.seen.remove(&id);
            } else {
                break;
            }
        }
    }
}

/// Process-global dedup. WS connection lives for the full plugin lifetime
/// so a static map is fine; we'd revisit if we ever ran multiple Lark
/// accounts in one plugin process.
static MESSAGE_DEDUP: OnceLock<StdMutex<MessageDedup>> = OnceLock::new();

fn message_dedup() -> &'static StdMutex<MessageDedup> {
    MESSAGE_DEDUP.get_or_init(|| StdMutex::new(MessageDedup::new()))
}

/// Flatten a Lark `post` message body to plain text.
///
/// Lark `post` content shape:
/// ```jsonc
/// {
///   "title": "optional title",
///   "content": [
///     [{"tag":"text","text":"hi "},{"tag":"a","text":"link","href":"..."}],
///     [{"tag":"at","user_name":"Alice","user_id":"ou_..."}],
///     ...
///   ]
/// }
/// ```
/// Each inner array is a paragraph. We render paragraphs joined by `\n`,
/// inline tags concatenated as their visible text. Unknown / non-textual
/// tags (`img`, `emotion`, `media`) are surfaced as `[<tag>]` so the LLM
/// at least knows something was there. Title is emitted on its own line
/// before the content if non-empty.
fn flatten_post_to_text(content_obj: &Value) -> String {
    let mut out = String::new();
    if let Some(title) = content_obj.get("title").and_then(|v| v.as_str()) {
        let t = title.trim();
        if !t.is_empty() {
            out.push_str(t);
            out.push('\n');
        }
    }
    let rows = match content_obj.get("content").and_then(|v| v.as_array()) {
        Some(rows) => rows,
        None => return out.trim().to_string(),
    };
    let mut paragraphs: Vec<String> = Vec::with_capacity(rows.len());
    for row in rows {
        let items = match row.as_array() {
            Some(arr) => arr,
            None => continue,
        };
        let mut line = String::new();
        for item in items {
            let tag = item.get("tag").and_then(|v| v.as_str()).unwrap_or("");
            match tag {
                // Plain inline text — most common.
                "text" => {
                    if let Some(s) = item.get("text").and_then(|v| v.as_str()) {
                        line.push_str(s);
                    }
                }
                // Inline link: render as the visible text. Append the
                // href in parens when both differ so the LLM can still
                // see what was linked.
                "a" => {
                    let display = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    let href = item.get("href").and_then(|v| v.as_str()).unwrap_or("");
                    if display.is_empty() && !href.is_empty() {
                        line.push_str(href);
                    } else {
                        line.push_str(display);
                        if !href.is_empty() && href != display {
                            line.push_str(" (");
                            line.push_str(href);
                            line.push(')');
                        }
                    }
                }
                // @mention: prefer user_name; fall back to a generic stub
                // so the LLM at least sees an `@` mark.
                "at" => {
                    let name = item
                        .get("user_name")
                        .and_then(|v| v.as_str())
                        .or_else(|| item.get("user_id").and_then(|v| v.as_str()))
                        .unwrap_or("user");
                    line.push('@');
                    line.push_str(name);
                }
                // Inline code.
                "code_inline" => {
                    let s = item.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    line.push('`');
                    line.push_str(s);
                    line.push('`');
                }
                // Markdown block — Lark sends rendered MD as a single tag.
                "md" => {
                    if let Some(s) = item.get("text").and_then(|v| v.as_str()) {
                        line.push_str(s);
                    }
                }
                // Horizontal rule appears as its own paragraph in Lark.
                "hr" => {
                    line.push_str("---");
                }
                // Surface non-textual tags so the LLM has a hint.
                "img" | "media" | "emotion" => {
                    line.push('[');
                    line.push_str(tag);
                    line.push(']');
                }
                // Unknown tag: fall back to any `text` field, otherwise
                // a tag marker.
                other => {
                    if let Some(s) = item.get("text").and_then(|v| v.as_str()) {
                        line.push_str(s);
                    } else {
                        line.push('[');
                        line.push_str(other);
                        line.push(']');
                    }
                }
            }
        }
        paragraphs.push(line);
    }
    if !out.is_empty() && !paragraphs.is_empty() {
        // Title was set; ensure single blank line before body so it
        // visually separates without producing two newlines.
    }
    out.push_str(&paragraphs.join("\n"));
    out.trim().to_string()
}

fn build_image_id(image_key: &str, filename: &str) -> String {
    format!("image:{}:{}", image_key, filename)
}

fn parse_attachment_id(s: &str) -> Option<AttachmentRef> {
    if let Some(rest) = s.strip_prefix("file:") {
        let mut parts = rest.splitn(3, ':');
        let mid = parts.next()?.to_string();
        let key = parts.next()?.to_string();
        let name = parts.next()?.to_string();
        if mid.is_empty() || key.is_empty() {
            return None;
        }
        Some(AttachmentRef {
            kind: AttachmentKind::File,
            message_id: Some(mid),
            key,
            filename: if name.is_empty() {
                "lark-file".to_string()
            } else {
                name
            },
        })
    } else if let Some(rest) = s.strip_prefix("image:") {
        let mut parts = rest.splitn(2, ':');
        let key = parts.next()?.to_string();
        let name = parts.next()?.to_string();
        if key.is_empty() {
            return None;
        }
        let filename = if name.is_empty() {
            format!("{key}.png")
        } else {
            name
        };
        Some(AttachmentRef {
            kind: AttachmentKind::Image,
            message_id: None,
            key,
            filename,
        })
    } else {
        None
    }
}

async fn download_attachment(cfg: &LarkConfig, att: &AttachmentRef) -> Result<Vec<u8>> {
    let token = fetch_app_access_token(cfg).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()?;
    let url = match att.kind {
        AttachmentKind::File => {
            let mid = att.message_id.as_deref().unwrap_or_default();
            format!(
                "{}/open-apis/im/v1/messages/{}/resources/{}?type=file",
                cfg.base_url.trim_end_matches('/'),
                mid,
                att.key
            )
        }
        AttachmentKind::Image => format!(
            "{}/open-apis/im/v1/images/{}",
            cfg.base_url.trim_end_matches('/'),
            att.key
        ),
    };
    let resp = client
        .get(url)
        .bearer_auth(&token)
        .send()
        .await
        .context("GET attachment")?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("lark attachment fetch failed: HTTP {status} body={body}");
    }
    let bytes = resp.bytes().await.context("read attachment body")?;
    Ok(bytes.to_vec())
}

/// Crude filename → MIME guesser. The import pipeline doesn't trust
/// this — it sniffs by extension itself — but we surface a sensible
/// hint in the protocol response for downstream consumers that do.
fn guess_mime(filename: &str) -> String {
    let lower = filename.to_ascii_lowercase();
    let ext = std::path::Path::new(&lower)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    match ext {
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "pdf" => "application/pdf",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "doc" => "application/msword",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "zip" => "application/zip",
        "json" => "application/json",
        "yaml" | "yml" => "text/yaml",
        "csv" => "text/csv",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Stamp an emoji reaction on the user's inbound message so the chat
/// shows a "received, processing" indicator while the engine works.
/// Lark's reaction API takes a `reaction_type.emoji_type` from a fixed
/// allowlist — `EYES` (👀) is rejected with code 231001, while `OK`
/// (👌) is universally accepted and reads as "received". Operators
/// who want a different emoji can override via `LARK_REACTION_EMOJI`
/// (must be a name from Lark's allowlist, e.g. SMILE / OK / THUMBSUP /
/// JINGYAN / DONE / HAPPY).
///
/// Best-effort. If the API rejects (permissions, rate limit, expired
/// message, unknown emoji), we log a debug warning and let the message
/// flow through to the engine anyway — the user just won't see the
/// reaction.
async fn add_inbound_reaction(cfg: &LarkConfig, message_id: &str) -> Result<()> {
    let token = fetch_app_access_token(cfg).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;
    let url = format!(
        "{}/open-apis/im/v1/messages/{}/reactions",
        cfg.base_url.trim_end_matches('/'),
        message_id
    );
    let emoji = std::env::var("LARK_REACTION_EMOJI").unwrap_or_else(|_| "OK".to_string());
    let body = json!({
        "reaction_type": {"emoji_type": emoji},
    });
    let resp = client
        .post(url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .context("POST /im/v1/messages/{id}/reactions")?;
    let status = resp.status();
    let json: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        anyhow::bail!("lark add reaction failed: HTTP {status} body={json}");
    }
    let code = json.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != 0 {
        anyhow::bail!("lark add reaction returned code {code}: {json}");
    }
    Ok(())
}

async fn fetch_app_access_token(cfg: &LarkConfig) -> Result<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?;
    let url = format!(
        "{}/open-apis/auth/v3/app_access_token/internal",
        cfg.base_url.trim_end_matches('/')
    );
    let resp = client
        .post(url)
        .json(&json!({
            "app_id": cfg.app_id,
            "app_secret": cfg.app_secret,
        }))
        .send()
        .await
        .context("POST /auth/v3/app_access_token/internal")?;
    let status = resp.status();
    let json: Value = resp.json().await.context("read auth response")?;
    if !status.is_success() {
        anyhow::bail!("lark auth failed: HTTP {status} body={json}");
    }
    let token = json
        .get("app_access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("auth response missing app_access_token: {json}"))?;
    Ok(token.to_string())
}

/// Per-process cache of the bot's own `open_id` — used to filter the
/// reactions we ourselves post via [`add_inbound_reaction`] from the
/// inbound event stream. Resolved once on first reaction and reused
/// for the rest of the process lifetime.
static BOT_OPEN_ID: OnceCell<Option<String>> = OnceCell::const_new();

/// Fetch the bot's own `open_id` from Lark's `/bot/v3/info` endpoint.
/// Returns `Ok(None)` on any non-fatal error (network blip, missing
/// field) so callers can gracefully fall back to "we don't know who
/// the bot is yet". Errors are logged once at WARN.
async fn fetch_bot_open_id(cfg: &LarkConfig) -> Option<String> {
    let token = match fetch_app_access_token(cfg).await {
        Ok(t) => t,
        Err(e) => {
            warn!(error=%e, "bot/v3/info: token fetch failed");
            return None;
        }
    };
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            warn!(error=%e, "bot/v3/info: client build failed");
            return None;
        }
    };
    let url = format!(
        "{}/open-apis/bot/v3/info",
        cfg.base_url.trim_end_matches('/')
    );
    let resp = match client.get(url).bearer_auth(&token).send().await {
        Ok(r) => r,
        Err(e) => {
            warn!(error=%e, "bot/v3/info: request failed");
            return None;
        }
    };
    let body: Value = match resp.json().await {
        Ok(j) => j,
        Err(e) => {
            warn!(error=%e, "bot/v3/info: response not json");
            return None;
        }
    };
    let code = body.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != 0 {
        warn!(?body, "bot/v3/info returned non-zero code");
        return None;
    }
    let open_id = body
        .pointer("/bot/open_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    if open_id.is_none() {
        warn!(?body, "bot/v3/info: missing bot.open_id");
    }
    open_id
}

/// Get the bot's `open_id`, fetching once and caching for the rest of
/// the process. Returns `None` if Lark's `/bot/v3/info` ever fails to
/// produce one — callers should treat that as "filter unavailable" and
/// fall back to "include everything."
async fn bot_open_id(cfg: &LarkConfig) -> Option<&'static str> {
    let cached = BOT_OPEN_ID
        .get_or_init(|| async { fetch_bot_open_id(cfg).await })
        .await;
    cached.as_deref()
}

/// Look up the chat that owns a given message id. Reaction events
/// historically don't carry `chat_id` but the messages they reference
/// do. One round-trip per reaction is acceptable for IM volume; if it
/// ever isn't, cache by `message_id` (entries are immutable on Lark's
/// side once the message is delivered).
async fn fetch_message_chat_id(cfg: &LarkConfig, message_id: &str) -> Result<String> {
    let token = fetch_app_access_token(cfg).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?;
    let url = format!(
        "{}/open-apis/im/v1/messages/{}",
        cfg.base_url.trim_end_matches('/'),
        message_id
    );
    let resp = client
        .get(url)
        .bearer_auth(&token)
        .send()
        .await
        .context("GET /im/v1/messages/{id}")?;
    let status = resp.status();
    let body: Value = resp.json().await.context("read message response")?;
    if !status.is_success() {
        anyhow::bail!("lark fetch message failed: HTTP {status} body={body}");
    }
    let code = body.get("code").and_then(|v| v.as_i64()).unwrap_or(-1);
    if code != 0 {
        anyhow::bail!("lark fetch message returned code {code}: {body}");
    }
    let chat_id = body
        .pointer("/data/items/0/chat_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("message response missing data.items[0].chat_id: {body}"))?;
    Ok(chat_id.to_string())
}

// ---------------------------------------------------------------------
// Lark inbound — WebSocket long-poll → event.message_received
// ---------------------------------------------------------------------

/// How long the WS may be silent (no inbound *application* events)
/// before we consider it dead and exit so the supervisor respawns us.
///
/// IMPORTANT — what this actually measures:
///
/// `payload_tx` (the channel we update on receive) is only fed by
/// openlark-client's `EventDispatcherHandler::do_without_validation`,
/// which the SDK calls **only for application-layer data frames**
/// (`im.message.receive_v1`, `card.action.trigger`,
/// `im.message.reaction.*` etc.). Lark's WebSocket ping/pong heartbeats
/// are control frames handled internally by the SDK
/// (`FrameHandler::handle_control_frame`) and never reach our channel.
///
/// So this watchdog is **not** a TCP/WS liveness probe — it only
/// triggers on a prolonged absence of user-visible activity. The
/// previous 5-/15-minute defaults claimed to lean on Lark's "frame
/// every 30s" heartbeat cadence, but those frames are invisible to us;
/// the watchdog was firing on legitimate idle periods (a developer
/// taking a 15-minute break) and forcing a plugin respawn that lost
/// no real liveness signal.
///
/// 6 hours of zero application events is genuinely suspicious in
/// production, but harmless in dev. Operators who want the watchdog
/// effectively off can set `LARK_WS_WATCHDOG_SILENCE_SECS=0`; any
/// positive value re-enables with that threshold (in seconds).
///
/// Real TCP-dead detection is the SDK's job (its own ping/pong keepalive
/// closes the connection on missed pongs); if that's unreliable, the
/// fix belongs upstream in openlark, not here.
const WS_WATCHDOG_SILENCE_SECS_DEFAULT: i64 = 6 * 60 * 60;

/// `0` ⇒ watchdog disabled; positive ⇒ the silence threshold in seconds.
fn ws_watchdog_silence_secs() -> Option<i64> {
    let raw = std::env::var("LARK_WS_WATCHDOG_SILENCE_SECS")
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(WS_WATCHDOG_SILENCE_SECS_DEFAULT);
    if raw <= 0 {
        None
    } else {
        Some(raw)
    }
}

/// How often the watchdog wakes up to check the silence window.
/// 30s is short enough to react reasonably and long enough to avoid
/// spinning.
const WS_WATCHDOG_TICK_SECS: u64 = 30;

/// Process exit code used by the watchdog when it detects a dead
/// WS. The SNACA `PluginSupervisor` interprets non-zero exit as a
/// crash and respawns with backoff — kept as a last-resort tripwire
/// behind the application-layer reconnect loop below.
const WS_WATCHDOG_DEAD_EXIT: i32 = 2;

/// Backoff bounds for the application-layer reconnect loop. First
/// reconnect fires after `MIN`; consecutive quick failures double up
/// to `MAX` to avoid hammering a broken endpoint.
const RECONNECT_BACKOFF_MIN: Duration = Duration::from_secs(1);
const RECONNECT_BACKOFF_MAX: Duration = Duration::from_secs(60);

/// A session that stayed up at least this long is treated as a healthy
/// gateway-side recycle (Lark routinely cycles long-lived sessions), so
/// we reset the backoff to `MIN`. Sessions that drop faster than this
/// keep escalating the backoff.
const RECONNECT_GOOD_SESSION_SECS: u64 = 60;

async fn run_lark_ws(cfg: LarkConfig, tx: mpsc::UnboundedSender<JsonRpcMessage>) -> Result<()> {
    use open_lark::ws_client::{EventDispatcherHandler, LarkWsClient};
    use open_lark::Config;

    let ws_config = Config::builder()
        .app_id(cfg.app_id.clone())
        .app_secret(cfg.app_secret.clone())
        .base_url(cfg.base_url.clone())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| anyhow::anyhow!("Lark Config build failed: {e}"))?;
    let ws_config = Arc::new(ws_config);

    let (payload_tx, mut payload_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let cfg_for_pump = Arc::new(cfg);
    let tx_for_pump = tx.clone();

    // Liveness timestamp shared by the receiver loop and the watchdog.
    // Stored as unix-millis so AtomicI64 suffices; readers/writers use
    // Relaxed ordering — we just need eventual visibility, not a happens-
    // before relationship.
    let last_event_ms = Arc::new(AtomicI64::new(Utc::now().timestamp_millis()));

    // Receiver task: every payload off the channel updates the liveness
    // stamp. This catches everything — user messages, reactions, Lark
    // heartbeats, even malformed frames — anything coming over the WS
    // means TCP and the SDK loop are still alive. Lives across reconnects:
    // every `LarkWsClient::open()` call reuses the same payload_tx (via
    // a cloned `EventDispatcherHandler`), so the channel never closes.
    let last_event_for_pump = last_event_ms.clone();
    tokio::spawn(async move {
        while let Some(payload) = payload_rx.recv().await {
            last_event_for_pump.store(Utc::now().timestamp_millis(), Ordering::Relaxed);
            if let Err(e) = handle_lark_payload(&cfg_for_pump, &tx_for_pump, &payload).await {
                warn!(error = %e, "lark payload processing failed");
            }
        }
    });

    // Watchdog: now a tripwire for a stuck reconnect loop rather than the
    // sole recovery mechanism. The reconnect loop below handles every case
    // where a session actually ends (clean close, heartbeat timeout, IO
    // error). The watchdog only fires if `open()` itself hangs forever
    // with no events and no return — in which case a process restart is
    // the only escape.
    let last_event_for_dog = last_event_ms.clone();
    match ws_watchdog_silence_secs() {
        None => info!("lark ws watchdog disabled (LARK_WS_WATCHDOG_SILENCE_SECS=0)"),
        Some(threshold_secs) => {
            info!(threshold_secs, "lark ws watchdog armed");
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_secs(WS_WATCHDOG_TICK_SECS));
                // First tick fires immediately; skip it so we don't false-alarm
                // before any traffic has had a chance to flow.
                tick.tick().await;
                loop {
                    tick.tick().await;
                    let last = last_event_for_dog.load(Ordering::Relaxed);
                    let now = Utc::now().timestamp_millis();
                    let gap_secs = (now - last) / 1000;
                    if gap_secs > threshold_secs {
                        error!(
                            silence_secs = gap_secs,
                            threshold_secs,
                            "lark ws watchdog: no application events for too long; \
                             assuming dead connection and exiting so supervisor can respawn"
                        );
                        // Give the error log a moment to flush through
                        // the tracing subscriber + stderr pipe before the
                        // process dies. Lost log lines here would make
                        // ops debugging miserable.
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        std::process::exit(WS_WATCHDOG_DEAD_EXIT);
                    }
                }
            });
        }
    }

    let event_handler = EventDispatcherHandler::builder()
        .payload_sender(payload_tx)
        .build();

    // Application-layer reconnect loop.
    //
    // `LarkWsClient::open()` represents a single gateway session and
    // returns when the underlying stream closes — Lark recycles long-
    // lived sessions, NAT/firewall idle timeouts kill the TCP socket,
    // and the SDK's internal 120s heartbeat closes the stream when pings
    // stop. The SDK's `handler_loop` also silently swallows
    // `WsEvent::Error`, so a heartbeat-timed session returns `Ok(())`
    // from `open()` with no error surface. Without this loop, the plugin
    // would keep running but be permanently deaf.
    //
    // Each `open()` re-fetches a fresh ws endpoint (`device_id` /
    // `ticket`) from Lark, so reconnect is effectively a clean reattach
    // from the gateway's perspective.
    let mut backoff = RECONNECT_BACKOFF_MIN;
    let mut attempt: u64 = 0;
    loop {
        attempt += 1;
        info!(attempt, "opening lark websocket long-poll");
        let started = std::time::Instant::now();
        let result = LarkWsClient::open(Arc::clone(&ws_config), event_handler.clone()).await;
        let session_secs = started.elapsed().as_secs();
        // Reset liveness so the watchdog can't fire on the gap between
        // sessions (especially during the backoff sleep below).
        last_event_ms.store(Utc::now().timestamp_millis(), Ordering::Relaxed);
        match result {
            Ok(()) => warn!(
                attempt,
                session_secs,
                "lark ws session ended (gateway recycle or heartbeat timeout); reconnecting"
            ),
            Err(e) => warn!(
                attempt,
                session_secs,
                error = %e,
                "lark ws session failed; reconnecting after backoff"
            ),
        }
        if session_secs >= RECONNECT_GOOD_SESSION_SECS {
            backoff = RECONNECT_BACKOFF_MIN;
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(RECONNECT_BACKOFF_MAX);
    }
}

async fn handle_lark_payload(
    cfg: &LarkConfig,
    tx: &mpsc::UnboundedSender<JsonRpcMessage>,
    payload: &[u8],
) -> Result<()> {
    let envelope: Value = serde_json::from_slice(payload).context("payload is not json")?;
    let event_type = envelope
        .pointer("/header/event_type")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    match event_type {
        "im.message.receive_v1" => {
            // Fall through to the inbound-message body below.
        }
        "card.action.trigger" => {
            return handle_card_action(cfg, tx, &envelope).await;
        }
        "im.message.reaction.created_v1" | "im.message.reaction.deleted_v1" => {
            return handle_reaction_event(cfg, tx, &envelope, event_type).await;
        }
        "im.message.recalled_v1" => {
            return handle_recall_event(tx, &envelope).await;
        }
        other => {
            debug!(event_type = other, "ignoring unsupported event");
            return Ok(());
        }
    }
    let event = envelope
        .pointer("/event")
        .ok_or_else(|| anyhow::anyhow!("missing event body"))?;
    let message = event
        .pointer("/message")
        .ok_or_else(|| anyhow::anyhow!("missing event.message"))?;

    let message_type = message
        .pointer("/message_type")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let content_raw = message
        .pointer("/content")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let content_obj: Value =
        serde_json::from_str(content_raw).context("message.content is not valid json")?;

    // Translate Lark's typed message into SNACA's text + attachments
    // shape. `text` lands in `MessageReceivedParams::content`; binary
    // bodies land in `attachments` with an opaque id we know how to
    // resolve later via `file.download`. Every match arm below either
    // assigns `text` or returns early, so we leave it uninitialized
    // here rather than pay for a `String::new()` that's always discarded.
    let text: String;
    let mut attachments: Vec<Attachment> = Vec::new();
    let inbound_msg_id = message
        .pointer("/message_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let create_time_ms = message
        .pointer("/create_time")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // Drop very old messages (WS reconnect after a long outage will
    // redeliver the recent backlog; replying to yesterday's morning
    // standup is worse than ignoring it). Dedup is the next gate —
    // even within the 30-min window, a reconnect can replay the same
    // event multiple times.
    if is_message_expired_now(create_time_ms) {
        debug!(
            message_id = inbound_msg_id.as_str(),
            create_time_ms,
            "skipping expired message (older than 30min)"
        );
        return Ok(());
    }
    if !inbound_msg_id.is_empty() {
        let mut dedup = message_dedup().lock().expect("dedup mutex poisoned");
        if dedup.check_and_record(&inbound_msg_id) {
            debug!(
                message_id = inbound_msg_id.as_str(),
                "skipping duplicate message (already processed)"
            );
            return Ok(());
        }
    }

    match message_type {
        "text" => {
            text = content_obj
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if text.is_empty() {
                debug!("empty text body; skipping");
                return Ok(());
            }
        }
        "file" | "audio" | "video" | "media" => {
            let file_key = content_obj
                .get("file_key")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if file_key.is_empty() || inbound_msg_id.is_empty() {
                warn!(message_type, "missing file_key or message_id; dropping");
                return Ok(());
            }
            let filename = content_obj
                .get("file_name")
                .and_then(|v| v.as_str())
                .unwrap_or("attachment")
                .to_string();
            let size = content_obj
                .get("file_size")
                .and_then(|v| {
                    // Lark sometimes reports size as a string, sometimes as a number.
                    v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                })
                .unwrap_or(0);
            attachments.push(Attachment {
                id: build_file_id(&inbound_msg_id, file_key, &filename),
                filename,
                mime_type: content_obj
                    .get("file_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("application/octet-stream")
                    .to_string(),
                size,
            });
            // Mention the filename in `content` so the LLM has a hint
            // about what was uploaded even before the import lands.
            text = format!(
                "[uploaded file: {}]",
                attachments[0].filename
            );
        }
        "image" => {
            let image_key = content_obj
                .get("image_key")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if image_key.is_empty() {
                warn!("image message missing image_key; dropping");
                return Ok(());
            }
            // Images get a synthetic .png filename. The downloader
            // serves the raw bytes regardless of actual format; the
            // import pipeline won't run useful extraction over them
            // until we add proper image support, but the bytes are
            // captured.
            let filename = format!("{image_key}.png");
            attachments.push(Attachment {
                id: build_image_id(image_key, &filename),
                filename,
                mime_type: "image/png".to_string(),
                size: 0,
            });
            text = "[uploaded image]".to_string();
        }
        "post" => {
            // Lark `post` is a rich-text envelope with an optional title
            // and a 2D array of inline tags. We flatten it to plain text
            // (preserving paragraph breaks) so the LLM sees the same
            // content the user typed. Embedded images surface as `[image]`
            // markers — extracting them is M3 territory along with proper
            // image attachment support.
            text = flatten_post_to_text(&content_obj);
            if text.trim().is_empty() {
                debug!("empty post body after flatten; skipping");
                return Ok(());
            }
        }
        "sticker" => {
            // Stickers are bundled emoji/animated images. We don't
            // download the bytes — the LLM doesn't need them — but we
            // surface a `[sticker:<key>]` marker so the engine knows
            // *something* visual was sent, not silence.
            let key = content_obj
                .get("file_key")
                .or_else(|| content_obj.get("sticker_id"))
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            text = format!("[sticker:{key}]");
        }
        "share_chat" => {
            // User shared a group/chat link. The body usually carries
            // `chat_id` only; we can't resolve a human name without an
            // extra API hop, so the marker stays opaque.
            let cid = content_obj
                .get("chat_id")
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            text = format!("[shared chat: {cid}]");
        }
        "share_user" => {
            let uid = content_obj
                .get("user_id")
                .or_else(|| content_obj.get("open_id"))
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            text = format!("[shared user: {uid}]");
        }
        "location" => {
            let name = content_obj
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            // Coords arrive as strings sometimes; tolerate both shapes.
            let lat = content_obj.get("latitude").and_then(num_or_str_f64);
            let lng = content_obj.get("longitude").and_then(num_or_str_f64);
            text = match (name.is_empty(), lat, lng) {
                (false, Some(la), Some(ln)) => format!("[location: {name} ({la}, {ln})]"),
                (true, Some(la), Some(ln)) => format!("[location: ({la}, {ln})]"),
                (false, _, _) => format!("[location: {name}]"),
                _ => "[location]".to_string(),
            };
        }
        "system" => {
            // Group system events: bot added/removed, member joined, etc.
            // Lark stores the rendered text under `template`; sometimes
            // there's a `from_user` array carrying the actor's name.
            let template = content_obj
                .get("template")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let actor = content_obj
                .get("from_user")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|u| u.get("user_name").or_else(|| u.get("user_id")))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            text = match (template.is_empty(), actor.is_empty()) {
                (true, _) => "[system event]".to_string(),
                (false, true) => format!("[system: {template}]"),
                (false, false) => format!("[system: {template} (by {actor})]"),
            };
        }
        "interactive" => {
            // Inbound interactive cards. Lark almost always delivers
            // user button clicks via `card.action.trigger` (handled
            // separately above); this arm catches the rare case where
            // a card body itself is forwarded. Render a marker — the
            // structured card JSON is too verbose for the LLM context.
            text = "[interactive card]".to_string();
        }
        other => {
            debug!(message_type = other, "skipping unsupported message type");
            return Ok(());
        }
    }

    // Routing identifiers. For p2p chats the sender's open_id is the
    // natural reply target; for groups, it's the chat_id. We hand the
    // host the chat_id we should send back to so outbound can use it
    // verbatim.
    let chat_type = message
        .pointer("/chat_type")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let sender_open_id = event
        .pointer("/sender/sender_id/open_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let chat_id = if chat_type == "p2p" {
        sender_open_id.to_string()
    } else {
        message
            .pointer("/chat_id")
            .and_then(|v| v.as_str())
            .or_else(|| event.pointer("/chat/chat_id").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string()
    };
    if chat_id.is_empty() {
        warn!("could not resolve chat_id from event; dropping");
        return Ok(());
    }

    let user_id = event
        .pointer("/sender/sender_id/user_id")
        .or_else(|| event.pointer("/sender/sender_id/open_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let tenant_id = envelope
        .pointer("/header/tenant_key")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| cfg.tenant_id.clone());

    // Fire-and-forget reaction. Spawned so the reaction round-trip
    // doesn't delay forwarding the inbound event to the engine.
    if !inbound_msg_id.is_empty() {
        let cfg_for_react = cfg.clone();
        let mid_for_react = inbound_msg_id.clone();
        tokio::spawn(async move {
            if let Err(e) = add_inbound_reaction(&cfg_for_react, &mid_for_react).await {
                debug!(error = %e, message_id = %mid_for_react, "could not add inbound reaction");
            }
        });
    }

    let inbound = MessageReceivedParams {
        auth: cfg.plugin_token.clone(),
        tenant_id,
        chat_id,
        user_id,
        message_id: inbound_msg_id,
        content: text,
        mentions: Vec::new(),
        attachments,
        reply_to: None,
        received_at: Utc::now().to_rfc3339(),
    };
    let notif = JsonRpcNotification::new(
        plugin_to_host::EVENT_MESSAGE_RECEIVED,
        Some(serde_json::to_value(inbound).expect("inbound serialises")),
    );
    if tx.send(JsonRpcMessage::Notification(notif)).is_err() {
        warn!("stdout writer closed; dropping inbound event");
    }
    Ok(())
}

fn uuid_short() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn flatten_post_simple_text_only() {
        let body = json!({
            "title": "",
            "content": [
                [{"tag": "text", "text": "hello "}, {"tag": "text", "text": "world"}],
            ]
        });
        assert_eq!(flatten_post_to_text(&body), "hello world");
    }

    #[test]
    fn flatten_post_preserves_paragraph_breaks() {
        let body = json!({
            "content": [
                [{"tag": "text", "text": "line one"}],
                [{"tag": "text", "text": "line two"}],
            ]
        });
        assert_eq!(flatten_post_to_text(&body), "line one\nline two");
    }

    #[test]
    fn flatten_post_emits_title_on_top() {
        let body = json!({
            "title": "Daily standup",
            "content": [[{"tag": "text", "text": "what i did"}]]
        });
        assert_eq!(flatten_post_to_text(&body), "Daily standup\nwhat i did");
    }

    #[test]
    fn flatten_post_renders_link_with_href_when_text_differs() {
        let body = json!({
            "content": [[
                {"tag": "text", "text": "see "},
                {"tag": "a", "text": "docs", "href": "https://example.com/docs"},
            ]]
        });
        assert_eq!(
            flatten_post_to_text(&body),
            "see docs (https://example.com/docs)"
        );
    }

    #[test]
    fn flatten_post_link_uses_href_when_text_empty() {
        let body = json!({
            "content": [[{"tag": "a", "text": "", "href": "https://x"}]]
        });
        assert_eq!(flatten_post_to_text(&body), "https://x");
    }

    #[test]
    fn flatten_post_renders_at_mention() {
        let body = json!({
            "content": [[
                {"tag": "at", "user_name": "Alice", "user_id": "ou_a"},
                {"tag": "text", "text": " hi"},
            ]]
        });
        assert_eq!(flatten_post_to_text(&body), "@Alice hi");
    }

    #[test]
    fn flatten_post_at_falls_back_to_user_id() {
        let body = json!({
            "content": [[{"tag": "at", "user_id": "ou_x"}]]
        });
        assert_eq!(flatten_post_to_text(&body), "@ou_x");
    }

    #[test]
    fn flatten_post_inline_code_wrapped_in_backticks() {
        let body = json!({
            "content": [[
                {"tag": "text", "text": "run "},
                {"tag": "code_inline", "text": "ls -la"},
            ]]
        });
        assert_eq!(flatten_post_to_text(&body), "run `ls -la`");
    }

    #[test]
    fn flatten_post_markdown_passthrough() {
        let body = json!({
            "content": [[{"tag": "md", "text": "**bold** _italic_"}]]
        });
        assert_eq!(flatten_post_to_text(&body), "**bold** _italic_");
    }

    #[test]
    fn flatten_post_hr_renders_as_dashes() {
        let body = json!({
            "content": [
                [{"tag": "text", "text": "above"}],
                [{"tag": "hr"}],
                [{"tag": "text", "text": "below"}],
            ]
        });
        assert_eq!(flatten_post_to_text(&body), "above\n---\nbelow");
    }

    #[test]
    fn flatten_post_img_emotion_media_become_markers() {
        let body = json!({
            "content": [[
                {"tag": "text", "text": "see "},
                {"tag": "img", "image_key": "img_xxx"},
                {"tag": "text", "text": " and "},
                {"tag": "emotion", "key": "smile"},
            ]]
        });
        assert_eq!(flatten_post_to_text(&body), "see [img] and [emotion]");
    }

    #[test]
    fn flatten_post_unknown_tag_uses_text_or_marker() {
        let body = json!({
            "content": [
                [{"tag": "foo", "text": "verbatim"}],
                [{"tag": "bar"}],
            ]
        });
        assert_eq!(flatten_post_to_text(&body), "verbatim\n[bar]");
    }

    #[test]
    fn flatten_post_empty_returns_empty() {
        let body = json!({"title": "", "content": []});
        assert_eq!(flatten_post_to_text(&body), "");
    }

    #[test]
    fn flatten_post_realistic_lark_payload() {
        // Mirrors what Lark sends for: paste with a link + bold + mention.
        let body = json!({
            "title": "Feature request",
            "content": [
                [
                    {"tag": "at", "user_name": "Bot", "user_id": "ou_bot"},
                    {"tag": "text", "text": " can you check "},
                    {"tag": "a", "text": "this issue", "href": "https://example.com/i/1"},
                    {"tag": "text", "text": "?"},
                ],
                [{"tag": "text", "text": "thanks!"}],
            ]
        });
        assert_eq!(
            flatten_post_to_text(&body),
            "Feature request\n@Bot can you check this issue (https://example.com/i/1)?\nthanks!"
        );
    }

    // ----- num_or_str_f64 -----

    #[test]
    fn num_or_str_f64_accepts_both_shapes() {
        assert_eq!(num_or_str_f64(&json!(1.5)), Some(1.5));
        assert_eq!(num_or_str_f64(&json!("2.25")), Some(2.25));
        assert_eq!(num_or_str_f64(&json!("not a number")), None);
        assert_eq!(num_or_str_f64(&json!(null)), None);
    }

    // ----- new message_type translations -----
    //
    // We test the body-of-arm logic by inlining the same arms a small
    // helper that mirrors the production switch. Keeps tests self-
    // contained without booting the plugin.

    fn translate_message(message_type: &str, content: Value) -> Option<String> {
        match message_type {
            "sticker" => {
                let key = content
                    .get("file_key")
                    .or_else(|| content.get("sticker_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                Some(format!("[sticker:{key}]"))
            }
            "share_chat" => {
                let cid = content
                    .get("chat_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                Some(format!("[shared chat: {cid}]"))
            }
            "share_user" => {
                let uid = content
                    .get("user_id")
                    .or_else(|| content.get("open_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("?");
                Some(format!("[shared user: {uid}]"))
            }
            "location" => {
                let name = content.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let lat = content.get("latitude").and_then(num_or_str_f64);
                let lng = content.get("longitude").and_then(num_or_str_f64);
                Some(match (name.is_empty(), lat, lng) {
                    (false, Some(la), Some(ln)) => {
                        format!("[location: {name} ({la}, {ln})]")
                    }
                    (true, Some(la), Some(ln)) => {
                        format!("[location: ({la}, {ln})]")
                    }
                    (false, _, _) => format!("[location: {name}]"),
                    _ => "[location]".to_string(),
                })
            }
            "system" => {
                let template = content
                    .get("template")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let actor = content
                    .get("from_user")
                    .and_then(|v| v.as_array())
                    .and_then(|a| a.first())
                    .and_then(|u| u.get("user_name").or_else(|| u.get("user_id")))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                Some(match (template.is_empty(), actor.is_empty()) {
                    (true, _) => "[system event]".to_string(),
                    (false, true) => format!("[system: {template}]"),
                    (false, false) => format!("[system: {template} (by {actor})]"),
                })
            }
            "interactive" => Some("[interactive card]".to_string()),
            _ => None,
        }
    }

    #[test]
    fn sticker_uses_file_key() {
        assert_eq!(
            translate_message("sticker", json!({"file_key": "img_xyz"})),
            Some("[sticker:img_xyz]".to_string())
        );
    }

    #[test]
    fn sticker_falls_back_to_sticker_id() {
        assert_eq!(
            translate_message("sticker", json!({"sticker_id": "s_42"})),
            Some("[sticker:s_42]".to_string())
        );
    }

    #[test]
    fn sticker_marker_when_no_id() {
        assert_eq!(
            translate_message("sticker", json!({})),
            Some("[sticker:?]".to_string())
        );
    }

    #[test]
    fn share_chat_extracts_chat_id() {
        assert_eq!(
            translate_message("share_chat", json!({"chat_id": "oc_abc"})),
            Some("[shared chat: oc_abc]".to_string())
        );
    }

    #[test]
    fn share_user_prefers_user_id_over_open_id() {
        assert_eq!(
            translate_message(
                "share_user",
                json!({"user_id": "ou_a", "open_id": "ou_b"})
            ),
            Some("[shared user: ou_a]".to_string())
        );
        assert_eq!(
            translate_message("share_user", json!({"open_id": "ou_b"})),
            Some("[shared user: ou_b]".to_string())
        );
    }

    #[test]
    fn location_full_name_and_coords() {
        assert_eq!(
            translate_message(
                "location",
                json!({"name": "Hongqiao", "latitude": 31.2, "longitude": 121.4})
            ),
            Some("[location: Hongqiao (31.2, 121.4)]".to_string())
        );
    }

    #[test]
    fn location_string_coords_tolerated() {
        assert_eq!(
            translate_message(
                "location",
                json!({"name": "X", "latitude": "10.5", "longitude": "20.7"})
            ),
            Some("[location: X (10.5, 20.7)]".to_string())
        );
    }

    #[test]
    fn location_name_only() {
        assert_eq!(
            translate_message("location", json!({"name": "Office"})),
            Some("[location: Office]".to_string())
        );
    }

    #[test]
    fn location_coords_only() {
        assert_eq!(
            translate_message(
                "location",
                json!({"latitude": 1.0, "longitude": 2.0})
            ),
            Some("[location: (1, 2)]".to_string())
        );
    }

    #[test]
    fn location_empty_marker() {
        assert_eq!(
            translate_message("location", json!({})),
            Some("[location]".to_string())
        );
    }

    #[test]
    fn system_with_template_and_actor() {
        assert_eq!(
            translate_message(
                "system",
                json!({
                    "template": "added bot to chat",
                    "from_user": [{"user_name": "Alice"}],
                })
            ),
            Some("[system: added bot to chat (by Alice)]".to_string())
        );
    }

    #[test]
    fn system_template_only() {
        assert_eq!(
            translate_message(
                "system",
                json!({"template": "user left"})
            ),
            Some("[system: user left]".to_string())
        );
    }

    #[test]
    fn system_falls_back_when_no_template() {
        assert_eq!(
            translate_message("system", json!({})),
            Some("[system event]".to_string())
        );
    }

    #[test]
    fn interactive_returns_marker() {
        assert_eq!(
            translate_message("interactive", json!({})),
            Some("[interactive card]".to_string())
        );
    }

    // ----- reaction event extraction -----

    /// Sub-helper that mirrors the field-extraction logic in
    /// handle_reaction_event so we can test it without spawning the
    /// stdio loop.
    fn extract_reaction(envelope: &Value, event_type: &str) -> (String, String, String, String) {
        let event = envelope.pointer("/event").unwrap_or(&Value::Null);
        let message_id = event
            .pointer("/message_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let emoji = event
            .pointer("/reaction_type/emoji_type")
            .and_then(|v| v.as_str())
            .unwrap_or("?")
            .to_string();
        let user_id = event
            .pointer("/user_id/open_id")
            .or_else(|| event.pointer("/user_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let action = if event_type.ends_with("created_v1") {
            "added"
        } else {
            "removed"
        }
        .to_string();
        (message_id, emoji, user_id, action)
    }

    #[test]
    fn reaction_extraction_full_payload() {
        let env = json!({
            "header": {"event_type": "im.message.reaction.created_v1"},
            "event": {
                "message_id": "om_abc",
                "reaction_type": {"emoji_type": "THUMBSUP"},
                "user_id": {"open_id": "ou_xy"},
                "action_time": "1715000000000",
            }
        });
        let (mid, em, uid, act) =
            extract_reaction(&env, "im.message.reaction.created_v1");
        assert_eq!(mid, "om_abc");
        assert_eq!(em, "THUMBSUP");
        assert_eq!(uid, "ou_xy");
        assert_eq!(act, "added");
    }

    #[test]
    fn reaction_extraction_deleted_action() {
        let env = json!({
            "header": {"event_type": "im.message.reaction.deleted_v1"},
            "event": {
                "message_id": "om_abc",
                "reaction_type": {"emoji_type": "DONE"},
                "user_id": {"open_id": "ou_xy"},
            }
        });
        let (_, em, _, act) =
            extract_reaction(&env, "im.message.reaction.deleted_v1");
        assert_eq!(em, "DONE");
        assert_eq!(act, "removed");
    }

    #[test]
    fn reaction_extraction_user_id_string_fallback() {
        let env = json!({
            "event": {
                "message_id": "om_x",
                "reaction_type": {"emoji_type": "X"},
                "user_id": "ou_flat",
            }
        });
        let (_, _, uid, _) = extract_reaction(&env, "im.message.reaction.created_v1");
        assert_eq!(uid, "ou_flat");
    }

    #[test]
    fn reaction_extraction_missing_emoji_marker() {
        let env = json!({"event": {"message_id": "om_x"}});
        let (_, em, _, _) = extract_reaction(&env, "im.message.reaction.created_v1");
        assert_eq!(em, "?");
    }

    // ----- recall event translation -----

    #[tokio::test]
    async fn recall_event_emits_message_recalled_notification() {
        let env = json!({
            "header": {"event_type": "im.message.recalled_v1"},
            "event": {
                "message_id": "om_recall_1",
                "chat_id": "oc_chat_1",
                "recall_time": "1715000000000",
                "recall_type": "message_owner"
            }
        });
        let (tx, mut rx) = mpsc::unbounded_channel::<JsonRpcMessage>();
        super::handle_recall_event(&tx, &env).await.unwrap();
        let msg = rx.recv().await.expect("a notification was sent");
        let notif = match msg {
            JsonRpcMessage::Notification(n) => n,
            other => panic!("expected Notification, got {other:?}"),
        };
        assert_eq!(notif.method, plugin_to_host::EVENT_MESSAGE_RECALLED);
        let params: MessageRecalledParams =
            serde_json::from_value(notif.params.unwrap()).unwrap();
        assert_eq!(params.chat_id, "oc_chat_1");
        assert_eq!(params.message_id, "om_recall_1");
        assert!(
            params.user_id.is_empty(),
            "recall events don't carry a stable actor id"
        );
        // 1715000000000 ms = 2024-05-06T14:53:20Z; round-trip year only
        // (date components vary by TZ printing — check year prefix).
        assert!(
            params.recalled_at.starts_with("2024-"),
            "got recalled_at: {}",
            params.recalled_at
        );
    }

    #[tokio::test]
    async fn recall_event_skipped_when_chat_id_missing() {
        // Older Lark schemas occasionally omit chat_id; handler must
        // log + drop rather than emit a broken notification.
        let env = json!({
            "header": {"event_type": "im.message.recalled_v1"},
            "event": {"message_id": "om_x", "recall_time": "1715000000000"}
        });
        let (tx, mut rx) = mpsc::unbounded_channel::<JsonRpcMessage>();
        super::handle_recall_event(&tx, &env).await.unwrap();
        assert!(
            rx.try_recv().is_err(),
            "no notification expected when chat_id is missing"
        );
    }

    #[tokio::test]
    async fn recall_event_falls_back_to_now_on_bad_recall_time() {
        let env = json!({
            "header": {"event_type": "im.message.recalled_v1"},
            "event": {
                "message_id": "om_x",
                "chat_id": "oc_x",
                "recall_time": "not-a-number"
            }
        });
        let (tx, mut rx) = mpsc::unbounded_channel::<JsonRpcMessage>();
        super::handle_recall_event(&tx, &env).await.unwrap();
        let msg = rx.recv().await.unwrap();
        let notif = match msg {
            JsonRpcMessage::Notification(n) => n,
            other => panic!("got {other:?}"),
        };
        let params: MessageRecalledParams =
            serde_json::from_value(notif.params.unwrap()).unwrap();
        // Fallback timestamp is `Utc::now().to_rfc3339()` — assert
        // shape, not value (chrono RFC3339 always emits a 4-digit year
        // and ends in Z or +offset).
        assert!(
            params.recalled_at.len() >= 20,
            "expected RFC3339 timestamp, got {:?}",
            params.recalled_at
        );
    }

    // ----- markdown_for_lark -----

    #[test]
    fn markdown_h1_gets_bar_marker_and_bold() {
        assert_eq!(markdown_for_lark("# Title\n", MarkdownMode::V1), "▎ **Title**\n");
    }

    #[test]
    fn markdown_h2_gets_chevron_and_bold() {
        assert_eq!(markdown_for_lark("## Section\n", MarkdownMode::V1), "▸ **Section**\n");
    }

    #[test]
    fn markdown_h3_to_h6_are_just_bold() {
        assert_eq!(markdown_for_lark("### Sub\n", MarkdownMode::V1), "**Sub**\n");
        assert_eq!(markdown_for_lark("#### Deep\n", MarkdownMode::V1), "**Deep**\n");
        assert_eq!(markdown_for_lark("##### Deeper\n", MarkdownMode::V1), "**Deeper**\n");
        assert_eq!(markdown_for_lark("###### Deepest\n", MarkdownMode::V1), "**Deepest**\n");
    }

    #[test]
    fn markdown_preserves_non_header_lines_verbatim() {
        let input = "# Hello\n\nplain text\n- list\n**bold**\n";
        let out = markdown_for_lark(input, MarkdownMode::V1);
        assert!(out.contains("▎ **Hello**\n"));
        assert!(out.contains("\nplain text\n"));
        assert!(out.contains("- list\n"));
        assert!(out.contains("**bold**\n"));
    }

    #[test]
    fn markdown_does_not_touch_fenced_code() {
        // `# comment` inside a fence is shell, not a header.
        let input = "# Real Header\n```bash\n# this is a comment\necho hi\n```\n# After\n";
        let out = markdown_for_lark(input, MarkdownMode::V1);
        assert!(out.contains("▎ **Real Header**\n"));
        assert!(out.contains("# this is a comment\n"));
        assert!(out.contains("▎ **After**\n"));
    }

    #[test]
    fn markdown_handles_seven_or_more_hashes_as_text() {
        // Spec caps headers at 6; `####### x` is plain text in standard MD.
        assert_eq!(markdown_for_lark("####### nope\n", MarkdownMode::V1), "####### nope\n");
    }

    #[test]
    fn markdown_requires_space_after_hash() {
        // `#tag` is a hashtag, not a header.
        assert_eq!(markdown_for_lark("#tag\n", MarkdownMode::V1), "#tag\n");
        // `##broken` likewise.
        assert_eq!(markdown_for_lark("##broken\n", MarkdownMode::V1), "##broken\n");
    }

    #[test]
    fn markdown_preserves_leading_indent() {
        assert_eq!(
            markdown_for_lark("  ### nested\n", MarkdownMode::V1),
            "  **nested**\n"
        );
    }

    #[test]
    fn markdown_handles_text_without_trailing_newline() {
        // Last line of LLM output sometimes has no newline. The function
        // shouldn't synthesise one.
        assert_eq!(markdown_for_lark("# Title", MarkdownMode::V1), "▎ **Title**");
        assert_eq!(markdown_for_lark("plain", MarkdownMode::V1), "plain");
    }

    #[test]
    fn markdown_realistic_llm_reply() {
        // Mimics the kind of output DeepSeek produces.
        let input = r#"# Rust 异步运行时对比

## 1. Tokio

**优点：**
- 生态最成熟
- 性能优秀

```rust
// not a header even though it starts with //
let x = 1;
```

### 总结

选 Tokio 就对了。
"#;
        let out = markdown_for_lark(input, MarkdownMode::V1);
        assert!(out.contains("▎ **Rust 异步运行时对比**"));
        assert!(out.contains("▸ **1. Tokio**"));
        assert!(out.contains("**总结**"));
        assert!(out.contains("// not a header"));
        assert!(out.contains("- 生态最成熟"));
    }

    #[test]
    fn markdown_empty_header_left_alone() {
        // `# ` with nothing after is meaningless; preserve verbatim.
        assert_eq!(markdown_for_lark("# \n", MarkdownMode::V1), "# \n");
    }

    #[test]
    fn markdown_preserves_blank_lines() {
        let input = "# A\n\n\n## B\n";
        let out = markdown_for_lark(input, MarkdownMode::V1);
        assert_eq!(out, "▎ **A**\n\n\n▸ **B**\n");
    }

    // ----- table conversion -----

    #[test]
    fn table_2col_becomes_inline_kv() {
        let input = "| Key | Value |\n|-----|-------|\n| 生态 | 最成熟 |\n| 性能 | 优秀 |\n";
        let out = markdown_for_lark(input, MarkdownMode::V1);
        assert!(out.contains("**生态**: 最成熟\n"));
        assert!(out.contains("**性能**: 优秀\n"));
        assert!(!out.contains("|---"), "separator should be gone");
        assert!(!out.contains("| Key |"), "header row should be gone");
    }

    #[test]
    fn table_3col_becomes_per_row_bullet_list() {
        let input = "\
| 特性 | Tokio | smol |
|------|-------|------|
| 生态 | 最成熟 | 最小 |
| 性能 | 9/10 | 7/10 |
";
        let out = markdown_for_lark(input, MarkdownMode::V1);
        assert!(out.contains("**生态**\n- Tokio: 最成熟\n- smol: 最小\n"));
        assert!(out.contains("**性能**\n- Tokio: 9/10\n- smol: 7/10\n"));
        // Separator and header row should not survive.
        assert!(!out.contains("|---"));
        assert!(!out.contains("| 特性 |"));
    }

    #[test]
    fn table_1col_emits_bold_lines() {
        let input = "| Item |\n|------|\n| First |\n| Second |\n";
        let out = markdown_for_lark(input, MarkdownMode::V1);
        assert!(out.contains("**First**\n"));
        assert!(out.contains("**Second**\n"));
    }

    #[test]
    fn table_empty_cells_become_em_dash() {
        let input = "| K | V |\n|---|---|\n| a |  |\n|   | b |\n";
        let out = markdown_for_lark(input, MarkdownMode::V1);
        assert!(out.contains("**a**: —\n"));
        assert!(out.contains("**—**: b\n"));
    }

    #[test]
    fn table_inside_fenced_code_left_alone() {
        let input = "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n";
        let out = markdown_for_lark(input, MarkdownMode::V1);
        assert!(out.contains("| a | b |\n"));
        assert!(out.contains("|---|---|\n"));
        assert!(out.contains("| 1 | 2 |\n"));
    }

    #[test]
    fn table_without_separator_is_plain_text() {
        // Real bar character at line start without the `|---|` next line —
        // not a table, should pass through verbatim.
        let input = "| not | a | table |\nfollowed by prose\n";
        let out = markdown_for_lark(input, MarkdownMode::V1);
        assert_eq!(out, input);
    }

    #[test]
    fn table_with_alignment_separator_recognised() {
        // `:---:` and `:---` are valid GFM alignment hints.
        let input = "| a | b |\n|:---|---:|\n| x | y |\n";
        let out = markdown_for_lark(input, MarkdownMode::V1);
        assert!(out.contains("**x**: y\n"));
    }

    #[test]
    fn table_in_realistic_llm_reply_combined_with_headers() {
        let input = "\
## 客户档案

| 客户 | 状态 |
|------|------|
| 赛鼎 | ✅ |
| 湘阁里辣 | ✅ |

继续：
";
        let out = markdown_for_lark(input, MarkdownMode::V1);
        assert!(out.contains("▸ **客户档案**\n"));
        assert!(out.contains("**赛鼎**: ✅\n"));
        assert!(out.contains("**湘阁里辣**: ✅\n"));
        assert!(out.contains("继续：\n"));
        assert!(!out.contains("|---"));
    }

    #[test]
    fn table_passthrough_when_native_mode_forced() {
        // Force-native via env should keep raw pipes even in v1 mode.
        std::env::set_var("LARK_TABLE_MODE", "native");
        let input = "| a | b |\n|---|---|\n| 1 | 2 |\n";
        let out = markdown_for_lark(input, MarkdownMode::V1);
        std::env::remove_var("LARK_TABLE_MODE");
        assert!(out.contains("| a | b |\n"));
        assert!(out.contains("| 1 | 2 |\n"));
    }

    #[test]
    fn v2_mode_keeps_tables_native_by_default() {
        let input = "| a | b |\n|---|---|\n| 1 | 2 |\n";
        let out = markdown_for_lark(input, MarkdownMode::V2);
        assert!(out.contains("| a | b |\n"));
        assert!(out.contains("| 1 | 2 |\n"));
    }

    #[test]
    fn v2_mode_demotes_h1_to_h4_and_others_to_h5() {
        assert_eq!(
            markdown_for_lark("# Title\n", MarkdownMode::V2),
            "#### Title\n"
        );
        assert_eq!(
            markdown_for_lark("## Section\n", MarkdownMode::V2),
            "##### Section\n"
        );
        assert_eq!(
            markdown_for_lark("### Sub\n", MarkdownMode::V2),
            "##### Sub\n"
        );
        assert_eq!(
            markdown_for_lark("###### Deepest\n", MarkdownMode::V2),
            "##### Deepest\n"
        );
    }

    #[test]
    fn v2_mode_no_unicode_prefix_or_bold_wrap() {
        // Sanity: v2 should NOT add the v1 ▎/▸ markers or wrap in **.
        let out = markdown_for_lark("# Hello\n", MarkdownMode::V2);
        assert!(!out.contains("▎"));
        assert!(!out.contains("▸"));
        assert!(!out.contains("**"));
    }

    #[test]
    fn lark_table_mode_list_forces_conversion_in_v2() {
        std::env::set_var("LARK_TABLE_MODE", "list");
        let input = "| a | b |\n|---|---|\n| 1 | 2 |\n";
        let out = markdown_for_lark(input, MarkdownMode::V2);
        std::env::remove_var("LARK_TABLE_MODE");
        // Even in v2, an explicit `list` override flattens to bullets.
        assert!(out.contains("**1**: 2\n"));
        assert!(!out.contains("|---"));
    }

    #[test]
    fn malformed_table_v2_synthesises_header_and_separator() {
        // LLM forgot the separator. We inject a numeric header + separator
        // so all LLM rows become body rows (Lark fills empty header cells
        // with `--`, but empty body cells stay empty — that's what we want).
        let input = "| 1×1=1 | | |\n| 2×1=2 | 2×2=4 | |\n| 3×1=3 | 3×2=6 | 3×3=9 |\n";
        let out = markdown_for_lark(input, MarkdownMode::V2);
        // Synthetic numeric header — column count is the widest row.
        assert!(out.contains("| 1 | 2 | 3 |\n"));
        assert!(out.contains("|---|---|---|\n"));
        // Original rows preserved as body.
        assert!(out.contains("| 1×1=1 | | |\n"));
        assert!(out.contains("| 3×1=3 | 3×2=6 | 3×3=9 |\n"));
    }

    #[test]
    fn malformed_table_widest_row_drives_column_count() {
        // First row has 2 columns, second has 4. We need 4-column header
        // so the wider row's data isn't silently truncated by Lark.
        let input = "| a |\n| b |\n| c | d | e | f |\n";
        let out = markdown_for_lark(input, MarkdownMode::V2);
        assert!(out.contains("| 1 | 2 | 3 | 4 |\n"));
        assert!(out.contains("|---|---|---|---|\n"));
    }

    #[test]
    fn malformed_table_v1_synthesises_then_flattens() {
        // v1 path: synthetic numeric header + separator triggers the
        // list-flattening renderer. For a 2-column body the renderer
        // collapses to `**col0**: col1` (the synthetic "2" label is
        // meaningless and the renderer's 2-column branch drops it).
        let input = "| Alice | Eng |\n| Bob | Sales |\n| Carol | PM |\n";
        let out = markdown_for_lark(input, MarkdownMode::V1);
        assert!(out.contains("**Alice**: Eng\n"));
        assert!(out.contains("**Bob**: Sales\n"));
        assert!(out.contains("**Carol**: PM\n"));
        assert!(!out.contains("|---"));
    }

    #[test]
    fn malformed_table_v1_3plus_columns_uses_bullet_list() {
        // For 3+ columns the renderer emits `**col0**` plus per-column
        // bullets labelled with the synthetic numeric header.
        let input = "| Alice | Eng | NY |\n| Bob | Sales | SF |\n";
        let out = markdown_for_lark(input, MarkdownMode::V1);
        assert!(out.contains("**Alice**\n- 2: Eng\n- 3: NY\n"));
        assert!(out.contains("**Bob**\n- 2: Sales\n- 3: SF\n"));
        assert!(!out.contains("|---"));
    }

    #[test]
    fn single_pipe_line_not_treated_as_table() {
        // One `|`-line on its own is just text, not a malformed table.
        let input = "| just one line |\nfollowed by prose\n";
        let out = markdown_for_lark(input, MarkdownMode::V2);
        assert_eq!(out, input);
    }

    #[test]
    fn looks_like_table_row_basics() {
        assert!(looks_like_table_row("| a | b |"));
        assert!(looks_like_table_row("|x|"));
        assert!(!looks_like_table_row("a | b"));
        assert!(!looks_like_table_row("|"));
        assert!(!looks_like_table_row(""));
    }

    #[test]
    fn is_table_separator_basics() {
        assert!(is_table_separator("|---|---|"));
        assert!(is_table_separator("| --- | --- |"));
        assert!(is_table_separator("|:---|:---:|---:|"));
        assert!(!is_table_separator("| a | b |"));
        assert!(!is_table_separator("|---|abc|"));
        assert!(!is_table_separator("|"));
        assert!(!is_table_separator("|||"));
    }

    // ----- expiry / dedup -----

    #[test]
    fn message_expiry_empty_string_treated_as_fresh() {
        assert!(!is_message_expired_now(""));
    }

    #[test]
    fn message_expiry_unparseable_treated_as_fresh() {
        // Bad input shouldn't drop messages — over-process beats silent loss.
        assert!(!is_message_expired_now("not-a-number"));
    }

    #[test]
    fn message_expiry_recent_timestamp_passes() {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let recent = (now_ms - 60_000).to_string(); // 1 min ago
        assert!(!is_message_expired_now(&recent));
    }

    #[test]
    fn message_expiry_old_timestamp_drops() {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let old = (now_ms - 60 * 60 * 1000).to_string(); // 1 hour ago
        assert!(is_message_expired_now(&old));
    }

    #[test]
    fn dedup_first_seen_returns_false() {
        let mut d = MessageDedup::new();
        assert!(!d.check_and_record("om_first"));
    }

    #[test]
    fn dedup_second_seen_returns_true() {
        let mut d = MessageDedup::new();
        d.check_and_record("om_dup");
        assert!(d.check_and_record("om_dup"));
    }

    #[test]
    fn dedup_distinct_ids_dont_collide() {
        let mut d = MessageDedup::new();
        assert!(!d.check_and_record("om_a"));
        assert!(!d.check_and_record("om_b"));
        assert!(!d.check_and_record("om_c"));
        assert_eq!(d.seen.len(), 3);
    }

    #[test]
    fn dedup_evicts_oldest_at_capacity() {
        let mut d = MessageDedup::new();
        for i in 0..DEDUP_MAX_ENTRIES {
            d.check_and_record(&format!("om_{i}"));
        }
        assert_eq!(d.seen.len(), DEDUP_MAX_ENTRIES);
        // Next insert should evict om_0 to make room.
        d.check_and_record("om_overflow");
        assert!(d.seen.contains_key("om_overflow"));
        assert!(!d.seen.contains_key("om_0"));
        assert_eq!(d.seen.len(), DEDUP_MAX_ENTRIES);
    }
}
