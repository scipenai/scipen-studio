use std::io::{self, Write};

use snaca_sdk::{AgentBuilder, AgentStreamEvent};

#[tokio::main]
async fn main() -> snaca_sdk::Result<()> {
    let agent = AgentBuilder::new()
        .llm(snaca_sdk::llm::deepseek_from_env("deepseek-chat")?)
        .read_only_agent_defaults()
        .data_root("./data-sdk")
        .build()
        .await?;

    let mut stream = agent.stream("用三句话介绍 SNACA，并保持简洁。");
    while let Some(event) = stream.next().await {
        match event? {
            event @ AgentStreamEvent::Llm(_) => {
                if let Some(delta) = event.into_text_delta() {
                    print!("{delta}");
                    io::stdout().flush().ok();
                }
            }
            AgentStreamEvent::Completed(out) => {
                println!("\n\niterations: {}", out.outcome.iterations);
                break;
            }
        }
    }

    Ok(())
}
