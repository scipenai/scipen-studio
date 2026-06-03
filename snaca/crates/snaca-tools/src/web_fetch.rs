//! `WebFetch` — fetch a URL, convert HTML to Markdown, return it.
//!
//! Mirrors the reference Claude Code `WebFetchTool`'s safety surface
//! (URL length cap, private-IP rejection, max content size, cross-host
//! redirect handling) without the parts that bind to Anthropic's ecosystem
//! (preapproved-domains list, api.anthropic.com domain blocklist preflight,
//! LRU result cache, secondary-model post-processing). The assistant
//! receives the markdown body directly and decides what to do with it.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput, ToolResult,
};
use std::net::IpAddr;
use std::time::{Duration, Instant};
use url::Url;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_URL_LEN: usize = 2000;
const MAX_REDIRECTS: usize = 10;
const MAX_BODY_BYTES: usize = 10 * 1024 * 1024;
const MAX_MARKDOWN_LEN: usize = 100_000;

pub struct WebFetchTool {
    http: reqwest::Client,
}

impl WebFetchTool {
    pub fn new() -> Self {
        // Custom redirect policy: allow same-origin and www<->apex toggles
        // up to MAX_REDIRECTS; stop on the first cross-host hop so we can
        // surface the redirect to the LLM (matches reference utils.ts:255-313).
        let policy = reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                return attempt.error("too many redirects");
            }
            let prev = attempt
                .previous()
                .last()
                .cloned()
                .unwrap_or_else(|| attempt.url().clone());
            if is_permitted_redirect(&prev, attempt.url()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        });

        let http = crate::http_client::snaca_http_client_builder("webfetch", REQUEST_TIMEOUT)
            .redirect(policy)
            .build()
            .expect("reqwest client builder with default config never fails");
        Self { http }
    }
}

impl Default for WebFetchTool {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Deserialize)]
struct WebFetchInput {
    url: String,
    #[serde(default)]
    prompt: Option<String>,
}

#[async_trait]
impl Tool for WebFetchTool {
    fn name(&self) -> &str {
        "WebFetch"
    }

    fn description(&self) -> &str {
        "Fetch a single URL and return its content as markdown. Converts HTML \
         to markdown automatically; plain text and markdown bodies pass through \
         verbatim. Returns at most 100KB of content (truncated with a marker).\n\
         \n\
         Usage notes:\n\
         - The URL must be a fully-formed http(s) URL. HTTP is auto-upgraded to HTTPS.\n\
         - This is read-only and does not modify any files.\n\
         - Fails for authenticated/private URLs (e.g. Google Docs, Confluence, \
         private GitHub repos) — those need the appropriate authenticated client.\n\
         - If a request crosses hosts via redirect, the tool stops and returns \
         the redirect URL so you can decide whether to follow it. Re-call WebFetch \
         with the new URL to continue.\n\
         - Optional `prompt` is recorded in the output header as a memo of intent; \
         it is not used to pre-summarize the page. Read the markdown yourself."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "format": "uri",
                    "description": "The URL to fetch. Must be http or https; max 2000 characters."
                },
                "prompt": {
                    "type": "string",
                    "description": "Optional note recorded in the result header to remind you what you wanted from this page. The assistant should read the returned markdown to answer the user."
                }
            },
            "required": ["url"]
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
        let input: WebFetchInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;

        let url = validate_and_normalize_url(&input.url)?;
        let started = Instant::now();

        let response = self
            .http
            .get(url.clone())
            .header(
                reqwest::header::ACCEPT,
                "text/markdown, text/html, text/plain, */*",
            )
            .send()
            .await
            .map_err(|e| ToolError::Execution(format!("WebFetch request failed: {e}")))?;

        let status = response.status();
        let final_url = response.url().clone();

        // Cross-host redirect short-circuit: our redirect policy stops on
        // the first hop that changes host, so the response will still carry
        // a 3xx status with a Location header. Surface that to the model.
        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(|loc| {
                    // Resolve relative Locations against the response URL.
                    final_url.join(loc).map(|u| u.to_string()).unwrap_or_else(|_| loc.to_string())
                })
                .unwrap_or_else(|| final_url.to_string());
            return Ok(ToolOutput::text(format!(
                "This URL ({original}) redirects to a different host: {location}\n\
                 Status: {status}\n\
                 \n\
                 WebFetch refuses to follow cross-host redirects automatically. \
                 If you trust the destination, call WebFetch again with that URL.",
                original = url,
                location = location,
                status = status.as_u16(),
            )));
        }

        if !status.is_success() {
            // Read up to 2 KB of the body for diagnostic context, then bail.
            let snippet = response
                .text()
                .await
                .map(|b| truncate_chars(&b, 1_000))
                .unwrap_or_default();
            return Err(ToolError::Execution(format!(
                "WebFetch got HTTP {} from {}: {}",
                status.as_u16(),
                final_url,
                snippet
            )));
        }

        // Enforce body size cap via Content-Length when present.
        if let Some(len) = response.content_length() {
            if len as usize > MAX_BODY_BYTES {
                return Err(ToolError::Execution(format!(
                    "WebFetch refusing body of {} bytes (cap is {} bytes)",
                    len, MAX_BODY_BYTES
                )));
            }
        }

        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        // Stream body with size cap regardless of Content-Length.
        let body = read_capped(response).await?;

        let kind = classify_content(&content_type);
        let markdown = match kind {
            ContentKind::Html => html2md::parse_html(&body),
            ContentKind::TextLike => body,
            ContentKind::Unsupported => {
                return Err(ToolError::Execution(format!(
                    "WebFetch does not support content-type {:?}. Only HTML, text/plain, and \
                     text/markdown are converted; download binary content separately and use Read.",
                    content_type
                )));
            }
        };

        let bytes = markdown.len();
        let (markdown, truncated) = truncate_markdown(markdown);
        let duration_ms = started.elapsed().as_millis();

        let mut out = String::new();
        out.push_str(&format!("# Fetched: {final_url}\n"));
        if let Some(p) = input.prompt.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            out.push_str(&format!("[intent: {p}]\n"));
        }
        out.push_str(&format!(
            "Status: {status} ({code})  •  {bytes} bytes  •  {duration_ms} ms  •  content-type: {ct}\n\n---\n\n",
            status = status.canonical_reason().unwrap_or("OK"),
            code = status.as_u16(),
            bytes = bytes,
            duration_ms = duration_ms,
            ct = if content_type.is_empty() { "(unspecified)" } else { content_type.as_str() },
        ));
        out.push_str(&markdown);
        if truncated {
            out.push_str("\n\n[Content truncated due to length.]");
        }

        Ok(ToolOutput::text(out))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContentKind {
    Html,
    TextLike,
    Unsupported,
}

fn classify_content(content_type: &str) -> ContentKind {
    let lc = content_type.to_ascii_lowercase();
    if lc.contains("text/html") || lc.contains("application/xhtml") {
        ContentKind::Html
    } else if lc.contains("text/markdown")
        || lc.contains("text/plain")
        || lc.contains("application/json")
        || lc.contains("application/xml")
        || lc.contains("text/xml")
        || lc.is_empty()
    {
        ContentKind::TextLike
    } else {
        ContentKind::Unsupported
    }
}

fn truncate_markdown(s: String) -> (String, bool) {
    if s.chars().count() <= MAX_MARKDOWN_LEN {
        return (s, false);
    }
    let truncated: String = s.chars().take(MAX_MARKDOWN_LEN).collect();
    (truncated, true)
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

async fn read_capped(response: reqwest::Response) -> Result<String, ToolError> {
    let mut buf = Vec::<u8>::new();
    let mut resp = response;
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if buf.len() + chunk.len() > MAX_BODY_BYTES {
                    return Err(ToolError::Execution(format!(
                        "WebFetch body exceeded {} bytes; aborting",
                        MAX_BODY_BYTES
                    )));
                }
                buf.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => {
                return Err(ToolError::Execution(format!(
                    "WebFetch error while reading body: {e}"
                )));
            }
        }
    }
    String::from_utf8(buf).or_else(|e| {
        // Some pages are not strict UTF-8; fall back to lossy so we still
        // return something the LLM can read.
        Ok(String::from_utf8_lossy(e.as_bytes()).into_owned())
    })
}

fn validate_and_normalize_url(raw: &str) -> Result<Url, ToolError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(ToolError::InvalidInput("url is empty".into()));
    }
    if raw.len() > MAX_URL_LEN {
        return Err(ToolError::InvalidInput(format!(
            "url is too long: {} chars (max {MAX_URL_LEN})",
            raw.len()
        )));
    }

    let mut parsed = Url::parse(raw)
        .map_err(|e| ToolError::InvalidInput(format!("invalid url: {e}")))?;

    // Upgrade http -> https. set_scheme returns Err(()) for opaque-URL
    // mismatches but http<->https is a supported transition.
    if parsed.scheme() == "http" {
        let _ = parsed.set_scheme("https");
    }
    if parsed.scheme() != "https" {
        return Err(ToolError::InvalidInput(format!(
            "url scheme must be http or https, got {:?}",
            parsed.scheme()
        )));
    }

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ToolError::InvalidInput(
            "url must not include credentials".into(),
        ));
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| ToolError::InvalidInput("url has no host".into()))?;

    if is_private_host(host) {
        return Err(ToolError::InvalidInput(format!(
            "url host {host} is not publicly addressable"
        )));
    }

    Ok(parsed)
}

fn is_private_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    // Block obvious internal TLDs.
    if host.ends_with(".localhost") || host.ends_with(".internal") || host.ends_with(".local") {
        return true;
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => {
                v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || v4.is_broadcast()
                    || v4.is_documentation()
                    || v4.is_unspecified()
                    || v4.octets()[0] == 0
                    // CGNAT 100.64.0.0/10
                    || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xC0) == 0x40)
            }
            IpAddr::V6(v6) => {
                v6.is_loopback()
                    || v6.is_unspecified()
                    // unique local fc00::/7
                    || (v6.segments()[0] & 0xfe00) == 0xfc00
                    // link local fe80::/10
                    || (v6.segments()[0] & 0xffc0) == 0xfe80
            }
        };
    }
    false
}

fn is_permitted_redirect(from: &Url, to: &Url) -> bool {
    // Block downgrade to non-https hops first.
    if to.scheme() != "https" && to.scheme() != "http" {
        return false;
    }
    let from_host = from.host_str().unwrap_or("");
    let to_host = to.host_str().unwrap_or("");
    if from_host.is_empty() || to_host.is_empty() {
        return false;
    }
    if from_host.eq_ignore_ascii_case(to_host) {
        return true;
    }
    // www <-> apex toggle on the same registrable name. Don't blindly trust
    // longest-suffix-match; require one side to be exactly `www.<the_other>`.
    let from_low = from_host.to_ascii_lowercase();
    let to_low = to_host.to_ascii_lowercase();
    if from_low == format!("www.{to_low}") || to_low == format!("www.{from_low}") {
        return true;
    }
    false
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

    #[tokio::test]
    async fn rejects_localhost() {
        let tool = WebFetchTool::new();
        let err = tool
            .execute(json!({ "url": "http://localhost:8080/x" }), &ctx())
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn rejects_private_ipv4() {
        let tool = WebFetchTool::new();
        let err = tool
            .execute(json!({ "url": "https://192.168.0.1/" }), &ctx())
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn rejects_loopback_ipv6() {
        let tool = WebFetchTool::new();
        let err = tool
            .execute(json!({ "url": "https://[::1]/" }), &ctx())
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn rejects_credentials_in_url() {
        let tool = WebFetchTool::new();
        let err = tool
            .execute(
                json!({ "url": "https://user:pass@example.com/" }),
                &ctx(),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn rejects_overlong_url() {
        let tool = WebFetchTool::new();
        let long = format!("https://example.com/{}", "a".repeat(3000));
        let err = tool.execute(json!({ "url": long }), &ctx()).await.unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)), "got {err:?}");
    }

    #[tokio::test]
    async fn rejects_non_http_scheme() {
        let tool = WebFetchTool::new();
        let err = tool
            .execute(json!({ "url": "ftp://example.com/x" }), &ctx())
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)), "got {err:?}");
    }

    #[test]
    fn http_is_upgraded_to_https() {
        let u = validate_and_normalize_url("http://example.com/").unwrap();
        assert_eq!(u.scheme(), "https");
    }

    #[test]
    fn permitted_redirect_same_host() {
        let a = Url::parse("https://a.example.com/x").unwrap();
        let b = Url::parse("https://a.example.com/y").unwrap();
        assert!(is_permitted_redirect(&a, &b));
    }

    #[test]
    fn permitted_redirect_www_toggle() {
        let a = Url::parse("https://example.com/x").unwrap();
        let b = Url::parse("https://www.example.com/x").unwrap();
        assert!(is_permitted_redirect(&a, &b));
        assert!(is_permitted_redirect(&b, &a));
    }

    #[test]
    fn forbidden_redirect_cross_host() {
        let a = Url::parse("https://example.com/x").unwrap();
        let b = Url::parse("https://attacker.com/x").unwrap();
        assert!(!is_permitted_redirect(&a, &b));
    }

    #[test]
    fn html_to_markdown_strips_tags() {
        let md = html2md::parse_html("<h1>Title</h1><p>hello <b>world</b></p>");
        assert!(md.contains("Title"));
        assert!(md.contains("hello"));
        assert!(md.contains("world"));
        assert!(!md.contains("<h1"));
        assert!(!md.contains("<p"));
    }

    #[test]
    fn truncate_marks_long_input() {
        let big = "x".repeat(MAX_MARKDOWN_LEN + 1000);
        let (out, truncated) = truncate_markdown(big);
        assert!(truncated);
        assert_eq!(out.chars().count(), MAX_MARKDOWN_LEN);
    }

    #[test]
    fn truncate_passthrough_short_input() {
        let (out, truncated) = truncate_markdown("short".into());
        assert!(!truncated);
        assert_eq!(out, "short");
    }

    #[test]
    fn classify_content_kinds() {
        assert_eq!(classify_content("text/html; charset=utf-8"), ContentKind::Html);
        assert_eq!(classify_content("application/xhtml+xml"), ContentKind::Html);
        assert_eq!(classify_content("text/plain"), ContentKind::TextLike);
        assert_eq!(classify_content("text/markdown"), ContentKind::TextLike);
        assert_eq!(classify_content(""), ContentKind::TextLike);
        assert_eq!(classify_content("application/pdf"), ContentKind::Unsupported);
        assert_eq!(classify_content("image/png"), ContentKind::Unsupported);
    }

    #[test]
    fn capabilities_are_network_only() {
        let tool = WebFetchTool::new();
        let caps = tool.capabilities();
        assert!(caps.network_access);
        assert!(!caps.writes_filesystem);
        assert!(!caps.executes_commands);
        assert!(tool.is_read_only());
    }
}
