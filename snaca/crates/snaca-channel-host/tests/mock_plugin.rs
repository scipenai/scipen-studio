//! Integration test: host spawns the `snaca-cli mock-plugin` binary and
//! drives it through the full lifecycle (initialize → ping → send_message
//! → echo → shutdown).
//!
//! `escargot` builds `snaca-cli` once per test run; subsequent tests reuse
//! the artifact via Cargo's incremental cache.

use snaca_channel_host::{InboundEvent, PluginConfig, PluginHandle};
use snaca_channel_protocol::methods::MessageSendParams;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use tokio::time::timeout;

fn mock_plugin_binary() -> PathBuf {
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

fn config_for(name: &str, args: &[&str]) -> PluginConfig {
    let mut builder = PluginConfig::builder(name, mock_plugin_binary().to_string_lossy())
        .arg("mock-plugin");
    for a in args {
        builder = builder.arg(*a);
    }
    builder.build()
}

#[tokio::test]
async fn handshake_returns_manifest() {
    let _ = tracing_subscriber::fmt::try_init();
    let plugin = PluginHandle::spawn(config_for("test-mock-1", &[]))
        .await
        .expect("spawn");
    let manifest = plugin.manifest().clone();
    assert_eq!(manifest.protocol_version, "1.0");
    assert_eq!(manifest.plugin.name, "mock");
    assert!(manifest.capabilities.send_message);
    assert!(!manifest.capabilities.interactive_card);
    plugin.shutdown().await.unwrap();
}

#[tokio::test]
async fn ping_roundtrips() {
    let _ = tracing_subscriber::fmt::try_init();
    let plugin = PluginHandle::spawn(config_for("test-mock-2", &[]))
        .await
        .expect("spawn");
    let pong = plugin.ping().await.expect("ping");
    assert_eq!(pong.get("pong").and_then(|v| v.as_bool()), Some(true));
    plugin.shutdown().await.unwrap();
}

#[tokio::test]
async fn message_send_returns_id() {
    let _ = tracing_subscriber::fmt::try_init();
    let plugin = PluginHandle::spawn(config_for("test-mock-3", &[]))
        .await
        .expect("spawn");
    let result = plugin
        .send_message(MessageSendParams {
            tenant_id: "t1".into(),
            chat_id: "c1".into(),
            content: "hello".into(),
            format: None,
            reply_to: None,
            idempotency_key: None,
        })
        .await
        .expect("send_message");
    assert!(
        result.message_id.starts_with("mock-"),
        "got: {}",
        result.message_id
    );
    plugin.shutdown().await.unwrap();
}

#[tokio::test]
async fn auto_echo_pushes_inbound_event() {
    let _ = tracing_subscriber::fmt::try_init();
    let plugin = PluginHandle::spawn(config_for("test-mock-4", &["--auto-echo"]))
        .await
        .expect("spawn");
    let mut inbound = plugin
        .take_inbound()
        .await
        .expect("inbound stream available");

    plugin
        .send_message(MessageSendParams {
            tenant_id: "tenant-x".into(),
            chat_id: "chat-y".into(),
            content: "echo me".into(),
            format: None,
            reply_to: None,
            idempotency_key: None,
        })
        .await
        .expect("send_message");

    let event = timeout(Duration::from_secs(5), inbound.recv())
        .await
        .expect("inbound event arrives within 5s")
        .expect("inbound channel still open");

    match event {
        InboundEvent::MessageReceived { plugin: name, params } => {
            assert_eq!(name, "test-mock-4");
            assert_eq!(params.tenant_id, "tenant-x");
            assert_eq!(params.chat_id, "chat-y");
            assert_eq!(params.content, "echo me");
        }
        other => panic!("expected MessageReceived, got {other:?}"),
    }
    plugin.shutdown().await.unwrap();
}

#[tokio::test]
async fn shutdown_is_idempotent() {
    let _ = tracing_subscriber::fmt::try_init();
    let plugin = PluginHandle::spawn(config_for("test-mock-5", &[]))
        .await
        .expect("spawn");
    plugin.shutdown().await.unwrap();
    // Second shutdown is a no-op and must not error.
    plugin.shutdown().await.unwrap();
}

#[tokio::test]
async fn advertised_tools_visible_after_handshake() {
    let _ = tracing_subscriber::fmt::try_init();
    let plugin = PluginHandle::spawn(config_for(
        "test-mock-tools",
        &["--advertise-tool", "echo"],
    ))
    .await
    .expect("spawn");

    // tool.advertise is sent by the mock right after initialize completes.
    // It races with the test, so poll briefly.
    let mut tools = plugin.advertised_tools().await;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while tools.is_empty() && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(20)).await;
        tools = plugin.advertised_tools().await;
    }
    assert_eq!(tools.len(), 1, "expected one advertised tool, got {tools:?}");
    let t = &tools[0];
    assert_eq!(t.name, "echo");
    assert!(t.is_read_only);
    assert!(t
        .description
        .contains("echoes its arguments"));

    plugin.shutdown().await.unwrap();
}

#[tokio::test]
async fn invoke_tool_roundtrips() {
    let _ = tracing_subscriber::fmt::try_init();
    let plugin = PluginHandle::spawn(config_for(
        "test-mock-invoke",
        &["--advertise-tool", "echo"],
    ))
    .await
    .expect("spawn");

    let result = plugin
        .invoke_tool("echo", serde_json::json!({"echo": "hi"}))
        .await
        .expect("invoke_tool");
    assert!(!result.is_error, "got error: {}", result.content);
    assert!(
        result.content.contains("\"echo\":\"hi\""),
        "got content: {}",
        result.content
    );
    plugin.shutdown().await.unwrap();
}
