//! `TaskStop` — terminate a background task spawned by `Bash`.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput, ToolResult,
};

#[derive(Debug, Deserialize)]
struct TaskStopInput {
    task_id: String,
}

pub struct TaskStopTool;

#[async_trait]
impl Tool for TaskStopTool {
    fn name(&self) -> &str {
        "TaskStop"
    }

    fn description(&self) -> &str {
        "Terminate a background task spawned via Bash with \
         run_in_background. Sends SIGKILL — no graceful shutdown. \
         Idempotent: stopping an already-finished task returns its \
         final status."
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
        // Process control, not filesystem mutation.
        ToolCapabilities {
            reads_filesystem: false,
            writes_filesystem: false,
            executes_commands: true,
            network_access: false,
        }
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::Never
    }

    fn is_read_only(&self) -> bool {
        false
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input: TaskStopInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;

        let registry = crate::task_registry::task_registry_from_ctx(ctx).ok_or_else(|| {
            ToolError::Execution(
                "no TaskRegistry attached — background tasks are unavailable in this deployment".into(),
            )
        })?;

        let status = registry
            .stop(&input.task_id, ctx.tenant_id(), ctx.project_id())
            .await
            .ok_or_else(|| ToolError::NotFound(format!("task {} not found", input.task_id)))?;

        Ok(ToolOutput::json(json!({
            "task_id": input.task_id,
            "status": status.as_str(),
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

    #[tokio::test]
    async fn unknown_id_returns_not_found() {
        let registry = TaskRegistry::new();
        let tmp = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(
            TenantId::new("t"),
            ProjectId::from_raw("p"),
            SessionId::new(),
            tmp.path().to_path_buf(),
        )
        .with_task_registry(registry as Arc<dyn Any + Send + Sync>);
        let err = TaskStopTool
            .execute(json!({"task_id": "nope"}), &ctx)
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::NotFound(_)));
    }
}
