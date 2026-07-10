//! Embedded SPA fallback. Anything not matched by `/api/v1/*`,
//! `/admin/*`, or `/healthz` hits this handler. We look up the request
//! path against `web/dist/`; misses fall through to `index.html` so
//! client-side routing (`/threads`, `/plugins`, …) works on hard reloads.
//!
//! Two build-time modes (default `rust-embed` behaviour):
//! - **debug**: reads `web/dist/` from disk at request time, so a
//!   `npm run build && cargo run` cycle iterates the SPA without
//!   recompiling Rust.
//! - **release**: embeds bytes into the binary. `cargo build --release`
//!   without a prior `npm run build` produces a binary that returns a
//!   "SPA not built" notice from this handler.

use axum::{
    body::Body,
    http::{header, HeaderValue, Response, StatusCode, Uri},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/../../web/dist/"]
struct Assets;

pub async fn serve(uri: Uri) -> Response<Body> {
    let raw_path = uri.path().trim_start_matches('/');
    let path = if raw_path.is_empty() {
        "index.html".to_string()
    } else {
        raw_path.to_string()
    };

    if let Some(content) = Assets::get(&path) {
        return ok(&path, content.data.into_owned());
    }
    // SPA fallback. React Router uses history mode, so /threads,
    // /plugins, /login etc. only exist client-side. Serve index.html
    // for any path that doesn't look like a static asset and let the
    // SPA route.
    if !is_asset_path(&path) {
        if let Some(content) = Assets::get("index.html") {
            return ok("index.html", content.data.into_owned());
        }
    }
    spa_missing_response(&path)
}

fn ok(path: &str, bytes: Vec<u8>) -> Response<Body> {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    let mut resp = Response::new(Body::from(bytes));
    *resp.status_mut() = StatusCode::OK;
    if let Ok(value) = HeaderValue::from_str(mime.as_ref()) {
        resp.headers_mut().insert(header::CONTENT_TYPE, value);
    }
    // index.html should never be cached — its <script src> hashes change
    // on every build, but the entrypoint URL doesn't.
    let cache_control = if path == "index.html" {
        "no-cache, no-store, must-revalidate"
    } else if path.starts_with("assets/") {
        // Vite emits content-hashed filenames under /assets/, so they
        // can be cached aggressively.
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    resp.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control),
    );
    resp
}

fn is_asset_path(path: &str) -> bool {
    // Heuristic: an "asset" has a file extension that we don't want to
    // mask with index.html. Otherwise it's an SPA route.
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .is_some()
}

fn spa_missing_response(path: &str) -> Response<Body> {
    let body = serde_json::json!({
        "error": "admin SPA not built; run `npm --prefix web ci && npm --prefix web run build` then restart",
        "path": path,
    });
    let mut resp = Response::new(Body::from(body.to_string()));
    *resp.status_mut() = StatusCode::NOT_FOUND;
    resp.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    resp
}
