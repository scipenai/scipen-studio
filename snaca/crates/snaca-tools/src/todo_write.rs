//! `TodoWrite` — track multi-step plans across turns.
//!
//! Modeled after Claude Code's TodoWrite: the LLM submits the *full* todo
//! list on every call, and the tool overwrites the persisted copy. State
//! lives at `<workspace>/.snaca/todos.json` so it survives across turns
//! within a project but stays scoped to that project's workspace.
//!
//! Validation rules baked in:
//! - At most one `in_progress` item at a time. Two parallel "active" todos
//!   defeat the purpose of the tool — the LLM should mark one done before
//!   starting the next.
//! - `content` and `activeForm` are non-empty after trim.
//! - Hard ceiling of 100 items per list. A runaway model that emits 5 000
//!   todos isn't planning, it's hallucinating.
//!
//! The tool is *not* read-only (writes the json file) but doesn't gate on
//! approval — todos are internal scaffolding, not user-visible state
//! changes that warrant a confirmation card.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput, ToolResult,
};
use std::path::{Path, PathBuf};

const MAX_TODOS: usize = 100;
const STATE_DIR: &str = ".snaca";
const STATE_FILE: &str = "todos.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoItem {
    pub content: String,
    #[serde(rename = "activeForm")]
    pub active_form: String,
    pub status: TodoStatus,
}

#[derive(Debug, Deserialize)]
struct TodoWriteInput {
    todos: Vec<TodoItem>,
}

pub struct TodoWriteTool;

impl TodoWriteTool {
    /// Read the current todo list for `workspace_root`. Returns an empty
    /// vec if the state file is absent — this is the normal "no todos
    /// recorded yet" case, not an error.
    pub async fn read_state(workspace_root: &Path) -> Result<Vec<TodoItem>, std::io::Error> {
        let path = state_path(workspace_root);
        match tokio::fs::read(&path).await {
            Ok(bytes) => match serde_json::from_slice::<Vec<TodoItem>>(&bytes) {
                Ok(items) => Ok(items),
                Err(_) => Ok(Vec::new()), // corrupt file = treat as empty
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    fn validate(todos: &[TodoItem]) -> Result<(), ToolError> {
        if todos.len() > MAX_TODOS {
            return Err(ToolError::InvalidInput(format!(
                "todo list has {} items; ceiling is {}",
                todos.len(),
                MAX_TODOS
            )));
        }
        let mut in_progress_count = 0;
        for (i, item) in todos.iter().enumerate() {
            if item.content.trim().is_empty() {
                return Err(ToolError::InvalidInput(format!(
                    "todos[{i}].content is empty after trim"
                )));
            }
            if item.active_form.trim().is_empty() {
                return Err(ToolError::InvalidInput(format!(
                    "todos[{i}].activeForm is empty after trim"
                )));
            }
            if matches!(item.status, TodoStatus::InProgress) {
                in_progress_count += 1;
            }
        }
        if in_progress_count > 1 {
            return Err(ToolError::InvalidInput(format!(
                "exactly one todo may be in_progress at a time; got {in_progress_count}"
            )));
        }
        Ok(())
    }
}

fn state_path(workspace_root: &Path) -> PathBuf {
    workspace_root.join(STATE_DIR).join(STATE_FILE)
}

#[async_trait]
impl Tool for TodoWriteTool {
    fn name(&self) -> &str {
        "TodoWrite"
    }

    fn description(&self) -> &str {
        "Track a multi-step plan across turns. Submit the *full* todo list \
         on every call — the prior list is replaced verbatim. Each item has \
         `content` (imperative, e.g. \"Refactor parser\"), `activeForm` \
         (present continuous, e.g. \"Refactoring parser\"), and `status` \
         (pending|in_progress|completed). At most one item may be \
         in_progress at a time. Use this when a request needs three or more \
         distinct steps — skip it for trivial single-action requests."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "todos": {
                    "type": "array",
                    "description": "Full replacement todo list.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": {
                                "type": "string",
                                "description": "Imperative form, e.g. \"Run tests\"."
                            },
                            "activeForm": {
                                "type": "string",
                                "description": "Present continuous, e.g. \"Running tests\"."
                            },
                            "status": {
                                "type": "string",
                                "enum": ["pending", "in_progress", "completed"]
                            }
                        },
                        "required": ["content", "activeForm", "status"]
                    }
                }
            },
            "required": ["todos"]
        })
    }

    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::writes_filesystem()
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        // Internal scaffolding — never gate on approval.
        ApprovalRequirement::Never
    }

    fn is_read_only(&self) -> bool {
        false
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let parsed: TodoWriteInput = serde_json::from_value(input)
            .map_err(|e| ToolError::InvalidInput(e.to_string()))?;
        Self::validate(&parsed.todos)?;

        let path = state_path(ctx.workspace_root());
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let bytes = serde_json::to_vec_pretty(&parsed.todos)
            .map_err(|e| ToolError::Execution(e.to_string()))?;
        tokio::fs::write(&path, bytes).await?;

        let pending = parsed
            .todos
            .iter()
            .filter(|t| matches!(t.status, TodoStatus::Pending))
            .count();
        let in_progress = parsed
            .todos
            .iter()
            .filter(|t| matches!(t.status, TodoStatus::InProgress))
            .count();
        let completed = parsed
            .todos
            .iter()
            .filter(|t| matches!(t.status, TodoStatus::Completed))
            .count();

        Ok(ToolOutput::text(format!(
            "tracking {} todo{} ({} pending, {} in progress, {} completed)",
            parsed.todos.len(),
            if parsed.todos.len() == 1 { "" } else { "s" },
            pending,
            in_progress,
            completed
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_core::{ProjectId, SessionId, TenantId};
    use std::path::Path;

    fn ctx(root: &Path) -> ToolContext {
        ToolContext::new(
            TenantId::new("t"),
            ProjectId::from_raw("p"),
            SessionId::new(),
            root.to_path_buf(),
        )
    }

    fn item(content: &str, active: &str, status: TodoStatus) -> Value {
        json!({"content": content, "activeForm": active, "status": match status {
            TodoStatus::Pending => "pending",
            TodoStatus::InProgress => "in_progress",
            TodoStatus::Completed => "completed",
        }})
    }

    #[tokio::test]
    async fn writes_initial_list() {
        let dir = tempfile::tempdir().unwrap();
        let out = TodoWriteTool
            .execute(
                json!({"todos": [
                    item("Plan", "Planning", TodoStatus::InProgress),
                    item("Implement", "Implementing", TodoStatus::Pending),
                ]}),
                &ctx(dir.path()),
            )
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("tracking 2 todos"));
        assert!(out.contains("1 in progress"));

        let on_disk = TodoWriteTool::read_state(dir.path()).await.unwrap();
        assert_eq!(on_disk.len(), 2);
        assert_eq!(on_disk[0].content, "Plan");
        assert_eq!(on_disk[0].status, TodoStatus::InProgress);
    }

    #[tokio::test]
    async fn second_call_overwrites_first() {
        let dir = tempfile::tempdir().unwrap();
        TodoWriteTool
            .execute(
                json!({"todos": [item("a", "A", TodoStatus::Pending)]}),
                &ctx(dir.path()),
            )
            .await
            .unwrap();
        TodoWriteTool
            .execute(
                json!({"todos": [item("b", "B", TodoStatus::Completed)]}),
                &ctx(dir.path()),
            )
            .await
            .unwrap();
        let state = TodoWriteTool::read_state(dir.path()).await.unwrap();
        assert_eq!(state.len(), 1);
        assert_eq!(state[0].content, "b");
        assert_eq!(state[0].status, TodoStatus::Completed);
    }

    #[tokio::test]
    async fn rejects_two_in_progress() {
        let dir = tempfile::tempdir().unwrap();
        let err = TodoWriteTool
            .execute(
                json!({"todos": [
                    item("a", "A", TodoStatus::InProgress),
                    item("b", "B", TodoStatus::InProgress),
                ]}),
                &ctx(dir.path()),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)), "got: {err:?}");
    }

    #[tokio::test]
    async fn rejects_empty_content() {
        let dir = tempfile::tempdir().unwrap();
        let err = TodoWriteTool
            .execute(
                json!({"todos": [item("", "X", TodoStatus::Pending)]}),
                &ctx(dir.path()),
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn rejects_too_many_items() {
        let dir = tempfile::tempdir().unwrap();
        let too_many: Vec<Value> = (0..MAX_TODOS + 1)
            .map(|i| item(&format!("item-{i}"), &format!("item-{i}"), TodoStatus::Pending))
            .collect();
        let err = TodoWriteTool
            .execute(json!({"todos": too_many}), &ctx(dir.path()))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
    }

    #[tokio::test]
    async fn empty_list_clears_existing_state() {
        let dir = tempfile::tempdir().unwrap();
        TodoWriteTool
            .execute(
                json!({"todos": [item("a", "A", TodoStatus::Pending)]}),
                &ctx(dir.path()),
            )
            .await
            .unwrap();
        TodoWriteTool
            .execute(json!({"todos": []}), &ctx(dir.path()))
            .await
            .unwrap();
        let state = TodoWriteTool::read_state(dir.path()).await.unwrap();
        assert!(state.is_empty());
    }

    #[tokio::test]
    async fn read_state_returns_empty_when_file_absent() {
        let dir = tempfile::tempdir().unwrap();
        let state = TodoWriteTool::read_state(dir.path()).await.unwrap();
        assert!(state.is_empty());
    }

    #[tokio::test]
    async fn read_state_tolerates_corrupt_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = state_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"{not-json").unwrap();
        // Corrupt -> treated as empty rather than erroring; the next
        // TodoWrite call will overwrite cleanly.
        let state = TodoWriteTool::read_state(dir.path()).await.unwrap();
        assert!(state.is_empty());
    }
}
