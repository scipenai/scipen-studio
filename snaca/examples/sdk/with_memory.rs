use std::sync::Arc;

use snaca_sdk::{
    AgentBuilder, MemoryProvider, MemoryReadRequest, MemoryWriteRequest, ProjectId, TenantId,
};

#[tokio::main]
async fn main() -> snaca_sdk::Result<()> {
    let provider = Arc::new(snaca_sdk::memory::file_tree("./data-sdk")?);
    let tenant_id = TenantId::new("default");
    let project_id = ProjectId::from_raw("default");

    provider
        .write(MemoryWriteRequest {
            tenant_id: tenant_id.clone(),
            project_id: project_id.clone(),
            scope: "project".into(),
            name: "sdk-note".into(),
            content: "SNACA can be embedded through snaca-sdk.".into(),
        })
        .await
        .map_err(|e| snaca_sdk::SdkError::Runtime(e.to_string()))?;

    let saved = provider
        .read(MemoryReadRequest {
            tenant_id,
            project_id,
            scope: "project".into(),
            name: "sdk-note".into(),
        })
        .await
        .map_err(|e| snaca_sdk::SdkError::Runtime(e.to_string()))?;

    let agent = AgentBuilder::new()
        .llm(snaca_sdk::llm::deepseek_from_env("deepseek-chat")?)
        .read_only_agent_defaults()
        .memory_provider_arc(provider as Arc<dyn MemoryProvider>)
        .data_root("./data-sdk")
        .build()
        .await?;

    let out = agent
        .run(format!(
            "Use this saved memory in one sentence: {}",
            saved.content
        ))
        .await?;
    println!("{}", out.text);
    Ok(())
}
