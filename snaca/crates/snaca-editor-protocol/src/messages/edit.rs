//! `edit.propose` / `edit.propose_delta` / `edit.propose_complete` (notifications)
//! plus `edit.confirm` (host → SNACA request).

use crate::types::LineHunk;
use serde::{Deserialize, Serialize};

// --------- SNACA → host: propose ---------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EditProposeParams {
    pub proposal_id: String,
    pub turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    pub file: String,
    /// SHA-256 hex of the file content SNACA saw before computing the edit.
    pub base_hash: String,
    /// When `streaming = true`, hunks may be empty or contain prefix
    /// `new_text` that `edit.propose_delta` will extend.
    pub hunks: Vec<LineHunk>,
    pub streaming: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// Optional, expected post-apply hash. Helps host self-check.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_post_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EditProposeDeltaParams {
    pub proposal_id: String,
    pub hunk_id: String,
    pub append_text: String,
    /// Marks this hunk as finished (no more deltas for it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub done: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EditProposeCompleteParams {
    pub proposal_id: String,
    /// Authoritative hunks. Host should use these for the final Diff Review
    /// once streaming is over.
    pub final_hunks: Vec<LineHunk>,
}

// --------- host → SNACA: confirm ---------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EditConfirmParams {
    pub proposal_id: String,
    pub decision: EditDecision,
    /// Required iff `decision = AcceptPartial`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_hunk: Option<Vec<PerHunkDecision>>,
    /// Optional user-edited replacement text for individual hunks (the user
    /// accepted-with-modification path).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified_text: Option<Vec<HunkModifiedText>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditDecision {
    Accept,
    Reject,
    AcceptPartial,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PerHunkDecision {
    pub hunk_id: String,
    pub decision: PerHunkChoice,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PerHunkChoice {
    Accept,
    Reject,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HunkModifiedText {
    pub hunk_id: String,
    pub new_text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EditConfirmResult {
    pub applied: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub errors: Option<Vec<HunkError>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HunkError {
    pub hunk_id: String,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Position, Range};

    #[test]
    fn confirm_accept_skips_per_hunk() {
        let p = EditConfirmParams {
            proposal_id: "p-1".into(),
            decision: EditDecision::Accept,
            per_hunk: None,
            modified_text: None,
        };
        let s = serde_json::to_string(&p).unwrap();
        assert!(!s.contains("per_hunk"));
        assert!(!s.contains("modified_text"));
    }

    #[test]
    fn propose_roundtrips() {
        let p = EditProposeParams {
            proposal_id: "p-1".into(),
            turn_id: "tu-1".into(),
            tool_call_id: Some("tc-1".into()),
            file: "/p/a.tex".into(),
            base_hash: "abc".into(),
            hunks: vec![LineHunk::new(
                "h0",
                Range::new(Position::new(0, 0), Position::new(0, 5)),
                "hello",
                "Hi",
            )],
            streaming: false,
            summary: Some("trim".into()),
            expected_post_hash: None,
        };
        let s = serde_json::to_string(&p).unwrap();
        let back: EditProposeParams = serde_json::from_str(&s).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn decision_snake_case() {
        assert_eq!(
            serde_json::to_string(&EditDecision::AcceptPartial).unwrap(),
            "\"accept_partial\""
        );
    }
}
