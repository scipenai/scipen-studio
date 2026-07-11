//! `SnacaConfig` — runtime configuration passed via `init` / `config.reload`.
//!
//! Mirrors the toml-loadable shape, but `api_key` is **never** carried on
//! the wire. The `api_key_env` field names the env variable that holds the
//! real key; the host sets it during `spawn` before sending `init`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SnacaConfig {
    pub llm: LlmConfig,
    #[serde(default)]
    pub engine: EngineConfig,
    pub approval_mode: ApprovalMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<Vec<McpServerConfig>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logging: Option<LoggingConfig>,
    /// Read-only skills shipped with the app (Bundled scope, lowest priority).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundled_skills_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LlmConfig {
    pub provider: LlmProvider,
    /// Environment variable name carrying the real key.
    pub api_key_env: String,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inline_edit_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<RetryConfig>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LlmProvider {
    Deepseek,
    Anthropic,
    OpenaiCompatible,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RetryConfig {
    pub max_attempts: u32,
    pub base_delay_ms: u64,
    pub max_delay_secs: u64,
    pub jitter_ratio: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct EngineConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_iterations: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_guard_max_repeats: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub concurrent_tool_limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_after_input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_keep_recent: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protect_first_n: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_max_retries: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_extractor: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_extractor_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_summary_max_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_max_bytes: Option<u64>,
    /// `None` / `0` ⇒ no wall-clock cap on a turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_timeout_secs: Option<u64>,
    /// `0` disables collapsing of historical read-only tool results.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collapse_tool_results_threshold: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_tool_execution: Option<bool>,
    /// `0` disables the `max_tokens` escalation retry loop.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_token_escalation_attempts: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_output_token_ceiling: Option<u32>,
    /// `0` keeps every MCP client alive forever.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_idle_ttl_secs: Option<u64>,
    /// `0` disables the periodic idle-eviction reaper.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_reaper_period_secs: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalMode {
    Interactive,
    AutoAllow,
    AutoDeny,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub name: String,
    pub transport: McpTransport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub init_timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpTransport {
    Stdio,
    Http,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoggingConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> SnacaConfig {
        SnacaConfig {
            llm: LlmConfig {
                provider: LlmProvider::Deepseek,
                api_key_env: "SNACA_API_KEY".into(),
                model: "deepseek-chat".into(),
                inline_edit_model: None,
                base_url: None,
                timeout_secs: Some(120),
                retry: None,
            },
            engine: EngineConfig::default(),
            approval_mode: ApprovalMode::Interactive,
            mcp_servers: None,
            logging: None,
            bundled_skills_dir: None,
        }
    }

    #[test]
    fn roundtrips() {
        let c = sample();
        let s = serde_json::to_string(&c).unwrap();
        let back: SnacaConfig = serde_json::from_str(&s).unwrap();
        assert_eq!(c, back);
    }

    #[test]
    fn provider_serializes_snake_case() {
        let p = LlmProvider::OpenaiCompatible;
        assert_eq!(serde_json::to_string(&p).unwrap(), "\"openai_compatible\"");
    }

    #[test]
    fn api_key_env_required_field_present() {
        let v = serde_json::to_value(sample()).unwrap();
        assert_eq!(v["llm"]["api_key_env"], "SNACA_API_KEY");
        // assert nothing that looks like a real key
        assert!(!v.to_string().contains("sk-"));
    }
}
