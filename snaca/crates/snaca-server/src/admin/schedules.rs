//! `/api/v1/schedules` — create + read + toggle + delete scheduled tasks.

use crate::runtime::AppState;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use snaca_core::{ProjectId, TenantId};
use snaca_state::{NewScheduledTask, ScheduledTask};
use std::sync::Arc;

#[derive(Deserialize)]
pub struct ListQuery {
    #[serde(default)]
    pub enabled_only: bool,
}

#[derive(Serialize)]
pub struct ScheduledTaskDto {
    pub id: String,
    pub tenant_id: String,
    pub project_id: String,
    pub chat_id: String,
    pub plugin: String,
    pub prompt: String,
    pub interval_secs: Option<i64>,
    pub next_fire_at: String,
    pub last_fired_at: Option<String>,
    pub enabled: bool,
    pub created_at: String,
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ListQuery>,
) -> impl IntoResponse {
    match state.db.list_all_scheduled_tasks(q.enabled_only).await {
        Ok(rows) => {
            let rows: Vec<ScheduledTaskDto> = rows.into_iter().map(task_to_dto).collect();
            Json(serde_json::json!({"schedules": rows})).into_response()
        }
        Err(e) => internal_err(e),
    }
}

#[derive(Deserialize)]
pub struct CreateScheduleBody {
    pub tenant_id: String,
    pub project_id: String,
    pub chat_id: String,
    pub plugin: String,
    pub prompt: String,
    #[serde(default)]
    pub interval_secs: Option<i64>,
    pub next_fire_at: String,
}

pub async fn create(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateScheduleBody>,
) -> impl IntoResponse {
    let tenant = body.tenant_id.trim();
    let project = body.project_id.trim();
    let chat = body.chat_id.trim();
    let plugin = body.plugin.trim();
    let prompt = body.prompt.trim();
    if tenant.is_empty()
        || project.is_empty()
        || chat.is_empty()
        || plugin.is_empty()
        || prompt.is_empty()
    {
        return bad_request("tenant_id, project_id, chat_id, plugin, and prompt must be non-empty");
    }
    if matches!(body.interval_secs, Some(secs) if secs <= 0) {
        return bad_request("interval_secs must be positive when set");
    }
    let next_fire_at = match DateTime::parse_from_rfc3339(body.next_fire_at.trim()) {
        Ok(dt) => dt.with_timezone(&Utc),
        Err(e) => return bad_request(format!("next_fire_at must be RFC3339: {e}")),
    };
    let new_task = NewScheduledTask {
        tenant_id: TenantId::new(tenant.to_string()),
        project_id: ProjectId::from_raw(project.to_string()),
        chat_id: chat.to_string(),
        plugin: plugin.to_string(),
        prompt: prompt.to_string(),
        interval_secs: body.interval_secs,
        next_fire_at,
    };
    match state.db.schedule_task(&new_task).await {
        Ok(task) => (StatusCode::CREATED, Json(task_to_dto(task))).into_response(),
        Err(e) => internal_err(e),
    }
}

#[derive(Deserialize)]
pub struct EnabledBody {
    pub enabled: bool,
}

pub async fn set_enabled(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<EnabledBody>,
) -> impl IntoResponse {
    match state.db.set_scheduled_task_enabled(&id, body.enabled).await {
        Ok(()) => Json(serde_json::json!({"id": id, "enabled": body.enabled})).into_response(),
        Err(e) => internal_err(e),
    }
}

pub async fn delete(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.db.delete_scheduled_task(&id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => internal_err(e),
    }
}

fn internal_err(e: impl std::fmt::Display) -> axum::response::Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({"error": e.to_string()})),
    )
        .into_response()
}

fn bad_request(message: impl std::fmt::Display) -> axum::response::Response {
    (
        StatusCode::BAD_REQUEST,
        Json(serde_json::json!({"error": message.to_string()})),
    )
        .into_response()
}

fn task_to_dto(t: ScheduledTask) -> ScheduledTaskDto {
    ScheduledTaskDto {
        id: t.id,
        tenant_id: t.tenant_id.as_str().to_string(),
        project_id: t.project_id.as_str().to_string(),
        chat_id: t.chat_id,
        plugin: t.plugin,
        prompt: t.prompt,
        interval_secs: t.interval_secs,
        next_fire_at: t.next_fire_at.to_rfc3339(),
        last_fired_at: t.last_fired_at.map(|d| d.to_rfc3339()),
        enabled: t.enabled,
        created_at: t.created_at.to_rfc3339(),
    }
}
