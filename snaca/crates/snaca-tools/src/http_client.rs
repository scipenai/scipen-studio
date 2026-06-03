//! HTTP client construction shared by network-touching tools.
//!
//! Returns a `ClientBuilder` (not a built `Client`) so callers can layer
//! tool-specific options like `WebFetch`'s redirect policy before
//! finalising. The `name` argument lands in the User-Agent string —
//! `snaca-<name>/<crate-version>` — so server logs can attribute
//! requests to the originating tool.

use std::time::Duration;

pub fn snaca_http_client_builder(name: &str, timeout: Duration) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .timeout(timeout)
        .user_agent(format!("snaca-{}/{}", name, env!("CARGO_PKG_VERSION")))
}
