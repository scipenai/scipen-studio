//! `TaskOutput` — poll the stdout / stderr / status of a background
//! task spawned by `Bash` with `run_in_background = true`.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput, ToolResult,
};

#[derive(Debug, Deserialize)]
struct TaskOutputInput {
    task_id: String,
}

pub struct TaskOutputTool;

#[async_trait]
impl Tool for TaskOutputTool {
    fn name(&self) -> &str {
        "TaskOutput"
    }

    fn description(&self) -> &str {
        "Read the current stdout/stderr/status of a background task \
         spawned via Bash with run_in_background. Returns whatever has \
         been captured so far; safe to call repeatedly while the task \
         is still running. Output is tail-capped at 256 KiB per stream."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "task_id": {
                    "type": "string",
                    "description": "ID returned by an earlier Bash run_in_background call."
                }
            },
            "required": ["task_id"]
        })
    }

    fn capabilities(&self) -> ToolCapabilities {
        // Read-only with respect to the workspace; we just read
        // captured buffers. The underlying task may be writing, but
        // that's accounted for at spawn time.
        ToolCapabilities::read_only_filesystem()
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::Never
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input: TaskOutputInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;

        let registry = crate::task_registry::task_registry_from_ctx(ctx).ok_or_else(|| {
            ToolError::Execution(
                "no TaskRegistry attached — background tasks are unavailable in this deployment".into(),
            )
        })?;

        let snap = registry
            .snapshot(&input.task_id, ctx.tenant_id(), ctx.project_id())
            .ok_or_else(|| ToolError::NotFound(format!("task {} not found", input.task_id)))?;

        Ok(ToolOutput::json(json!({
            "task_id": snap.id,
            "cmd": snap.cmd,
            "status": snap.status.as_str(),
            "exit_code": match snap.status {
                crate::task_registry::TaskStatus::Exited(c) => Some(c),
                _ => None,
            },
            "elapsed_ms": snap.elapsed_ms,
            "stdout": snap.stdout,
            "stdout_truncated": snap.stdout_truncated,
            "stderr": snap.stderr,
            "stderr_truncated": snap.stderr_truncated,
        })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_registry::TaskRegistry;
    use snaca_core::{ProjectId, SessionId, TenantId};
    use std::any::Any;
    use std::sync::Arc;

    fn ctx_with_registry(registry: Arc<TaskRegistry>) -> ToolContext {
        let tmp = tempfile::tempdir().unwrap();
        ToolContext::new(
            TenantId::new("t"),
            ProjectId::from_raw("p"),
            SessionId::new(),
            tmp.path().to_path_buf(),
        )
        .with_task_registry(registry as Arc<dyn Any + Send + Sync>)
    }

    #[tokio::test]
    async fn unknown_id_returns_not_found() {
        let registry = TaskRegistry::new();
        let ctx = ctx_with_registry(registry);
        let err = TaskOutputTool
            .execute(json!({"task_id": "nope"}), &ctx)
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::NotFound(_)));
    }

    #[tokio::test]
    async fn missing_registry_returns_execution_error() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(
            TenantId::new("t"),
            ProjectId::from_raw("p"),
            SessionId::new(),
            tmp.path().to_path_buf(),
        );
        let err = TaskOutputTool
            .execute(json!({"task_id": "x"}), &ctx)
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::Execution(_)));
    }
}
