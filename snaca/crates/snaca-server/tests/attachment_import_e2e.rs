//! End-to-end test for the IM-attachment-import flow.
//!
//! Boots a real `Runtime` with a single mock plugin that:
//!   - auto-injects one `event.message_received` carrying an `Attachment`
//!   - serves that attachment's bytes when the host calls `file.download`
//!
//! The dispatcher should pull the attachment, run it through
//! `engine.import_attachment`, and write a memory entry under the
//! project's reference scope. We assert by reading the on-disk memory
//! tree once the round trip completes.

use async_trait::async_trait;
use snaca_core::{Message, MessageId, ProjectId, Role, TenantId, Usage};
use snaca_llm::{
    LlmClient, LlmResult, MessageRequest, MessageResponse, ProviderCaps, StopReason,
};
use snaca_memory::{MemoryScope, MemoryStore};
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
}

impl ConstantLlm {
    fn new(text: &str) -> Self {
        Self {
            text: text.into(),
            calls: AtomicUsize::new(0),
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
    async fn create_message(&self, _req: MessageRequest) -> LlmResult<MessageResponse> {
        self.calls.fetch_add(1, Ordering::Relaxed);
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
async fn attachment_lands_as_memory_entry_before_turn() {
    let _ = tracing_subscriber::fmt::try_init();
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    let cfg_path = tmp.path().join("snaca.toml");
    let cli_bin = snaca_cli_binary();

    // Inject one user message + one attachment. The dispatcher should
    // import the attachment first, then run the turn.
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

    // The mock plugin's `inject_tenant_id`/`inject_chat_id` defaults
    // give us deterministic routing. Project is the chat-id-derived
    // auto slug.
    let tenant = TenantId::new("mock-tenant");
    let project = ProjectId::auto_from_chat("mock-chat");

    // Wait up to 10s for the attachment to land in the memory tree.
    // The dispatcher imports synchronously *before* the LLM turn, so
    // an entry under `reference/` is the success signal.
    let layout = WorkspaceLayout::new(std::fs::canonicalize(&data_root).unwrap()).unwrap();
    let store = MemoryStore::new(layout.memory_dir(&tenant, &project));

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut names = Vec::new();
    while Instant::now() < deadline {
        names = store.list(MemoryScope::Reference).await.unwrap_or_default();
        if !names.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        !names.is_empty(),
        "expected an attachment-derived memory entry; got: {names:?}"
    );
    let landed = names.iter().any(|n| n.contains("spec"));
    assert!(landed, "expected `spec`-derived entry; got names: {names:?}");

    // Read the entry and confirm the inlined content actually made
    // it through file.download → import_one.
    let stem = names.iter().find(|n| n.contains("spec")).unwrap().clone();
    let entry = store.read(MemoryScope::Reference, &stem).await.unwrap();
    assert!(
        entry.content.contains("kebab-case"),
        "import did not preserve content; got: {:?}",
        entry.content
    );

    // The LLM was eventually invoked too — attachment import must
    // not block the turn from running.
    assert!(
        llm.calls.load(Ordering::Relaxed) >= 1,
        "LLM should have been called at least once after attachment import"
    );

    runtime.shutdown().await;
}
