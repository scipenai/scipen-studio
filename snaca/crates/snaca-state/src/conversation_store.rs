//! `snaca-agent-api::ConversationStore` adapter for SQLite state.

use crate::{Database, NewMessage, NewThread, StateError};
use async_trait::async_trait;
use snaca_agent_api::{
    ConversationMessage, ConversationStore, EnsureThread, HistoryQuery, StoreError,
    StoreMessageResult, ToolCallCompletion, ToolCallStart,
};

#[derive(Clone)]
pub struct SqliteConversationStore {
    db: Database,
}

impl SqliteConversationStore {
    pub fn new(db: Database) -> Self {
        Self { db }
    }

    pub fn database(&self) -> &Database {
        &self.db
    }

    pub fn into_database(self) -> Database {
        self.db
    }
}

#[async_trait]
impl ConversationStore for SqliteConversationStore {
    async fn ensure_thread(&self, thread: EnsureThread) -> Result<(), StoreError> {
        if self
            .db
            .find_thread(&thread.id)
            .await
            .map_err(map_state_error)?
            .is_none()
        {
            self.db
                .insert_thread(&NewThread {
                    id: thread.id,
                    tenant_id: thread.tenant_id,
                    project_id: thread.project_id,
                    // IM-mode threads have no editor title; use the default.
                    title: "New conversation".to_string(),
                })
                .await
                .map_err(map_state_error)?;
        }
        Ok(())
    }

    async fn append_message(
        &self,
        message: ConversationMessage,
    ) -> Result<StoreMessageResult, StoreError> {
        let row = self
            .db
            .append_message(&NewMessage {
                thread_id: message.thread_id,
                session_id: message.session_id,
                role: message.role,
                content: message.content,
                // IM-mode messages aren't turn-associated.
                turn_id: None,
            })
            .await
            .map_err(map_state_error)?;
        Ok(StoreMessageResult { id: row.id })
    }

    async fn recent_messages(
        &self,
        query: HistoryQuery,
    ) -> Result<Vec<ConversationMessage>, StoreError> {
        let rows = self
            .db
            .recent_messages(&query.thread_id, query.limit)
            .await
            .map_err(map_state_error)?;
        Ok(rows
            .into_iter()
            .map(|row| ConversationMessage {
                thread_id: row.thread_id,
                session_id: row.session_id,
                role: row.role,
                content: row.content,
            })
            .collect())
    }

    async fn record_tool_start(&self, call: ToolCallStart) -> Result<(), StoreError> {
        self.db
            .record_tool_start(&call.id, &call.message_id, &call.tool_name, &call.input)
            .await
            .map_err(map_state_error)
    }

    async fn record_tool_completion(
        &self,
        completion: ToolCallCompletion,
    ) -> Result<(), StoreError> {
        self.db
            .record_tool_completion(&completion.id, &completion.output, completion.is_error)
            .await
            .map_err(map_state_error)
    }
}

fn map_state_error(error: StateError) -> StoreError {
    match error {
        StateError::Serde(e) => StoreError::Serialization(e.to_string()),
        StateError::Sqlx(e) => StoreError::Unavailable(e.to_string()),
        StateError::Migration(e) => StoreError::Unavailable(e),
        StateError::NotFound(e) => StoreError::Other(format!("not found: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_core::{ContentBlock, ProjectId, Role, SessionId, TenantId, ThreadId, ToolUseId};

    #[tokio::test]
    async fn sqlite_conversation_store_roundtrips_history_and_tool_audit() {
        let db = Database::open_in_memory().await.unwrap();
        let store = SqliteConversationStore::new(db);
        let thread_id = ThreadId::new("thread");
        let tenant_id = TenantId::new("tenant");
        let project_id = ProjectId::from_raw("project");
        store
            .ensure_thread(EnsureThread {
                id: thread_id.clone(),
                tenant_id,
                project_id,
            })
            .await
            .unwrap();
        let message = store
            .append_message(ConversationMessage {
                thread_id: thread_id.clone(),
                session_id: SessionId::new(),
                role: Role::User,
                content: vec![ContentBlock::text("hello")],
            })
            .await
            .unwrap();
        let history = store
            .recent_messages(HistoryQuery {
                thread_id: thread_id.clone(),
                limit: 10,
            })
            .await
            .unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].role, Role::User);

        let tool_id = ToolUseId::new("toolu_1");
        store
            .record_tool_start(ToolCallStart {
                id: tool_id.clone(),
                message_id: message.id,
                tool_name: "Read".into(),
                input: serde_json::json!({"path": "README.md"}),
            })
            .await
            .unwrap();
        store
            .record_tool_completion(ToolCallCompletion {
                id: tool_id,
                output: serde_json::json!({"ok": true}),
                is_error: false,
            })
            .await
            .unwrap();
    }
}
