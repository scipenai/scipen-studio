//! MCP server configuration.
//!
//! Each registered MCP server is one row of `[[mcp]]` in `snaca.toml`.
//! Mirrors the shape used by Claude Code / OpenClaw so users can paste
//! existing definitions verbatim.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// How to reach the MCP server. Stdio spawns a child process; Http points
/// at a remote MCP server speaking the Streamable HTTP transport (the
/// modern MCP spec, supersedes the older raw SSE-only mode).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum McpTransport {
    /// Default — `command` + `args` + `cwd` + `env` apply, sandbox runs.
    #[default]
    Stdio,
    /// Remote server. `command`/`args`/`cwd` are ignored; `env` is *not*
    /// forwarded (the server already runs elsewhere). Sandboxing also
    /// doesn't apply — we don't own the remote process.
    Http {
        url: String,
        /// Optional `Authorization` header value (without the `Bearer `
        /// prefix — rmcp prepends it).
        #[serde(default)]
        auth_token: Option<String>,
        /// Extra HTTP headers (e.g. `X-Tenant-Id: ...`). Sent on every
        /// request.
        #[serde(default)]
        custom_headers: HashMap<String, String>,
    },
}


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    /// Logical name used to namespace tools as `mcp__<name>__<tool>`.
    pub name: String,
    /// How to reach the server. Defaults to stdio for backward
    /// compatibility — older configs without `[mcp.transport]` keep
    /// working unchanged.
    #[serde(default)]
    pub transport: McpTransport,
    /// Executable path or command in `PATH` (e.g. `npx`, `uvx`, `python`).
    /// Required for stdio; ignored for http transports.
    #[serde(default)]
    pub command: String,
    /// Arguments passed to the command (e.g. `["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]`).
    #[serde(default)]
    pub args: Vec<String>,
    /// Per-server environment variables. Inherits the parent process env;
    /// these override / add on top.
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Working directory for the child process. `None` = inherit.
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    /// Initialization timeout in seconds. Defaults to 30.
    #[serde(default)]
    pub init_timeout_secs: Option<u64>,
    /// Per-RPC timeout for `tools/call` and the active health probe, in
    /// seconds. `None` falls back to `DEFAULT_CALL_TIMEOUT_SECS` (60s)
    /// in `client.rs`. The rmcp SDK doesn't enforce a default timeout
    /// of its own, so without this knob a stuck MCP server can pin a
    /// turn until the engine's `turn_timeout_secs` cuts the whole turn
    /// rather than just the one bad tool call.
    #[serde(default)]
    pub call_timeout_secs: Option<u64>,
}

impl McpServerConfig {
    pub fn new(name: impl Into<String>, command: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            transport: McpTransport::Stdio,
            command: command.into(),
            args: Vec::new(),
            env: HashMap::new(),
            cwd: None,
            init_timeout_secs: None,
            call_timeout_secs: None,
        }
    }

    /// Construct a remote-HTTP MCP server config. `command`/`args`/`cwd`
    /// stay empty — the server runs out-of-process beyond our reach.
    pub fn http(name: impl Into<String>, url: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            transport: McpTransport::Http {
                url: url.into(),
                auth_token: None,
                custom_headers: HashMap::new(),
            },
            command: String::new(),
            args: Vec::new(),
            env: HashMap::new(),
            cwd: None,
            init_timeout_secs: None,
            call_timeout_secs: None,
        }
    }

    pub fn with_args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args = args.into_iter().map(Into::into).collect();
        self
    }

    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    pub fn with_cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }
}

/// `mcp__<server>__<tool>` namespacing helper. `tool` is normalised on
/// the way in so an upstream advertised name with hyphens / dots /
/// spaces still produces a valid LLM identifier — Anthropic's tool
/// regex is `^[a-zA-Z_][a-zA-Z0-9_]{0,63}$` and snaca-internal slugs
/// keep the same shape.
pub fn qualified_tool_name(server: &str, tool: &str) -> String {
    format!("mcp__{server}__{}", sanitize_tool_segment(tool))
}

/// Inverse — split a qualified name back into `(server, tool)`. The
/// returned `tool` is the sanitised slug, not the upstream name —
/// callers needing the raw remote name should consult `McpTool::remote_name`.
pub fn split_qualified_name(qualified: &str) -> Option<(&str, &str)> {
    let rest = qualified.strip_prefix("mcp__")?;
    let (server, tool) = rest.split_once("__")?;
    if server.is_empty() || tool.is_empty() {
        return None;
    }
    Some((server, tool))
}

/// Validation result for a server name. The split codec assumes server
/// names contain no `__` and start with `[a-z]` — otherwise an MCP tool
/// like `mcp__my__server__list` would parse back as `(server="my",
/// tool="server__list")`, silently routing calls to the wrong server.
/// We refuse those configs at load time rather than at first failure.
///
/// Rules (intentionally tight — server names are operator-controlled
/// and short, restricting the alphabet costs nothing):
/// - non-empty, ≤ 64 chars
/// - `[a-z0-9_-]+` only (no uppercase, no dots, no spaces)
/// - must not contain the `__` substring (would corrupt name split)
/// - must not start with `mcp_` (reserved prefix, avoids confusion)
pub fn validate_server_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("server name must not be empty".into());
    }
    if name.len() > 64 {
        return Err(format!(
            "server name too long ({} chars); max 64",
            name.len()
        ));
    }
    if name.contains("__") {
        return Err(format!(
            "server name {name:?} contains `__`; this would corrupt the \
             `mcp__<server>__<tool>` split — pick a single-underscore form"
        ));
    }
    if name.starts_with("mcp_") {
        return Err(format!(
            "server name {name:?} starts with reserved prefix `mcp_`; \
             pick a name that doesn't shadow the namespace"
        ));
    }
    for ch in name.chars() {
        let ok = ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-';
        if !ok {
            return Err(format!(
                "server name {name:?} contains invalid character {ch:?}; \
                 allowed alphabet is [a-z0-9_-]"
            ));
        }
    }
    Ok(())
}

/// Detect duplicate `name` across a slice of configs. Returns the first
/// repeated name. Operators get a clear startup error instead of one
/// server silently overwriting another in the tool registry.
pub fn find_duplicate_server_name(configs: &[McpServerConfig]) -> Option<String> {
    let mut seen = std::collections::HashSet::new();
    for c in configs {
        if !seen.insert(c.name.as_str()) {
            return Some(c.name.clone());
        }
    }
    None
}

/// Normalise an upstream tool name to an LLM-friendly slug. We don't
/// try to preserve the original text — `dot.notation` and `kebab-case`
/// both collapse to underscores. Runs of separator chars collapse to a
/// single `_`. Empty result (or a name that didn't start with an
/// alphabet character) is left for the caller to detect; this helper
/// never returns an invalid identifier in the normal case.
fn sanitize_tool_segment(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut last_was_sep = true;
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            out.push(ch);
            last_was_sep = false;
        } else if !last_was_sep {
            out.push('_');
            last_was_sep = true;
        }
    }
    // Trim trailing underscore from collapse pass.
    while out.ends_with('_') {
        out.pop();
    }
    // Anthropic requires the first char to be `[a-zA-Z_]`; a digit-led
    // upstream name (rare but legal in some MCP servers) gets prefixed.
    if let Some(first) = out.chars().next() {
        if first.is_ascii_digit() {
            out.insert(0, '_');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qualified_name_round_trips() {
        assert_eq!(
            qualified_tool_name("filesystem", "read_file"),
            "mcp__filesystem__read_file"
        );
        assert_eq!(
            split_qualified_name("mcp__filesystem__read_file"),
            Some(("filesystem", "read_file"))
        );
    }

    #[test]
    fn split_handles_underscored_tool_name() {
        // Tool name with internal underscores still parses; only the first
        // double-underscore after the prefix is the server boundary.
        assert_eq!(
            split_qualified_name("mcp__github__list_pull_requests"),
            Some(("github", "list_pull_requests"))
        );
    }

    #[test]
    fn tool_name_normalisation_collapses_separators() {
        // Hyphen / dot / space all collapse to a single `_`.
        assert_eq!(
            qualified_tool_name("svc", "list-resources.v2"),
            "mcp__svc__list_resources_v2"
        );
        assert_eq!(
            qualified_tool_name("svc", "do something"),
            "mcp__svc__do_something"
        );
        // Multi-char separator runs don't bloat into multiple underscores.
        assert_eq!(
            qualified_tool_name("svc", "a---b"),
            "mcp__svc__a_b"
        );
    }

    #[test]
    fn tool_name_normalisation_prefixes_leading_digit() {
        // Anthropic's tool regex requires `[a-zA-Z_]` first — leading
        // digits get an underscore prepended.
        assert_eq!(
            qualified_tool_name("svc", "2do"),
            "mcp__svc___2do"
        );
    }

    #[test]
    fn validate_server_name_accepts_valid_names() {
        for ok in &["github", "fs", "a", "x1", "my-server", "lark_v2"] {
            assert!(
                validate_server_name(ok).is_ok(),
                "expected {ok:?} to validate"
            );
        }
    }

    #[test]
    fn validate_server_name_rejects_double_underscore() {
        // Double-underscore would corrupt the qualified-name split:
        // `mcp__my__svc__tool` parses as `(server="my", tool="svc__tool")`.
        let err = validate_server_name("my__svc").unwrap_err();
        assert!(err.contains("__"), "got: {err}");
    }

    #[test]
    fn validate_server_name_rejects_reserved_prefix() {
        let err = validate_server_name("mcp_proxy").unwrap_err();
        assert!(err.contains("mcp_"), "got: {err}");
    }

    #[test]
    fn validate_server_name_rejects_uppercase_and_special() {
        assert!(validate_server_name("GitHub").is_err());
        assert!(validate_server_name("my.server").is_err());
        assert!(validate_server_name("with space").is_err());
        assert!(validate_server_name("").is_err());
    }

    #[test]
    fn find_duplicate_server_name_picks_first_collision() {
        let cfgs = vec![
            McpServerConfig::new("github", "gh"),
            McpServerConfig::new("fs", "fs"),
            McpServerConfig::new("github", "gh-clone"),
        ];
        assert_eq!(find_duplicate_server_name(&cfgs).as_deref(), Some("github"));
    }

    #[test]
    fn find_duplicate_server_name_returns_none_for_unique() {
        let cfgs = vec![
            McpServerConfig::new("github", "gh"),
            McpServerConfig::new("fs", "fs"),
        ];
        assert!(find_duplicate_server_name(&cfgs).is_none());
    }

    #[test]
    fn split_rejects_malformed() {
        assert!(split_qualified_name("not-an-mcp-name").is_none());
        assert!(split_qualified_name("mcp__only_server").is_none());
        assert!(split_qualified_name("mcp____").is_none());
    }

    #[test]
    fn server_config_default_transport_is_stdio() {
        let cfg = McpServerConfig::new("fs", "npx");
        assert!(matches!(cfg.transport, McpTransport::Stdio));
    }

    #[test]
    fn http_constructor_builds_remote_config() {
        let cfg = McpServerConfig::http("remote", "https://example.com/mcp");
        match cfg.transport {
            McpTransport::Http {
                url,
                auth_token,
                custom_headers,
            } => {
                assert_eq!(url, "https://example.com/mcp");
                assert!(auth_token.is_none());
                assert!(custom_headers.is_empty());
            }
            other => panic!("expected Http transport, got {other:?}"),
        }
        assert!(cfg.command.is_empty());
        assert!(cfg.args.is_empty());
    }

    #[test]
    fn transport_serde_round_trips_stdio() {
        let json = serde_json::to_string(&McpTransport::Stdio).unwrap();
        assert_eq!(json, r#"{"kind":"stdio"}"#);
        let back: McpTransport = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, McpTransport::Stdio));
    }

    #[test]
    fn transport_serde_round_trips_http() {
        let mut headers = HashMap::new();
        headers.insert("X-Tenant".into(), "alpha".into());
        let original = McpTransport::Http {
            url: "https://srv/mcp".into(),
            auth_token: Some("tok".into()),
            custom_headers: headers,
        };
        let json = serde_json::to_string(&original).unwrap();
        let back: McpTransport = serde_json::from_str(&json).unwrap();
        match back {
            McpTransport::Http {
                url,
                auth_token,
                custom_headers,
            } => {
                assert_eq!(url, "https://srv/mcp");
                assert_eq!(auth_token.as_deref(), Some("tok"));
                assert_eq!(custom_headers.get("X-Tenant").unwrap(), "alpha");
            }
            other => panic!("expected Http, got {other:?}"),
        }
    }
}
