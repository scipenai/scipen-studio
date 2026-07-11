//! `composer.start` + `plan.confirm` — Ctrl+I multi-file agent.

use crate::types::context::{ChatContext, Mention};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComposerStartParams {
    pub session_id: String,
    pub thread_id: String,
    pub instruction: String,
    #[serde(default)]
    pub mentions: Vec<Mention>,
    pub context: ChatContext,
    pub mode: ComposerMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<ComposerScope>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComposerMode {
    /// Emit `plan.update { awaiting: true }` and wait for `plan.confirm`.
    PlanFirst,
    /// Skip the plan-confirmation roundtrip, jump straight to edits.
    Immediate,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComposerScope {
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComposerStartResult {
    pub turn_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanConfirmParams {
    pub turn_id: String,
    pub decision: PlanDecision,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modifications: Option<PlanModifications>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanDecision {
    Accept,
    Reject,
    Modify,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct PlanModifications {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub add_files: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub remove_files: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlanConfirmResult {
    pub ok: bool,
}
