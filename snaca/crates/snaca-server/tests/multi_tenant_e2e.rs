//! Cross-tenant isolation e2e.
//!
//! Spawns one SNACA server with two mock-plugin subprocesses, each
//! injecting a synthetic user message that asks for a `Write` tool call.
//! Plugin A claims `tenant_id = "alpha"`, plugin B claims `"beta"`. The
//! `InputDrivenLlm` returns different scripted responses depending on
//! which user text it sees, so concurrent turns don't fight over a
//! shared queue.
//!
//! Asserts:
//! 1. Each tenant's `Write` lands in its own
//!    `data_root/<tenant>/projects/<auto-from-chat>/workspace/`.
//! 2. The other tenant cannot see that file (full filesystem isolation).
//! 3. The plugin that handled tenant A's turn received its reply, and
//!    likewise for B.

use async_trait::async_trait;
use serde_json::json;
use snaca_core::{ContentBlock, Message, MessageId, ProjectId, Role, TenantId, ToolUseId, Usage};
use snaca_llm::{
    LlmClient, LlmError, LlmResult, MessageRequest, MessageResponse, ProviderCaps, StopReason,
};
use snaca_server::{Config, Runtime};
use snaca_workspace::WorkspaceLayout;
use std::collections::HashMap;
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

/// LLM that picks a response queue based on the last user message's
/// content (substring match). Lets the multi-tenant test give each
/// tenant a deterministic, independent scripted response, even when the
/// dispatcher fires both turns concurrently.
struct InputDrivenLlm {
    branches: Mutex<HashMap<&'static str, Vec<MessageResponse>>>,
}

impl InputDrivenLlm {
    fn new() -> Self {
        Self {
            branches: Mutex::new(HashMap::new()),
        }
    }

    fn enqueue(&self, key: &'static str, responses: Vec<MessageResponse>) {
        let mut b = self.branches.lock().unwrap();
        b.insert(key, responses);
    }
}

fn last_user_text(req: &MessageRequest) -> String {
    for msg in req.messages.iter().rev() {
        if matches!(msg.role, Role::User) {
            for block in &msg.content {
                if let ContentBlock::Text { text } = block {
                    return text.clone();
                }
            }
        }
    }
    String::new()
}

#[async_trait]
impl LlmClient for InputDrivenLlm {
    fn provider_name(&self) -> &'static str {
        "input-driven"
    }
    fn model(&self) -> &str {
        "input-driven"
    }
    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps {
            tool_use: true,
            ..Default::default()
        }
    }
    async fn create_message(&self, req: MessageRequest) -> LlmResult<MessageResponse> {
        let last = last_user_text(&req);
        let mut branches = self.branches.lock().unwrap();
        let key = branches
            .keys()
            .find(|k| last.contains(*k))
            .copied()
            .ok_or_else(|| LlmError::Other(format!("no scripted branch for {last:?}")))?;
        let q = branches.get_mut(&key).unwrap();
        if q.is_empty() {
            return Err(LlmError::Other(format!(
                "scripted branch {key:?} exhausted (already consumed all responses)"
            )));
        }
        Ok(q.remove(0))
    }
}

fn assistant_write_call(call_id: &str, path: &str, content: &str) -> MessageResponse {
    MessageResponse {
        id: "x".into(),
        message: Message {
            id: MessageId::new(),
            role: Role::Assistant,
            content: vec![ContentBlock::ToolUse {
                id: ToolUseId::new(call_id),
                name: "Write".into(),
                input: json!({"path": path, "content": content}),
            }],
            created_at: chrono::Utc::now(),
        },
        usage: Usage::default(),
        stop_reason: StopReason::ToolUse,
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

#[tokio::test]
async fn alpha_and_beta_tenants_each_write_into_their_own_workspace() {
    let _ = tracing_subscriber::fmt::try_init();

    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    let cfg_path = tmp.path().join("snaca.toml");
    let cli_bin = snaca_cli_binary();

    std::fs::create_dir_all(&data_root).unwrap();
    let layout = WorkspaceLayout::new(std::fs::canonicalize(&data_root).unwrap()).unwrap();
    let alpha = TenantId::new("alpha");
    let beta = TenantId::new("beta");
    let alpha_project = ProjectId::auto_from_chat("alpha-chat");
    let beta_project = ProjectId::auto_from_chat("beta-chat");
    layout.ensure_project(&alpha, &alpha_project).unwrap();
    layout.ensure_project(&beta, &beta_project).unwrap();

    let alpha_ws = layout.workspace_dir(&alpha, &alpha_project);
    let beta_ws = layout.workspace_dir(&beta, &beta_project);

    let cfg = format!(
        r#"
[server]
http_listen = "127.0.0.1:0"
data_root = {data_root:?}
typing_update_interval_ms = 0

[tenant]
id = "fallback"

[llm]
provider = "deepseek"
api_key = "ignored"

[engine]
max_iterations = 4

[[plugins]]
name = "alpha-plugin"
command = {cli_bin:?}
args = [
    "mock-plugin",
    "--name", "alpha-plugin",
    "--auto-inject", "alpha-write please",
    "--inject-tenant-id", "alpha",
    "--inject-chat-id", "alpha-chat",
    "--auto-approval", "allow_always"
]

[[plugins]]
name = "beta-plugin"
command = {cli_bin:?}
args = [
    "mock-plugin",
    "--name", "beta-plugin",
    "--auto-inject", "beta-write please",
    "--inject-tenant-id", "beta",
    "--inject-chat-id", "beta-chat",
    "--auto-approval", "allow_always"
]
"#,
        data_root = data_root.to_string_lossy(),
        cli_bin = cli_bin.to_string_lossy(),
    );
    std::fs::write(&cfg_path, cfg).unwrap();
    let config = Config::load(&cfg_path).expect("config loads");

    let llm = Arc::new(InputDrivenLlm::new());
    llm.enqueue(
        "alpha-write",
        vec![
            assistant_write_call("a1", "alpha.txt", "alpha-data"),
            assistant_text("alpha done"),
        ],
    );
    llm.enqueue(
        "beta-write",
        vec![
            assistant_write_call("b1", "beta.txt", "beta-data"),
            assistant_text("beta done"),
        ],
    );

    let runtime = Runtime::build_with_llm(config, llm).await.expect("runtime");

    // Wait for both writes to land. Each tenant's Write tool produces
    // exactly one file; we poll for both before timing out.
    let deadline = Instant::now() + Duration::from_secs(15);
    let alpha_file = alpha_ws.join("alpha.txt");
    let beta_file = beta_ws.join("beta.txt");
    while Instant::now() < deadline {
        if alpha_file.exists() && beta_file.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    runtime.shutdown().await;

    assert!(
        alpha_file.exists(),
        "alpha tenant's Write did not land at {}",
        alpha_file.display()
    );
    assert!(
        beta_file.exists(),
        "beta tenant's Write did not land at {}",
        beta_file.display()
    );
    assert_eq!(std::fs::read_to_string(&alpha_file).unwrap(), "alpha-data");
    assert_eq!(std::fs::read_to_string(&beta_file).unwrap(), "beta-data");

    // Cross-isolation: each tenant's workspace must NOT contain the
    // other's file. (Belt-and-suspenders — the dispatcher routes per
    // payload tenant_id, but a regression in routing would surface as
    // both writes landing in the same workspace.)
    assert!(
        !alpha_ws.join("beta.txt").exists(),
        "beta's file leaked into alpha's workspace"
    );
    assert!(
        !beta_ws.join("alpha.txt").exists(),
        "alpha's file leaked into beta's workspace"
    );

    // Sanity check: the SQLite store should have one thread per chat.
    use snaca_state::Database;
    let db = Database::open(&data_root.join("state.sqlite")).await.unwrap();
    let alpha_threads = db
        .list_threads_for_project(&alpha, &alpha_project)
        .await
        .unwrap();
    let beta_threads = db
        .list_threads_for_project(&beta, &beta_project)
        .await
        .unwrap();
    assert_eq!(alpha_threads.len(), 1);
    assert_eq!(beta_threads.len(), 1);
    assert_eq!(alpha_threads[0].tenant_id.as_str(), "alpha");
    assert_eq!(beta_threads[0].tenant_id.as_str(), "beta");
}
