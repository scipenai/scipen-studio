//! `/api/v1/outbox` — read pending/failed/delivered rows, plus a
//! force-retry escape hatch for the operator.

use crate::runtime::AppState;
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use snaca_state::OutboxStatus;
use std::sync::Arc;

#[derive(Deserialize)]
pub struct ListQuery {
    /// "pending" | "delivered" | "failed" — unset = all.
    pub status: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Serialize)]
pub struct OutboxDto {
    pub id: String,
    pub plugin: String,
    pub tenant_id: String,
    pub chat_id: String,
    pub kind: &'static str,
    pub attempts: u32,
    pub next_attempt_at: String,
    pub status: &'static str,
    pub last_error: Option<String>,
    pub platform_message_id: Option<String>,
    pub created_at: String,
    pub delivered_at: Option<String>,
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ListQuery>,
) -> impl IntoResponse {
    let limit = q.limit.unwrap_or(100).min(500);
    let status = match q.status.as_deref() {
        Some(s) => match OutboxStatus::parse(s) {
            Some(parsed) => Some(parsed),
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "error": format!("unknown status {s:?}; expected pending|delivered|failed"),
                    })),
                )
                    .into_response();
            }
        },
        None => None,
    };
    match state.db.list_outbox(status, limit).await {
        Ok(rows) => {
            let rows: Vec<OutboxDto> = rows
                .into_iter()
                .map(|r| OutboxDto {
                    id: r.id,
                    plugin: r.plugin,
                    tenant_id: r.tenant_id,
                    chat_id: r.chat_id,
                    kind: r.kind.as_str(),
                    attempts: r.attempts,
                    next_attempt_at: r.next_attempt_at.to_rfc3339(),
                    status: r.status.as_str(),
                    last_error: r.last_error,
                    platform_message_id: r.platform_message_id,
                    created_at: r.created_at.to_rfc3339(),
                    delivered_at: r.delivered_at.map(|d| d.to_rfc3339()),
                })
                .collect();
            Json(serde_json::json!({"outbox": rows})).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

pub async fn retry(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    match state.db.outbox_force_retry(&id).await {
        Ok(true) => Json(serde_json::json!({"id": id, "requeued": true})).into_response(),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "outbox row not found"})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}
