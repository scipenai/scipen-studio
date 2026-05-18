//! Cross-process approval pipeline test.
//!
//! Wires the full chain: mock-plugin subprocess ↔ channel-host ↔ engine
//! ↔ ChannelApprovalGate ↔ ApprovalRegistry, with a scripted MockLlmClient
//! driving a Write-tool turn that requires approval.
//!
//! Two scenarios:
//! 1. `--auto-approval allow_always` → first turn round-trips through the
//!    plugin; the decision is persisted; the file lands on disk.
//! 2. `--auto-approval deny` → engine surfaces a tool_error, file remains
//!    untouched.

use async_trait::async_trait;
use serde_json::json;
use snaca_core::{ContentBlock, Message, MessageId, ProjectId, Role, TenantId, Usage};
use snaca_llm::{
    LlmClient, LlmResult, MessageRequest, MessageResponse, ProviderCaps, StopReason,
};
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

/// Minimal scripted LLM client. Tests pre-load it with one response per
/// expected `create_message` call.
struct ScriptedLlm {
    queue: Mutex<VecDeque<MessageResponse>>,
}

impl ScriptedLlm {
    fn new(responses: Vec<MessageResponse>) -> Self {
        Self {
            queue: Mutex::new(responses.into()),
        }
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
    async fn create_message(&self, _req: MessageRequest) -> LlmResult<MessageResponse> {
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

fn assistant_write_call(path: &str, content: &str) -> MessageResponse {
    MessageResponse {
        id: "x".into(),
        message: Message {
            id: MessageId::new(),
            role: Role::Assistant,
            content: vec![ContentBlock::tool_use(
                "tu_w",
                "Write",
                json!({"path": path, "content": content}),
            )],
            created_at: chrono::Utc::now(),
        },
        usage: Usage::default(),
        stop_reason: StopReason::ToolUse,
    }
}

struct Fixture {
    runtime: Runtime,
    record_path: PathBuf,
    workspace_dir: PathBuf,
    _tmp: tempfile::TempDir,
}

async fn build_fixture(auto_approval: &str, llm: Arc<dyn LlmClient>) -> Fixture {
    let _ = tracing_subscriber::fmt::try_init();
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    let record_path = tmp.path().join("sends.jsonl");
    let cfg_path = tmp.path().join("snaca.toml");
    let cli_bin = snaca_cli_binary();

    std::fs::create_dir_all(&data_root).unwrap();
    let layout = WorkspaceLayout::new(std::fs::canonicalize(&data_root).unwrap()).unwrap();
    // The mock plugin's `--auto-inject` injects an event with
    // `tenant_id: "mock-tenant"`; multi-tenant routing now honors that
    // over the server's config-default, so the workspace lives under
    // `<data_root>/mock-tenant/projects/<auto_from_chat("mock-chat")>/workspace`.
    let tenant = TenantId::new("mock-tenant");
    let project = ProjectId::auto_from_chat("mock-chat");
    layout.ensure_project(&tenant, &project).unwrap();
    let workspace_dir = layout.workspace_dir(&tenant, &project);

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
    "--auto-approval", "{auto_approval}",
    "--auto-inject", "please write something"
]

[plugins.env]
SNACA_MOCK_RECORD_SENDS = {record_path:?}
"#,
        data_root = data_root.to_string_lossy(),
        cli_bin = cli_bin.to_string_lossy(),
        record_path = record_path.to_string_lossy(),
    );
    std::fs::write(&cfg_path, cfg).unwrap();

    let config = Config::load(&cfg_path).expect("config loads");
    let runtime = Runtime::build_with_llm(config, llm).await.expect("runtime");
    Fixture {
        runtime,
        record_path,
        workspace_dir,
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

#[tokio::test]
async fn auto_approve_lets_write_tool_run() {
    let llm = Arc::new(ScriptedLlm::new(vec![
        assistant_write_call("hello.txt", "approved!\n"),
        assistant_text("file written"),
    ]));
    let fix = build_fixture("allow_always", llm).await;

    let record = wait_for_record(&fix.record_path, Instant::now() + Duration::from_secs(15)).await;
    assert!(!record.is_empty(), "no message.send recorded");
    assert!(record.contains("file written"), "got: {record}");

    let target = fix.workspace_dir.join("hello.txt");
    assert!(target.is_file(), "Write tool did not produce file");
    let on_disk = std::fs::read_to_string(&target).unwrap();
    assert_eq!(on_disk, "approved!\n");

    fix.runtime.shutdown().await;
}

#[tokio::test]
async fn auto_deny_blocks_write_tool_with_tool_error() {
    let llm = Arc::new(ScriptedLlm::new(vec![
        assistant_write_call("blocked.txt", "must-not-land"),
        assistant_text("write was blocked, sorry"),
    ]));
    let fix = build_fixture("deny", llm).await;

    let record = wait_for_record(&fix.record_path, Instant::now() + Duration::from_secs(15)).await;
    assert!(!record.is_empty(), "no message.send recorded");
    assert!(record.contains("blocked"), "expected denial reflection in reply: {record}");

    let target = fix.workspace_dir.join("blocked.txt");
    assert!(
        !target.exists(),
        "Write tool produced file despite deny gate"
    );

    fix.runtime.shutdown().await;
}
