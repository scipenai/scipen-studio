//! Store helpers for SDK users.

use crate::Result;
pub use snaca_agent_api::{
    ConversationMessage, ConversationStore, EnsureThread, HistoryQuery, InMemoryConversationStore,
    StoreError, StoreMessageResult, ToolCallCompletion, ToolCallStart,
};
use snaca_state::{Database, SqliteConversationStore};
use std::path::Path;

pub async fn sqlite(path: impl AsRef<Path>) -> Result<SqliteConversationStore> {
    Ok(SqliteConversationStore::new(Database::open(path).await?))
}

pub async fn in_memory() -> Result<SqliteConversationStore> {
    Ok(SqliteConversationStore::new(
        Database::open_in_memory().await?,
    ))
}

pub fn in_memory_conversation() -> InMemoryConversationStore {
    InMemoryConversationStore::new()
}
