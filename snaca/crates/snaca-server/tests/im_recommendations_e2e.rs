//! E2E coverage for IM interaction recommendations such as attachment import,
//! long reply splitting, approval cards, and question flows.

use async_trait::async_trait;
use data_encoding::BASE64;
use serde_json::{json, Value};
use snaca_core::{ContentBlock, Message, MessageId, Role, Usage};
use snaca_llm::{
    LlmClient, LlmError, LlmResult, MessageRequest, MessageResponse, ProviderCaps, StopReason,
};
use snaca_server::{Config, Runtime};
use snaca_workspace::WorkspaceLayout;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
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

fn assistant_text(text: impl Into<String>) -> MessageResponse {
    MessageResponse {
        id: "scripted".into(),
        message: Message {
            id: MessageId::new(),
            role: Role::Assistant,
            content: vec![ContentBlock::text(text.into())],
            created_at: chrono::Utc::now(),
        },
        usage: Usage::default(),
        stop_reason: StopReason::EndTurn,
    }
}

fn assistant_tool(name: &str, id: &str, input: Value) -> MessageResponse {
    MessageResponse {
        id: "scripted-tool".into(),
        message: Message {
            id: MessageId::new(),
            role: Role::Assistant,
            content: vec![ContentBlock::tool_use(id, name, input)],
            created_at: chrono::Utc::now(),
        },
        usage: Usage::default(),
        stop_reason: StopReason::ToolUse,
    }
}

struct ConstantLlm {
    text: String,
    calls: AtomicUsize,
}

impl ConstantLlm {
    fn new(text: &str) -> Self {
        Self {
            text: text.into(),
            calls: AtomicUsize::new(0),
        }
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl LlmClient for ConstantLlm {
    fn provider_name(&self) -> &'static str {
        "constant"
    }

    fn model(&self) -> &str {
        "constant"
    }

    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps {
            tool_use: true,
            ..Default::default()
        }
    }

    async fn create_message(&self, _req: MessageRequest) -> LlmResult<MessageResponse> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(assistant_text(self.text.clone()))
    }
}

struct ScriptedLlm {
    queue: Mutex<VecDeque<MessageResponse>>,
    calls: AtomicUsize,
}

impl ScriptedLlm {
    fn new(responses: Vec<MessageResponse>) -> Self {
        Self {
            queue: Mutex::new(responses.into()),
            calls: AtomicUsize::new(0),
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
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.queue
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| LlmError::Other("scripted queue exhausted".into()))
    }
}

struct RecallLlm {
    calls: AtomicUsize,
}

impl RecallLlm {
    fn new() -> Self {
        Self {
            calls: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl LlmClient for RecallLlm {
    fn provider_name(&self) -> &'static str {
        "recall"
    }

    fn model(&self) -> &str {
        "recall"
    }

    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps {
            tool_use: true,
            ..Default::default()
        }
    }

    async fn create_message(&self, _req: MessageRequest) -> LlmResult<MessageResponse> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst);
        if call == 0 {
            tokio::time::sleep(Duration::from_secs(20)).await;
            Ok(assistant_text("should not finish"))
        } else {
            Ok(assistant_text("after recall ok"))
        }
    }
}

async fn wait_for_file_contains(path: &Path, needle: &str, timeout: Duration) -> String {
    let deadline = Instant::now() + timeout;
    let mut text = String::new();
    while Instant::now() < deadline {
        if path.exists() {
            text = std::fs::read_to_string(path).unwrap_or_default();
            if text.contains(needle) {
                return text;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    text
}

fn read_jsonl(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

fn base_config(
    tmp: &tempfile::TempDir,
    args: &[&str],
    env: &[(&str, &Path)],
    extra_server: &str,
    extra_engine: &str,
) -> PathBuf {
    let data_root = tmp.path().join("data");
    base_config_with_data_root(tmp, &data_root, args, env, extra_server, extra_engine)
}

fn base_config_with_data_root(
    tmp: &tempfile::TempDir,
    data_root: &Path,
    args: &[&str],
    env: &[(&str, &Path)],
    extra_server: &str,
    extra_engine: &str,
) -> PathBuf {
    let cfg_path = tmp.path().join("snaca.toml");
    let cli_bin = snaca_cli_binary();
    let args_toml = args
        .iter()
        .map(|a| format!("{a:?}"))
        .collect::<Vec<_>>()
        .join(", ");
    let env_toml = env
        .iter()
        .map(|(k, v)| format!("{k} = {:?}", v.to_string_lossy()))
        .collect::<Vec<_>>()
        .join("\n");
    let cfg = format!(
        r#"
[server]
http_listen = "127.0.0.1:0"
data_root = {data_root:?}
{extra_server}

[tenant]
id = "default"

[llm]
provider = "deepseek"
api_key = "ignored"
model = "mock"

[engine]
max_iterations = 5
memory_extractor = false
{extra_engine}

[im_input]
assembly_enabled = false

[admin]
enabled = true
token = "test-token"

[[plugins]]
name = "mock"
command = {cli_bin:?}
args = [{args_toml}]

[plugins.env]
{env_toml}
"#,
        data_root = data_root.to_string_lossy(),
        cli_bin = cli_bin.to_string_lossy(),
        args_toml = args_toml,
        env_toml = env_toml,
        extra_server = extra_server,
        extra_engine = extra_engine,
    );
    std::fs::write(&cfg_path, cfg).unwrap();
    cfg_path
}

#[tokio::test]
async fn recalled_running_message_aborts_only_that_turn() {
    let _ = tracing_subscriber::fmt::try_init();
    let tmp = tempfile::tempdir().unwrap();
    let record_path = tmp.path().join("sends.jsonl");
    let cfg_path = base_config(
        &tmp,
        &[
            "mock-plugin",
            "--auto-inject",
            "slow please",
            "--inject-message-id",
            "recall-target",
            "--recall-auto-inject-after-ms",
            "500",
            "--inject-extra",
            "mock-chat:second ping",
        ],
        &[("SNACA_MOCK_RECORD_SENDS", record_path.as_path())],
        "",
        "",
    );
    let runtime = Runtime::build_with_llm(
        Config::load(&cfg_path).unwrap(),
        Arc::new(RecallLlm::new()) as Arc<dyn LlmClient>,
    )
    .await
    .unwrap();

    let record =
        wait_for_file_contains(&record_path, "after recall ok", Duration::from_secs(15)).await;
    runtime.shutdown().await;

    assert!(
        record.contains("after recall ok"),
        "later message did not complete after recall: {record}"
    );
    assert!(
        !record.contains("should not finish"),
        "recalled turn was not aborted: {record}"
    );
}

#[tokio::test]
async fn send_file_uploads_workspace_file_to_plugin() {
    let _ = tracing_subscriber::fmt::try_init();
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    std::fs::create_dir_all(&data_root).unwrap();
    let layout = WorkspaceLayout::new(std::fs::canonicalize(&data_root).unwrap()).unwrap();
    let tenant = snaca_core::TenantId::new("mock-tenant");
    let project = snaca_core::ProjectId::auto_from_chat("mock-chat");
    layout.ensure_project(&tenant, &project).unwrap();
    let workspace_dir = layout.workspace_dir(&tenant, &project);
    std::fs::write(workspace_dir.join("report.md"), "# report\nhello\n").unwrap();

    let upload_path = tmp.path().join("uploads.jsonl");
    let send_path = tmp.path().join("sends.jsonl");
    let cfg_path = base_config_with_data_root(
        &tmp,
        &data_root,
        &[
            "mock-plugin",
            "--file-upload-supported",
            "--auto-inject",
            "send file",
        ],
        &[
            ("SNACA_MOCK_RECORD_UPLOADS", upload_path.as_path()),
            ("SNACA_MOCK_RECORD_SENDS", send_path.as_path()),
        ],
        "",
        "",
    );
    let llm = Arc::new(ScriptedLlm::new(vec![
        assistant_tool(
            "SendFile",
            "tu_send",
            json!({"path": "report.md", "filename": "final-report.md"}),
        ),
        assistant_text("file queued"),
    ]));
    let runtime = Runtime::build_with_llm(Config::load(&cfg_path).unwrap(), llm)
        .await
        .unwrap();

    let uploads =
        wait_for_file_contains(&upload_path, "final-report.md", Duration::from_secs(15)).await;
    runtime.shutdown().await;

    let rows = read_jsonl(&upload_path);
    assert_eq!(rows.len(), 1, "unexpected upload rows: {uploads}");
    assert_eq!(rows[0]["tenant_id"], "mock-tenant");
    assert_eq!(rows[0]["chat_id"], "mock-chat");
    assert_eq!(rows[0]["filename"], "final-report.md");
    let bytes = BASE64
        .decode(rows[0]["bytes_base64"].as_str().unwrap().as_bytes())
        .unwrap();
    assert_eq!(bytes, b"# report\nhello\n");
}

#[tokio::test]
async fn outbox_retries_after_plugin_disconnect_on_first_send() {
    let _ = tracing_subscriber::fmt::try_init();
    let tmp = tempfile::tempdir().unwrap();
    let record_path = tmp.path().join("sends.jsonl");
    let marker_path = tmp.path().join("first-send-failed.marker");
    let cfg_path = base_config(
        &tmp,
        &["mock-plugin", "--auto-inject", "please retry"],
        &[
            ("SNACA_MOCK_RECORD_SENDS", record_path.as_path()),
            ("SNACA_MOCK_FAIL_FIRST_SEND_ONCE", marker_path.as_path()),
        ],
        "",
        "",
    );
    let runtime = Runtime::build_with_llm(
        Config::load(&cfg_path).unwrap(),
        Arc::new(ConstantLlm::new("retry-ok")) as Arc<dyn LlmClient>,
    )
    .await
    .unwrap();

    let record = wait_for_file_contains(&record_path, "retry-ok", Duration::from_secs(50)).await;
    runtime.shutdown().await;

    assert!(
        marker_path.exists(),
        "mock did not inject first-send failure"
    );
    assert!(
        record.contains("retry-ok"),
        "outbox retry did not deliver: {record}"
    );
    let rows = read_jsonl(&record_path);
    assert_eq!(rows.len(), 1, "only the retry should be recorded: {record}");
    assert!(
        rows[0]["idempotency_key"].as_str().is_some(),
        "retry payload should preserve an idempotency key: {record}"
    );
}

#[tokio::test]
async fn scheduler_fire_path_injects_mock_im_turn_and_sends_reply() {
    let _ = tracing_subscriber::fmt::try_init();
    let tmp = tempfile::tempdir().unwrap();
    let record_path = tmp.path().join("sends.jsonl");
    let cfg_path = base_config(
        &tmp,
        &["mock-plugin"],
        &[("SNACA_MOCK_RECORD_SENDS", record_path.as_path())],
        "scheduler_tick_period_secs = 1\nscheduler_batch_size = 10",
        "",
    );
    let runtime = Runtime::build_with_llm(
        Config::load(&cfg_path).unwrap(),
        Arc::new(ConstantLlm::new("scheduled-ok")) as Arc<dyn LlmClient>,
    )
    .await
    .unwrap();

    let client = reqwest::Client::new();
    let url = format!("http://{}/api/v1/schedules", runtime.http_handle.local_addr);
    let create = client
        .post(&url)
        .bearer_auth("test-token")
        .json(&json!({
            "tenant_id": "mock-tenant",
            "project_id": "proj-scheduled",
            "chat_id": "mock-chat",
            "plugin": "mock",
            "prompt": "scheduled prompt",
            "next_fire_at": (chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339(),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(create.status(), 201);

    let record =
        wait_for_file_contains(&record_path, "scheduled-ok", Duration::from_secs(12)).await;
    runtime.shutdown().await;

    assert!(
        record.contains("scheduled-ok"),
        "scheduled task did not flow through IM turn: {record}"
    );
}

#[tokio::test]
async fn duplicate_inbound_message_id_is_processed_once() {
    let _ = tracing_subscriber::fmt::try_init();
    let tmp = tempfile::tempdir().unwrap();
    let record_path = tmp.path().join("sends.jsonl");
    let cfg_path = base_config(
        &tmp,
        &[
            "mock-plugin",
            "--auto-inject",
            "dedup please",
            "--inject-message-id",
            "dup-1",
            "--inject-extra",
            "mock-chat:id=dup-1:duplicate replay",
        ],
        &[("SNACA_MOCK_RECORD_SENDS", record_path.as_path())],
        "",
        "",
    );
    let llm = Arc::new(ConstantLlm::new("dedup-ok"));
    let runtime = Runtime::build_with_llm(
        Config::load(&cfg_path).unwrap(),
        llm.clone() as Arc<dyn LlmClient>,
    )
    .await
    .unwrap();

    let record = wait_for_file_contains(&record_path, "dedup-ok", Duration::from_secs(10)).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    runtime.shutdown().await;

    let rows = read_jsonl(&record_path);
    assert_eq!(llm.calls(), 1, "LLM should be called once; sends: {record}");
    assert_eq!(
        rows.len(),
        1,
        "duplicate should not produce a second send: {record}"
    );
    assert_eq!(rows[0]["content"], "dedup-ok");
}
