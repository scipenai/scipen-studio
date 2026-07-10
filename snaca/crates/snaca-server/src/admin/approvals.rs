//! `/api/v1/approvals` — list + delete persisted approval decisions.
//!
//! `decision = "allow"|"deny"` for the `(tenant, project, tool, input_signature)`
//! tuple. The catch-all row uses `input_signature = ""`. Listing is
//! tenant/project filterable; delete takes the same key as a query.

use crate::runtime::AppState;
use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use snaca_core::{ProjectId, TenantId};
use std::sync::Arc;

#[derive(Deserialize)]
pub struct ListQuery {
    pub tenant: Option<String>,
    pub project: Option<String>,
}

#[derive(Serialize)]
pub struct DecisionDto {
    pub tenant_id: String,
    pub project_id: String,
    pub tool_name: String,
    pub input_signature: String,
    pub decision: &'static str,
    pub decided_at: String,
}

pub async fn list(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ListQuery>,
) -> impl IntoResponse {
    let tenant = q.tenant.map(TenantId::new);
    let project = q.project.map(ProjectId::from_raw);
    let result = state
        .db
        .list_decisions(tenant.as_ref(), project.as_ref())
        .await;
    match result {
        Ok(rows) => {
            let rows: Vec<DecisionDto> = rows
                .into_iter()
                .map(|d| DecisionDto {
                    tenant_id: d.tenant_id.as_str().to_string(),
                    project_id: d.project_id.as_str().to_string(),
                    tool_name: d.tool_name,
                    input_signature: d.input_signature,
                    decision: d.decision.as_str(),
                    decided_at: d.decided_at.to_rfc3339(),
                })
                .collect();
            Json(serde_json::json!({"decisions": rows})).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
pub struct DeleteQuery {
    pub tenant: String,
    pub project: String,
    pub tool: String,
    #[serde(default)]
    pub input_signature: String,
}

pub async fn delete(
    State(state): State<Arc<AppState>>,
    Query(q): Query<DeleteQuery>,
) -> impl IntoResponse {
    let tenant = TenantId::new(q.tenant);
    let project = ProjectId::from_raw(q.project);
    match state
        .db
        .forget_decision(&tenant, &project, &q.tool, &q.input_signature)
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}
