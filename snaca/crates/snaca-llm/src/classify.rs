//! Shared HTTP error classifier for provider clients.
//!
//! Both DeepSeek and Anthropic clients route non-2xx responses through
//! [`classify_http_error`] so the engine sees structured
//! [`LlmError`] variants (`RateLimited`, `ServerTransient`,
//! `AuthExpired`, `ContextOverflow`) instead of an opaque
//! `HttpStatus { status, body }`. The retry wrapper relies on this
//! mapping to decide whether to back off and re-issue the request.

use crate::error::LlmError;
use std::time::Duration;

/// Map a provider's non-2xx HTTP response to a structured [`LlmError`].
///
/// Inputs:
/// - `status` — HTTP status code.
/// - `retry_after_header` — raw `Retry-After` header value if present.
/// - `provider_error_type` — `error.type` field from the provider's
///    parsed error envelope (Anthropic `overloaded_error`,
///    `invalid_request_error`, ...). `None` when the envelope didn't
///    parse.
/// - `provider_error_code` — `error.code` field (DeepSeek-style codes
///    like `rate_limit_exceeded`).
/// - `provider_message` — `error.message` field.
/// - `body` — raw response body for fallback context-overflow detection
///    and `HttpStatus` payload.
///
/// Priority:
/// 1. Context-overflow phrasing wins regardless of status (some
///    providers return 400, some 413, some 429 with quota copy that
///    actually means "prompt too long").
/// 2. Status-code mapping (429/401/403/5xx) — most reliable signal.
/// 3. Envelope-derived overrides for codes the status alone misses
///    (Anthropic `overloaded_error` → ServerTransient).
/// 4. Fall back to `Provider { code, message }` if we have an
///    envelope, else `HttpStatus { status, body }`.
pub fn classify_http_error(
    status: u16,
    retry_after_header: Option<&str>,
    provider_error_type: Option<&str>,
    provider_error_code: Option<&str>,
    provider_message: Option<&str>,
    body: &str,
) -> LlmError {
    let retry_after = parse_retry_after(retry_after_header);

    // (1) Context-overflow phrasing wins regardless of status. Providers
    // are inconsistent: Anthropic uses 400 invalid_request_error with
    // "prompt is too long", DeepSeek returns 400 with
    // "context_length_exceeded" in the body, OpenAI uses
    // "maximum context length" in a 400 envelope.
    if looks_like_context_overflow(provider_message, body) {
        return LlmError::ContextOverflow;
    }

    // (2) Status-code mapping.
    match status {
        429 => return LlmError::RateLimited { retry_after },
        401 | 403 => return LlmError::AuthExpired { status },
        500 | 502 | 503 | 504 | 529 => return LlmError::ServerTransient { status },
        _ => {}
    }

    // (3) Envelope-derived overrides for cases the status missed.
    if let Some(t) = provider_error_type {
        match t {
            "overloaded_error" => return LlmError::ServerTransient { status },
            "rate_limit_error" => return LlmError::RateLimited { retry_after },
            _ => {}
        }
    }
    if let Some(c) = provider_error_code {
        match c {
            "rate_limit_exceeded" => return LlmError::RateLimited { retry_after },
            _ => {}
        }
    }

    // (4) Fallback. Prefer the parsed envelope over the raw body so the
    // user sees a clean "provider error <code>: <msg>" instead of JSON.
    if let Some(msg) = provider_message {
        let code = provider_error_code
            .or(provider_error_type)
            .map(str::to_string)
            .unwrap_or_else(|| status.to_string());
        return LlmError::Provider {
            code,
            message: msg.to_string(),
        };
    }

    LlmError::HttpStatus {
        status,
        body: body.to_string(),
    }
}

/// Parse an HTTP `Retry-After` header value.
///
/// Per RFC 7231 §7.1.3, the value is either:
/// - an integer number of seconds, or
/// - an HTTP-date.
///
/// We accept both. Returns `None` if the value is empty, unparseable,
/// or in the past.
pub(crate) fn parse_retry_after(raw: Option<&str>) -> Option<Duration> {
    let raw = raw?.trim();
    if raw.is_empty() {
        return None;
    }
    // Try integer seconds first (the common case).
    if let Ok(secs) = raw.parse::<u64>() {
        // Clamp to something sane; providers occasionally suggest
        // hours-long backoffs that aren't useful in an interactive
        // agent loop.
        return Some(Duration::from_secs(secs.min(600)));
    }
    // HTTP-date — RFC 1123 / 7231 IMF-fixdate.
    if let Ok(when) = chrono::DateTime::parse_from_rfc2822(raw) {
        let now = chrono::Utc::now();
        let delta = when.with_timezone(&chrono::Utc) - now;
        if delta > chrono::Duration::zero() {
            let secs = delta.num_seconds().min(600).max(0) as u64;
            return Some(Duration::from_secs(secs));
        }
    }
    None
}

/// Heuristic match for "your prompt exceeds the model's context window"
/// across all providers we currently support. The retry wrapper does
/// not retry `ContextOverflow`; the engine's compaction path picks it
/// up instead.
fn looks_like_context_overflow(message: Option<&str>, body: &str) -> bool {
    const HINTS: &[&str] = &[
        "prompt is too long",
        "context_length_exceeded",
        "maximum context length",
        "context window",
        "exceeds the maximum",
        "too many tokens",
        "input length exceeds",
        "string too long",
        "request too large",
    ];
    let haystacks = [message.unwrap_or(""), body];
    for h in haystacks {
        let lower = h.to_ascii_lowercase();
        if HINTS.iter().any(|p| lower.contains(p)) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_after_integer_seconds() {
        assert_eq!(
            parse_retry_after(Some("30")),
            Some(Duration::from_secs(30))
        );
    }

    #[test]
    fn retry_after_clamps_runaway() {
        // 1 hour suggested → clamped to 10 min.
        assert_eq!(
            parse_retry_after(Some("3600")),
            Some(Duration::from_secs(600))
        );
    }

    #[test]
    fn retry_after_empty_or_missing() {
        assert_eq!(parse_retry_after(None), None);
        assert_eq!(parse_retry_after(Some("")), None);
        assert_eq!(parse_retry_after(Some("   ")), None);
    }

    #[test]
    fn classify_429_is_rate_limited() {
        let e = classify_http_error(429, Some("5"), None, None, None, "");
        match e {
            LlmError::RateLimited { retry_after } => {
                assert_eq!(retry_after, Some(Duration::from_secs(5)));
            }
            other => panic!("expected RateLimited, got {:?}", other),
        }
    }

    #[test]
    fn classify_401_is_auth_expired() {
        let e = classify_http_error(401, None, None, None, None, "");
        assert!(matches!(e, LlmError::AuthExpired { status: 401 }));
    }

    #[test]
    fn classify_500_503_529_is_server_transient() {
        for s in [500u16, 502, 503, 504, 529] {
            let e = classify_http_error(s, None, None, None, None, "");
            assert!(
                matches!(e, LlmError::ServerTransient { status } if status == s),
                "expected ServerTransient({}), got {:?}",
                s,
                e
            );
        }
    }

    #[test]
    fn anthropic_overloaded_envelope_is_server_transient() {
        // Anthropic occasionally returns 200 with overloaded_error in
        // the streaming body, and 529 in some regions. Make sure the
        // envelope override kicks in even if the status didn't match.
        let e = classify_http_error(
            200,
            None,
            Some("overloaded_error"),
            None,
            Some("Overloaded"),
            "",
        );
        assert!(matches!(e, LlmError::ServerTransient { .. }));
    }

    #[test]
    fn deepseek_rate_limit_envelope_is_rate_limited() {
        let e = classify_http_error(
            400,
            Some("10"),
            None,
            Some("rate_limit_exceeded"),
            Some("Rate limit reached"),
            "",
        );
        match e {
            LlmError::RateLimited { retry_after } => {
                assert_eq!(retry_after, Some(Duration::from_secs(10)));
            }
            other => panic!("expected RateLimited, got {:?}", other),
        }
    }

    #[test]
    fn prompt_too_long_wins_over_400() {
        let e = classify_http_error(
            400,
            None,
            Some("invalid_request_error"),
            None,
            Some("prompt is too long: 200000 tokens > 200000 maximum"),
            "",
        );
        assert!(matches!(e, LlmError::ContextOverflow));
    }

    #[test]
    fn deepseek_context_length_in_body_wins() {
        let e = classify_http_error(
            400,
            None,
            None,
            None,
            None,
            r#"{"error":{"message":"This model's maximum context length is 128000 tokens (context_length_exceeded)."}}"#,
        );
        assert!(matches!(e, LlmError::ContextOverflow));
    }

    #[test]
    fn unknown_4xx_falls_back_to_provider_envelope() {
        let e = classify_http_error(
            418,
            None,
            Some("teapot"),
            None,
            Some("I am a teapot"),
            "",
        );
        match e {
            LlmError::Provider { code, message } => {
                assert_eq!(code, "teapot");
                assert_eq!(message, "I am a teapot");
            }
            other => panic!("expected Provider, got {:?}", other),
        }
    }

    #[test]
    fn unknown_4xx_without_envelope_falls_back_to_http_status() {
        let e = classify_http_error(418, None, None, None, None, "raw body");
        match e {
            LlmError::HttpStatus { status, body } => {
                assert_eq!(status, 418);
                assert_eq!(body, "raw body");
            }
            other => panic!("expected HttpStatus, got {:?}", other),
        }
    }
}
