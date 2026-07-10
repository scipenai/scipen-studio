use async_trait::async_trait;
use serde_json::{json, Value};
use snaca_sdk::{
    AgentBuilder, ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolOutput, ToolResult,
};

struct EchoTool;

#[async_trait]
impl Tool for EchoTool {
    fn name(&self) -> &str {
        "echo"
    }

    fn description(&self) -> &str {
        "Echo input text."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "text": { "type": "string" }
            },
            "required": ["text"]
        })
    }

    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::default()
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::Never
    }

    async fn execute(&self, input: Value, _ctx: &ToolContext) -> ToolResult {
        Ok(ToolOutput::text(input["text"].as_str().unwrap_or_default()))
    }
}

#[tokio::main]
async fn main() -> snaca_sdk::Result<()> {
    let tools = snaca_sdk::ToolRegistry::builder().add(EchoTool).build();
    let agent = AgentBuilder::new()
        .llm(snaca_sdk::llm::deepseek_from_env("deepseek-chat")?)
        .tools(tools)
        .data_root("./data-sdk")
        .build()
        .await?;

    let out = agent
        .run("Call echo with text `hello` and report the result.")
        .await?;
    println!("{}", out.text);
    Ok(())
}
