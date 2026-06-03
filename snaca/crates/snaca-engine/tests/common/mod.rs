//! Test fixtures shared across `snaca-engine` integration tests.
//!
//! Each integration test crate compiles `common/` independently, so any
//! helper not referenced by *that* particular test file looks unused to
//! rustc and triggers `dead_code` / `unused_imports`. Suppressing both
//! at module scope is the conventional fix for shared test fixtures.
#![allow(dead_code, unused_imports)]

use async_trait::async_trait;
use serde_json::{json, Value};
use snaca_core::{ContentBlock, Message, MessageId, Role, ToolUseId, Usage};
use snaca_llm::{
    LlmClient, LlmError, LlmResult, MessageRequest, MessageResponse, ProviderCaps, StopReason,
};
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput, ToolResult,
};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

/// In-memory `LlmClient` driven by a script of pre-recorded responses
/// and errors. Each pop returns the next outcome — `enqueue_err` lets
/// tests script transient failures (e.g. `ContextOverflow`) the engine
/// recovers from before a queued success.
pub struct MockLlmClient {
    queue: Arc<Mutex<VecDeque<LlmResult<MessageResponse>>>>,
    requests: Arc<Mutex<Vec<MessageRequest>>>,
}

impl MockLlmClient {
    pub fn new() -> Self {
        Self {
            queue: Arc::new(Mutex::new(VecDeque::new())),
            requests: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn enqueue(&self, resp: MessageResponse) {
        self.queue.lock().unwrap().push_back(Ok(resp));
    }

    pub fn enqueue_err(&self, err: LlmError) {
        self.queue.lock().unwrap().push_back(Err(err));
    }

    pub fn observed_request_count(&self) -> usize {
        self.requests.lock().unwrap().len()
    }

    /// Snapshot every observed request, in the order they were issued.
    /// Cloning the inner Vec keeps the mutex-locked critical section short.
    pub fn observed_requests(&self) -> Vec<MessageRequest> {
        self.requests.lock().unwrap().clone()
    }
}

#[async_trait]
impl LlmClient for MockLlmClient {
    fn provider_name(&self) -> &'static str {
        "mock"
    }
    fn model(&self) -> &str {
        "mock-model"
    }
    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps {
            tool_use: true,
            prompt_cache: false,
            thinking: false,
            streaming: false,
        }
    }
    async fn create_message(&self, req: MessageRequest) -> LlmResult<MessageResponse> {
        self.requests.lock().unwrap().push(req);
        match self.queue.lock().unwrap().pop_front() {
            Some(outcome) => outcome,
            None => Err(LlmError::Other("mock queue empty".into())),
        }
    }
}

/// Helper — build an `Assistant` text response that ends the turn.
pub fn assistant_text(text: &str) -> MessageResponse {
    MessageResponse {
        id: "mock".into(),
        message: Message {
            id: MessageId::new(),
            role: Role::Assistant,
            content: vec![ContentBlock::text(text)],
            created_at: chrono::Utc::now(),
        },
        usage: Usage {
            input_tokens: 1,
            output_tokens: 1,
            ..Default::default()
        },
        stop_reason: StopReason::EndTurn,
    }
}

/// Helper — build an `Assistant` response that requests one or more tool calls.
pub fn assistant_tool_call(calls: Vec<(&str, &str, Value)>) -> MessageResponse {
    let blocks = calls
        .into_iter()
        .map(|(id, name, input)| ContentBlock::tool_use(id, name, input))
        .collect::<Vec<_>>();
    MessageResponse {
        id: "mock".into(),
        message: Message {
            id: MessageId::new(),
            role: Role::Assistant,
            content: blocks,
            created_at: chrono::Utc::now(),
        },
        usage: Usage {
            input_tokens: 1,
            output_tokens: 1,
            ..Default::default()
        },
        stop_reason: StopReason::ToolUse,
    }
}

/// Trivial tool — echoes its `text` argument back. Used to keep tests
/// hermetic (no filesystem dependencies).
pub struct EchoTool;

#[async_trait]
impl Tool for EchoTool {
    fn name(&self) -> &str {
        "Echo"
    }
    fn description(&self) -> &str {
        "Echo the `text` argument back."
    }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {"text": {"type": "string"}},
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
        let text = input
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("missing 'text'".into()))?;
        Ok(ToolOutput::text(format!("echo: {text}")))
    }
}

/// Returns a tool result block reference helper for assertions.
pub fn first_tool_result(content: &[ContentBlock]) -> Option<(ToolUseId, String, bool)> {
    for b in content {
        if let ContentBlock::ToolResult {
            tool_use_id,
            content,
            is_error,
        } = b
        {
            let text = content
                .iter()
                .find_map(|c| match c {
                    ContentBlock::Text { text } => Some(text.clone()),
                    _ => None,
                })
                .unwrap_or_default();
            return Some((tool_use_id.clone(), text, *is_error));
        }
    }
    None
}
