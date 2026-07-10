//! End-to-end test for the IM-attachment-staging flow.
//!
//! Boots a real `Runtime` with a single mock plugin that:
//!   - auto-injects one `event.message_received` carrying an `Attachment`
//!   - serves that attachment's bytes when the host calls `file.download`
//!
//! The dispatcher should pull the attachment and drop it into the
//! project's workspace dir as a regular file. We assert by reading
//! the file off disk after the round trip completes.
//!
//! Note: the dispatcher used to also chunk + embed each attachment
//! into the memory vector store. That pipeline was removed when the
//! engine adopted the frozen-snapshot memory model — attachments now
//! live only as workspace files; the LLM decides whether to persist
//! anything via `MemoryWrite`.

use async_trait::async_trait;
use snaca_core::{Message, MessageId, ProjectId, Role, TenantId, Usage};
use snaca_llm::{LlmClient, LlmResult, MessageRequest, MessageResponse, ProviderCaps, StopReason};
use snaca_server::{Config, Runtime};
use snaca_workspace::WorkspaceLayout;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
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

struct ConstantLlm {
    text: String,
    calls: AtomicUsize,
    last_user_text: std::sync::Mutex<Option<String>>,
    user_texts: std::sync::Mutex<Vec<String>>,
}

impl ConstantLlm {
    fn new(text: &str) -> Self {
        Self {
            text: text.into(),
            calls: AtomicUsize::new(0),
            last_user_text: std::sync::Mutex::new(None),
            user_texts: std::sync::Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl LlmClient for ConstantLlm {
    fn provider_name(&self) -> &'static str {
        "constant-mock"
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
    async fn create_message(&self, req: MessageRequest) -> LlmResult<MessageResponse> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        let last_user_text = req
            .messages
            .iter()
            .rev()
            .find(|m| m.role == Role::User)
            .map(|m| {
                m.content
                    .iter()
                    .filter_map(|b| match b {
                        snaca_core::ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            });
        if let Some(text) = last_user_text.clone() {
            self.user_texts.lock().unwrap().push(text);
        }
        *self.last_user_text.lock().unwrap() = last_user_text;
        Ok(MessageResponse {
            id: "constant".into(),
            message: Message {
                id: MessageId::new(),
                role: Role::Assistant,
                content: vec![snaca_core::ContentBlock::text(self.text.clone())],
                created_at: chrono::Utc::now(),
            },
            usage: Usage {
                input_tokens: 1,
                output_tokens: 1,
                ..Default::default()
            },
            stop_reason: StopReason::EndTurn,
        })
    }
}

#[tokio::test]
async fn attachment_lands_in_workspace_dir() {
    let _ = tracing_subscriber::fmt::try_init();
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    let cfg_path = tmp.path().join("snaca.toml");
    let cli_bin = snaca_cli_binary();

    // Inject one user message + one attachment. The dispatcher should
    // stage the attachment into the workspace dir, then run the turn.
    let cfg = format!(
        r#"
[server]
http_listen = "127.0.0.1:0"
data_root = {data_root:?}

[tenant]
id = "default"

[llm]
api_key = "ignored"
model = "constant"

[engine]
memory_extractor = false

[[plugins]]
name = "mock"
command = {cli_bin:?}
args = [
    "mock-plugin",
    "--auto-inject",
    "look at the spec",
    "--inject-attachment",
    "att-1:spec.md:project conventions: kebab-case file names",
]
"#,
        data_root = data_root.to_string_lossy(),
        cli_bin = cli_bin.to_string_lossy(),
    );
    std::fs::write(&cfg_path, cfg).unwrap();

    let config = Config::load(&cfg_path).expect("config loads");
    let llm = Arc::new(ConstantLlm::new("noted"));
    let runtime = Runtime::build_with_llm(config, llm.clone())
        .await
        .expect("runtime starts");

    let tenant = TenantId::new("mock-tenant");
    let project = ProjectId::auto_from_chat("mock-chat");

    // Wait up to 10s for the attachment to land in the workspace dir.
    // The dispatcher stages synchronously *before* the LLM turn, so
    // the file appearing under `<workspace>/spec.md` is the success
    // signal.
    let layout = WorkspaceLayout::new(std::fs::canonicalize(&data_root).unwrap()).unwrap();
    let workspace_dir = layout.workspace_dir(&tenant, &project);
    let target = workspace_dir.join("spec.md");

    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if target.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        target.exists(),
        "expected attachment to land in workspace dir at {}",
        target.display()
    );
    let body = std::fs::read_to_string(&target).expect("read staged attachment");
    assert!(
        body.contains("kebab-case"),
        "staged attachment lost its content; got: {body:?}"
    );

    // The LLM was eventually invoked too — attachment staging must
    // not block the turn from running.
    wait_for_llm_calls(&llm, 1).await;

    runtime.shutdown().await;
}

async fn wait_for_llm_calls(llm: &ConstantLlm, expected: usize) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if llm.calls.load(Ordering::Relaxed) >= expected {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!(
        "LLM call count stayed below {expected}; got {}",
        llm.calls.load(Ordering::Relaxed)
    );
}
