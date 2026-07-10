//! `/api/v1/plugins` — list + reload. Thin wrapper around
//! [`crate::PluginRegistry`]; the heavy lifting (graceful shutdown +
//! respawn) is the registry's job.

use crate::runtime::AppState;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use std::sync::Arc;

pub async fn list(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let statuses = state.plugins.list_status().await;
    Json(serde_json::json!({"plugins": statuses}))
}

pub async fn reload(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
) -> impl IntoResponse {
    match state.plugins.reload(&name).await {
        Ok(status) => (
            StatusCode::OK,
            Json(serde_json::json!({"status": "reloaded", "plugin": status})),
        )
            .into_response(),
        Err(e) => {
            let msg = e.to_string();
            let code = if msg.contains("not registered") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            (code, Json(serde_json::json!({"error": msg}))).into_response()
        }
    }
}
