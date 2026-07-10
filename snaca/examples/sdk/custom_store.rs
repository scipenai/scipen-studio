use snaca_sdk::{
    ContentBlock, ConversationMessage, ConversationStore, EnsureThread, HistoryQuery,
    InMemoryConversationStore, ProjectId, Role, SessionId, TenantId, ThreadId,
};

#[tokio::main]
async fn main() -> snaca_sdk::Result<()> {
    let store = InMemoryConversationStore::new();
    let thread_id = ThreadId::new("example-thread");

    store
        .ensure_thread(EnsureThread {
            id: thread_id.clone(),
            tenant_id: TenantId::new("tenant"),
            project_id: ProjectId::from_raw("project"),
        })
        .await
        .map_err(|e| snaca_sdk::SdkError::Runtime(e.to_string()))?;

    store
        .append_message(ConversationMessage {
            thread_id: thread_id.clone(),
            session_id: SessionId::new(),
            role: Role::User,
            content: vec![ContentBlock::text("hello")],
        })
        .await
        .map_err(|e| snaca_sdk::SdkError::Runtime(e.to_string()))?;

    let history = store
        .recent_messages(HistoryQuery {
            thread_id,
            limit: 10,
        })
        .await
        .map_err(|e| snaca_sdk::SdkError::Runtime(e.to_string()))?;

    println!("stored {} message(s)", history.len());
    Ok(())
}
