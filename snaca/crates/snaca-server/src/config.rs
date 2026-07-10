//! Server configuration — loaded from `snaca.toml` (or `--config <path>`).
//!
//! Single-tenant, single-LLM-provider in M1. Multi-tenant + per-plugin
//! tenant binding land in M2 (the schema is forward-compatible: `[tenant]`
//! is allowed to be a list later).

use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub server: ServerSection,
    pub tenant: TenantSection,
    pub llm: LlmSection,
    #[serde(default)]
    pub engine: EngineSection,
    #[serde(default)]
    pub logging: LoggingSection,
    #[serde(default)]
    pub plugins: Vec<PluginSection>,
    /// `[[mcp]]` blocks — one MCP server each.
    #[serde(default)]
    pub mcp: Vec<McpSection>,
    /// Built-in WebSearch / WebFetch tool settings. Optional — if the
    /// section is missing or fields are empty, those tools fall back to
    /// reading their keys from the process environment directly.
    #[serde(default)]
    pub web: WebSection,
    /// `[admin]` — admin Web UI + REST API settings.
    #[serde(default)]
    pub admin: AdminSection,
    /// `[skills]` — operator-supplied skill directories that aren't
    /// tied to any single tenant or project.
    #[serde(default)]
    pub skills: SkillsSection,
    /// `[im_input]` — assemble bursty IM text/file fragments into one
    /// user turn before invoking the agent.
    #[serde(default)]
    pub im_input: ImInputSection,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SkillsSection {
    /// Optional directory whose `*.md` files (or `<name>/SKILL.md`
    /// folders) are loaded into every (tenant, project) registry with
    /// `SkillScope::Global` — lowest on-disk priority, so tenant or
    /// project files with the same name still override. Relative paths
    /// resolve against the config file's parent directory; `${VAR}`
    /// placeholders are expanded against the process environment. A
    /// missing directory at startup is tolerated; the provider warns
    /// once per load and serves the rest of the registry. Leave unset
    /// to keep the historical two-scope (tenant + project) behaviour.
    #[serde(default)]
    pub global_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ImInputSection {
    /// Enable the IM input assembler. When on, short bursts of text and
    /// attachment messages from the same user are coalesced into one
    /// engine turn. The assembler is purely time/structure based — it
    /// never inspects message content to decide whether to wait.
    /// Default true.
    #[serde(default)]
    pub assembly_enabled: Option<bool>,

    /// Debounce for a text (or text+file) burst, in milliseconds. Each
    /// new fragment resets the window. Default 1500.
    #[serde(default)]
    pub text_debounce_ms: Option<u64>,

    /// Structural grace period for a file-only message: how long the
    /// assembler waits for a trailing instruction ("帮我总结一下") to
    /// arrive before delivering the file(s) as-is. Default 8.
    #[serde(default)]
    pub attachment_wait_secs: Option<u64>,

    /// Absolute ceiling, measured from the first fragment of a burst,
    /// after which the pending buffer is always flushed regardless of
    /// how often the debounce window has reset. Guards against a chat
    /// wedging on input that never settles. Default 30.
    #[serde(default)]
    pub hard_cap_secs: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AdminSection {
    /// Master switch for `/api/v1/*` and the embedded admin SPA at `/`.
    /// Default `false` — the legacy `/admin/*` endpoints stay reachable
    /// without auth so existing tooling (`snaca admin`) is unaffected.
    #[serde(default)]
    pub enabled: bool,
    /// Bearer token required on every `/api/v1/*` request. If `enabled`
    /// is true and this is `None`/empty, a fresh token is generated at
    /// startup, persisted back to the config file, and logged at INFO
    /// level once (so the operator can copy it out of the log).
    #[serde(default)]
    pub token: Option<String>,
    /// Allowed CORS origins for the admin API. Used by the Vite dev
    /// server (`npm run dev` on port 5173). Production builds serve
    /// the SPA from the same origin so CORS is a no-op there.
    #[serde(default)]
    pub cors_origins: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct WebSection {
    /// API key for Tavily Search, used by the `WebSearch` tool. Accepts a
    /// literal value or a `${VAR}` placeholder. Resolved at server startup
    /// and exported as `TAVILY_API_KEY` for the tool to pick up via
    /// `WebSearchTool::from_env()`. If unset, WebSearch is still registered
    /// but every call returns an error explaining the missing key.
    #[serde(default)]
    pub tavily_api_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct LoggingSection {
    /// `tracing_subscriber::EnvFilter` directive applied at startup. Same
    /// grammar as `RUST_LOG` (e.g. `"info,snaca_llm=debug,reqwest=info"`).
    /// `RUST_LOG`, if set, wins — toml is the fallback so operators can
    /// override at runtime without editing config.
    #[serde(default)]
    pub filter: Option<String>,

    /// Path to a log file. When set, all tracing output is redirected to
    /// this file with size-based rotation; stderr no longer receives logs.
    /// Relative paths resolve against the config file's parent directory;
    /// `${VAR}` placeholders are expanded against the process environment.
    /// Parent directories are created on startup if missing.
    #[serde(default)]
    pub file: Option<PathBuf>,

    /// Rotate the active log file once it exceeds this many MiB. Default 50.
    /// Ignored when `file` is unset.
    #[serde(default)]
    pub max_size_mb: Option<u64>,

    /// Maximum number of rotated archives kept on disk (excluding the
    /// active file). Older archives are pruned. Default 10. Ignored when
    /// `file` is unset.
    #[serde(default)]
    pub max_files: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct McpSection {
    pub name: String,
    /// Stdio (default — the historical M2 mode) spawns `command` as a
    /// child; HTTP points at a remote URL. Backward-compatible: configs
    /// without `transport = …` still parse as stdio.
    #[serde(default)]
    pub transport: snaca_mcp::McpTransport,
    /// Required for stdio, ignored for HTTP. Default empty so the toml
    /// schema can be uniform across both transport kinds. Supports
    /// `${VAR}` placeholders.
    #[serde(default)]
    pub command: String,
    /// CLI arguments forwarded to `command`. Each element supports
    /// `${VAR}` placeholders.
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Working directory for the child process. Relative paths resolve
    /// against the config file's parent directory; `${VAR}` placeholders
    /// are expanded against the process environment.
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    /// Initialization timeout in seconds (default 30).
    #[serde(default)]
    pub init_timeout_secs: Option<u64>,
    /// Per-RPC timeout for `tools/call` against this server, in seconds.
    /// `None` falls back to the rmcp client default (60 s). A stuck MCP
    /// server can otherwise pin a whole turn behind one bad tool call —
    /// the engine's `turn_timeout_secs` is too coarse for this.
    #[serde(default)]
    pub call_timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServerSection {
    /// `host:port` for the admin/health HTTP listener.
    #[serde(default = "default_listen")]
    pub http_listen: String,

    /// Where SNACA stores per-tenant project workspaces, memory, and the
    /// `state.sqlite` database. Relative paths resolve against the config
    /// file's parent directory. Supports `${VAR}` placeholders for
    /// environment-driven absolute paths (e.g. `${SNACA_DIR}/data`).
    pub data_root: PathBuf,

    /// Minimum delay between successive `message.update` RPCs the typing
    /// listener issues for one turn, in milliseconds. `0` disables
    /// throttling (every text delta hits the plugin). The built-in
    /// default is `200` ms — see `ChannelTypingListener`.
    #[serde(default)]
    pub typing_update_interval_ms: Option<u64>,

    /// Idle timeout for cached MCP child processes. After this many
    /// seconds without any tool call, the next look-up evicts the
    /// connection and the next tool call spawns a fresh process. `0`
    /// disables eviction (clients live until shutdown). Default 600 s
    /// (10 minutes).
    #[serde(default)]
    pub mcp_idle_ttl_secs: Option<u64>,

    /// Period for the periodic MCP reaper task that sweeps idle entries
    /// out of every pool, in seconds. Without this, eviction only runs
    /// when somebody calls `client_for` — so a tenant that goes silent
    /// for hours leaves its subprocess running until traffic returns.
    /// `0` disables the reaper. Default 60 s.
    #[serde(default)]
    pub mcp_reaper_period_secs: Option<u64>,

    /// Poll period for the in-process scheduled-task dispatcher. Default
    /// 30 seconds; tests can lower this to 1 for deterministic e2e.
    #[serde(default)]
    pub scheduler_tick_period_secs: Option<u64>,

    /// Max due scheduled tasks claimed per scheduler tick. Default 50.
    #[serde(default)]
    pub scheduler_batch_size: Option<u32>,
}

fn default_listen() -> String {
    "127.0.0.1:8080".into()
}

#[derive(Debug, Clone, Deserialize)]
pub struct TenantSection {
    /// Static tenant id used for every IM event in M1. Forward-compatible —
    /// M2 will derive this from the IM payload (e.g. Lark `tenant_key`).
    pub id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LlmSection {
    /// `"deepseek"` (OpenAI-compatible) or `"anthropic"` (Messages API).
    #[serde(default = "default_provider")]
    pub provider: String,
    /// API key. Use `${VAR}` to interpolate from environment, e.g.
    /// `api_key = "${DEEPSEEK_API_KEY}"`.
    pub api_key: String,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default)]
    pub base_url: Option<String>,
    /// Max wait for one LLM round trip, in seconds.
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    /// Anthropic-only: value of the `anthropic-version` header.
    /// Defaults to `"2023-06-01"`.
    #[serde(default)]
    pub anthropic_version: Option<String>,

    /// Total attempts the retry wrapper will make for one round trip
    /// before surfacing the last transient error to the engine.
    /// `Some(1)` disables retry. Default 5 (≈30s worst-case backoff).
    #[serde(default)]
    pub retry_max_attempts: Option<u32>,

    /// First sleep before the second attempt, in milliseconds.
    /// Subsequent sleeps double up to `retry_max_delay_secs`. Default 500.
    #[serde(default)]
    pub retry_base_delay_ms: Option<u64>,

    /// Cap on each sleep — also caps any provider-supplied
    /// `Retry-After`. Default 30s.
    #[serde(default)]
    pub retry_max_delay_secs: Option<u64>,

    /// Uniform jitter ratio on top of the deterministic backoff.
    /// `0.5` = up to 50 % jitter added. Default 0.5.
    #[serde(default)]
    pub retry_jitter_ratio: Option<f64>,
}

fn default_provider() -> String {
    "deepseek".into()
}
fn default_model() -> String {
    "deepseek-chat".into()
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct EngineSection {
    #[serde(default)]
    pub max_iterations: Option<usize>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// Size of the loaded history window, counted in *conversational*
    /// (User + Assistant) messages — huge `Role::Tool` results don't
    /// consume the budget, so file-extraction dumps can't evict earlier
    /// goals/files. Default 30. Accepts the legacy `history_limit` key as
    /// an alias so pre-rename configs keep working.
    #[serde(default, alias = "history_limit")]
    pub conversation_history_limit: Option<u32>,
    /// Override the built-in system prompt. Empty / missing = use default.
    #[serde(default)]
    pub system_prompt: Option<String>,

    /// Compact a thread once a single LLM round trip's *input* tokens
    /// exceed this. `None` / `0` disables auto-compaction. Recommended
    /// value: ~75 % of the model's context window minus tool schemas.
    #[serde(default)]
    pub compact_after_input_tokens: Option<u32>,

    /// When compaction fires, keep this many of the most recent messages
    /// verbatim. Default 6.
    #[serde(default)]
    pub compact_keep_recent: Option<usize>,

    /// Keep this many of the *oldest* messages verbatim across
    /// compactions. Protects the initial task framing
    /// (system / first user goal / first assistant plan / first tool
    /// result) from being folded into the rolling summary. Default 4.
    /// Set to 0 to fall back to the pre-M6 behaviour where only the
    /// recent tail is preserved.
    #[serde(default)]
    pub protect_first_n: Option<usize>,

    /// Bound on the per-turn shrink-retry loop the engine runs when
    /// the LLM returns `ContextOverflow`. Each retry halves the
    /// effective `compact_keep_recent` (`6 → 3 → 2 → 2`). Default 3.
    #[serde(default)]
    pub compact_max_retries: Option<u8>,

    /// Per-turn cap on transparent recovery from
    /// `LlmError::MalformedToolArgs` — model emits a tool_use whose
    /// `arguments` field is not valid JSON. Each retry persists a
    /// synthetic User feedback message describing the parse error so
    /// the model can self-correct on the next iteration. `Some(0)`
    /// disables (immediate surface). Default 2.
    #[serde(default)]
    pub malformed_tool_args_max_retries: Option<u8>,

    /// Per-turn cap on transparent recovery from
    /// `LlmError::ContentFiltered` — the provider's content-moderation
    /// layer rejecting the request (e.g. DeepSeek "Content Exists Risk").
    /// Each round binary-searches the current history window to localize
    /// the flagged message(s), marks them redacted, and re-runs the turn.
    /// `Some(0)` disables (immediate surface). Default 4.
    #[serde(default)]
    pub content_filter_max_retries: Option<u8>,

    /// Hard cap on the summariser's output tokens. Default 2048. Too
    /// low truncates summaries mid-sentence and re-fires compaction on
    /// the next turn; too high just turns history budget into preamble
    /// budget.
    #[serde(default)]
    pub compact_summary_max_tokens: Option<u32>,

    /// Abort the turn once the model issues the same `(tool, input)` pair
    /// this many times. `None` keeps the engine default (3). `Some(0)`
    /// disables the guard entirely (escape hatch for self-similar tool
    /// chains the operator has explicitly accepted).
    #[serde(default)]
    pub loop_guard_max_repeats: Option<usize>,

    /// Enable synthetic User feedback when the same tool call fails
    /// repeatedly inside one turn. Default true; set false to rely only
    /// on raw tool_error messages plus loop_guard.
    #[serde(default)]
    pub repeated_tool_failure_feedback: Option<bool>,

    /// Enable the post-turn memory extractor. When true, every
    /// successful terminal turn fires an LLM call (`memory_extractor_model`
    /// or the engine's default model) to mine `user`/`feedback`
    /// memory entries from the transcript. Default on — the extractor
    /// is what makes SNACA's memory tree grow across turns. Set to
    /// `false` to opt out (e.g. cost-sensitive short Q&A deployments).
    #[serde(default)]
    pub memory_extractor: Option<bool>,

    /// Override the model used for memory extraction. Useful when the
    /// extractor should run on a cheaper / faster model than the main
    /// turn body. Defaults to `llm.model` from the parent section.
    #[serde(default)]
    pub memory_extractor_model: Option<String>,

    /// Disable the default sensitive-info filter that wraps the
    /// extractor. Off (filter active) is the safe default; turn this
    /// on only if PII rejection is happening at a different layer of
    /// the pipeline.
    #[serde(default)]
    pub memory_extractor_no_filter: Option<bool>,

    /// Last-resort byte cap on the history loaded into each LLM call.
    /// Compaction handles the steady-state case but only fires after
    /// a successful turn; this cap protects against single huge
    /// tool_results / imports overwhelming the context window before
    /// compaction can run. Default 1.5 MiB.
    #[serde(default)]
    pub history_max_bytes: Option<usize>,

    /// Wall-clock cap on one turn in seconds. `None` / unset = no
    /// global timeout (extended-thinking models can legitimately take
    /// many minutes). Set on multi-tenant deployments to bound damage
    /// from runaway turns. When tripped, the engine cancels the turn
    /// and surfaces `EngineError::TurnTimeout`.
    #[serde(default)]
    pub turn_timeout_secs: Option<u64>,

    /// Max number of read-only tool calls allowed to run in parallel
    /// within one tool-batch (one assistant message). Set to 1 to
    /// disable concurrency. Default 5.
    #[serde(default)]
    pub concurrent_tool_limit: Option<usize>,

    /// Byte threshold for collapsing old read-only tool_results in
    /// loaded history (Read / Grep / Glob / LS / MemoryRead /
    /// TaskOutput). Results bigger than this in pre-tail history
    /// slots are replaced with a one-line marker. Default 1024.
    /// Set to 0 to disable.
    #[serde(default)]
    pub collapse_tool_results_threshold: Option<usize>,

    /// Hard per-tool-result byte ceiling applied at capture time. A
    /// single tool output larger than this (a Bash dump, an error with
    /// a multi-MB stdout tail) is truncated to a head+tail preview
    /// before being persisted, so it can't blow the model context on
    /// load or the compaction-summary request. Default 200 KiB. Set to
    /// 0 to disable.
    #[serde(default)]
    pub max_tool_result_bytes: Option<usize>,

    /// Pre-execute read-only no-approval tool calls in parallel with
    /// the LLM response stream. Default `true`. Set to `false` to
    /// fall back to fully-sequential post-stream execution (useful
    /// for debugging tool ordering or providers whose stream framing
    /// trips up the eager dispatch heuristics).
    #[serde(default)]
    pub stream_tool_execution: Option<bool>,

    /// Per-turn retries for mid-stream LLM transport failures after
    /// the response has already started. This covers broken SSE body
    /// reads such as "Connection reset by peer". Default 2. Set to 0
    /// to surface immediately.
    #[serde(default)]
    pub stream_interrupted_max_retries: Option<u8>,

    /// How many times one turn may re-issue an LLM request with a
    /// higher output-token cap after `stop_reason == MaxTokens`. Each
    /// attempt doubles the previous cap (capped at
    /// `max_output_token_ceiling`). Escalation only fires when the
    /// truncated response had no tool_use blocks. Default 2. Set to 0
    /// to disable.
    #[serde(default)]
    pub max_output_token_escalation_attempts: Option<u32>,

    /// Hard ceiling on the post-escalation output cap. Default
    /// 32768 — safe across DeepSeek / OpenAI / Anthropic standard
    /// outputs. Raise for Anthropic Sonnet 4.x with extended-output
    /// beta enabled.
    #[serde(default)]
    pub max_output_token_ceiling: Option<u32>,

    /// When true, every `MemoryWrite` tool call is staged into
    /// `<project>/memory/pending/<id>.json` instead of writing
    /// directly to the project's memory tree. An operator runs
    /// `snaca-cli memory pending` to inspect and `... approve|reject`
    /// to action. Useful for IM/gateway deployments where a
    /// background turn could otherwise plant entries in the
    /// `user/` profile space the human owner had no chance to
    /// veto. Default `false`.
    #[serde(default)]
    pub memory_write_approval: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PluginSection {
    pub name: String,
    /// Executable to spawn as the IM-channel plugin subprocess. Supports
    /// `${VAR}` placeholders so a single config can move between hosts
    /// (e.g. `command = "${SNACA_DIR}/bin/snaca-plugin-lark"`). NOT
    /// re-anchored against the config file's directory — pass an
    /// absolute path here, or rely on the launcher's `PATH`.
    pub command: String,
    /// CLI arguments forwarded to `command`. Each element supports
    /// `${VAR}` placeholders.
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Working directory for the plugin subprocess. Relative paths
    /// resolve against the config file's parent directory; `${VAR}`
    /// placeholders are expanded against the process environment.
    #[serde(default)]
    pub cwd: Option<PathBuf>,
}

impl Config {
    /// Load and validate a config file. Resolves `${VAR}` placeholders
    /// against the process environment for: `llm.api_key`,
    /// `web.tavily_api_key`, every `plugins[].env` and `mcp[].env`
    /// value, and the path-bearing fields `server.data_root`,
    /// `logging.file`, `skills.global_dir`,
    /// `plugins[].command|args|cwd`, and `mcp[].command|args|cwd`.
    /// Missing variables fail loudly at startup.
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("reading config from {}", path.display()))?;
        Self::load_from_str(&raw, path)
    }

    /// Parse and validate config text using `path` only as the anchor for
    /// relative paths.
    pub fn load_from_str(raw: &str, path: &Path) -> Result<Self> {
        let mut cfg: Config =
            toml::from_str(raw).with_context(|| format!("parsing config {}", path.display()))?;

        cfg.resolve_env()?;
        cfg.resolve_paths(path);
        cfg.validate()?;
        Ok(cfg)
    }

    /// Parse and validate config text before writing it from the admin UI.
    /// This deliberately does not expand `${VAR}` placeholders: editing a
    /// config should be possible even when the current web-admin process does
    /// not have the future deployment environment in scope. Startup still
    /// uses [`Config::load`] and fails loudly if placeholders cannot resolve.
    pub fn validate_for_write(raw: &str, path: &Path) -> Result<Self> {
        let mut cfg: Config =
            toml::from_str(raw).with_context(|| format!("parsing config {}", path.display()))?;

        cfg.resolve_paths(path);
        cfg.validate()?;
        Ok(cfg)
    }

    fn resolve_env(&mut self) -> Result<()> {
        self.llm.api_key =
            expand_env(&self.llm.api_key).with_context(|| "resolving llm.api_key")?;
        for plugin in &mut self.plugins {
            for (k, v) in plugin.env.iter_mut() {
                *v = expand_env(v)
                    .with_context(|| format!("resolving plugins.{}.env.{k}", plugin.name))?;
            }
        }

        // Path-bearing fields: `${VAR}` is expanded BEFORE `resolve_paths`
        // anchors relative paths to the config file's directory. A path
        // that already comes out absolute after expansion (the common
        // case for `${SNACA_DIR}/foo`) is left alone by resolve_paths.
        // Plain "./foo" without placeholders is unchanged here and still
        // gets the config-dir treatment downstream — no regression for
        // existing configs.
        expand_env_path(&mut self.server.data_root, "server.data_root")?;
        if let Some(p) = self.logging.file.as_mut() {
            expand_env_path(p, "logging.file")?;
        }
        if let Some(p) = self.skills.global_dir.as_mut() {
            expand_env_path(p, "skills.global_dir")?;
        }
        for plugin in &mut self.plugins {
            plugin.command = expand_env(&plugin.command)
                .with_context(|| format!("resolving plugins.{}.command", plugin.name))?;
            for (i, arg) in plugin.args.iter_mut().enumerate() {
                *arg = expand_env(arg)
                    .with_context(|| format!("resolving plugins.{}.args[{i}]", plugin.name))?;
            }
            if let Some(p) = plugin.cwd.as_mut() {
                expand_env_path(p, &format!("plugins.{}.cwd", plugin.name))?;
            }
        }
        for server in &mut self.mcp {
            server.command = expand_env(&server.command)
                .with_context(|| format!("resolving mcp.{}.command", server.name))?;
            for (i, arg) in server.args.iter_mut().enumerate() {
                *arg = expand_env(arg)
                    .with_context(|| format!("resolving mcp.{}.args[{i}]", server.name))?;
            }
            for (k, v) in server.env.iter_mut() {
                *v = expand_env(v)
                    .with_context(|| format!("resolving mcp.{}.env.{k}", server.name))?;
            }
            if let Some(p) = server.cwd.as_mut() {
                expand_env_path(p, &format!("mcp.{}.cwd", server.name))?;
            }
        }

        // WebSearch reads its key from `TAVILY_API_KEY`. The toml section is
        // a convenience: if a value is configured, expand it and export so
        // the tool picks it up via the standard `from_env()` path. An empty
        // resolved value is treated as "not set" — preserves the existing
        // env if any.
        if let Some(raw) = self.web.tavily_api_key.as_deref() {
            let expanded = expand_env(raw).with_context(|| "resolving web.tavily_api_key")?;
            let trimmed = expanded.trim();
            if !trimmed.is_empty() {
                // SAFETY: runs during single-threaded startup (`Config::load`
                // is called before the tokio runtime is built and any tool
                // registry is constructed).
                unsafe {
                    std::env::set_var("TAVILY_API_KEY", trimmed);
                }
                self.web.tavily_api_key = Some(trimmed.to_string());
            } else {
                self.web.tavily_api_key = None;
            }
        }

        Ok(())
    }

    fn resolve_paths(&mut self, config_path: &Path) {
        if self.server.data_root.is_relative() {
            if let Some(parent) = config_path.parent() {
                self.server.data_root = parent.join(&self.server.data_root);
            }
        }
        if let Some(log_file) = &self.logging.file {
            if log_file.is_relative() {
                if let Some(parent) = config_path.parent() {
                    self.logging.file = Some(parent.join(log_file));
                }
            }
        }
        if let Some(skills_dir) = &self.skills.global_dir {
            if skills_dir.is_relative() {
                if let Some(parent) = config_path.parent() {
                    self.skills.global_dir = Some(parent.join(skills_dir));
                }
            }
        }
        for plugin in &mut self.plugins {
            if let Some(cwd) = &plugin.cwd {
                if cwd.is_relative() {
                    if let Some(parent) = config_path.parent() {
                        plugin.cwd = Some(parent.join(cwd));
                    }
                }
            }
        }
        for server in &mut self.mcp {
            if let Some(cwd) = &server.cwd {
                if cwd.is_relative() {
                    if let Some(parent) = config_path.parent() {
                        server.cwd = Some(parent.join(cwd));
                    }
                }
            }
        }
    }

    /// Ensure `[admin].token` is set when the admin surface is enabled.
    /// Generates a random base32 token, writes it back to `path` in
    /// place (appending an `[admin]` block when missing), and returns
    /// `Some(token)` so the caller can log it. No-op when the admin
    /// surface is disabled or a token is already configured.
    ///
    /// Token format: 32 base32-no-pad characters (~160 bits of entropy),
    /// safe to paste into a URL query string or `Authorization: Bearer`.
    pub fn ensure_admin_token(&mut self, path: &Path) -> Result<Option<String>> {
        if !self.admin.enabled {
            return Ok(None);
        }
        if self
            .admin
            .token
            .as_deref()
            .map(|t| !t.trim().is_empty())
            .unwrap_or(false)
        {
            return Ok(None);
        }
        let token = generate_admin_token();
        self.admin.token = Some(token.clone());
        write_admin_token(path, &token)
            .with_context(|| format!("persisting admin token to {}", path.display()))?;
        Ok(Some(token))
    }

    fn validate(&self) -> Result<()> {
        if self.tenant.id.is_empty() {
            anyhow::bail!("tenant.id must be non-empty");
        }
        if self.llm.api_key.is_empty() {
            anyhow::bail!("llm.api_key resolved to an empty string");
        }
        if self.llm.provider != "deepseek" && self.llm.provider != "anthropic" {
            anyhow::bail!(
                "llm.provider = {:?} is not supported; valid values are 'deepseek' or 'anthropic'",
                self.llm.provider
            );
        }
        for p in &self.plugins {
            if p.name.is_empty() {
                anyhow::bail!("plugins[].name must be non-empty");
            }
            if p.command.is_empty() {
                anyhow::bail!("plugins[{}].command must be non-empty", p.name);
            }
        }
        let mut mcp_names = std::collections::HashSet::new();
        for s in &self.mcp {
            if s.name.is_empty() {
                anyhow::bail!("mcp[].name must be non-empty");
            }
            if !mcp_names.insert(&s.name) {
                anyhow::bail!("mcp[].name {:?} appears more than once", s.name);
            }
            if s.command.is_empty() {
                anyhow::bail!("mcp[{}].command must be non-empty", s.name);
            }
        }
        Ok(())
    }
}

/// 20 random bytes → 32-char base32 (no padding). 160 bits of entropy
/// — well above the 128-bit floor for a session-grade bearer token.
fn generate_admin_token() -> String {
    use rand::Rng;
    let mut bytes = [0u8; 20];
    rand::rng().fill_bytes(&mut bytes);
    data_encoding::BASE32_NOPAD.encode(&bytes)
}

/// Rewrite `path` so the resolved `[admin]` block carries `token = "..."`.
///
/// Three cases:
/// 1. `[admin]` already exists with `token = "..."` (possibly empty) →
///    replace the value, keep formatting.
/// 2. `[admin]` exists without a `token` line → append `token = "..."`
///    immediately after the section header.
/// 3. No `[admin]` section at all → append `\n[admin]\ntoken = "..."\n`
///    at the end of the file.
///
/// We deliberately do NOT round-trip the whole TOML (which would lose
/// comments + ordering). The cost is that we can't handle exotic
/// formatting (multi-line strings, inline `admin = { ... }` syntax). In
/// practice the snaca.toml.example uses plain `[section]` blocks so a
/// line-based edit is the right trade-off.
fn write_admin_token(path: &Path, token: &str) -> Result<()> {
    let original = std::fs::read_to_string(path)
        .with_context(|| format!("reading {} for token rewrite", path.display()))?;
    let new_token_line = format!("token = \"{token}\"");

    let mut lines: Vec<String> = original.lines().map(|s| s.to_string()).collect();
    // Find `[admin]` (skipping inline-table forms `admin = { ... }`).
    let admin_idx = lines.iter().position(|l| {
        let trimmed = l.trim();
        trimmed == "[admin]" || trimmed.starts_with("[admin]") && !trimmed.contains('.')
    });
    match admin_idx {
        Some(header_idx) => {
            // Scan inside the section (until next `[...]` header) for a
            // `token =` line.
            let section_end = lines[header_idx + 1..]
                .iter()
                .position(|l| {
                    let t = l.trim_start();
                    t.starts_with('[') && !t.starts_with("[[")
                })
                .map(|p| p + header_idx + 1)
                .unwrap_or(lines.len());
            let token_idx = lines[header_idx + 1..section_end]
                .iter()
                .position(|l| l.trim_start().starts_with("token"))
                .map(|p| p + header_idx + 1);
            match token_idx {
                Some(i) => lines[i] = new_token_line,
                None => lines.insert(header_idx + 1, new_token_line),
            }
        }
        None => {
            if !lines.last().map(|l| l.is_empty()).unwrap_or(true) {
                lines.push(String::new());
            }
            lines.push("[admin]".into());
            lines.push(new_token_line);
        }
    }
    let mut rewritten = lines.join("\n");
    if original.ends_with('\n') && !rewritten.ends_with('\n') {
        rewritten.push('\n');
    }
    std::fs::write(path, rewritten)
        .with_context(|| format!("writing {} with new admin token", path.display()))?;
    Ok(())
}

/// Replace `${VAR}` placeholders with the corresponding environment variable.
/// Missing variables produce an error so misconfiguration is loud at startup.
fn expand_env(input: &str) -> Result<String> {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(open) = rest.find("${") {
        out.push_str(&rest[..open]);
        let after = &rest[open + 2..];
        let close = after
            .find('}')
            .ok_or_else(|| anyhow::anyhow!("unterminated `${{` in {input:?}"))?;
        let name = &after[..close];
        if name.is_empty() {
            anyhow::bail!("empty `${{}}` placeholder in {input:?}");
        }
        let value = std::env::var(name)
            .with_context(|| format!("environment variable {name} is not set"))?;
        out.push_str(&value);
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Expand `${VAR}` placeholders embedded in a path field in place. Skips
/// paths that contain no placeholder (cheap fast path) and silently
/// leaves non-UTF-8 paths alone — those can't be tokenised against
/// `${VAR}` markers and are vanishingly rare on supported targets.
fn expand_env_path(p: &mut PathBuf, label: &str) -> Result<()> {
    if let Some(s) = p.to_str() {
        if s.contains("${") {
            let expanded = expand_env(s).with_context(|| format!("resolving {label}"))?;
            *p = PathBuf::from(expanded);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::Mutex;

    /// Serialise tests that mutate process-wide env vars. cargo test
    /// runs the suite in parallel by default and `TAVILY_API_KEY` /
    /// `SNACA_TEST_TAVILY` are global state — without this lock the
    /// two `web_tavily_*` tests race each other (and any future test
    /// that touches the same vars).
    static ENV_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn write_temp(content: &str) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(content.as_bytes()).unwrap();
        f
    }

    #[test]
    fn loads_minimal_config() {
        let f = write_temp(
            r#"
[server]
data_root = "./data"

[tenant]
id = "default"

[llm]
api_key = "test-key"
"#,
        );
        let cfg = Config::load(f.path()).unwrap();
        assert_eq!(cfg.tenant.id, "default");
        assert_eq!(cfg.llm.provider, "deepseek");
        assert_eq!(cfg.llm.model, "deepseek-chat");
        assert_eq!(cfg.server.http_listen, "127.0.0.1:8080");
        assert!(cfg.plugins.is_empty());
    }

    #[test]
    fn rejects_unknown_provider() {
        let f = write_temp(
            r#"
[server]
data_root = "./data"
[tenant]
id = "default"
[llm]
provider = "openai"
api_key = "x"
"#,
        );
        let err = Config::load(f.path()).unwrap_err();
        assert!(err.to_string().contains("provider"), "got: {err}");
    }

    #[test]
    fn rejects_empty_api_key_after_expansion() {
        // SAFETY: tests are single-threaded under cargo when env is touched;
        // we set then unset around the load.
        let f = write_temp(
            r#"
[server]
data_root = "./data"
[tenant]
id = "default"
[llm]
api_key = "${SNACA_TEST_EMPTY_KEY}"
"#,
        );
        // SAFETY: only this test reads SNACA_TEST_EMPTY_KEY; tests are typically
        // run single-threaded relative to env mutation in this crate.
        unsafe {
            std::env::set_var("SNACA_TEST_EMPTY_KEY", "");
        }
        let err = Config::load(f.path()).unwrap_err();
        assert!(err.to_string().contains("empty"), "got: {err}");
        unsafe {
            std::env::remove_var("SNACA_TEST_EMPTY_KEY");
        }
    }

    #[test]
    fn validate_for_write_allows_unresolved_placeholders() {
        let f = write_temp(
            r#"
[server]
data_root = "${SNACA_FUTURE_ROOT}/data"
[tenant]
id = "default"
[llm]
api_key = "${SNACA_FUTURE_KEY}"

[[plugins]]
name = "mock"
command = "${SNACA_FUTURE_BIN}/snaca-cli"
args = ["mock-plugin"]
"#,
        );
        let cfg = Config::validate_for_write(&std::fs::read_to_string(f.path()).unwrap(), f.path())
            .unwrap();
        assert_eq!(cfg.llm.api_key, "${SNACA_FUTURE_KEY}");
        let err = Config::load(f.path()).unwrap_err();
        assert!(err.to_string().contains("resolving llm.api_key"));
    }

    #[test]
    fn validate_for_write_still_rejects_invalid_shape() {
        let f = write_temp(
            r#"
[server]
data_root = "./data"
[tenant]
id = "default"
[llm]
provider = "openai"
api_key = "${SNACA_FUTURE_KEY}"
"#,
        );
        let err = Config::validate_for_write(&std::fs::read_to_string(f.path()).unwrap(), f.path())
            .unwrap_err();
        assert!(err.to_string().contains("provider"), "got: {err}");
    }

    #[test]
    fn relative_data_root_resolves_against_config_dir() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("snaca.toml");
        std::fs::write(
            &cfg_path,
            r#"
[server]
data_root = "./data"
[tenant]
id = "t"
[llm]
api_key = "k"
"#,
        )
        .unwrap();
        let cfg = Config::load(&cfg_path).unwrap();
        assert!(cfg.server.data_root.is_absolute());
        assert!(cfg.server.data_root.starts_with(dir.path()));
    }

    #[test]
    fn logging_file_resolves_against_config_dir_and_parses_size() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("snaca.toml");
        std::fs::write(
            &cfg_path,
            r#"
[server]
data_root = "./data"
[tenant]
id = "t"
[llm]
api_key = "k"

[logging]
file = "./logs/snaca.log"
max_size_mb = 25
max_files = 7
"#,
        )
        .unwrap();
        let cfg = Config::load(&cfg_path).unwrap();
        let log_file = cfg.logging.file.unwrap();
        assert!(
            log_file.is_absolute(),
            "relative path not resolved: {log_file:?}"
        );
        assert!(log_file.starts_with(dir.path()));
        assert!(log_file.ends_with("logs/snaca.log"));
        assert_eq!(cfg.logging.max_size_mb, Some(25));
        assert_eq!(cfg.logging.max_files, Some(7));
    }

    #[test]
    fn skills_global_dir_resolves_against_config_dir() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("snaca.toml");
        std::fs::write(
            &cfg_path,
            r#"
[server]
data_root = "./data"
[tenant]
id = "t"
[llm]
api_key = "k"

[skills]
global_dir = "./shared-skills"
"#,
        )
        .unwrap();
        let cfg = Config::load(&cfg_path).unwrap();
        let global = cfg.skills.global_dir.unwrap();
        assert!(
            global.is_absolute(),
            "relative path not resolved: {global:?}"
        );
        assert!(global.starts_with(dir.path()));
        assert!(global.ends_with("shared-skills"));
    }

    #[test]
    fn skills_section_defaults_to_none() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("snaca.toml");
        std::fs::write(
            &cfg_path,
            r#"
[server]
data_root = "./data"
[tenant]
id = "t"
[llm]
api_key = "k"
"#,
        )
        .unwrap();
        let cfg = Config::load(&cfg_path).unwrap();
        assert!(cfg.skills.global_dir.is_none());
    }

    #[test]
    fn im_input_section_parses_operator_overrides() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("snaca.toml");
        std::fs::write(
            &cfg_path,
            r#"
[server]
data_root = "./data"
[tenant]
id = "t"
[llm]
api_key = "k"

[im_input]
assembly_enabled = true
text_debounce_ms = 250
attachment_wait_secs = 12
hard_cap_secs = 99
"#,
        )
        .unwrap();
        let cfg = Config::load(&cfg_path).unwrap();
        assert_eq!(cfg.im_input.assembly_enabled, Some(true));
        assert_eq!(cfg.im_input.text_debounce_ms, Some(250));
        assert_eq!(cfg.im_input.attachment_wait_secs, Some(12));
        assert_eq!(cfg.im_input.hard_cap_secs, Some(99));
    }

    #[test]
    fn ensure_admin_token_skips_when_disabled() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("snaca.toml");
        std::fs::write(
            &cfg_path,
            r#"
[server]
data_root = "./data"
[tenant]
id = "t"
[llm]
api_key = "k"
"#,
        )
        .unwrap();
        let mut cfg = Config::load(&cfg_path).unwrap();
        // Default `[admin]` block has `enabled = false`, so no token is generated.
        let token = cfg.ensure_admin_token(&cfg_path).unwrap();
        assert!(token.is_none());
        assert!(cfg.admin.token.is_none());
    }

    #[test]
    fn ensure_admin_token_generates_and_persists_when_enabled() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("snaca.toml");
        std::fs::write(
            &cfg_path,
            r#"
[server]
data_root = "./data"
[tenant]
id = "t"
[llm]
api_key = "k"

[admin]
enabled = true
"#,
        )
        .unwrap();
        let mut cfg = Config::load(&cfg_path).unwrap();
        let token = cfg.ensure_admin_token(&cfg_path).unwrap().unwrap();
        assert!(token.len() >= 16, "weak token: {token}");
        // File now contains the token line.
        let written = std::fs::read_to_string(&cfg_path).unwrap();
        assert!(
            written.contains(&format!("token = \"{token}\"")),
            "token not persisted: {written}"
        );
        // Second call is a no-op (token already present).
        let mut cfg2 = Config::load(&cfg_path).unwrap();
        assert_eq!(cfg2.admin.token.as_deref(), Some(token.as_str()));
        let token2 = cfg2.ensure_admin_token(&cfg_path).unwrap();
        assert!(token2.is_none());
    }

    #[test]
    fn ensure_admin_token_appends_section_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let cfg_path = dir.path().join("snaca.toml");
        // No `[admin]` section at all, but the user has explicitly enabled
        // admin via env-like override — we simulate by editing the loaded
        // config in memory.
        std::fs::write(
            &cfg_path,
            r#"
[server]
data_root = "./data"
[tenant]
id = "t"
[llm]
api_key = "k"
"#,
        )
        .unwrap();
        let mut cfg = Config::load(&cfg_path).unwrap();
        cfg.admin.enabled = true;
        let token = cfg.ensure_admin_token(&cfg_path).unwrap().unwrap();
        let written = std::fs::read_to_string(&cfg_path).unwrap();
        assert!(written.contains("[admin]"), "section missing: {written}");
        assert!(
            written.contains(&format!("token = \"{token}\"")),
            "token missing: {written}"
        );
    }

    #[test]
    fn env_expansion_works() {
        unsafe {
            std::env::set_var("SNACA_TEST_API_KEY", "sk-1234");
        }
        let f = write_temp(
            r#"
[server]
data_root = "./data"
[tenant]
id = "t"
[llm]
api_key = "${SNACA_TEST_API_KEY}"
"#,
        );
        let cfg = Config::load(f.path()).unwrap();
        assert_eq!(cfg.llm.api_key, "sk-1234");
        unsafe {
            std::env::remove_var("SNACA_TEST_API_KEY");
        }
    }

    #[test]
    fn missing_env_var_is_loud() {
        let f = write_temp(
            r#"
[server]
data_root = "./data"
[tenant]
id = "t"
[llm]
api_key = "${SNACA_TEST_DEFINITELY_UNSET}"
"#,
        );
        let err = Config::load(f.path()).unwrap_err();
        // anyhow's chain — search across all causes, not just the outer one.
        let full: String = err
            .chain()
            .map(|e| e.to_string())
            .collect::<Vec<_>>()
            .join(" / ");
        assert!(
            full.contains("SNACA_TEST_DEFINITELY_UNSET"),
            "got chain: {full}"
        );
    }

    #[test]
    fn env_expansion_covers_path_fields() {
        unsafe {
            std::env::set_var("SNACA_TEST_DIR", "/opt/snaca");
        }
        let f = write_temp(
            r#"
[server]
data_root = "${SNACA_TEST_DIR}/data"
[tenant]
id = "t"
[llm]
api_key = "k"
[logging]
file = "${SNACA_TEST_DIR}/logs/snaca.log"
[skills]
global_dir = "${SNACA_TEST_DIR}/skills-global"

[[plugins]]
name = "lark"
command = "${SNACA_TEST_DIR}/bin/snaca-plugin-lark"
args = ["--data", "${SNACA_TEST_DIR}/cache"]
cwd = "${SNACA_TEST_DIR}/run"

[[mcp]]
name = "fs"
command = "${SNACA_TEST_DIR}/bin/mcp-fs"
args = ["${SNACA_TEST_DIR}/share"]
cwd = "${SNACA_TEST_DIR}/run"
[mcp.env]
DATA = "${SNACA_TEST_DIR}/payload"
"#,
        );
        let cfg = Config::load(f.path()).unwrap();
        // Expanded to absolute path → resolve_paths leaves it alone.
        assert_eq!(cfg.server.data_root, PathBuf::from("/opt/snaca/data"));
        assert_eq!(
            cfg.logging.file.as_deref(),
            Some(PathBuf::from("/opt/snaca/logs/snaca.log").as_path())
        );
        assert_eq!(
            cfg.skills.global_dir.as_deref(),
            Some(PathBuf::from("/opt/snaca/skills-global").as_path())
        );
        let p = &cfg.plugins[0];
        assert_eq!(p.command, "/opt/snaca/bin/snaca-plugin-lark");
        assert_eq!(p.args, vec!["--data", "/opt/snaca/cache"]);
        assert_eq!(p.cwd, Some(PathBuf::from("/opt/snaca/run")));
        let m = &cfg.mcp[0];
        assert_eq!(m.command, "/opt/snaca/bin/mcp-fs");
        assert_eq!(m.args, vec!["/opt/snaca/share"]);
        assert_eq!(m.cwd, Some(PathBuf::from("/opt/snaca/run")));
        assert_eq!(
            m.env.get("DATA").map(String::as_str),
            Some("/opt/snaca/payload")
        );
        unsafe {
            std::env::remove_var("SNACA_TEST_DIR");
        }
    }

    #[test]
    fn web_tavily_api_key_exports_to_env() {
        let _g = ENV_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        unsafe {
            std::env::remove_var("TAVILY_API_KEY");
        }
        let f = write_temp(
            r#"
[server]
data_root = "./data"
[tenant]
id = "t"
[llm]
api_key = "k"
[web]
tavily_api_key = "tvly-from-toml"
"#,
        );
        let cfg = Config::load(f.path()).unwrap();
        assert_eq!(cfg.web.tavily_api_key.as_deref(), Some("tvly-from-toml"));
        assert_eq!(
            std::env::var("TAVILY_API_KEY").ok().as_deref(),
            Some("tvly-from-toml")
        );
        unsafe {
            std::env::remove_var("TAVILY_API_KEY");
        }
    }

    #[test]
    fn web_tavily_api_key_supports_env_interpolation() {
        let _g = ENV_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        unsafe {
            std::env::set_var("SNACA_TEST_TAVILY", "tvly-from-env");
            std::env::remove_var("TAVILY_API_KEY");
        }
        let f = write_temp(
            r#"
[server]
data_root = "./data"
[tenant]
id = "t"
[llm]
api_key = "k"
[web]
tavily_api_key = "${SNACA_TEST_TAVILY}"
"#,
        );
        let cfg = Config::load(f.path()).unwrap();
        assert_eq!(cfg.web.tavily_api_key.as_deref(), Some("tvly-from-env"));
        assert_eq!(
            std::env::var("TAVILY_API_KEY").ok().as_deref(),
            Some("tvly-from-env")
        );
        unsafe {
            std::env::remove_var("SNACA_TEST_TAVILY");
            std::env::remove_var("TAVILY_API_KEY");
        }
    }

    #[test]
    fn web_section_optional() {
        let f = write_temp(
            r#"
[server]
data_root = "./data"
[tenant]
id = "t"
[llm]
api_key = "k"
"#,
        );
        let cfg = Config::load(f.path()).unwrap();
        assert!(cfg.web.tavily_api_key.is_none());
    }

    #[test]
    fn parses_plugins_section() {
        let f = write_temp(
            r#"
[server]
data_root = "./data"
[tenant]
id = "t"
[llm]
api_key = "k"

[[plugins]]
name = "mock"
command = "/usr/local/bin/snaca-cli"
args = ["mock-plugin", "--auto-echo"]
"#,
        );
        let cfg = Config::load(f.path()).unwrap();
        assert_eq!(cfg.plugins.len(), 1);
        assert_eq!(cfg.plugins[0].name, "mock");
        assert_eq!(cfg.plugins[0].args, vec!["mock-plugin", "--auto-echo"]);
    }
}
