use snaca_sdk::AgentBuilder;

#[tokio::main]
async fn main() -> snaca_sdk::Result<()> {
    let agent = AgentBuilder::new()
        .llm(snaca_sdk::llm::deepseek_from_env("deepseek-chat")?)
        .read_only_agent_defaults()
        .data_root("./data-sdk")
        .build()
        .await?;

    let out = agent.run("用一句话介绍 SNACA").await?;
    println!("{}", out.text);
    Ok(())
}
