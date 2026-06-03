//! `McpClient` — one connected MCP server.
//!
//! Holds the rmcp `RunningService` plus a cached `tools/list` result so
//! callers don't pay a network round-trip just to enumerate tools.

use crate::config::{McpServerConfig, McpTransport};
use crate::error::{McpError, McpResult};
use rmcp::model::{CallToolRequestParams, CallToolResult, Tool as RmcpTool};
use rmcp::service::RunningService;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::{StreamableHttpClientTransport, TokioChildProcess};
use rmcp::{RoleClient, ServiceExt};
use serde_json::Value;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tokio::process::Command;
use tracing::{debug, info, warn};

const DEFAULT_INIT_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// Short cap on the liveness probe. The probe is one `tools/list` RPC
/// against an already-connected server; if it doesn't answer in 5s the
/// connection is effectively dead and we want the pool's idle sweep to
/// evict it rather than block the sweep behind a 60s tool-call budget.
const HEALTH_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

pub struct McpClient {
    name: String,
    service: Arc<RunningService<RoleClient, ()>>,
    tools: Vec<RmcpTool>,
    /// Per-RPC budget for `tools/call`. Set once at connect from
    /// `McpServerConfig::call_timeout_secs` (falls back to
    /// `DEFAULT_CALL_TIMEOUT`).
    call_timeout: Duration,
}

impl McpClient {
    /// Spawn the server child process, perform the MCP initialize
    /// handshake, and pre-fetch its tool list. No sandbox — for production
    /// multi-tenant deployments use [`McpClient::connect_sandboxed`].
    pub async fn connect(config: &McpServerConfig) -> McpResult<Self> {
        Self::connect_sandboxed(config, None).await
    }

    /// Same as [`connect`](Self::connect) but applies a landlock ruleset
    /// to the child's process tree before exec, confining it to
    /// `sandbox_workspace` plus `/tmp` (writable) plus the standard
    /// read-only system dirs. `/tmp` is whitelisted because many MCP
    /// servers (e.g. fetch, github) want a scratch directory; if you
    /// need stricter, `connect` does no sandboxing at all and the
    /// caller is expected to gate spawn at a different layer.
    ///
    /// `sandbox_workspace = None` is identical to `connect` — kept as
    /// one entry point so the pool can decide per-call.
    pub async fn connect_sandboxed(
        config: &McpServerConfig,
        sandbox_workspace: Option<&Path>,
    ) -> McpResult<Self> {
        let timeout = config
            .init_timeout_secs
            .map(Duration::from_secs)
            .unwrap_or(DEFAULT_INIT_TIMEOUT);

        let service = match &config.transport {
            McpTransport::Stdio => connect_stdio(config, sandbox_workspace, timeout).await?,
            McpTransport::Http {
                url,
                auth_token,
                custom_headers,
            } => {
                // Sandboxing only applies when WE spawn the process; for
                // remote HTTP the server runs elsewhere. Log a hint so
                // operators don't assume otherwise.
                if sandbox_workspace.is_some() {
                    debug!(
                        server = %config.name,
                        "ignoring sandbox_workspace for http transport"
                    );
                }
                connect_http(
                    &config.name,
                    url,
                    auth_token.as_deref(),
                    custom_headers,
                    timeout,
                )
                .await?
            }
        };

        let listing = service
            .list_tools(Default::default())
            .await
            .map_err(|e| McpError::Initialization {
                server: config.name.clone(),
                reason: format!("list_tools: {e}"),
            })?;

        info!(
            server = %config.name,
            tool_count = listing.tools.len(),
            transport = transport_kind(&config.transport),
            "mcp server connected"
        );

        let call_timeout = config
            .call_timeout_secs
            .map(Duration::from_secs)
            .unwrap_or(DEFAULT_CALL_TIMEOUT);

        Ok(McpClient {
            name: config.name.clone(),
            service: Arc::new(service),
            tools: listing.tools,
            call_timeout,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn tools(&self) -> &[RmcpTool] {
        &self.tools
    }

    pub fn service(&self) -> Arc<RunningService<RoleClient, ()>> {
        self.service.clone()
    }

    /// Issue a `tools/call`. `arguments` should be a JSON object;
    /// non-object values are treated as `None` (i.e. no arguments).
    ///
    /// Bounded by `self.call_timeout`. On timeout the rmcp request
    /// future is dropped — rmcp's `Cancellation` notification fires
    /// from `RunningService` if the server later replies, so we won't
    /// leak a half-completed call against the next request.
    pub async fn call_tool(
        &self,
        tool_name: &str,
        arguments: Value,
    ) -> McpResult<CallToolResult> {
        let arguments = arguments.as_object().cloned();
        debug!(server = %self.name, tool = tool_name, "calling mcp tool");
        // CallToolRequestParams is `#[non_exhaustive]` — populate defaults
        // first, then override the fields we care about.
        let mut param = CallToolRequestParams::default();
        param.name = tool_name.to_string().into();
        param.arguments = arguments;
        match tokio::time::timeout(self.call_timeout, self.service.call_tool(param)).await {
            Ok(Ok(res)) => Ok(res),
            Ok(Err(e)) => Err(McpError::ToolCall {
                server: self.name.clone(),
                tool: tool_name.to_string(),
                reason: e.to_string(),
            }),
            Err(_) => {
                warn!(
                    server = %self.name,
                    tool = tool_name,
                    timeout_secs = self.call_timeout.as_secs(),
                    "mcp tool call timed out"
                );
                Err(McpError::Timeout {
                    server: self.name.clone(),
                    tool: tool_name.to_string(),
                    timeout_secs: self.call_timeout.as_secs(),
                })
            }
        }
    }

    /// Round-trip a cheap RPC to verify the connection is still
    /// alive. Uses `tools/list` — every MCP server implements it, and
    /// we don't store the result so cached `tools()` stays the
    /// startup snapshot. Returns `Ok(())` if the server replies,
    /// `Err(McpError::HealthCheckFailed)` otherwise (timeout maps to
    /// the same error variant with a `timed out` reason — the pool
    /// treats both identically: evict on the next sweep). Bounded by
    /// `HEALTH_PROBE_TIMEOUT` (5s) — a probe that hangs longer than
    /// that is itself a sign of a dead connection.
    pub async fn health_check(&self) -> McpResult<()> {
        match tokio::time::timeout(HEALTH_PROBE_TIMEOUT, self.service.list_tools(Default::default()))
            .await
        {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => Err(McpError::HealthCheckFailed {
                server: self.name.clone(),
                reason: e.to_string(),
            }),
            Err(_) => Err(McpError::HealthCheckFailed {
                server: self.name.clone(),
                reason: format!(
                    "timed out after {}s",
                    HEALTH_PROBE_TIMEOUT.as_secs()
                ),
            }),
        }
    }

    /// Best-effort graceful shutdown. The rmcp service is consumed by
    /// `cancel()`; we hold an `Arc` so we drop the local handle and let
    /// the last `Arc` owner cancel naturally on `Drop` if multiple clones
    /// exist.
    pub async fn shutdown(self) {
        match Arc::try_unwrap(self.service) {
            Ok(service) => {
                if let Err(e) = service.cancel().await {
                    warn!(server = %self.name, error = %e, "cancel returned error");
                }
            }
            Err(_) => {
                debug!(server = %self.name, "service still has clones; relying on Drop");
            }
        }
    }
}

/// Spawn a child process speaking MCP over stdio. Same shape as the
/// pre-Streamable-HTTP path; refactored out so the transport branch in
/// `connect_sandboxed` stays readable.
async fn connect_stdio(
    config: &McpServerConfig,
    sandbox_workspace: Option<&Path>,
    timeout: Duration,
) -> McpResult<RunningService<RoleClient, ()>> {
    let mut cmd = Command::new(&config.command);
    cmd.args(&config.args).envs(&config.env);
    if let Some(cwd) = &config.cwd {
        cmd.current_dir(cwd);
    }

    #[cfg(target_os = "linux")]
    if let Some(workspace) = sandbox_workspace {
        let workspace = workspace.to_path_buf();
        // MCP children typically need to write to a tool-cache (~/.npm,
        // ~/.cache/uv, etc.) and to /tmp. Allow both as defaults; the
        // landlock ruleset still blocks writes to system dirs (/etc,
        // /var, /usr) and to other tenants' project workspaces.
        let home = dirs::home_dir();
        unsafe {
            cmd.pre_exec(move || {
                let mut extras: Vec<&Path> = vec![Path::new("/tmp")];
                if let Some(h) = home.as_deref() {
                    extras.push(h);
                }
                snaca_workspace::sandbox::apply(&workspace, &extras)
                    .map_err(std::io::Error::other)?;
                Ok(())
            });
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = sandbox_workspace; // silence unused on non-linux
    }

    let transport = TokioChildProcess::new(cmd).map_err(|e| McpError::Initialization {
        server: config.name.clone(),
        reason: format!("spawn: {e}"),
    })?;

    tokio::time::timeout(timeout, ().serve(transport))
        .await
        .map_err(|_| McpError::Initialization {
            server: config.name.clone(),
            reason: "initialize timed out".into(),
        })?
        .map_err(|e| McpError::Initialization {
            server: config.name.clone(),
            reason: e.to_string(),
        })
}

/// Connect to a remote MCP server via the Streamable HTTP transport.
/// rmcp's reqwest backend handles SSE framing, session id management,
/// and graceful reconnect; we just hand it the URL + headers.
async fn connect_http(
    name: &str,
    url: &str,
    auth_token: Option<&str>,
    custom_headers: &std::collections::HashMap<String, String>,
    timeout: Duration,
) -> McpResult<RunningService<RoleClient, ()>> {
    use http::{HeaderName, HeaderValue};
    let mut headers: std::collections::HashMap<HeaderName, HeaderValue> =
        std::collections::HashMap::with_capacity(custom_headers.len());
    for (k, v) in custom_headers {
        let header_name = HeaderName::from_bytes(k.as_bytes()).map_err(|e| {
            McpError::Initialization {
                server: name.to_string(),
                reason: format!("invalid header name {k:?}: {e}"),
            }
        })?;
        let header_value = HeaderValue::from_str(v).map_err(|e| McpError::Initialization {
            server: name.to_string(),
            reason: format!("invalid header value for {k:?}: {e}"),
        })?;
        headers.insert(header_name, header_value);
    }

    let mut cfg = StreamableHttpClientTransportConfig::with_uri(url.to_string());
    if let Some(token) = auth_token {
        cfg = cfg.auth_header(token.to_string());
    }
    if !headers.is_empty() {
        cfg = cfg.custom_headers(headers);
    }
    // `<reqwest::Client as Default>::default()` builds a usable client
    // without forcing the caller to construct one. Tenants needing a
    // custom client (proxies, certs) can switch to a config that
    // overrides `with_client` once we expose that path.
    let transport: StreamableHttpClientTransport<reqwest::Client> =
        StreamableHttpClientTransport::with_client(reqwest::Client::default(), cfg);

    tokio::time::timeout(timeout, ().serve(transport))
        .await
        .map_err(|_| McpError::Initialization {
            server: name.to_string(),
            reason: "http initialize timed out".into(),
        })?
        .map_err(|e| McpError::Initialization {
            server: name.to_string(),
            reason: e.to_string(),
        })
}

fn transport_kind(t: &McpTransport) -> &'static str {
    match t {
        McpTransport::Stdio => "stdio",
        McpTransport::Http { .. } => "http",
    }
}
