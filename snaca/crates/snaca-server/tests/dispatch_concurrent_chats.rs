//! End-to-end proof that one plugin (one Feishu bot) now processes
//! messages from different chats in parallel.
//!
//! Setup:
//! - One `mock-plugin` subprocess. Injects two `event.message_received`
//!   right after `initialize`: one to `chat-a`, one to `chat-b`.
//! - LLM is a streaming mock that sleeps `LLM_DELAY` *before* yielding
//!   its (single-turn) reply. Both turns therefore spend ~LLM_DELAY
//!   inside `create_message_stream`.
//! - mock-plugin records every host `message.send` to a JSONL file with
//!   a millisecond-precision `ts_ms` field.
//!
//! Assertion: the wall-clock gap between the two recorded sends must be
//! much smaller than `LLM_DELAY`. Pre-refactor (serialised dispatcher)
//! it would be ~LLM_DELAY since the second turn could only start after
//! the first finished. With per-chat workers it should be a few tens of
//! milliseconds at most — the dispatcher just routes both events into
//! distinct worker tasks and they progress in parallel.

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

/// How long the scripted LLM sleeps before yielding events. Picked so
/// the serial vs parallel gap is unambiguous: serial dispatcher takes
/// ~2 × LLM_DELAY, parallel takes ~1 × LLM_DELAY.
const LLM_DELAY: Duration = Duration::from_millis(700);

/// Max acceptable wall-clock gap between the two recorded sends. Well
/// below LLM_DELAY (700ms) so any regression that re-serialises the
/// dispatcher will trip this assertion immediately. Generous enough
/// that GC pauses / loaded CI runners don't flake.
const MAX_GAP_MS: u128 = 250;

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

/// Streaming LLM that sleeps `LLM_DELAY` before yielding a canned
/// single-turn reply. The sleep happens *after* releasing the queue
/// lock so concurrent calls can both pop their script and then sleep
/// in parallel — which is the whole point of this test.
struct SlowScriptedLlm {
    queue: Mutex<Vec<Vec<StreamEvent>>>,
}

#[async_trait]
impl LlmClient for SlowScriptedLlm {
    fn provider_name(&self) -> &'static str {
        "slow-scripted"
    }
    fn model(&self) -> &str {
        "slow-scripted"
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
        // Lock released — both concurrent calls now sleep in parallel.
        tokio::time::sleep(LLM_DELAY).await;
        Ok(Box::pin(stream::iter(evs.into_iter().map(Ok))))
    }
}

fn single_text_turn(text: &str) -> Vec<StreamEvent> {
    vec![
        StreamEvent::MessageStart {
            message_id: "m".into(),
            model: None,
        },
        StreamEvent::ContentBlockStart {
            index: 0,
            block: ContentBlockStart::Text,
        },
        StreamEvent::ContentBlockDelta {
            index: 0,
            delta: ContentDelta::Text { text: text.into() },
        },
        StreamEvent::ContentBlockStop { index: 0 },
        StreamEvent::MessageDelta {
            stop_reason: Some(StopReason::EndTurn),
            usage: None,
        },
        StreamEvent::MessageStop,
    ]
}

#[tokio::test]
async fn two_chats_on_one_plugin_run_in_parallel() {
    let _ = tracing_subscriber::fmt::try_init();
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    let sends_path = tmp.path().join("sends.jsonl");
    let cfg_path = tmp.path().join("snaca.toml");
    let cli_bin = snaca_cli_binary();

    std::fs::create_dir_all(&data_root).unwrap();
    let layout = WorkspaceLayout::new(std::fs::canonicalize(&data_root).unwrap()).unwrap();
    let tenant = TenantId::new("mock-tenant");
    // Pre-create both auto-projects so the very first turn isn't
    // dominated by `ensure_project` mkdir/embedder-init time. That
    // would otherwise be the first chat's startup tax and make the
    // parallel-vs-serial gap noisier than the LLM_DELAY itself.
    layout
        .ensure_project(&tenant, &ProjectId::auto_from_chat("chat-a"))
        .unwrap();
    layout
        .ensure_project(&tenant, &ProjectId::auto_from_chat("chat-b"))
        .unwrap();

    let cfg = format!(
        r#"
[server]
http_listen = "127.0.0.1:0"
data_root = {data_root:?}
typing_update_interval_ms = 1000   # don't fire mid-stream typing updates we'd have to ignore

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
    "hi-a",
    "--inject-chat-id",
    "chat-a",
    "--inject-extra",
    "chat-b:hi-b",
]

[plugins.env]
SNACA_MOCK_RECORD_SENDS = {sends_path:?}
"#,
        data_root = data_root.to_string_lossy(),
        cli_bin = cli_bin.to_string_lossy(),
        sends_path = sends_path.to_string_lossy(),
    );
    std::fs::write(&cfg_path, cfg).unwrap();
    let config = Config::load(&cfg_path).expect("config loads");

    // One scripted reply per chat. Order doesn't matter — each
    // create_message_stream call pops one off the front, both calls
    // get a valid script.
    let llm: Arc<dyn LlmClient> = Arc::new(SlowScriptedLlm {
        queue: Mutex::new(vec![
            single_text_turn("reply-1"),
            single_text_turn("reply-2"),
        ]),
    });
    let runtime = Runtime::build_with_llm(config, llm).await.expect("runtime");

    // Poll the sends file until both chats appear. 10s deadline
    // accommodates plugin spawn + first-chat workspace warmup.
    let deadline = Instant::now() + Duration::from_secs(10);
    let sends: Vec<serde_json::Value>;
    loop {
        if Instant::now() > deadline {
            panic!(
                "timed out waiting for both chat sends; observed: {}",
                std::fs::read_to_string(&sends_path).unwrap_or_default()
            );
        }
        let raw = std::fs::read_to_string(&sends_path).unwrap_or_default();
        let parsed: Vec<serde_json::Value> = raw
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect();
        let chats: std::collections::HashSet<&str> = parsed
            .iter()
            .filter_map(|v| v.get("chat_id").and_then(|c| c.as_str()))
            .collect();
        if chats.contains("chat-a") && chats.contains("chat-b") {
            sends = parsed;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    runtime.shutdown().await;

    // Extract the *first* send per chat (a turn could in principle
    // produce multiple sends, e.g. the typing listener leaving a stub;
    // the wall-clock gap that matters is when each turn's first reply
    // actually lands).
    let pick = |chat: &str| -> u128 {
        sends
            .iter()
            .find(|v| v.get("chat_id").and_then(|c| c.as_str()) == Some(chat))
            .and_then(|v| v.get("ts_ms").and_then(|t| t.as_u64()))
            .unwrap_or_else(|| panic!("missing send for {chat} in {sends:?}")) as u128
    };
    let ts_a = pick("chat-a");
    let ts_b = pick("chat-b");
    let gap = ts_a.max(ts_b) - ts_a.min(ts_b);

    println!(
        "chat-a ts={} chat-b ts={} gap={}ms (max allowed {}ms; LLM_DELAY={}ms)",
        ts_a,
        ts_b,
        gap,
        MAX_GAP_MS,
        LLM_DELAY.as_millis()
    );
    assert!(
        gap <= MAX_GAP_MS,
        "wall-clock gap between the two chat sends was {gap}ms — \
         expected <= {MAX_GAP_MS}ms, since both turns sleep {}ms in parallel. \
         A gap close to {}ms means the dispatcher is serialising chats again.",
        LLM_DELAY.as_millis(),
        LLM_DELAY.as_millis()
    );
}
