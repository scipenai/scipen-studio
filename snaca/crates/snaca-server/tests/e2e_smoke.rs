//! End-to-end smoke test for `snaca-server`.
//!
//! Drives a complete SNACA process in-process:
//! - Build `snaca-cli` (via `escargot`) and run it as the IM plugin
//! - Inject a synthetic user message via `--auto-inject`
//! - Mock the LLM with an in-memory client that always replies "pong"
//! - Verify the plugin received `message.send` with our expected text
//! - Hit `/healthz` to confirm the HTTP surface is alive
//!
//! Validates the full chain: plugin subprocess ↔ channel-host ↔ dispatcher
//! ↔ engine ↔ LLM ↔ engine ↔ dispatcher ↔ channel-host ↔ plugin.

use async_trait::async_trait;
use snaca_core::{Message, MessageId, Role, Usage};
use snaca_llm::{
    LlmClient, LlmResult, MessageRequest, MessageResponse, ProviderCaps, StopReason,
};
use snaca_server::{Config, Runtime};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

/// Builds `snaca-cli` once per test process; subsequent calls reuse the
/// cached path.
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
async fn end_to_end_user_message_round_trips() {
    let _ = tracing_subscriber::fmt::try_init();

    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    let record_path = tmp.path().join("sends.jsonl");
    let cfg_path = tmp.path().join("snaca.toml");

    let cli_bin = snaca_cli_binary();

    // SAFETY: paths in TOML need backslash-escaping on Windows; we're testing
    // on Linux (per project description), so writing the path as-is is fine.
    let cfg = format!(
        r#"
[server]
http_listen = "127.0.0.1:0"
data_root = {data_root:?}

[tenant]
id = "default"

[llm]
provider = "deepseek"
api_key = "ignored-by-mock"
model = "constant"

[[plugins]]
name = "mock"
command = {cli_bin:?}
args = ["mock-plugin", "--auto-inject", "ping"]

[plugins.env]
SNACA_MOCK_RECORD_SENDS = {record_path:?}
"#,
        data_root = data_root.to_string_lossy(),
        cli_bin = cli_bin.to_string_lossy(),
        record_path = record_path.to_string_lossy(),
    );
    std::fs::write(&cfg_path, cfg).unwrap();

    let config = Config::load(&cfg_path).expect("config loads");
    let llm = Arc::new(ConstantLlm::new("pong"));
    let runtime = Runtime::build_with_llm(config, llm.clone())
        .await
        .expect("runtime starts");

    // 1. Health endpoint is alive.
    let url = format!("http://{}/healthz", runtime.http_handle.local_addr);
    let resp = reqwest::get(&url).await.expect("healthz GET");
    assert_eq!(resp.status(), 200);
    let body = resp.json::<serde_json::Value>().await.unwrap();
    assert_eq!(body["status"], "ok");

    // 2. Wait up to 10 s for the synthetic user message to round-trip.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut record_text = String::new();
    while Instant::now() < deadline {
        if record_path.exists() {
            record_text = std::fs::read_to_string(&record_path).unwrap_or_default();
            if record_text.contains("pong") {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        record_text.contains("pong"),
        "expected `pong` in plugin send record, got: {record_text:?}"
    );
    assert!(
        record_text.contains("mock-chat"),
        "expected chat_id `mock-chat` in record, got: {record_text:?}"
    );

    // 3. LLM was invoked at least once.
    assert!(llm.calls.load(Ordering::Relaxed) >= 1);

    runtime.shutdown().await;
}

#[tokio::test]
async fn healthz_responds_when_no_plugins_configured() {
    let _ = tracing_subscriber::fmt::try_init();
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    let cfg_path = tmp.path().join("snaca.toml");

    let cfg = format!(
        r#"
[server]
http_listen = "127.0.0.1:0"
data_root = {data_root:?}

[tenant]
id = "default"

[llm]
api_key = "x"
"#,
        data_root = data_root.to_string_lossy()
    );
    std::fs::write(&cfg_path, cfg).unwrap();

    let config = Config::load(&cfg_path).expect("config loads");
    let llm = Arc::new(ConstantLlm::new("noop"));
    let runtime = Runtime::build_with_llm(config, llm).await.unwrap();

    let url = format!("http://{}/healthz", runtime.http_handle.local_addr);
    let resp = reqwest::get(&url).await.unwrap();
    assert_eq!(resp.status(), 200);

    runtime.shutdown().await;
}
