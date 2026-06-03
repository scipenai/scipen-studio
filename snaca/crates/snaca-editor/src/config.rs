//! Configuration loading helpers.
//!
//! P0 scope is minimal: optionally pre-read a `snaca.toml` for early
//! sanity-check (so the operator gets immediate feedback if the file is
//! malformed). The authoritative config still arrives via `init.snaca_config`
//! — Studio is the source of truth, the toml is only a debugging convenience.

use anyhow::{Context, Result};
use snaca_editor_protocol::types::SnacaConfig;
use std::path::Path;
use tracing::{debug, info};

pub async fn preload_from_file(path: &Path) -> Result<SnacaConfig> {
    let raw = tokio::fs::read_to_string(path)
        .await
        .with_context(|| format!("read {}", path.display()))?;
    let expanded = expand_env(&raw);
    let cfg: SnacaConfig =
        toml::from_str(&expanded).context("parse snaca.toml (post env expansion)")?;
    info!(path = %path.display(), provider = ?cfg.llm.provider, "config preloaded");
    debug!(?cfg, "full config");
    Ok(cfg)
}

/// Expand `${VAR}` placeholders from the environment. Missing vars
/// are left literal — fail-fast happens at use time (e.g. when the LLM
/// client tries to send the empty API key).
fn expand_env(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '$' && chars.peek() == Some(&'{') {
            chars.next(); // consume '{'
            let mut name = String::new();
            while let Some(&ch) = chars.peek() {
                if ch == '}' {
                    chars.next();
                    break;
                }
                name.push(ch);
                chars.next();
            }
            if let Ok(val) = std::env::var(&name) {
                out.push_str(&val);
            } else {
                out.push_str("${");
                out.push_str(&name);
                out.push('}');
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_env_replaces_set_vars() {
        std::env::set_var("SNACA_TEST_VAR_X", "hello");
        let s = expand_env(r#"api_key = "${SNACA_TEST_VAR_X}""#);
        assert!(s.contains("\"hello\""));
        std::env::remove_var("SNACA_TEST_VAR_X");
    }

    #[test]
    fn expand_env_keeps_missing_literal() {
        std::env::remove_var("SNACA_TEST_VAR_MISSING");
        let s = expand_env(r#"api_key = "${SNACA_TEST_VAR_MISSING}""#);
        assert!(s.contains("${SNACA_TEST_VAR_MISSING}"));
    }
}
