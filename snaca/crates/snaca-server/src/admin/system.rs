//! `/api/v1/system/*` — process-level admin actions.

use crate::runtime::AppState;
use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::Serialize;
use std::sync::Arc;

#[derive(Serialize)]
pub struct ShutdownResponse {
    pub accepted: bool,
    pub reason: &'static str,
}

pub async fn shutdown(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let _ = state.admin_shutdown_tx.send(true);
    (
        StatusCode::ACCEPTED,
        Json(ShutdownResponse {
            accepted: true,
            reason: "admin_request",
        }),
    )
}
