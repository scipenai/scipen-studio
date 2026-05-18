//! `tool.approval_request` (SNACA→host notification) and
//! `tool.confirm` (host→SNACA request).

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolApprovalRequestParams {
    pub tool_call_id: String,
    pub turn_id: String,
    /// E.g. `"Bash"`, `"mcp__filesystem__delete"`.
    pub tool: String,
    pub args: Value,
    /// One-line human summary for the approval card.
    pub summary: String,
    pub risk: RiskLevel,
    /// What to apply if host times out (recommend `Deny`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_decision: Option<DefaultDecision>,
    /// Auto-decide threshold. Defaults to 300s when omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DefaultDecision {
    Allow,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolConfirmParams {
    pub tool_call_id: String,
    pub decision: ToolDecision,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolDecision {
    Allow,
    Deny,
    AllowAlways,
    DenyAlways,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolConfirmResult {
    pub ok: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decision_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&ToolDecision::AllowAlways).unwrap(),
            "\"allow_always\""
        );
    }
}
