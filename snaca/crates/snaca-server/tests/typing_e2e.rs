//! End-to-end typing-listener test.
//!
//! Wires the full stack: streaming-aware mock LLM → engine →
//! `ChannelTypingListener` → mock-plugin subprocess → record file. Asserts
//! that text deltas show up in the plugin's update_message log in order.

use async_trait::async_trait;
use futures::stream::{self, BoxStream};
use snaca_core::{ProjectId, TenantId};
use snaca_llm::{
    ContentBlockStart, ContentDelta, LlmClient, LlmError, LlmResult, MessageRequest,
    MessageResponse, ProviderCaps, StopReason, StreamEvent,
};
use snaca_server::{Config, Runtime};
use snaca_workspace::WorkspaceLayout;
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

struct ScriptedStreamLlm {
    queue: Mutex<Vec<Vec<StreamEvent>>>,
}

#[async_trait]
impl LlmClient for ScriptedStreamLlm {
    fn provider_name(&self) -> &'static str {
        "scripted"
    }
    fn model(&self) -> &str {
        "scripted"
    }
    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps {
            tool_use: true,
            streaming: true,
            ..Default::default()
        }
    }
    async fn create_message(&self, _req: MessageRequest) -> LlmResult<MessageResponse> {
        Err(LlmError::Other("streaming-only mock".into()))
    }
    async fn create_message_stream(
        &self,
        _req: MessageRequest,
    ) -> LlmResult<BoxStream<'static, LlmResult<StreamEvent>>> {
        let evs = {
            let mut q = self.queue.lock().unwrap();
            if q.is_empty() {
                return Err(LlmError::Other("queue empty".into()));
            }
            q.remove(0)
        };
        Ok(Box::pin(stream::iter(evs.into_iter().map(Ok))))
    }
}

fn streaming_text_events(pieces: &[&str]) -> Vec<StreamEvent> {
    let mut events = vec![
        StreamEvent::MessageStart {
            message_id: "m".into(),
            model: None,
        },
        StreamEvent::ContentBlockStart {
            index: 0,
            block: ContentBlockStart::Text,
        },
    ];
    for piece in pieces {
        events.push(StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::Text {
                text: (*piece).into(),
            },
        });
    }
    events.push(StreamEvent::ContentBlockStop { index: 0 });
    events.push(StreamEvent::MessageDelta {
        stop_reason: Some(StopReason::EndTurn),
        usage: None,
    });
    events.push(StreamEvent::MessageStop);
    events
}

#[tokio::test]
async fn streaming_text_produces_typewriter_updates_in_im() {
    let _ = tracing_subscriber::fmt::try_init();
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    let sends_path = tmp.path().join("sends.jsonl");
    let updates_path = tmp.path().join("updates.jsonl");
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
typing_update_interval_ms = 0   # disable throttling for assertion-friendly tests

[tenant]
id = "default"

[llm]
provider = "deepseek"
api_key = "ignored"

[engine]
max_iterations = 2

[[plugins]]
name = "mock"
command = {cli_bin:?}
args = [
    "mock-plugin",
    "--auto-inject",
    "stream please",
    # Streaming-typewriter test: mock advertises update_message
    # capability so the dispatcher's listener actually pushes deltas.
    "--update-supported",
]

[plugins.env]
SNACA_MOCK_RECORD_SENDS = {sends_path:?}
SNACA_MOCK_RECORD_UPDATES = {updates_path:?}
"#,
        data_root = data_root.to_string_lossy(),
        cli_bin = cli_bin.to_string_lossy(),
        sends_path = sends_path.to_string_lossy(),
        updates_path = updates_path.to_string_lossy(),
    );
    std::fs::write(&cfg_path, cfg).unwrap();
    let config = Config::load(&cfg_path).expect("config loads");

    let llm: Arc<dyn LlmClient> = Arc::new(ScriptedStreamLlm {
        queue: Mutex::new(vec![streaming_text_events(&[
            "Hello", ", ", "world", "!",
        ])]),
    });
    let runtime = Runtime::build_with_llm(config, llm).await.expect("runtime");

    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if updates_path.exists() {
            let s = std::fs::read_to_string(&updates_path).unwrap_or_default();
            // Wait until we've seen the final piece.
            if s.contains("Hello, world!") {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let updates_text = std::fs::read_to_string(&updates_path).unwrap_or_default();
    let updates: Vec<&str> = updates_text.lines().collect();
    println!("--- updates ---\n{updates_text}\n---------------");

    runtime.shutdown().await;

    // Pure-streaming path: first delta lands as `send_message` (with
    // format=card so subsequent updates have an editable surface),
    // every following delta lands as `update_message` carrying the
    // cumulative text. 4 deltas → 1 send + 3 updates minimum.
    let sends = std::fs::read_to_string(&sends_path).unwrap_or_default();
    println!("--- sends ---\n{sends}\n-------------");
    assert!(
        sends.contains("\"content\":\"Hello\""),
        "first send_message should carry just 'Hello'; got: {sends}"
    );

    assert!(
        updates.len() >= 3,
        "expected at least 3 message.update calls (one per delta after the first); got {} from:\n{updates_text}",
        updates.len()
    );
    // Each update_message carries the cumulative text up to that point.
    assert!(updates[0].contains("Hello, "), "first update: {}", updates[0]);
    assert!(updates_text.contains("Hello, world"));
    assert!(updates_text.contains("Hello, world!"));
}
