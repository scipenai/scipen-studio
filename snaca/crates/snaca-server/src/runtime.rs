//! `Runtime` — the wiring layer.
//!
//! Splitting startup logic out of `main.rs` lets us instantiate a complete
//! SNACA process in tests (with a swappable `LlmClient`) without spawning a
//! real binary.

use crate::admin;
use crate::config::Config;
use crate::dispatch::InputAssemblyConfig;
use crate::outbox;
use crate::plugin_registry::{PluginRegistry, PluginSpawner};
use crate::scheduler::{spawn_scheduler, PluginFireHandler, SchedulerConfig};
use crate::tool_factory::LayeredToolFactory;
use anyhow::{anyhow, Context, Result};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use snaca_channel_host::PluginConfig;
use snaca_core::TenantId;
use snaca_engine::{Engine, EngineConfig};
use snaca_llm::{LlmClient, RetryConfig};
use snaca_mcp::{find_duplicate_server_name, validate_server_name, McpManager, McpServerConfig};
use snaca_sdk::{
    llm::{LlmOptions, LlmProvider},
    EngineRuntimeBuilder,
};
use snaca_skills::{LayoutSkillProvider, SkillProvider};
use snaca_state::Database;
use snaca_tools::base_tool_registry;
use snaca_workspace::WorkspaceLayout;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use tokio::sync::{watch, Notify};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tower_http::cors::{Any, CorsLayer};
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
    /// In-process scheduled-task poller. It injects due rows back into
    /// the plugin dispatcher through `PluginFireHandler`.
    pub scheduler_worker: JoinHandle<()>,
    pub scheduler_cancel: CancellationToken,
    /// Fired by authenticated admin API requests that ask the process to
    /// exit so an external supervisor can restart it with the saved config.
    pub admin_shutdown_rx: watch::Receiver<bool>,
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
        Self::build_with_llm_and_config_path(config, llm, None).await
    }

    pub async fn build_with_llm_and_config_path(
        config: Config,
        llm: Arc<dyn LlmClient>,
        config_path: Option<PathBuf>,
    ) -> Result<Self> {
        std::fs::create_dir_all(&config.server.data_root)
            .with_context(|| format!("creating data_root {}", config.server.data_root.display()))?;
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
                return Err(anyhow!("invalid [[mcp]] server name in config: {reason}"));
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
        let skill_provider: Arc<dyn SkillProvider> = Arc::new(
            LayoutSkillProvider::new(workspace.clone())
                .with_global_dir(config.skills.global_dir.clone()),
        );
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
            conversation_history_limit: config.engine.conversation_history_limit.unwrap_or(30),
            // Treat `Some(0)` as "explicitly disabled" — same as `None`. Any
            // positive value enables auto-compaction at that threshold.
            compact_after_input_tokens: config.engine.compact_after_input_tokens.filter(|t| *t > 0),
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
            // `Some(0)` -> disable malformed-args recovery (immediate
            // surface). `None` -> engine default (2 retries). The error
            // is rare in steady state — DeepSeek's long-Chinese
            // MultiEdit payloads are the recurring offender.
            malformed_tool_args_max_retries: config
                .engine
                .malformed_tool_args_max_retries
                .unwrap_or(2),
            // `Some(0)` -> disable content-filter recovery (surface the
            // moderation rejection immediately). `None` -> engine default
            // (4 localize-and-redact rounds). Guards against a poisoned
            // history message (flagged external content persisted in a
            // tool_result) bricking the thread on every replayed turn.
            content_filter_max_retries: config.engine.content_filter_max_retries.unwrap_or(4),
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
            repeated_tool_failure_feedback: config
                .engine
                .repeated_tool_failure_feedback
                .unwrap_or(true),
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
            // 0 disables the per-result cap; any positive value is the
            // byte ceiling above which a single tool_result is truncated
            // to a preview at capture time.
            max_tool_result_bytes: config.engine.max_tool_result_bytes.unwrap_or(200 * 1024),
            stream_tool_execution: config.engine.stream_tool_execution.unwrap_or(true),
            stream_interrupted_max_retries: config
                .engine
                .stream_interrupted_max_retries
                .unwrap_or(2),
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
            memory_write_approval: config.engine.memory_write_approval.unwrap_or(false),
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

        let mut engine_builder = EngineRuntimeBuilder::new()
            .llm_arc(llm.clone())
            .tools(base)
            .state(db.clone())
            .workspace(workspace.clone())
            .config(engine_cfg)
            .tool_factory(tool_factory.clone())
            .task_registry(task_registry_opaque);
        if let Some(extractor) = build_memory_extractor(&config, llm.clone(), workspace.clone()) {
            engine_builder = engine_builder.memory_extractor(extractor);
        }
        let engine = Arc::new(engine_builder.build()?);

        let typing_interval = config
            .server
            .typing_update_interval_ms
            .map(Duration::from_millis)
            .unwrap_or(crate::typing::DEFAULT_UPDATE_INTERVAL);
        let input_assembly = build_input_assembly_config(&config);

        let spawner = PluginSpawner {
            engine: engine.clone(),
            db: db.clone(),
            tenant_id: tenant_id.clone(),
            typing_interval,
            input_assembly,
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

        let scheduler_defaults = SchedulerConfig::default();
        let scheduler_cfg = SchedulerConfig {
            tick_period: config
                .server
                .scheduler_tick_period_secs
                .filter(|s| *s > 0)
                .map(Duration::from_secs)
                .unwrap_or(scheduler_defaults.tick_period),
            batch_size: config
                .server
                .scheduler_batch_size
                .filter(|n| *n > 0)
                .unwrap_or(scheduler_defaults.batch_size),
        };
        let scheduler_cancel = CancellationToken::new();
        let scheduler_worker = spawn_scheduler(
            db.clone(),
            Arc::new(PluginFireHandler::new(db.clone(), plugins.clone())),
            scheduler_cfg,
            scheduler_cancel.clone(),
        );

        let started_at = Instant::now();
        let started_at_wall = Utc::now();
        let (admin_shutdown_tx, admin_shutdown_rx) = watch::channel(false);
        let config_snapshot = Arc::new(ConfigSnapshot::from_config(&config));
        let admin_token = config
            .admin
            .token
            .as_ref()
            .filter(|t| !t.is_empty() && config.admin.enabled)
            .cloned();
        // Snapshot the config file's bytes as they were at boot (post
        // token-persistence). `GET /config/file` diffs the live file
        // against this to report whether a restart is pending.
        let startup_config_toml = match &config_path {
            Some(p) => tokio::fs::read_to_string(p).await.ok(),
            None => None,
        };
        let http_handle = start_http(
            &config.server.http_listen,
            Arc::new(AppState {
                plugins: plugins.clone(),
                engine: engine.clone(),
                db: db.clone(),
                config_snapshot,
                config_path,
                startup_config_toml,
                admin_token,
                admin_shutdown_tx,
                started_at,
                started_at_wall,
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
            scheduler_worker,
            scheduler_cancel,
            admin_shutdown_rx,
        })
    }

    /// Convenience: build a runtime from a config alone. Selects the
    /// configured provider; only `deepseek` is supported in M1.
    pub async fn build(config: Config) -> Result<Self> {
        let llm = build_llm(&config)?;
        Self::build_with_llm(config, llm).await
    }

    pub async fn build_with_config_path(config: Config, config_path: PathBuf) -> Result<Self> {
        let llm = build_llm(&config)?;
        Self::build_with_llm_and_config_path(config, llm, Some(config_path)).await
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
        self.scheduler_cancel.cancel();
        match tokio::time::timeout(Duration::from_secs(5), self.scheduler_worker).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!(error=%e, "scheduler task panicked"),
            Err(_) => tracing::warn!("scheduler task timed out during shutdown"),
        }
        self.plugins.shutdown_all().await;
        self.mcp.shutdown().await;
    }
}

fn build_llm(config: &Config) -> Result<Arc<dyn LlmClient>> {
    let provider = config
        .llm
        .provider
        .parse::<LlmProvider>()
        .map_err(|e| anyhow!(e.to_string()))?;
    let mut options = LlmOptions::new(
        provider,
        config.llm.api_key.clone(),
        config.llm.model.clone(),
    )
    .retry(build_retry_config(&config.llm));
    if let Some(url) = &config.llm.base_url {
        options = options.base_url(url.clone());
    }
    if let Some(secs) = config.llm.timeout_secs {
        options = options.timeout(Duration::from_secs(secs));
    }
    if let Some(v) = &config.llm.anthropic_version {
        options = options.anthropic_version(v.clone());
    }
    options.build().map_err(|e| anyhow!(e.to_string()))
}

fn build_input_assembly_config(config: &Config) -> InputAssemblyConfig {
    let defaults = InputAssemblyConfig::default();
    InputAssemblyConfig {
        enabled: config.im_input.assembly_enabled.unwrap_or(defaults.enabled),
        text_debounce: config
            .im_input
            .text_debounce_ms
            .map(Duration::from_millis)
            .unwrap_or(defaults.text_debounce),
        attachment_wait: config
            .im_input
            .attachment_wait_secs
            .filter(|s| *s > 0)
            .map(Duration::from_secs)
            .unwrap_or(defaults.attachment_wait),
        hard_cap: config
            .im_input
            .hard_cap_secs
            .filter(|s| *s > 0)
            .map(Duration::from_secs)
            .unwrap_or(defaults.hard_cap),
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
    let raw: snaca_engine::SharedExtractor =
        Arc::new(snaca_engine::LlmMemoryExtractor::new(llm, model).with_workspace(workspace));
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

/// Shared state for the admin HTTP surface. Grows as new handlers
/// need things the runtime owns. Held in an Arc so axum can clone it
/// cheaply per request.
pub struct AppState {
    pub plugins: Arc<PluginRegistry>,
    pub engine: Arc<Engine>,
    /// Used by the read-only Threads/Approvals/Schedules/Outbox handlers.
    pub db: Database,
    /// Read-only redacted view of the loaded config. The dashboard page
    /// renders this verbatim; nothing here is secret.
    pub config_snapshot: Arc<ConfigSnapshot>,
    /// Original config file path. Present for the real binary and absent in
    /// older tests that construct runtime state from an in-memory config.
    pub config_path: Option<PathBuf>,
    /// Raw `snaca.toml` bytes read at boot (after any startup token
    /// persistence). `GET /config/file` compares the live file against
    /// this to report `restart_required` — i.e. the on-disk config has
    /// diverged from what this process is actually running. `None` when
    /// no config path is available (in-memory test runtimes).
    pub startup_config_toml: Option<String>,
    /// `None` when `[admin].enabled = false` — the auth middleware then
    /// returns 503 for every `/api/v1/*` request. The legacy `/admin/*`
    /// surface is unaffected.
    pub admin_token: Option<String>,
    /// Signals main/runtime owner to perform normal shutdown. This does
    /// not restart in-process; a supervisor such as systemd/docker should
    /// bring the process back if desired.
    pub admin_shutdown_tx: watch::Sender<bool>,
    /// Monotonic clock at server boot — used to compute `uptime_seconds`.
    pub started_at: Instant,
    /// Wall-clock equivalent of `started_at`, surfaced as RFC3339.
    pub started_at_wall: DateTime<Utc>,
}

/// Static read-only view of the config bits the admin Dashboard cares
/// about. Built once at startup so handlers don't re-clone the whole
/// `Config`. Secrets (`llm.api_key`, plugin env values) are scrubbed —
/// the redacted JSON is what /api/v1/config returns verbatim.
pub struct ConfigSnapshot {
    pub tenant_id: String,
    pub llm_provider: String,
    pub llm_model: String,
    pub mcp_server_count: usize,
    pub redacted_json: serde_json::Value,
}

impl ConfigSnapshot {
    pub fn from_config(cfg: &Config) -> Self {
        let plugins_json: Vec<_> = cfg
            .plugins
            .iter()
            .map(|p| {
                let env_keys: Vec<&String> = p.env.keys().collect();
                serde_json::json!({
                    "name": p.name,
                    "command": p.command,
                    "args": p.args,
                    "env_keys": env_keys,
                    "cwd": p.cwd.as_ref().map(|c| c.display().to_string()),
                })
            })
            .collect();
        let mcp_json: Vec<_> = cfg
            .mcp
            .iter()
            .map(|s| {
                serde_json::json!({
                    "name": s.name,
                    "command": s.command,
                    "args": s.args,
                    "env_keys": s.env.keys().collect::<Vec<_>>(),
                })
            })
            .collect();
        let redacted_json = serde_json::json!({
            "server": {
                "http_listen": cfg.server.http_listen,
                "data_root": cfg.server.data_root.display().to_string(),
            },
            "tenant": { "id": cfg.tenant.id },
            "llm": {
                "provider": cfg.llm.provider,
                "model": cfg.llm.model,
                "base_url": cfg.llm.base_url,
                "api_key_set": !cfg.llm.api_key.is_empty(),
            },
            "engine": {
                "max_iterations": cfg.engine.max_iterations,
                "conversation_history_limit": cfg.engine.conversation_history_limit,
                "compact_after_input_tokens": cfg.engine.compact_after_input_tokens,
                "memory_extractor": cfg.engine.memory_extractor.unwrap_or(true),
                "memory_write_approval": cfg.engine.memory_write_approval.unwrap_or(false),
            },
            "im_input": {
                "assembly_enabled": cfg.im_input.assembly_enabled.unwrap_or(true),
                "text_debounce_ms": cfg.im_input.text_debounce_ms.unwrap_or(1500),
                "attachment_wait_secs": cfg.im_input.attachment_wait_secs.unwrap_or(8),
                "hard_cap_secs": cfg.im_input.hard_cap_secs.unwrap_or(30),
            },
            "plugins": plugins_json,
            "mcp": mcp_json,
            "admin": {
                "enabled": cfg.admin.enabled,
                "cors_origins": cfg.admin.cors_origins,
                "token_set": cfg.admin.token.as_deref().map(|t| !t.is_empty()).unwrap_or(false),
            },
        });
        Self {
            tenant_id: cfg.tenant.id.clone(),
            llm_provider: cfg.llm.provider.clone(),
            llm_model: cfg.llm.model.clone(),
            mcp_server_count: cfg.mcp.len(),
            redacted_json,
        }
    }
}

async fn start_http(listen: &str, state: Arc<AppState>) -> Result<HttpHandle> {
    let cors = build_cors_layer(&state);
    let app = Router::new()
        .route("/healthz", get(healthz))
        // Legacy unauthenticated admin surface — preserved so `snaca admin`
        // and any existing automation keep working unchanged.
        .route("/admin/plugins", get(list_plugins))
        .route("/admin/plugins/{name}/reload", post(reload_plugin))
        .route("/admin/threads/{thread_id}/abort", post(abort_thread))
        // New authenticated admin API + embedded SPA.
        .nest("/api/v1", admin::router(state.clone()))
        .fallback(admin::web::serve)
        .layer(cors)
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

fn build_cors_layer(state: &AppState) -> CorsLayer {
    use axum::http::{HeaderName, Method};
    let methods = [
        Method::GET,
        Method::POST,
        Method::PATCH,
        Method::DELETE,
        Method::OPTIONS,
    ];
    let headers: Vec<HeaderName> = vec![
        axum::http::header::AUTHORIZATION,
        axum::http::header::CONTENT_TYPE,
    ];
    let configured = &state.config_snapshot.redacted_json["admin"]["cors_origins"];
    let origins: Vec<String> = configured
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    if origins.is_empty() {
        // Default policy: same-origin only. The embedded SPA is served
        // from the same axum listener so this is the right default.
        return CorsLayer::new()
            .allow_methods(methods)
            .allow_headers(headers);
    }
    if origins.iter().any(|o| o == "*") {
        // Wildcard origins are incompatible with `Authorization` credentials
        // in browsers — we expose the Authorization header explicitly and
        // accept that this is the operator's choice.
        return CorsLayer::new()
            .allow_methods(methods)
            .allow_headers(headers)
            .allow_origin(Any);
    }
    let header_origins: Vec<axum::http::HeaderValue> =
        origins.iter().filter_map(|o| o.parse().ok()).collect();
    CorsLayer::new()
        .allow_methods(methods)
        .allow_headers(headers)
        .allow_origin(header_origins)
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
        Ok(status) => (
            StatusCode::OK,
            Json(serde_json::json!({"status": "reloaded", "plugin": status})),
        )
            .into_response(),
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
