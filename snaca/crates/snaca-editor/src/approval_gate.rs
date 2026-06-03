//! Engine `ApprovalGate` impl for the editor protocol. Generic tools go
//! through `tool.approval.request` + `tool.confirm`. Edit/Write/MultiEdit
//! detour through `edit.propose` + `edit.confirm` so the host can use
//! Monaco's diff UI; resolution flows back through the same Engine
//! ApprovalDecision channel.

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use snaca_editor_protocol::messages::edit::{EditDecision, EditProposeParams};
use snaca_editor_protocol::messages::tool::{
    DefaultDecision, RiskLevel, ToolApprovalRequestParams, ToolDecision,
};
use snaca_editor_protocol::types::hunk::LineHunk;
use snaca_editor_protocol::types::range::{Position, Range};
use snaca_engine::{ApprovalDecision, ApprovalError, ApprovalGate, ApprovalRequest};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use tracing::debug;
use uuid::Uuid;

use crate::outbound::OutboundWriter;
use crate::turn_engine::PendingApprovals;

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(300);

pub struct EditorApprovalGate {
    outbound: Arc<OutboundWriter>,
    turn_id: String,
    pending_tool: PendingApprovals,
    pending_edit: PendingApprovals,
    workspace_root: PathBuf,
    cancel: CancellationToken,
}

impl EditorApprovalGate {
    pub fn new(
        outbound: Arc<OutboundWriter>,
        turn_id: String,
        pending_tool: PendingApprovals,
        pending_edit: PendingApprovals,
        workspace_root: PathBuf,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            outbound,
            turn_id,
            pending_tool,
            pending_edit,
            workspace_root,
            cancel,
        }
    }
}

#[async_trait]
impl ApprovalGate for EditorApprovalGate {
    async fn request(&self, request: ApprovalRequest) -> Result<ApprovalDecision, ApprovalError> {
        if matches!(request.tool_name.as_str(), "Edit" | "Write" | "MultiEdit") {
            match self.try_edit_propose(&request).await {
                Ok(decision) => return Ok(decision),
                Err(reason) => {
                    debug!(tool = %request.tool_name, reason, "edit.propose declined; using generic approval");
                }
            }
        }
        self.request_generic(request).await
    }
}

impl EditorApprovalGate {
    async fn request_generic(
        &self,
        request: ApprovalRequest,
    ) -> Result<ApprovalDecision, ApprovalError> {
        let tool_call_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<ApprovalDecision>();
        {
            let mut map = self.pending_tool.lock().unwrap();
            map.insert(tool_call_id.clone(), tx);
        }

        let params = ToolApprovalRequestParams {
            tool_call_id: tool_call_id.clone(),
            turn_id: self.turn_id.clone(),
            tool: request.tool_name.clone(),
            args: request.tool_input.clone(),
            summary: if request.reason.is_empty() {
                format!("{} requires approval", request.tool_name)
            } else {
                request.reason.clone()
            },
            risk: risk_for_tool(&request.tool_name),
            default_decision: Some(DefaultDecision::Deny),
            timeout_secs: Some(DEFAULT_TIMEOUT.as_secs()),
        };
        if let Err(e) = self.outbound.emit_tool_approval_request(params).await {
            self.pending_tool.lock().unwrap().remove(&tool_call_id);
            return Err(ApprovalError::Other(format!(
                "outbound emit failed: {e}"
            )));
        }

        await_decision(rx, &self.pending_tool, &tool_call_id, &self.cancel).await
    }

    async fn try_edit_propose(
        &self,
        request: &ApprovalRequest,
    ) -> Result<ApprovalDecision, String> {
        let file_rel = extract_path(&request.tool_input)?;
        let abs_path = self.workspace_root.join(&file_rel);
        let old_content = match tokio::fs::read_to_string(&abs_path).await {
            Ok(s) => s,
            // Diff Review is for modifying an existing file; new-file
            // creates fall back to generic approval (path + preview).
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err("file does not exist (new-file create)".into());
            }
            Err(e) => return Err(format!("read failed: {e}")),
        };
        let new_content = compute_new_content(
            &request.tool_name,
            &request.tool_input,
            &old_content,
        )?;

        let proposal_id = Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel::<ApprovalDecision>();
        {
            let mut map = self.pending_edit.lock().unwrap();
            map.insert(proposal_id.clone(), tx);
        }

        let mut hasher = Sha256::new();
        hasher.update(old_content.as_bytes());
        let base_hash = format!("{:x}", hasher.finalize());
        let end_line = old_content
            .chars()
            .filter(|c| *c == '\n')
            .count()
            .min(u32::MAX as usize) as u32;
        let end_col = old_content
            .lines()
            .last()
            .map(|s| s.chars().count().min(u32::MAX as usize) as u32)
            .unwrap_or(0);

        let hunks = vec![LineHunk {
            hunk_id: "h0".into(),
            range: Range::new(Position::new(0, 0), Position::new(end_line, end_col)),
            old_text: old_content,
            new_text: new_content,
        }];

        let params = EditProposeParams {
            proposal_id: proposal_id.clone(),
            turn_id: self.turn_id.clone(),
            tool_call_id: None,
            file: file_rel.clone(),
            base_hash,
            hunks,
            streaming: false,
            summary: Some(format!("{} {}", request.tool_name, file_rel)),
            expected_post_hash: None,
        };
        if let Err(e) = self.outbound.emit_edit_propose(params).await {
            self.pending_edit.lock().unwrap().remove(&proposal_id);
            return Err(format!("emit_edit_propose failed: {e}"));
        }

        match await_decision(rx, &self.pending_edit, &proposal_id, &self.cancel).await {
            Ok(decision) => Ok(decision),
            Err(ApprovalError::Timeout) => Err("timeout".into()),
            Err(ApprovalError::Cancelled) => Err("cancelled".into()),
            Err(ApprovalError::Other(s)) => Err(s),
        }
    }
}

async fn await_decision(
    rx: oneshot::Receiver<ApprovalDecision>,
    pending: &PendingApprovals,
    key: &str,
    cancel: &CancellationToken,
) -> Result<ApprovalDecision, ApprovalError> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => {
            pending.lock().unwrap().remove(key);
            Err(ApprovalError::Cancelled)
        }
        outcome = tokio::time::timeout(DEFAULT_TIMEOUT, rx) => match outcome {
            Ok(Ok(decision)) => Ok(decision),
            Ok(Err(_recv_closed)) => Err(ApprovalError::Cancelled),
            Err(_elapsed) => {
                pending.lock().unwrap().remove(key);
                Err(ApprovalError::Timeout)
            }
        },
    }
}

fn extract_path(input: &serde_json::Value) -> Result<String, String> {
    input
        .as_object()
        .and_then(|o| o.get("path"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "missing or non-string `path`".into())
}

fn compute_new_content(
    tool_name: &str,
    input: &serde_json::Value,
    old: &str,
) -> Result<String, String> {
    let obj = input
        .as_object()
        .ok_or_else(|| "tool input is not an object".to_string())?;
    match tool_name {
        "Write" => obj
            .get("content")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "Write: missing `content`".into()),
        "Edit" => {
            let old_string = obj
                .get("old_string")
                .and_then(|v| v.as_str())
                .ok_or("Edit: missing `old_string`")?;
            let new_string = obj
                .get("new_string")
                .and_then(|v| v.as_str())
                .ok_or("Edit: missing `new_string`")?;
            let replace_all = obj
                .get("replace_all")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            apply_single_edit(old, old_string, new_string, replace_all)
        }
        "MultiEdit" => {
            let edits = obj
                .get("edits")
                .and_then(|v| v.as_array())
                .ok_or("MultiEdit: missing `edits` array")?;
            let mut content = old.to_string();
            for (i, e) in edits.iter().enumerate() {
                let eo = e.as_object().ok_or("MultiEdit: edit must be object")?;
                let old_s = eo
                    .get("old_string")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| format!("MultiEdit edit#{i}: missing old_string"))?;
                let new_s = eo
                    .get("new_string")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| format!("MultiEdit edit#{i}: missing new_string"))?;
                let replace_all = eo
                    .get("replace_all")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                content = apply_single_edit(&content, old_s, new_s, replace_all)?;
            }
            Ok(content)
        }
        _ => Err(format!("unsupported tool {tool_name}")),
    }
}

fn apply_single_edit(
    content: &str,
    old: &str,
    new: &str,
    replace_all: bool,
) -> Result<String, String> {
    if old.is_empty() {
        return Err("old_string is empty".into());
    }
    if !content.contains(old) {
        return Err(format!(
            "old_string not found in file (len {} chars)",
            old.chars().count()
        ));
    }
    if replace_all {
        Ok(content.replace(old, new))
    } else {
        Ok(content.replacen(old, new, 1))
    }
}

/// `DenyAlways` collapses to `Deny` (engine has no remembered-deny mode).
pub fn decision_from_wire(decision: ToolDecision) -> ApprovalDecision {
    match decision {
        ToolDecision::Allow => ApprovalDecision::AllowOnce,
        ToolDecision::AllowAlways => ApprovalDecision::AllowAlways,
        ToolDecision::Deny | ToolDecision::DenyAlways => ApprovalDecision::Deny,
    }
}

/// `AcceptPartial` collapses to `AllowOnce` — partial accept is a
/// host-side hunk-level rendering concern; the engine runs the tool once.
pub fn decision_from_edit(decision: EditDecision) -> ApprovalDecision {
    match decision {
        EditDecision::Accept | EditDecision::AcceptPartial => ApprovalDecision::AllowOnce,
        EditDecision::Reject => ApprovalDecision::Deny,
    }
}

fn risk_for_tool(tool: &str) -> RiskLevel {
    match tool {
        "Bash" => RiskLevel::High,
        _ => RiskLevel::Medium,
    }
}
