//! Bearer-token middleware for `/api/v1/*`.
//!
//! The token is compared with [`subtle::ConstantTimeEq`] so an attacker
//! can't distinguish "wrong length" from "wrong content" by timing the
//! request. When `[admin].enabled = false` we treat every API request
//! as a 503 — the surface is gated behind explicit operator opt-in;
//! silently allowing through unauthenticated traffic if someone forgot
//! to set a token would be the worst-case footgun.

use crate::runtime::AppState;
use axum::{
    body::Body,
    extract::State,
    http::{header, Method, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use std::sync::Arc;
use subtle::ConstantTimeEq;

const BEARER_PREFIX: &str = "Bearer ";

pub async fn require_token(
    State(state): State<Arc<AppState>>,
    req: Request<Body>,
    next: Next,
) -> Response {
    // Let CORS preflights through unauthenticated — the browser strips
    // custom headers (Authorization) from preflights by design.
    if req.method() == Method::OPTIONS {
        return next.run(req).await;
    }
    let configured = match state.admin_token.as_deref() {
        Some(t) if !t.is_empty() => t,
        _ => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(serde_json::json!({
                    "error": "admin api disabled; set [admin].enabled = true and restart",
                })),
            )
                .into_response();
        }
    };

    let provided = extract_token(&req).unwrap_or_default();
    let ok: bool = provided.as_bytes().ct_eq(configured.as_bytes()).unwrap_u8() == 1;
    if !ok {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "invalid or missing bearer token"})),
        )
            .into_response();
    }
    next.run(req).await
}

/// Try header first (`Authorization: Bearer …`), fall back to `?token=`
/// query param so users can paste the auto-login URL straight from the
/// startup log — same affordance cc-connect's admin UI offers.
fn extract_token(req: &Request<Body>) -> Option<String> {
    if let Some(h) = req.headers().get(header::AUTHORIZATION) {
        if let Ok(s) = h.to_str() {
            if let Some(stripped) = s.strip_prefix(BEARER_PREFIX) {
                return Some(stripped.trim().to_string());
            }
        }
    }
    // Query string fallback.
    if let Some(q) = req.uri().query() {
        for pair in q.split('&') {
            let mut it = pair.splitn(2, '=');
            let k = it.next()?;
            if k == "token" {
                let v = it.next().unwrap_or("");
                // Lightweight percent-decode for the common cases — `+`
                // and `%XX`. Pulls no extra crate; the fallback path is
                // for human-friendly URLs, not arbitrary binary tokens.
                return Some(percent_decode(v));
            }
        }
    }
    None
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let h = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2]));
                if let (Some(a), Some(b)) = h {
                    out.push((a << 4) | b);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_default()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}
