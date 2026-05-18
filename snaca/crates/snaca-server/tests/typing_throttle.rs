//! Throttling test for `ChannelTypingListener`.
//!
//! Drives the listener directly (no engine, no HTTP) with many text
//! deltas issued faster than the throttle window; asserts the plugin
//! receives one initial `send_message` plus only as many `update_message`
//! calls as throttle windows expired. Final accumulated text is still
//! correct — the engine's end-of-turn `update_message` covers any
//! deltas the throttle suppressed.

use snaca_channel_host::{PluginConfig, PluginHandle};
use snaca_engine::TurnEventListener;
use snaca_llm::{ContentBlockStart, ContentDelta, StreamEvent};
use snaca_server::ChannelTypingListener;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

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

async fn spawn_recording_plugin(updates_path: &std::path::Path) -> PluginHandle {
    let cli = snaca_cli_binary();
    // `--update-supported` makes the mock advertise update_message
    // capability — the listener only pushes deltas when the plugin
    // declares it, so the throttle assertions need a plugin that
    // actually accepts updates.
    let cfg = PluginConfig::builder("mock-throttle", cli.to_string_lossy())
        .args(["mock-plugin", "--update-supported"])
        .env("SNACA_MOCK_RECORD_UPDATES", updates_path.display().to_string())
        .build();
    PluginHandle::spawn(cfg).await.expect("spawn mock plugin")
}

fn text_delta(text: &str) -> StreamEvent {
    StreamEvent::ContentBlockDelta {
        index: 0,
        delta: ContentDelta::Text {
            text: text.to_string(),
        },
    }
}

#[tokio::test]
async fn throttle_collapses_burst_into_few_updates() {
    let _ = tracing_subscriber::fmt::try_init();
    let tmp = tempfile::tempdir().unwrap();
    let updates_path = tmp.path().join("updates.jsonl");
    let plugin = spawn_recording_plugin(&updates_path).await;

    // 100 ms throttle. We'll fire 20 deltas without delay (≪100 ms total)
    // → expect 1 send + at most a couple of updates (likely zero).
    let listener = ChannelTypingListener::with_interval(
        plugin.clone(),
        "mock-tenant".into(),
        "mock-chat".into(),
        Duration::from_millis(100),
    );
    listener
        .on_event(&StreamEvent::ContentBlockStart {
            index: 0,
            block: ContentBlockStart::Text,
        })
        .await;
    for _ in 0..20 {
        listener.on_event(&text_delta("x")).await;
    }
    // Let any pending RPCs settle.
    tokio::time::sleep(Duration::from_millis(50)).await;

    let updates_text = std::fs::read_to_string(&updates_path).unwrap_or_default();
    let update_count = updates_text.lines().count();
    assert!(
        update_count <= 2,
        "expected <=2 updates inside the throttle window; got {update_count}:\n{updates_text}"
    );

    // After the throttle window expires, the very next delta must push.
    tokio::time::sleep(Duration::from_millis(120)).await;
    listener.on_event(&text_delta("done")).await;
    tokio::time::sleep(Duration::from_millis(20)).await;

    let updates_text = std::fs::read_to_string(&updates_path).unwrap_or_default();
    assert!(
        updates_text.contains("done"),
        "post-window delta did not flush: {updates_text}"
    );

    // Listener accumulated all 20 'x' + final 'done'.
    let handoff = listener.finalize().await.expect("listener fired");
    // pushed_text is the most-recently-flushed snapshot, which is the
    // final "xxxx...done" line.
    assert!(
        handoff.streamed_text.ends_with("done"),
        "got: {}",
        handoff.streamed_text
    );

    plugin.shutdown().await.unwrap();
}

#[tokio::test]
async fn zero_interval_pushes_every_delta() {
    let _ = tracing_subscriber::fmt::try_init();
    let tmp = tempfile::tempdir().unwrap();
    let updates_path = tmp.path().join("updates.jsonl");
    let plugin = spawn_recording_plugin(&updates_path).await;

    let listener = ChannelTypingListener::with_interval(
        plugin.clone(),
        "mock-tenant".into(),
        "mock-chat".into(),
        Duration::ZERO,
    );
    for s in ["a", "b", "c", "d", "e"] {
        listener.on_event(&text_delta(s)).await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;

    let updates_text = std::fs::read_to_string(&updates_path).unwrap_or_default();
    let update_count = updates_text.lines().count();
    // 5 deltas: 1 send + 4 updates expected.
    assert_eq!(
        update_count, 4,
        "expected 4 updates with zero throttle; got {update_count}:\n{updates_text}"
    );

    plugin.shutdown().await.unwrap();
}
