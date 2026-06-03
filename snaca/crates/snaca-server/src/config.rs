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
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct LoggingSection {
    /// `tracing_subscriber::EnvFilter` directive applied at startup. Same
    /// grammar as `RUST_LOG` (e.g. `"info,snaca_llm=debug,reqwest=info"`).
    /// `RUST_LOG`, if set, wins — toml is the fallback so operators can
    /// override at runtime without editing config.
    #[serde(default)]
    pub filter: Option<String>,
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
    /// schema can be uniform across both transport kinds.
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
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
    /// file's parent directory.
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
    #[serde(default)]
    pub history_limit: Option<u32>,
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

    /// Memory embedder backend for vector recall. Recognised values:
    /// - `"none"` / unset → no recall, only the static MEMORY.md index
    /// - `"hash"` → deterministic stub (good for dev / smoke tests)
    /// - `"fastembed"` → real ONNX embedder (requires `--features fastembed`)
    ///
    /// Unknown values fall back to `none` with a startup warning.
    #[serde(default)]
    pub memory_embedder: Option<String>,

    /// Hash embedder dimensionality. Only consulted when
    /// `memory_embedder = "hash"`. Default 128.
    #[serde(default)]
    pub memory_embedder_dim: Option<usize>,

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

    /// Enable the LLM rerank pass between cosine recall and the
    /// system-prompt splice. Without it, the engine truncates the
    /// cosine top-k inline. With it, the engine pulls a wider pool
    /// and asks the LLM to pick the best 5. Default off — adds an
    /// LLM call per turn.
    #[serde(default)]
    pub memory_reranker: Option<bool>,

    /// Override the model used for memory rerank. Useful when the
    /// rerank step should run on a smaller / faster model than the
    /// main turn. Defaults to `llm.model` from the parent section.
    #[serde(default)]
    pub memory_reranker_model: Option<String>,

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

    /// Pre-execute read-only no-approval tool calls in parallel with
    /// the LLM response stream. Default `true`. Set to `false` to
    /// fall back to fully-sequential post-stream execution (useful
    /// for debugging tool ordering or providers whose stream framing
    /// trips up the eager dispatch heuristics).
    #[serde(default)]
    pub stream_tool_execution: Option<bool>,

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
}

#[derive(Debug, Clone, Deserialize)]
pub struct PluginSection {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub cwd: Option<PathBuf>,
}

impl Config {
    /// Load and validate a config file. Resolves `${VAR}` placeholders in
    /// `llm.api_key` and any `plugins[].env` value against the process env.
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)
            .with_context(|| format!("reading config from {}", path.display()))?;
        let mut cfg: Config = toml::from_str(&raw)
            .with_context(|| format!("parsing config {}", path.display()))?;

        cfg.resolve_env()?;
        cfg.resolve_paths(path);
        cfg.validate()?;
        Ok(cfg)
    }

    fn resolve_env(&mut self) -> Result<()> {
        self.llm.api_key = expand_env(&self.llm.api_key)
            .with_context(|| "resolving llm.api_key")?;
        for plugin in &mut self.plugins {
            for (k, v) in plugin.env.iter_mut() {
                *v = expand_env(v).with_context(|| format!("resolving plugins.{}.env.{k}", plugin.name))?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

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
