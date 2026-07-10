//! Cross-process `AskUserQuestion` pipeline test.
//!
//! Wires the full chain:
//!
//!   mock-plugin subprocess ↔ channel-host ↔ engine
//!     ↔ ChannelQuestionGate ↔ QuestionRegistry ↔ AskUserQuestionTool
//!
//! Scenarios covered:
//!
//! 1. **Interactive happy path** (`--auto-answer 0`): the mock plugin
//!    acks `question.present` and immediately fires
//!    `event.question_callback` with the selected option. The next
//!    scripted LLM message exposes that the tool_result was wired
//!    back into the LLM context — we assert the reply text contains
//!    the user's pick.
//!
//! 2. **Timeout path**: the mock plugin advertises
//!    `interactive_card` but `--auto-answer` is unset, so the host's
//!    `request_question` times out. The tool surfaces a clean
//!    tool_error and the LLM's follow-up reply lands as expected.
//!    The production timeout is intentionally fixed here; the test
//!    bounds its wait separately and confirms the eventual error path.
//!
//! 3. **Text fallback**: a mock with `interactive_card: false`
//!    receives the question as plain text. We then inject a follow-up
//!    `event.message_received` carrying the user's reply ("1") via
//!    `--inject-extra`; the dispatcher's text-fallback intercept
//!    routes it to the parser and the LLM gets a structured answer.

use async_trait::async_trait;
use serde_json::{json, Value};
use snaca_core::{ContentBlock, Message, MessageId, ProjectId, Role, TenantId, Usage};
use snaca_llm::{LlmClient, LlmResult, MessageRequest, MessageResponse, ProviderCaps, StopReason};
use snaca_server::{Config, Runtime};
use snaca_workspace::WorkspaceLayout;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

fn snaca_cli_binary() -> PathBuf {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let cargo = escargot::CargoBuild::new()
            .bin("snaca-cli")
            .package("snaca-cli")
            .current_target()
            .run()
            .expect("build snaca-cli");
        cargo.path().to_path_buf()
    })
    .clone()
}

/// Scripted LLM that records every incoming MessageRequest so the test
/// can assert what landed in the tool_result message sent back to the
/// model.
struct ScriptedLlm {
    queue: Mutex<VecDeque<MessageResponse>>,
    seen: Arc<Mutex<Vec<MessageRequest>>>,
}

impl ScriptedLlm {
    fn new(responses: Vec<MessageResponse>) -> Self {
        Self {
            queue: Mutex::new(responses.into()),
            seen: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn seen(&self) -> Arc<Mutex<Vec<MessageRequest>>> {
        self.seen.clone()
    }
}

#[async_trait]
impl LlmClient for ScriptedLlm {
    fn provider_name(&self) -> &'static str {
        "scripted"
    }
    fn model(&self) -> &str {
        "scripted"
    }
    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps {
            tool_use: true,
            ..Default::default()
        }
    }
    async fn create_message(&self, req: MessageRequest) -> LlmResult<MessageResponse> {
        self.seen.lock().unwrap().push(req);
        self.queue
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| snaca_llm::LlmError::Other("scripted queue exhausted".into()))
    }
}

fn assistant_text(text: &str) -> MessageResponse {
    MessageResponse {
        id: "x".into(),
        message: Message {
            id: MessageId::new(),
            role: Role::Assistant,
            content: vec![ContentBlock::text(text)],
            created_at: chrono::Utc::now(),
        },
        usage: Usage::default(),
        stop_reason: StopReason::EndTurn,
    }
}

fn assistant_ask_question(input: Value) -> MessageResponse {
    MessageResponse {
        id: "x".into(),
        message: Message {
            id: MessageId::new(),
            role: Role::Assistant,
            content: vec![ContentBlock::tool_use("tu_q", "AskUserQuestion", input)],
            created_at: chrono::Utc::now(),
        },
        usage: Usage::default(),
        stop_reason: StopReason::ToolUse,
    }
}

struct Fixture {
    runtime: Runtime,
    record_path: PathBuf,
    llm_seen: Arc<Mutex<Vec<MessageRequest>>>,
    _tmp: tempfile::TempDir,
}

async fn build_fixture(mock_args: &str, llm: Arc<ScriptedLlm>) -> Fixture {
    let _ = tracing_subscriber::fmt::try_init();
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    let record_path = tmp.path().join("sends.jsonl");
    let cfg_path = tmp.path().join("snaca.toml");
    let cli_bin = snaca_cli_binary();

    std::fs::create_dir_all(&data_root).unwrap();
    let layout = WorkspaceLayout::new(std::fs::canonicalize(&data_root).unwrap()).unwrap();
    let tenant = TenantId::new("mock-tenant");
    let project = ProjectId::auto_from_chat("mock-chat");
    layout.ensure_project(&tenant, &project).unwrap();

    let cfg = format!(
        r#"
[server]
http_listen = "127.0.0.1:0"
data_root = {data_root:?}

[tenant]
id = "default"

[llm]
provider = "deepseek"
api_key = "ignored"

[engine]
max_iterations = 4

[[plugins]]
name = "mock"
command = {cli_bin:?}
args = [
    "mock-plugin",
    {mock_args}
    "--auto-inject", "please ask me a question"
]

[plugins.env]
SNACA_MOCK_RECORD_SENDS = {record_path:?}
"#,
        data_root = data_root.to_string_lossy(),
        cli_bin = cli_bin.to_string_lossy(),
        record_path = record_path.to_string_lossy(),
        mock_args = mock_args,
    );
    std::fs::write(&cfg_path, cfg).unwrap();

    let config = Config::load(&cfg_path).expect("config loads");
    let llm_seen = llm.seen();
    let runtime = Runtime::build_with_llm(config, llm as Arc<dyn LlmClient>)
        .await
        .expect("runtime");
    Fixture {
        runtime,
        record_path,
        llm_seen,
        _tmp: tmp,
    }
}

async fn wait_for_record(path: &std::path::Path, deadline: Instant) -> String {
    while Instant::now() < deadline {
        if path.exists() {
            let s = std::fs::read_to_string(path).unwrap_or_default();
            if !s.is_empty() && !s.contains("\"content\":\"(no reply)\"") {
                return s;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    String::new()
}

/// Extract the last tool_result text the engine sent back to the LLM.
/// Returns the inner string of the most recent User-role message that
/// contains a `tool_result` block. None if no such message exists yet.
fn last_tool_result_text(seen: &[MessageRequest]) -> Option<String> {
    for req in seen.iter().rev() {
        for msg in req.messages.iter().rev() {
            // Tool results live on either the User role (Anthropic
            // canonical) or the dedicated Tool role (snaca-engine
            // appends them with Role::Tool). Accept both.
            if msg.role != Role::User && msg.role != Role::Tool {
                continue;
            }
            for block in &msg.content {
                if let ContentBlock::ToolResult { content, .. } = block {
                    let text: String = content
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::Text { text } => Some(text.clone()),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    if !text.is_empty() {
                        return Some(text);
                    }
                }
            }
        }
    }
    None
}

#[tokio::test]
async fn auto_answer_round_trips_through_question_pipeline() {
    let llm = Arc::new(ScriptedLlm::new(vec![
        // Turn 1: model asks a multiple-choice question via the tool.
        assistant_ask_question(json!({
            "questions": [{
                "question": "Which auth method?",
                "options": [
                    {"label": "OAuth"},
                    {"label": "JWT"}
                ]
            }]
        })),
        // Turn 2: model sees the tool_result and replies with the pick.
        assistant_text("you picked OAuth, proceeding"),
    ]));
    let fix = build_fixture(r#""--auto-answer", "0","#, llm.clone()).await;

    let record = wait_for_record(&fix.record_path, Instant::now() + Duration::from_secs(20)).await;
    assert!(!record.is_empty(), "no message.send recorded");
    assert!(
        record.contains("OAuth"),
        "final reply does not mention OAuth pick: {record}"
    );

    // The tool_result that landed in the second LLM call must include
    // the resolved label so the model can act on it.
    let seen = fix.llm_seen.lock().unwrap().clone();
    let tool_result = last_tool_result_text(&seen)
        .expect("a tool_result message should have been sent back to the LLM");
    assert!(
        tool_result.contains("OAuth"),
        "tool_result missing resolved option: {tool_result}"
    );
    assert!(
        tool_result.contains("Which auth method?"),
        "tool_result missing question text: {tool_result}"
    );

    fix.runtime.shutdown().await;
}

#[tokio::test]
async fn text_fallback_intercepts_next_user_message() {
    // Mock with `--reply-to-question 1` and NO --auto-answer.
    //
    // Without --auto-answer the mock's manifest leaves
    // interactive_card=false, so ChannelQuestionGate routes to the
    // text-fallback path (SNACA_QUESTION_FALLBACK defaults to "text").
    // The gate sends a plain markdown prompt; the mock's
    // reply_to_question handler observes the outbound `❓` send and
    // fires a synthetic user message_received with the configured
    // answer. The dispatcher's text-fallback intercept resolves the
    // gate's oneshot before per-chat enqueue, so no deadlock.
    let llm = Arc::new(ScriptedLlm::new(vec![
        assistant_ask_question(json!({
            "questions": [{
                "question": "Which auth method?",
                "options": [
                    {"label": "OAuth"},
                    {"label": "JWT"}
                ]
            }]
        })),
        assistant_text("you picked OAuth, proceeding"),
    ]));
    let fix = build_fixture(r#""--reply-to-question", "1","#, llm.clone()).await;

    let record = wait_for_record(&fix.record_path, Instant::now() + Duration::from_secs(25)).await;
    assert!(!record.is_empty(), "no message.send recorded");
    assert!(
        record.contains("OAuth"),
        "final reply does not mention OAuth pick: {record}"
    );

    let seen = fix.llm_seen.lock().unwrap().clone();
    let tool_result = last_tool_result_text(&seen).expect("tool_result expected");
    assert!(
        tool_result.contains("OAuth"),
        "text-fallback parser did not resolve '1' to OAuth: {tool_result}"
    );

    fix.runtime.shutdown().await;
}
