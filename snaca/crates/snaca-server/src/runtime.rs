//! `Runtime` — the wiring layer.
//!
//! Splitting startup logic out of `main.rs` lets us instantiate a complete
//! SNACA process in tests (with a swappable `LlmClient`) without spawning a
//! real binary.

use crate::config::Config;
use crate::outbox;
use crate::plugin_registry::{PluginRegistry, PluginSpawner};
use anyhow::{anyhow, Context, Result};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use snaca_channel_host::PluginConfig;
use snaca_core::TenantId;
use snaca_engine::{Engine, EngineConfig};
use snaca_llm::anthropic::AnthropicConfig;
use snaca_llm::{
    deepseek::DeepSeekConfig, AnthropicClient, DeepSeekClient, LlmClient, RetryConfig,
    RetryingLlmClient,
};
use crate::tool_factory::LayeredToolFactory;
use snaca_mcp::{
    find_duplicate_server_name, validate_server_name, McpManager, McpServerConfig,
};
use snaca_skills::{LayoutSkillProvider, SkillProvider};
use snaca_state::Database;
use snaca_tools::base_tool_registry;
use snaca_workspace::WorkspaceLayout;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tracing::info;

/// Components produced from a [`Config`] — owned by the running server.
pub struct Runtime {
    pub engine: Arc<Engine>,
    /// Plugin lifecycle owner — supports listing + hot-reload via the
    /// admin HTTP API. Held inside an `Arc` so the HTTP handlers can
    /// share access without taking the runtime's exclusive `&mut`.
    pub plugins: Arc<PluginRegistry>,
    pub http_handle: HttpHandle,
    /// Connected MCP servers. Held so they aren't dropped (which would
    /// terminate their child processes) for the runtime's lifetime.
    pub mcp: Arc<McpManager>,
    /// One per-plugin background task that drains the persistent outbox
    /// of pending outbound deliveries. Independent of plugin-process
    /// lifecycle — survives plugin crashes/respawns. Held here so the
    /// tokio task isn't dropped before `Runtime` is.
    pub outbox_workers: Vec<JoinHandle<()>>,
    /// Shutdown signal for the outbox workers. `notify_one` per worker
    /// causes the corresponding task to exit at its next `select!` arm.
    /// Currently unused (Runtime has no explicit shutdown method) but
    /// kept so adding one later is a one-line change.
    pub outbox_shutdown: Arc<Notify>,
}

pub struct HttpHandle {
    pub local_addr: SocketAddr,
    pub task: JoinHandle<std::io::Result<()>>,
    pub shutdown: tokio::sync::oneshot::Sender<()>,
}

impl Runtime {
    /// Build everything from a config + an explicit `LlmClient`. Used by
    /// integration tests so they can inject a mock provider.
    pub async fn build_with_llm(config: Config, llm: Arc<dyn LlmClient>) -> Result<Self> {
        std::fs::create_dir_all(&config.server.data_root).with_context(|| {
            format!(
                "creating data_root {}",
                config.server.data_root.display()
            )
        })?;
        let data_root = std::fs::canonicalize(&config.server.data_root)?;

        let workspace = WorkspaceLayout::new(&data_root)?;

        let db_path = data_root.join("state.sqlite");
        let db = Database::open(&db_path).await?;
        info!(db = %db_path.display(), "opened state database");

        let tenant_id = TenantId::new(config.tenant.id.clone());

        // Build a manager for the configured MCP servers. No subprocesses
        // are spawned at startup — each (tenant, project) gets its own
        // connection on first use.
        let mcp_configs: Vec<McpServerConfig> = config
            .mcp
            .iter()
            .map(|s| McpServerConfig {
                name: s.name.clone(),
                transport: s.transport.clone(),
                command: s.command.clone(),
                args: s.args.clone(),
                env: s.env.clone(),
                cwd: s.cwd.clone(),
                init_timeout_secs: s.init_timeout_secs,
                call_timeout_secs: s.call_timeout_secs,
            })
            .collect();
        // Reject misconfigured MCP server names at startup. A name with
        // `__` would scramble the qualified-name codec; duplicates
        // would let one server overwrite another in the tool registry
        // without warning. Surface the first offender with a clear
        // pointer rather than discovering it on tool dispatch.
        for cfg in &mcp_configs {
            if let Err(reason) = validate_server_name(&cfg.name) {
                return Err(anyhow!(
                    "invalid [[mcp]] server name in config: {reason}"
                ));
            }
        }
        if let Some(dup) = find_duplicate_server_name(&mcp_configs) {
            return Err(anyhow!(
                "duplicate [[mcp]] server name {dup:?}; each server entry must have a unique `name`"
            ));
        }
        // Multi-tenant deployment — confine each MCP child to its
        // (tenant, project) workspace via landlock. Trusted single-tenant
        // setups can downgrade to `from_configs` if MCP servers need
        // broader filesystem access. The idle TTL is configurable so
        // long-running production deployments can reclaim subprocess
        // FDs without kicking active tenants.
        let mcp_idle_ttl = config
            .server
            .mcp_idle_ttl_secs
            .map(Duration::from_secs)
            .unwrap_or(snaca_mcp::pool::DEFAULT_IDLE_TTL);
        let mcp = Arc::new(McpManager::from_configs_with_layout_and_ttl(
            &mcp_configs,
            workspace.clone(),
            mcp_idle_ttl,
        ));
        // Start the periodic reaper so quiet pools still release their
        // subprocesses. `0` in config disables it (Manager treats zero
        // as "no reaper"). The reaper holds Weak refs, so it can't keep
        // McpManager alive past shutdown.
        let reaper_period = config
            .server
            .mcp_reaper_period_secs
            .map(Duration::from_secs)
            .unwrap_or(snaca_mcp::manager::DEFAULT_REAPER_PERIOD);
        mcp.start_reaper(reaper_period);

        // Multi-tenant tools come from a factory, not a static registry —
        // skills and MCP servers are loaded per (tenant, project) on demand.
        let base = base_tool_registry();
        info!(
            base_tool_count = base.len(),
            mcp_server_count = mcp.server_count(),
            "base tools assembled"
        );
        let skill_provider: Arc<dyn SkillProvider> =
            Arc::new(LayoutSkillProvider::new(workspace.clone()));
        let tool_factory = Arc::new(LayeredToolFactory::new(
            base.clone(),
            mcp.clone(),
            skill_provider,
        ));

        let engine_cfg = EngineConfig {
            model: config.llm.model.clone(),
            system_prompt: config
                .engine
                .system_prompt
                .clone()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| EngineConfig::default_for(&config.llm.model).system_prompt),
            max_iterations: config.engine.max_iterations.unwrap_or(10),
            max_tokens: config.engine.max_tokens.or(Some(4096)),
            history_limit: config.engine.history_limit.unwrap_or(50),
            // Treat `Some(0)` as "explicitly disabled" — same as `None`. Any
            // positive value enables auto-compaction at that threshold.
            compact_after_input_tokens: config
                .engine
                .compact_after_input_tokens
                .filter(|t| *t > 0),
            compact_keep_recent: config
                .engine
                .compact_keep_recent
                .filter(|k| *k >= 2)
                .unwrap_or(6),
            // 0 disables first-N protection (legacy "summary at the
            // head of history" behaviour). Any positive value keeps
            // the first N messages verbatim across compactions.
            protect_first_n: config.engine.protect_first_n.unwrap_or(4),
            // Caps the per-turn shrink-retry loop on
            // `LlmError::ContextOverflow`. `Some(0)` disables retry
            // entirely (single attempt then surface).
            compact_max_retries: config.engine.compact_max_retries.unwrap_or(3),
            compact_summary_max_tokens: config
                .engine
                .compact_summary_max_tokens
                .filter(|n| *n > 0)
                .unwrap_or(2048),
            // Production always runs compaction in the background — the
            // blocking path exists only for tests that need to assert on
            // post-compaction DB state without polling.
            compact_blocking: false,
            // `Some(0)` -> disabled. `None` -> keep engine default.
            loop_guard_max_repeats: match config.engine.loop_guard_max_repeats {
                Some(0) => None,
                Some(n) => Some(n),
                None => Some(3),
            },
            history_max_bytes: config.engine.history_max_bytes.unwrap_or(1_500_000),
            // None keeps the engine-default behaviour (no wall-clock
            // cap). Operators opt in by setting a positive value.
            turn_timeout_secs: config.engine.turn_timeout_secs.filter(|s| *s > 0),
            // 1 disables concurrency (degrades to sequential).
            concurrent_tool_limit: config
                .engine
                .concurrent_tool_limit
                .filter(|n| *n >= 1)
                .unwrap_or(5),
            // 0 disables collapse entirely; any positive value sets
            // the byte threshold above which old read-only
            // tool_results are replaced with a marker.
            collapse_tool_results_threshold: config
                .engine
                .collapse_tool_results_threshold
                .unwrap_or(1024),
            stream_tool_execution: config.engine.stream_tool_execution.unwrap_or(true),
            // 0 disables escalation entirely; any other value caps it.
            max_output_token_escalation_attempts: config
                .engine
                .max_output_token_escalation_attempts
                .unwrap_or(2),
            max_output_token_ceiling: config
                .engine
                .max_output_token_ceiling
                .filter(|n| *n > 0)
                .unwrap_or(32_768),
        };
        // The static `tools` parameter on `Engine::new` is the fallback
        // registry — used only if no factory is attached. We always attach
        // one in production, but pass `base` so tests / mocks that build
        // an `Engine` directly without a factory still see the built-ins.
        // One TaskRegistry per process — shared across all tenants /
        // projects, with tenant/project scoping enforced inside the
        // registry. Dropping the last Arc on shutdown SIGKILLs any
        // leftover background children via TaskRegistry's Drop.
        let task_registry_opaque: Arc<dyn std::any::Any + Send + Sync> =
            snaca_tools::TaskRegistry::new();

        let mut engine_obj = Engine::new(
            llm.clone(),
            base,
            db.clone(),
            workspace.clone(),
            engine_cfg,
        )
        .with_tool_factory(tool_factory.clone())
        .with_task_registry(task_registry_opaque);
        if let Some(embedder) = build_embedder(&config) {
            engine_obj = engine_obj.with_embedder(embedder);
        }
        if let Some(extractor) = build_memory_extractor(&config, llm.clone(), workspace.clone()) {
            engine_obj = engine_obj.with_memory_extractor(extractor);
        }
        if let Some(reranker) = build_memory_reranker(&config, llm.clone()) {
            engine_obj = engine_obj.with_reranker(reranker);
        }
        let engine = Arc::new(engine_obj);

        let typing_interval = config
            .server
            .typing_update_interval_ms
            .map(Duration::from_millis)
            .unwrap_or(crate::typing::DEFAULT_UPDATE_INTERVAL);

        let spawner = PluginSpawner {
            engine: engine.clone(),
            db: db.clone(),
            tenant_id: tenant_id.clone(),
            typing_interval,
        };
        let plugins = PluginRegistry::new(spawner);
        // Late-bind the plugin registry into the tool factory so per-turn
        // registry composition picks up plugin-advertised tools.
        // `tool_factory` was wrapped in `Arc` for engine handoff — we still
        // hold a clone here, and `set_plugins` only mutates an internal
        // OnceCell so concurrent reads are safe.
        tool_factory.set_plugins(plugins.clone());
        for p in &config.plugins {
            let mut builder = PluginConfig::builder(&p.name, &p.command).args(p.args.clone());
            for (k, v) in &p.env {
                builder = builder.env(k, v);
            }
            if let Some(cwd) = &p.cwd {
                builder = builder.cwd(cwd.clone());
            }
            plugins.insert(builder.build()).await?;
        }

        // Spawn one outbox worker per configured plugin name. These tasks
        // run for the lifetime of the process; they retry pending
        // outbound deliveries left behind when a plugin crashed mid-RPC,
        // so the user always eventually receives messages the engine
        // committed to send. See [`crate::outbox`] for the protocol.
        let outbox_shutdown = Arc::new(Notify::new());
        let outbox_workers: Vec<JoinHandle<()>> = config
            .plugins
            .iter()
            .map(|p| {
                outbox::spawn_worker(
                    db.clone(),
                    plugins.clone(),
                    p.name.clone(),
                    outbox_shutdown.clone(),
                )
            })
            .collect();

        let http_handle = start_http(
            &config.server.http_listen,
            Arc::new(AppState {
                plugins: plugins.clone(),
                engine: engine.clone(),
            }),
        )
        .await?;
        info!(addr = %http_handle.local_addr, "http listener bound");
        Ok(Runtime {
            engine,
            plugins,
            http_handle,
            mcp,
            outbox_workers,
            outbox_shutdown,
        })
    }

    /// Convenience: build a runtime from a config alone. Selects the
    /// configured provider; only `deepseek` is supported in M1.
    pub async fn build(config: Config) -> Result<Self> {
        let llm = build_llm(&config)?;
        Self::build_with_llm(config, llm).await
    }

    /// Stop everything. Called from `main` on Ctrl-C and from tests on
    /// teardown. Best-effort — errors are logged not propagated.
    pub async fn shutdown(self) {
        // Tell HTTP to stop serving.
        let _ = self.http_handle.shutdown.send(());
        match tokio::time::timeout(Duration::from_secs(5), self.http_handle.task).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => tracing::warn!(error=%e, "http task ended with error"),
            Ok(Err(e)) => tracing::warn!(error=%e, "http task panicked"),
            Err(_) => tracing::warn!("http task timed out during shutdown"),
        }
        self.plugins.shutdown_all().await;
        self.mcp.shutdown().await;
    }
}

fn build_llm(config: &Config) -> Result<Arc<dyn LlmClient>> {
    let retry_cfg = build_retry_config(&config.llm);
    match config.llm.provider.as_str() {
        "deepseek" => {
            let mut cfg = DeepSeekConfig::new(&config.llm.api_key).with_model(&config.llm.model);
            if let Some(url) = &config.llm.base_url {
                cfg = cfg.with_base_url(url.clone());
            }
            if let Some(secs) = config.llm.timeout_secs {
                cfg = cfg.with_timeout(Duration::from_secs(secs));
            }
            let raw = DeepSeekClient::new(cfg)?;
            Ok(Arc::new(RetryingLlmClient::new(raw, retry_cfg)))
        }
        "anthropic" => {
            let mut cfg = AnthropicConfig::new(&config.llm.api_key).with_model(&config.llm.model);
            if let Some(url) = &config.llm.base_url {
                cfg = cfg.with_base_url(url.clone());
            }
            if let Some(secs) = config.llm.timeout_secs {
                cfg = cfg.with_timeout(Duration::from_secs(secs));
            }
            if let Some(v) = &config.llm.anthropic_version {
                cfg = cfg.with_anthropic_version(v.clone());
            }
            let raw = AnthropicClient::new(cfg)?;
            Ok(Arc::new(RetryingLlmClient::new(raw, retry_cfg)))
        }
        other => Err(anyhow!("unsupported llm.provider: {other}")),
    }
}

/// Resolve a [`RetryConfig`] from the `[llm]` section, falling back to
/// the wrapper's defaults for any field the operator left unset.
fn build_retry_config(llm: &crate::config::LlmSection) -> RetryConfig {
    let defaults = RetryConfig::default();
    RetryConfig {
        max_attempts: llm.retry_max_attempts.unwrap_or(defaults.max_attempts),
        base_delay: llm
            .retry_base_delay_ms
            .map(Duration::from_millis)
            .unwrap_or(defaults.base_delay),
        max_delay: llm
            .retry_max_delay_secs
            .map(Duration::from_secs)
            .unwrap_or(defaults.max_delay),
        jitter_ratio: llm.retry_jitter_ratio.unwrap_or(defaults.jitter_ratio),
    }
}

/// Construct an embedder from `config.engine.memory_embedder`. Returns
/// `None` when the operator opts out (the default), the value is
/// unrecognised, or the requested backend isn't compiled in. We log
/// rather than panic so a misconfiguration only disables recall — the
/// rest of the engine still runs.
fn build_embedder(config: &Config) -> Option<Arc<dyn snaca_memory::Embedder>> {
    let kind = config
        .engine
        .memory_embedder
        .as_deref()
        .unwrap_or("none")
        .to_ascii_lowercase();
    match kind.as_str() {
        "" | "none" => None,
        "hash" => {
            let dim = config.engine.memory_embedder_dim.unwrap_or(128);
            info!(dim, "memory embedder = hash (development / tests only)");
            Some(Arc::new(snaca_memory::HashEmbedder::new(dim)))
        }
        "fastembed" => {
            #[cfg(feature = "fastembed")]
            {
                info!("memory embedder = fastembed (multilingual-e5-small)");
                match snaca_memory::FastEmbedEmbedder::try_new(
                    snaca_memory::FastEmbedConfig::default(),
                ) {
                    Ok(e) => Some(Arc::new(e) as Arc<dyn snaca_memory::Embedder>),
                    Err(e) => {
                        tracing::warn!(error = %e, "fastembed init failed; recall disabled");
                        None
                    }
                }
            }
            #[cfg(not(feature = "fastembed"))]
            {
                tracing::warn!(
                    "memory_embedder = \"fastembed\" but `fastembed` feature isn't compiled in; recall disabled"
                );
                None
            }
        }
        other => {
            tracing::warn!(
                memory_embedder = other,
                "unknown memory embedder; recall disabled"
            );
            None
        }
    }
}

/// Construct the post-turn memory extractor when enabled in config.
/// Always wraps the LLM extractor in the default sensitive-info filter
/// unless the operator explicitly opts out via
/// `memory_extractor_no_filter = true`.
fn build_memory_extractor(
    config: &Config,
    llm: Arc<dyn LlmClient>,
    workspace: WorkspaceLayout,
) -> Option<snaca_engine::SharedExtractor> {
    // Default on: the extractor is the mechanism that makes SNACA's
    // memory tree grow across turns. Operators can still opt out with
    // `memory_extractor = false` if the extra per-turn LLM call is
    // unwanted.
    if !config.engine.memory_extractor.unwrap_or(true) {
        return None;
    }
    let model = config
        .engine
        .memory_extractor_model
        .clone()
        .unwrap_or_else(|| config.llm.model.clone());
    info!(model = %model, "memory extractor enabled");
    // Pre-inject the existing-memory manifest so the LLM doesn't
    // re-propose names that already live in the tree — pads the
    // index over time otherwise.
    let raw: snaca_engine::SharedExtractor = Arc::new(
        snaca_engine::LlmMemoryExtractor::new(llm, model).with_workspace(workspace),
    );
    if config.engine.memory_extractor_no_filter.unwrap_or(false) {
        tracing::warn!(
            "memory_extractor_no_filter = true — PII filter disabled; proposals land verbatim"
        );
        Some(raw)
    } else {
        Some(Arc::new(snaca_engine::FilteredMemoryExtractor::new(
            raw,
            snaca_engine::SensitiveFilter::default_set(),
        )))
    }
}

/// Build the retrieval reranker when enabled in config. Returns
/// `None` (the default) when rerank is off — the engine falls back to
/// truncating cosine recall.
fn build_memory_reranker(
    config: &Config,
    llm: Arc<dyn LlmClient>,
) -> Option<snaca_engine::SharedReranker> {
    if !config.engine.memory_reranker.unwrap_or(false) {
        return None;
    }
    let model = config
        .engine
        .memory_reranker_model
        .clone()
        .unwrap_or_else(|| config.llm.model.clone());
    info!(model = %model, "memory reranker enabled");
    Some(Arc::new(snaca_engine::LlmReranker::new(llm, model)))
}

/// Shared state for the admin HTTP surface. Grows as new handlers
/// need things the runtime owns. Held in an Arc so axum can clone it
/// cheaply per request.
pub struct AppState {
    pub plugins: Arc<PluginRegistry>,
    pub engine: Arc<Engine>,
}

async fn start_http(listen: &str, state: Arc<AppState>) -> Result<HttpHandle> {
    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/admin/plugins", get(list_plugins))
        .route("/admin/plugins/{name}/reload", post(reload_plugin))
        .route("/admin/threads/{thread_id}/abort", post(abort_thread))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .with_context(|| format!("binding {listen}"))?;
    let local_addr = listener.local_addr()?;
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
    });
    Ok(HttpHandle {
        local_addr,
        task,
        shutdown: shutdown_tx,
    })
}

async fn healthz() -> Json<serde_json::Value> {
    Json(serde_json::json!({"status": "ok"}))
}

/// `GET /admin/plugins` — JSON snapshot of every running plugin.
async fn list_plugins(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let statuses = state.plugins.list_status().await;
    Json(serde_json::json!({"plugins": statuses}))
}

/// `POST /admin/plugins/:name/reload` — kill + respawn a plugin without
/// restarting the main process. Returns 404 if the name is unknown, 500
/// if the respawn itself fails.
async fn reload_plugin(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    match state.plugins.reload(&name).await {
        Ok(status) => (StatusCode::OK, Json(serde_json::json!({"status": "reloaded", "plugin": status}))).into_response(),
        Err(e) => {
            // The registry returns "plugin not registered" as the
            // first failure case; everything else is a respawn problem.
            let msg = e.to_string();
            let code = if msg.contains("not registered") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (code, Json(serde_json::json!({"error": msg}))).into_response()
        }
    }
}

/// `POST /admin/threads/:thread_id/abort` — cancel the in-flight turn
/// on `thread_id`. Returns 200 + `{aborted: bool}`: `true` if a turn
/// was running and got cancelled, `false` if nothing was registered
/// (turn already finished, or never started). The response is 200
/// either way — the operation is idempotent and "thread not running"
/// is not an error state.
async fn abort_thread(
    State(state): State<Arc<AppState>>,
    Path(thread_id): Path<String>,
) -> impl IntoResponse {
    let count = state
        .engine
        .abort_thread(&snaca_core::ThreadId::new(thread_id));
    // Keep `aborted: bool` for backwards-compat with anyone scripting
    // against the old API; add `count` so operators can tell how many
    // turns the request actually cancelled (groups chats may have
    // several inflight on the same thread now that turns are
    // per-message keyed).
    (
        StatusCode::OK,
        Json(serde_json::json!({"aborted": count > 0, "count": count})),
    )
}
