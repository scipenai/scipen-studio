//! Read-only system snapshot for the admin Dashboard page.

use crate::{config::Config, runtime::AppState};
use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Serialize)]
pub struct StatusResponse {
    pub version: &'static str,
    pub uptime_seconds: u64,
    pub started_at: String,
    pub tenant_id: String,
    pub llm_provider: String,
    pub llm_model: String,
    pub plugin_count: usize,
    pub mcp_server_count: usize,
}

pub async fn status(State(state): State<Arc<AppState>>) -> Json<StatusResponse> {
    let uptime = state.started_at.elapsed().as_secs();
    let plugin_count = state.plugins.list_status().await.len();
    Json(StatusResponse {
        version: env!("CARGO_PKG_VERSION"),
        uptime_seconds: uptime,
        started_at: state.started_at_wall.to_rfc3339(),
        tenant_id: state.config_snapshot.tenant_id.clone(),
        llm_provider: state.config_snapshot.llm_provider.clone(),
        llm_model: state.config_snapshot.llm_model.clone(),
        plugin_count,
        mcp_server_count: state.config_snapshot.mcp_server_count,
    })
}

/// Read-only snapshot of `[server]`, `[tenant]`, `[llm]`, `[engine]`,
/// `[[plugins]]`, `[[mcp]]`. Secrets (`api_key`, plugin env vars) are
/// redacted — the operator can see *that* a key is set, not what it is.
pub async fn config(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    Json(state.config_snapshot.redacted_json.clone())
}

#[derive(Serialize)]
pub struct ConfigFileResponse {
    pub path: String,
    pub toml: String,
    /// `true` when the on-disk config has diverged from the bytes this
    /// process booted with — a save is persisted but not yet applied, so
    /// the UI can keep showing a restart-pending hint across reloads.
    pub restart_required: bool,
}

#[derive(Deserialize)]
pub struct UpdateConfigFileRequest {
    pub toml: String,
}

#[derive(Serialize)]
pub struct UpdateConfigFileResponse {
    pub path: String,
    pub restart_required: bool,
}

pub async fn config_file(State(state): State<Arc<AppState>>) -> Response {
    let Some(path) = state.config_path.as_ref() else {
        return config_path_missing();
    };
    match tokio::fs::read_to_string(path).await {
        Ok(toml) => {
            // A restart is pending when the live file has diverged from the
            // bytes this process booted with — e.g. a prior PUT was saved
            // but not yet applied. Without a boot snapshot (in-memory test
            // runtimes) we can't tell, so we conservatively report false.
            let restart_required = state
                .startup_config_toml
                .as_ref()
                .map(|startup| startup != &toml)
                .unwrap_or(false);
            Json(ConfigFileResponse {
                path: path.display().to_string(),
                toml,
                restart_required,
            })
            .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("reading config file failed: {e}"),
            })),
        )
            .into_response(),
    }
}

pub async fn update_config_file(
    State(state): State<Arc<AppState>>,
    Json(req): Json<UpdateConfigFileRequest>,
) -> Response {
    let Some(path) = state.config_path.as_ref() else {
        return config_path_missing();
    };
    if let Err(e) = Config::validate_for_write(&req.toml, path) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": format!("config validation failed: {e:#}"),
            })),
        )
            .into_response();
    }
    match write_config_atomically(path, &req.toml).await {
        Ok(()) => Json(UpdateConfigFileResponse {
            path: path.display().to_string(),
            restart_required: true,
        })
        .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": format!("writing config file failed: {e}"),
            })),
        )
            .into_response(),
    }
}

fn config_path_missing() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({
            "error": "config file path is unavailable for this runtime",
        })),
    )
        .into_response()
}

async fn write_config_atomically(path: &std::path::Path, toml: &str) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("snaca.toml");
    let tmp = parent.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));

    if let Err(e) = tokio::fs::write(&tmp, toml).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    if let Err(e) = tokio::fs::rename(&tmp, path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    Ok(())
}
