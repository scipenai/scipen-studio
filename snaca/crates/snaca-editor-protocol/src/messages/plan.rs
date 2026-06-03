//! `plan.update` — Composer plan events.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanUpdateParams {
    pub turn_id: String,
    /// When `true`, host MUST wait for `plan.confirm` before SNACA proceeds.
    pub awaiting: bool,
    pub files: Vec<PlanFile>,
    pub rationale: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanFile {
    pub path: String,
    pub action: PlanFileAction,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rename_to: Option<String>,
    pub summary: String,
    pub status: PlanFileStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanFileAction {
    Create,
    Modify,
    Delete,
    Rename,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanFileStatus {
    Pending,
    InProgress,
    Done,
    Rejected,
    Failed,
}
