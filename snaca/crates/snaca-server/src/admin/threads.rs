//! `/api/v1/{tenants,projects,threads}` — read-only browsing of the
//! state DB plus an idempotent `abort` endpoint that piggy-backs on
//! [`snaca_engine::Engine::abort_thread`].

use crate::runtime::AppState;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use snaca_core::{ContentBlock, MessageId, ProjectId, Role, TenantId, ThreadId};
use std::sync::Arc;

pub async fn list_tenants(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    match state.db.list_tenants().await {
        Ok(tenants) => {
            let tenants: Vec<String> = tenants
                .into_iter()
                .map(|t| t.as_str().to_string())
                .collect();
            Json(serde_json::json!({"tenants": tenants})).into_response()
        }
        Err(e) => internal_err(e),
    }
}

pub async fn list_projects(
    State(state): State<Arc<AppState>>,
    Path(tenant): Path<String>,
) -> impl IntoResponse {
    let tid = TenantId::new(tenant);
    match state.db.list_projects_for_tenant(&tid).await {
        Ok(projects) => {
            let projects: Vec<String> = projects
                .into_iter()
                .map(|p| p.as_str().to_string())
                .collect();
            Json(serde_json::json!({"projects": projects})).into_response()
        }
        Err(e) => internal_err(e),
    }
}

#[derive(Serialize)]
pub struct ThreadSummary {
    pub id: String,
    pub tenant_id: String,
    pub project_id: String,
    pub created_at: String,
}

pub async fn list_threads(
    State(state): State<Arc<AppState>>,
    Path((tenant, project)): Path<(String, String)>,
) -> impl IntoResponse {
    let tid = TenantId::new(tenant);
    let pid = ProjectId::from_raw(project);
    match state.db.list_threads_for_project(&tid, &pid).await {
        Ok(threads) => {
            let threads: Vec<ThreadSummary> = threads
                .into_iter()
                .map(|t| ThreadSummary {
                    id: t.id.as_str().to_string(),
                    tenant_id: t.tenant_id.as_str().to_string(),
                    project_id: t.project_id.as_str().to_string(),
                    created_at: t.created_at.to_rfc3339(),
                })
                .collect();
            Json(serde_json::json!({"threads": threads})).into_response()
        }
        Err(e) => internal_err(e),
    }
}

#[derive(Deserialize)]
pub struct MessagesQuery {
    /// Max rows to return. Defaults to 50; capped at 500 server-side.
    #[serde(default)]
    pub limit: Option<u32>,
    /// Optional cursor: only return messages older than this id (use the
    /// `id` of the oldest message in the previous page).
    #[serde(default)]
    pub before: Option<String>,
}

#[derive(Serialize)]
pub struct MessageDto {
    pub id: String,
    pub thread_id: String,
    pub session_id: String,
    pub role: &'static str,
    pub content: Vec<ContentBlock>,
    pub created_at: String,
}

pub async fn list_messages(
    State(state): State<Arc<AppState>>,
    Path(thread_id): Path<String>,
    Query(q): Query<MessagesQuery>,
) -> impl IntoResponse {
    let tid = ThreadId::new(thread_id);
    let limit = q.limit.unwrap_or(50).min(500);
    let result = match q.before.as_deref() {
        Some(cursor) => match uuid::Uuid::parse_str(cursor) {
            Ok(uuid) => {
                let cut = MessageId::from_uuid(uuid);
                state.db.messages_before(&tid, &cut, limit).await
            }
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": "invalid `before` cursor"})),
                )
                    .into_response();
            }
        },
        None => state.db.recent_messages(&tid, limit).await,
    };
    match result {
        Ok(rows) => {
            let messages: Vec<MessageDto> = rows
                .into_iter()
                .map(|m| MessageDto {
                    id: m.id.to_string(),
                    thread_id: m.thread_id.as_str().to_string(),
                    session_id: m.session_id.to_string(),
                    role: role_str(m.role),
                    content: m.content,
                    created_at: m.created_at.to_rfc3339(),
                })
                .collect();
            Json(serde_json::json!({"messages": messages})).into_response()
        }
        Err(e) => internal_err(e),
    }
}

pub async fn abort(
    State(state): State<Arc<AppState>>,
    Path(thread_id): Path<String>,
) -> impl IntoResponse {
    let count = state.engine.abort_thread(&ThreadId::new(thread_id));
    Json(serde_json::json!({"aborted": count > 0, "count": count}))
}

fn role_str(r: Role) -> &'static str {
    match r {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}

fn internal_err(e: impl std::fmt::Display) -> axum::response::Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(serde_json::json!({"error": e.to_string()})),
    )
        .into_response()
}
