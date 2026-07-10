//! Approval gating — decides whether a tool call may run.
//!
//! Runtimes consult an [`ApprovalGate`] before invoking a tool whose approval
//! policy requires user or deployment confirmation. The gate is supplied by
//! the embedding application, so the core runtime does not need to know
//! whether approval happens through IM cards, a local UI, logs, or tests.

use async_trait::async_trait;
use serde_json::Value;
use snaca_core::{ProjectId, TenantId};
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct ApprovalRequest {
    pub tenant_id: TenantId,
    pub project_id: ProjectId,
    /// Tool name as registered, for example `"Bash"` or
    /// `"mcp__filesystem__read_file"`.
    pub tool_name: String,
    /// The exact input the runtime is about to forward to the tool.
    pub tool_input: Value,
    /// Human-readable description the gate can show to the user.
    pub reason: String,
}

/// User decision on a single approval prompt.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ApprovalDecision {
    /// Allow this exact call. Do not remember; ask again next time.
    #[default]
    AllowOnce,
    /// Allow this call and remember it for the project.
    AllowAlways,
    /// Reject this call.
    Deny,
}

impl ApprovalDecision {
    pub fn is_allow(self) -> bool {
        matches!(
            self,
            ApprovalDecision::AllowOnce | ApprovalDecision::AllowAlways
        )
    }
}

#[derive(Debug, Error)]
pub enum ApprovalError {
    #[error("approval timed out")]
    Timeout,

    #[error("approval channel closed before a decision was made")]
    Cancelled,

    #[error("approval gate failed: {0}")]
    Other(String),
}

#[async_trait]
pub trait ApprovalGate: Send + Sync {
    async fn request(&self, request: ApprovalRequest) -> Result<ApprovalDecision, ApprovalError>;
}

/// Approves every request. Used by tests and by deployments that already gate
/// tool selection upstream.
pub struct NoopApprovalGate;

#[async_trait]
impl ApprovalGate for NoopApprovalGate {
    async fn request(&self, _request: ApprovalRequest) -> Result<ApprovalDecision, ApprovalError> {
        Ok(ApprovalDecision::AllowOnce)
    }
}

/// Denies every request.
pub struct DenyAllApprovalGate;

#[async_trait]
impl ApprovalGate for DenyAllApprovalGate {
    async fn request(&self, _request: ApprovalRequest) -> Result<ApprovalDecision, ApprovalError> {
        Ok(ApprovalDecision::Deny)
    }
}

/// Counts every approval request and returns a configured decision.
#[derive(Default)]
pub struct CountingGate {
    pub calls: std::sync::atomic::AtomicUsize,
    pub decision: ApprovalDecision,
}

impl CountingGate {
    pub fn new(decision: ApprovalDecision) -> Self {
        Self {
            calls: Default::default(),
            decision,
        }
    }

    pub fn calls(&self) -> usize {
        self.calls.load(std::sync::atomic::Ordering::Relaxed)
    }
}

#[async_trait]
impl ApprovalGate for CountingGate {
    async fn request(&self, _request: ApprovalRequest) -> Result<ApprovalDecision, ApprovalError> {
        self.calls
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Ok(self.decision)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn req() -> ApprovalRequest {
        ApprovalRequest {
            tenant_id: TenantId::new("t"),
            project_id: ProjectId::from_raw("p"),
            tool_name: "X".into(),
            tool_input: json!({}),
            reason: "for testing".into(),
        }
    }

    #[tokio::test]
    async fn noop_gate_allows() {
        let d = NoopApprovalGate.request(req()).await.unwrap();
        assert!(d.is_allow());
        assert_eq!(d, ApprovalDecision::AllowOnce);
    }

    #[tokio::test]
    async fn deny_all_gate_denies() {
        let d = DenyAllApprovalGate.request(req()).await.unwrap();
        assert!(!d.is_allow());
        assert_eq!(d, ApprovalDecision::Deny);
    }

    #[tokio::test]
    async fn counting_gate_tracks_calls() {
        let gate = CountingGate::new(ApprovalDecision::AllowAlways);
        gate.request(req()).await.unwrap();
        gate.request(req()).await.unwrap();
        assert_eq!(gate.calls(), 2);
    }
}
