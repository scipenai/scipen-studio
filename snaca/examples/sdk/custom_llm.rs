use async_trait::async_trait;
use snaca_sdk::{
    AgentBuilder, LlmClientTrait, LlmResult, Message, MessageRequest, MessageResponse,
    ProviderCaps, StopReason, Usage,
};

struct StaticLlm;

#[async_trait]
impl LlmClientTrait for StaticLlm {
    fn provider_name(&self) -> &'static str {
        "static"
    }

    fn model(&self) -> &str {
        "static-model"
    }

    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps {
            tool_use: false,
            ..Default::default()
        }
    }

    async fn create_message(&self, _request: MessageRequest) -> LlmResult<MessageResponse> {
        Ok(MessageResponse {
            id: "static-msg".into(),
            message: Message::assistant_text("hello from a custom LLM"),
            usage: Usage {
                input_tokens: 1,
                output_tokens: 1,
                ..Default::default()
            },
            stop_reason: StopReason::EndTurn,
        })
    }
}

#[tokio::main]
async fn main() -> snaca_sdk::Result<()> {
    let agent = AgentBuilder::new()
        .llm(StaticLlm)
        .minimal_agent_defaults()
        .build()
        .await?;

    let out = agent.run("ignored by StaticLlm").await?;
    println!("{}", out.text);
    Ok(())
}
