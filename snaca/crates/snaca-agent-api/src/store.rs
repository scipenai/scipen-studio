//! Conversation persistence contracts for embeddable agent runtimes.
//!
//! The concrete server still uses `snaca-state::Database` directly today, but
//! SDK-facing code can depend on this trait and accept alternate stores.

use async_trait::async_trait;
use snaca_core::{
    ContentBlock, MessageId, ProjectId, Role, SessionId, TenantId, ThreadId, ToolUseId,
};
use std::collections::HashMap;
use std::sync::Mutex;
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct EnsureThread {
    pub id: ThreadId,
    pub tenant_id: TenantId,
    pub project_id: ProjectId,
}

#[derive(Debug, Clone)]
pub struct ConversationMessage {
    pub thread_id: ThreadId,
    pub session_id: SessionId,
    pub role: Role,
    pub content: Vec<ContentBlock>,
}

#[derive(Debug, Clone)]
pub struct StoreMessageResult {
    pub id: MessageId,
}

#[derive(Debug, Clone)]
pub struct HistoryQuery {
    pub thread_id: ThreadId,
    pub limit: u32,
}

#[derive(Debug, Clone)]
pub struct ToolCallStart {
    pub id: ToolUseId,
    pub message_id: MessageId,
    pub tool_name: String,
    pub input: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct ToolCallCompletion {
    pub id: ToolUseId,
    pub output: serde_json::Value,
    pub is_error: bool,
}

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("store unavailable: {0}")]
    Unavailable(String),

    #[error("store serialization error: {0}")]
    Serialization(String),

    #[error("store operation failed: {0}")]
    Other(String),
}

#[async_trait]
pub trait ConversationStore: Send + Sync {
    async fn ensure_thread(&self, thread: EnsureThread) -> Result<(), StoreError>;

    async fn append_message(
        &self,
        message: ConversationMessage,
    ) -> Result<StoreMessageResult, StoreError>;

    async fn recent_messages(
        &self,
        query: HistoryQuery,
    ) -> Result<Vec<ConversationMessage>, StoreError>;

    async fn record_tool_start(&self, call: ToolCallStart) -> Result<(), StoreError>;

    async fn record_tool_completion(
        &self,
        completion: ToolCallCompletion,
    ) -> Result<(), StoreError>;
}

#[derive(Default)]
pub struct InMemoryConversationStore {
    inner: Mutex<InMemoryState>,
}

#[derive(Default)]
struct InMemoryState {
    threads: HashMap<ThreadId, (TenantId, ProjectId)>,
    messages: HashMap<ThreadId, Vec<ConversationMessage>>,
    tool_calls: HashMap<ToolUseId, InMemoryToolCall>,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
struct InMemoryToolCall {
    message_id: MessageId,
    tool_name: String,
    input: serde_json::Value,
    completion: Option<ToolCallCompletion>,
}

impl InMemoryConversationStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn message_count(&self, thread_id: &ThreadId) -> usize {
        self.inner
            .lock()
            .expect("in-memory store lock poisoned")
            .messages
            .get(thread_id)
            .map(Vec::len)
            .unwrap_or(0)
    }

    pub fn tool_call_count(&self) -> usize {
        self.inner
            .lock()
            .expect("in-memory store lock poisoned")
            .tool_calls
            .len()
    }
}

#[async_trait]
impl ConversationStore for InMemoryConversationStore {
    async fn ensure_thread(&self, thread: EnsureThread) -> Result<(), StoreError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| StoreError::Unavailable(e.to_string()))?;
        inner
            .threads
            .insert(thread.id, (thread.tenant_id, thread.project_id));
        Ok(())
    }

    async fn append_message(
        &self,
        message: ConversationMessage,
    ) -> Result<StoreMessageResult, StoreError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| StoreError::Unavailable(e.to_string()))?;
        inner
            .messages
            .entry(message.thread_id.clone())
            .or_default()
            .push(message);
        Ok(StoreMessageResult {
            id: MessageId::new(),
        })
    }

    async fn recent_messages(
        &self,
        query: HistoryQuery,
    ) -> Result<Vec<ConversationMessage>, StoreError> {
        let inner = self
            .inner
            .lock()
            .map_err(|e| StoreError::Unavailable(e.to_string()))?;
        let mut messages = inner
            .messages
            .get(&query.thread_id)
            .cloned()
            .unwrap_or_default();
        let limit = query.limit as usize;
        if limit > 0 && messages.len() > limit {
            messages = messages.split_off(messages.len() - limit);
        }
        Ok(messages)
    }

    async fn record_tool_start(&self, call: ToolCallStart) -> Result<(), StoreError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| StoreError::Unavailable(e.to_string()))?;
        inner.tool_calls.insert(
            call.id,
            InMemoryToolCall {
                message_id: call.message_id,
                tool_name: call.tool_name,
                input: call.input,
                completion: None,
            },
        );
        Ok(())
    }

    async fn record_tool_completion(
        &self,
        completion: ToolCallCompletion,
    ) -> Result<(), StoreError> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|e| StoreError::Unavailable(e.to_string()))?;
        match inner.tool_calls.get_mut(&completion.id) {
            Some(call) => {
                call.completion = Some(completion);
                Ok(())
            }
            None => Err(StoreError::Other(format!(
                "tool call {} was not started",
                completion.id
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_core::{ContentBlock, Role};

    #[tokio::test]
    async fn in_memory_store_roundtrips_history() {
        let store = InMemoryConversationStore::new();
        let thread_id = ThreadId::new("thread");
        store
            .ensure_thread(EnsureThread {
                id: thread_id.clone(),
                tenant_id: TenantId::new("tenant"),
                project_id: ProjectId::from_raw("project"),
            })
            .await
            .unwrap();

        for text in ["one", "two", "three"] {
            store
                .append_message(ConversationMessage {
                    thread_id: thread_id.clone(),
                    session_id: SessionId::new(),
                    role: Role::User,
                    content: vec![ContentBlock::text(text)],
                })
                .await
                .unwrap();
        }

        let messages = store
            .recent_messages(HistoryQuery {
                thread_id: thread_id.clone(),
                limit: 2,
            })
            .await
            .unwrap();
        assert_eq!(store.message_count(&thread_id), 3);
        assert_eq!(messages.len(), 2);
        assert!(matches!(
            &messages[0].content[0],
            ContentBlock::Text { text } if text == "two"
        ));
    }

    #[tokio::test]
    async fn in_memory_store_tracks_tool_calls() {
        let store = InMemoryConversationStore::new();
        let id = ToolUseId::new("toolu_1");
        store
            .record_tool_start(ToolCallStart {
                id: id.clone(),
                message_id: MessageId::new(),
                tool_name: "echo".into(),
                input: serde_json::json!({"text": "hi"}),
            })
            .await
            .unwrap();
        store
            .record_tool_completion(ToolCallCompletion {
                id,
                output: serde_json::json!({"ok": true}),
                is_error: false,
            })
            .await
            .unwrap();
        assert_eq!(store.tool_call_count(), 1);
    }
}
