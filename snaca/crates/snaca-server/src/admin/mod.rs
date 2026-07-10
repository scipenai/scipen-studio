//! Admin web surface: `/api/v1/*` REST endpoints plus an embedded SPA
//! served at every non-API path.
//!
//! Split out of `runtime.rs` so the handler set can grow without that
//! file ballooning. Each submodule owns one resource type and its
//! handlers; [`router`] is the only function the runtime calls.
//!
//! ## Auth
//!
//! Every `/api/v1/*` route requires a `Bearer` token matching
//! `config.admin.token`. The token is generated on first start when
//! `[admin].enabled = true` — see [`crate::config::Config::ensure_admin_token`].
//! `/healthz` and the legacy `/admin/*` routes stay unauthenticated for
//! backwards compatibility with `snaca admin` CLI calls.
//!
//! ## SPA fallback
//!
//! Production builds embed `web/dist/` via `rust-embed` and serve those
//! files at every unmatched path; missing paths fall through to
//! `index.html` so React Router can take over (`/threads`, `/plugins`,
//! …). When the SPA hasn't been built ([`Assets::get("index.html")`]
//! returns `None`) we return a friendly 404 explaining how to build it.

pub mod approvals;
pub mod auth;
pub mod dashboard;
pub mod outbox;
pub mod plugins;
pub mod schedules;
pub mod system;
pub mod threads;
pub mod web;

use crate::runtime::AppState;
use axum::{
    middleware,
    routing::{delete, get, patch, post},
    Router,
};
use std::sync::Arc;

/// Build the `/api/v1` subtree. Returned router is *not yet wrapped* in
/// auth — the caller (runtime) layers `auth::require_token` so that
/// `OPTIONS` preflights and the unauthenticated `/healthz` can sit at
/// the same axum level without going through the auth middleware.
pub fn router(state: Arc<AppState>) -> Router<Arc<AppState>> {
    Router::new()
        // Dashboard
        .route("/status", get(dashboard::status))
        .route("/config", get(dashboard::config))
        .route(
            "/config/file",
            get(dashboard::config_file).put(dashboard::update_config_file),
        )
        .route("/system/shutdown", post(system::shutdown))
        // Plugins
        .route("/plugins", get(plugins::list))
        .route("/plugins/{name}/reload", post(plugins::reload))
        // Threads / messages
        .route("/tenants", get(threads::list_tenants))
        .route("/tenants/{tenant}/projects", get(threads::list_projects))
        .route(
            "/projects/{tenant}/{project}/threads",
            get(threads::list_threads),
        )
        .route("/threads/{id}/messages", get(threads::list_messages))
        .route("/threads/{id}/abort", post(threads::abort))
        // Approvals
        .route("/approvals", get(approvals::list))
        .route("/approvals", delete(approvals::delete))
        // Schedules
        .route("/schedules", get(schedules::list).post(schedules::create))
        .route("/schedules/{id}", delete(schedules::delete))
        .route("/schedules/{id}/enabled", patch(schedules::set_enabled))
        // Outbox
        .route("/outbox", get(outbox::list))
        .route("/outbox/{id}/retry", post(outbox::retry))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_token,
        ))
}
