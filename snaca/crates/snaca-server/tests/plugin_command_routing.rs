//! Plugin-advertised IM commands route through the dispatcher *without*
//! invoking the LLM.
//!
//! Spawns a real `snaca-server` runtime with one mock plugin configured
//! via `--advertise-command ping --auto-inject "/ping hello"`. The plugin
//! advertises `command.advertise(ping)` after initialize, then injects a
//! synthetic `event.message_received` with content "/ping hello". The
//! dispatcher should:
//!   1. fail the `/snaca` admin-command short-circuit,
//!   2. match `ping` against the originating plugin's advertised commands,
//!   3. issue `command.invoke` to the plugin,
//!   4. send the plugin's reply back via `message.send`,
//!   5. NEVER call the LLM.
//!
//! `SNACA_MOCK_RECORD_SENDS` lets us inspect outbound sends; the LLM is a
//! mock that asserts it's never invoked.

use async_trait::async_trait;
use snaca_llm::{
    LlmClient, LlmResult, MessageRequest, MessageResponse, ProviderCaps,
};
use snaca_server::{Config, Runtime};
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

struct AssertNoCallLlm {
    calls: AtomicUsize,
}

#[async_trait]
impl LlmClient for AssertNoCallLlm {
    fn provider_name(&self) -> &'static str {
        "assert-no-call"
    }
    fn model(&self) -> &str {
        "assert-no-call"
    }
    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps {
            tool_use: true,
            ..Default::default()
        }
    }
    async fn create_message(&self, _req: MessageRequest) -> LlmResult<MessageResponse> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        panic!("LLM should not be invoked when a slash command is routed to a plugin");
    }
}

#[tokio::test]
async fn slash_command_routes_to_plugin_without_llm() {
    let _ = tracing_subscriber::fmt::try_init();

    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    let record_path = tmp.path().join("sends.jsonl");
    let cfg_path = tmp.path().join("snaca.toml");
    let cli_bin = snaca_cli_binary();

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
args = [
    "mock-plugin",
    "--advertise-command", "ping",
    "--auto-inject", "/ping hello world",
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
    let llm = Arc::new(AssertNoCallLlm {
        calls: AtomicUsize::new(0),
    });
    let runtime = Runtime::build_with_llm(config, llm.clone())
        .await
        .expect("runtime starts");

    // Wait up to 10s for the round trip: advertise → inject → invoke → send.
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut record_text = String::new();
    while Instant::now() < deadline {
        if record_path.exists() {
            record_text = std::fs::read_to_string(&record_path).unwrap_or_default();
            if record_text.contains("pong: hello world") {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        record_text.contains("pong: hello world"),
        "expected `pong: hello world` in plugin send record, got: {record_text:?}"
    );

    // Strict: LLM must not have been invoked.
    assert_eq!(
        llm.calls.load(Ordering::Relaxed),
        0,
        "LLM was invoked for a slash command"
    );

    runtime.shutdown().await;
}

#[tokio::test]
async fn unknown_slash_command_falls_through_to_llm() {
    // Confirms parse_slash_command -> no advertised match -> turn proceeds.
    // Uses a constant LLM so we can verify it was actually called and the
    // user got a real LLM-routed response, not a "/foo ✓" fake-ack.
    let _ = tracing_subscriber::fmt::try_init();

    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    let record_path = tmp.path().join("sends.jsonl");
    let cfg_path = tmp.path().join("snaca.toml");
    let cli_bin = snaca_cli_binary();

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
args = [
    "mock-plugin",
    "--auto-inject", "/unknown_cmd value",
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
    let llm = Arc::new(ConstantLlm::new("from-llm"));
    let runtime = Runtime::build_with_llm(config, llm.clone())
        .await
        .expect("runtime starts");

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut record_text = String::new();
    while Instant::now() < deadline {
        if record_path.exists() {
            record_text = std::fs::read_to_string(&record_path).unwrap_or_default();
            if record_text.contains("from-llm") {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(
        record_text.contains("from-llm"),
        "expected LLM-generated reply in record, got: {record_text:?}"
    );
    assert!(
        llm.calls.load(Ordering::Relaxed) >= 1,
        "LLM should have been called"
    );

    runtime.shutdown().await;
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
            message: snaca_core::Message {
                id: snaca_core::MessageId::new(),
                role: snaca_core::Role::Assistant,
                content: vec![snaca_core::ContentBlock::text(self.text.clone())],
                created_at: chrono::Utc::now(),
            },
            usage: snaca_core::Usage {
                input_tokens: 1,
                output_tokens: 1,
                ..Default::default()
            },
            stop_reason: snaca_llm::StopReason::EndTurn,
        })
    }
}
