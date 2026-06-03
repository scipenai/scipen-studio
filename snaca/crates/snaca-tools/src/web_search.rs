//! `WebSearch` — search the web via the Tavily Search API.
//!
//! Tavily is provider-agnostic (works whether snaca is talking to Anthropic
//! or DeepSeek) and returns LLM-friendly result objects with title / url /
//! short content snippets. The API key is read from `TAVILY_API_KEY` at
//! tool construction time; if missing the tool is still registered but
//! `execute` returns a clear `Execution` error so the LLM (and the user
//! reading logs) can see why instead of the tool silently disappearing.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput, ToolResult,
};
use std::time::Duration;

const TAVILY_ENDPOINT: &str = "https://api.tavily.com/search";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_MAX_RESULTS: u32 = 10;
const MAX_MAX_RESULTS: u32 = 20;
const MIN_QUERY_LEN: usize = 2;

pub struct WebSearchTool {
    http: reqwest::Client,
    api_key: Option<String>,
}

impl WebSearchTool {
    /// Read `TAVILY_API_KEY` from the environment. Missing key is *not* a
    /// construction failure — execute will surface a helpful error instead.
    pub fn from_env() -> Self {
        let api_key = std::env::var("TAVILY_API_KEY")
            .ok()
            .filter(|s| !s.trim().is_empty());
        Self::with_api_key(api_key)
    }

    pub fn with_api_key(api_key: Option<String>) -> Self {
        let http = crate::http_client::snaca_http_client_builder("websearch", REQUEST_TIMEOUT)
            .build()
            .expect("reqwest client builder with default config never fails");
        Self { http, api_key }
    }
}

impl Default for WebSearchTool {
    fn default() -> Self {
        Self::from_env()
    }
}

#[derive(Debug, Deserialize)]
struct WebSearchInput {
    query: String,
    #[serde(default)]
    allowed_domains: Option<Vec<String>>,
    #[serde(default)]
    blocked_domains: Option<Vec<String>>,
    #[serde(default)]
    max_results: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct TavilyResponse {
    #[serde(default)]
    answer: Option<String>,
    #[serde(default)]
    results: Vec<TavilyResult>,
}

#[derive(Debug, Deserialize)]
struct TavilyResult {
    #[serde(default)]
    title: String,
    url: String,
    #[serde(default)]
    content: String,
}

#[async_trait]
impl Tool for WebSearchTool {
    fn name(&self) -> &str {
        "WebSearch"
    }

    fn description(&self) -> &str {
        "Search the web for current information using a search engine. Returns \
         a ranked list of results with titles, URLs and short content snippets, \
         plus an optional model-written answer summary. Use this when the user's \
         question needs information beyond your training cutoff, or for current \
         events, prices, releases, etc. Cite the URLs you used in your response \
         with markdown links — there is a `Sources:` block at the bottom of every \
         result. Backed by Tavily; requires the `TAVILY_API_KEY` env var."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "minLength": MIN_QUERY_LEN,
                    "description": "The search query."
                },
                "allowed_domains": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Only return results from these domains. Mutually exclusive with blocked_domains."
                },
                "blocked_domains": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Never return results from these domains. Mutually exclusive with allowed_domains."
                },
                "max_results": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_MAX_RESULTS,
                    "description": "Maximum number of results to return. Default 10, max 20."
                }
            },
            "required": ["query"]
        })
    }

    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities {
            reads_filesystem: false,
            writes_filesystem: false,
            executes_commands: false,
            network_access: true,
        }
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::Never
    }

    async fn execute(&self, input: Value, _ctx: &ToolContext) -> ToolResult {
        let input: WebSearchInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;

        let query = input.query.trim();
        if query.chars().count() < MIN_QUERY_LEN {
            return Err(ToolError::InvalidInput(format!(
                "query must be at least {MIN_QUERY_LEN} characters"
            )));
        }
        if input.allowed_domains.as_ref().is_some_and(|v| !v.is_empty())
            && input.blocked_domains.as_ref().is_some_and(|v| !v.is_empty())
        {
            return Err(ToolError::InvalidInput(
                "allowed_domains and blocked_domains are mutually exclusive".into(),
            ));
        }

        let api_key = self.api_key.as_deref().ok_or_else(|| {
            ToolError::Execution(
                "WebSearch requires the TAVILY_API_KEY environment variable to be set. \
                 Get a key at https://tavily.com and export TAVILY_API_KEY before starting the server."
                    .into(),
            )
        })?;

        let max_results = input
            .max_results
            .unwrap_or(DEFAULT_MAX_RESULTS)
            .clamp(1, MAX_MAX_RESULTS);

        let mut body = json!({
            "api_key": api_key,
            "query": query,
            "max_results": max_results,
            "include_answer": true,
            "search_depth": "basic",
        });
        if let Some(allowed) = input.allowed_domains.filter(|v| !v.is_empty()) {
            body["include_domains"] = json!(allowed);
        }
        if let Some(blocked) = input.blocked_domains.filter(|v| !v.is_empty()) {
            body["exclude_domains"] = json!(blocked);
        }

        let response = self
            .http
            .post(TAVILY_ENDPOINT)
            .json(&body)
            .send()
            .await
            .map_err(|e| ToolError::Execution(format!("Tavily request failed: {e}")))?;

        let status = response.status();
        if !status.is_success() {
            let body_text = response.text().await.unwrap_or_default();
            return Err(ToolError::Execution(format!(
                "Tavily returned HTTP {}: {}",
                status.as_u16(),
                truncate(&body_text, 500)
            )));
        }

        let parsed: TavilyResponse = response
            .json()
            .await
            .map_err(|e| ToolError::Execution(format!("Tavily response was not JSON: {e}")))?;

        Ok(ToolOutput::text(render_results(query, &parsed)))
    }
}

fn render_results(query: &str, resp: &TavilyResponse) -> String {
    let mut out = String::new();
    out.push_str(&format!("# Search results for: {query}\n\n"));

    if let Some(answer) = resp.answer.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push_str("## Summary\n");
        out.push_str(answer.trim());
        out.push_str("\n\n");
    }

    if resp.results.is_empty() {
        out.push_str("No results returned.\n");
        return out;
    }

    for (i, r) in resp.results.iter().enumerate() {
        let title = if r.title.trim().is_empty() {
            "(untitled)"
        } else {
            r.title.trim()
        };
        out.push_str(&format!("### {idx}. {title}\n", idx = i + 1));
        out.push_str(&format!("URL: {}\n", r.url));
        let snippet = r.content.trim();
        if !snippet.is_empty() {
            out.push_str(&truncate(snippet, 800));
            out.push('\n');
        }
        out.push('\n');
    }

    out.push_str("Sources:\n");
    for r in &resp.results {
        let title = if r.title.trim().is_empty() {
            r.url.as_str()
        } else {
            r.title.trim()
        };
        out.push_str(&format!("- [{}]({})\n", title, r.url));
    }
    out.push_str(
        "\nYou MUST cite the sources above in your response using markdown links.\n",
    );
    out
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_core::{ProjectId, SessionId, TenantId};
    use snaca_tools_api::ToolContext;

    fn ctx() -> ToolContext {
        ToolContext::new(
            TenantId::new("t"),
            ProjectId::from_raw("p"),
            SessionId::new(),
            std::env::temp_dir(),
        )
    }

    #[test]
    fn schema_has_required_query() {
        let tool = WebSearchTool::with_api_key(None);
        let schema = tool.input_schema();
        let required = schema["required"].as_array().unwrap();
        assert!(required.iter().any(|v| v == "query"));
    }

    #[tokio::test]
    async fn rejects_short_query() {
        let tool = WebSearchTool::with_api_key(Some("dummy".into()));
        let err = tool
            .execute(json!({ "query": "a" }), &ctx())
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn rejects_conflicting_domain_filters() {
        let tool = WebSearchTool::with_api_key(Some("dummy".into()));
        let err = tool
            .execute(
                json!({
                    "query": "rust language",
                    "allowed_domains": ["rust-lang.org"],
                    "blocked_domains": ["example.com"]
                }),
                &ctx(),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn missing_api_key_returns_execution_error() {
        let tool = WebSearchTool::with_api_key(None);
        let err = tool
            .execute(json!({ "query": "rust language" }), &ctx())
            .await
            .unwrap_err();
        match err {
            ToolError::Execution(msg) => {
                assert!(msg.contains("TAVILY_API_KEY"), "msg = {msg}");
            }
            other => panic!("expected Execution error, got {other:?}"),
        }
    }

    #[test]
    fn capabilities_are_network_only() {
        let tool = WebSearchTool::with_api_key(None);
        let caps = tool.capabilities();
        assert!(caps.network_access);
        assert!(!caps.writes_filesystem);
        assert!(!caps.executes_commands);
        assert!(tool.is_read_only());
    }

    #[test]
    fn renders_results_with_sources_block() {
        let resp = TavilyResponse {
            answer: Some("Rust is a systems language.".into()),
            results: vec![
                TavilyResult {
                    title: "Rust home".into(),
                    url: "https://www.rust-lang.org/".into(),
                    content: "Empowering everyone to build reliable and efficient software.".into(),
                },
                TavilyResult {
                    title: "".into(),
                    url: "https://doc.rust-lang.org/book/".into(),
                    content: "The Rust Programming Language book.".into(),
                },
            ],
        };
        let out = render_results("rust language", &resp);
        assert!(out.contains("# Search results for: rust language"));
        assert!(out.contains("## Summary"));
        assert!(out.contains("Rust home"));
        assert!(out.contains("https://www.rust-lang.org/"));
        assert!(out.contains("Sources:"));
        assert!(out.contains("- [Rust home](https://www.rust-lang.org/)"));
        // untitled result falls back to URL
        assert!(out.contains("- [https://doc.rust-lang.org/book/](https://doc.rust-lang.org/book/)"));
        assert!(out.contains("You MUST cite the sources above"));
    }

    #[test]
    fn renders_empty_results() {
        let resp = TavilyResponse {
            answer: None,
            results: vec![],
        };
        let out = render_results("nothing", &resp);
        assert!(out.contains("No results returned"));
    }
}
