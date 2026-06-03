//! End-to-end tests for the admin HTTP surface:
//! - `GET  /admin/plugins`            — list every running plugin
//! - `POST /admin/plugins/{name}/reload` — kill + respawn one plugin
//!
//! These exercise the [`PluginRegistry`] in production wiring: a real
//! `snaca-cli mock-plugin` subprocess is spawned, the test makes admin
//! API calls, and we verify the registry's bookkeeping (reload_count,
//! refreshed start time) matches what the HTTP responses report.

use async_trait::async_trait;
use snaca_core::{Message, MessageId, Role, Usage};
use snaca_llm::{
    LlmClient, LlmResult, MessageRequest, MessageResponse, ProviderCaps, StopReason,
};
use snaca_server::{Config, Runtime};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
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

fn config_with_two_plugins(data_root: &std::path::Path) -> String {
    let cli = snaca_cli_binary();
    format!(
        r#"
[server]
http_listen = "127.0.0.1:0"
data_root = {data_root:?}

[tenant]
id = "default"

[llm]
api_key = "ignored-by-mock"
model = "constant"

[[plugins]]
name = "alpha"
command = {cli:?}
args = ["mock-plugin"]

[[plugins]]
name = "beta"
command = {cli:?}
args = ["mock-plugin"]
"#,
        data_root = data_root.to_string_lossy(),
        cli = cli.to_string_lossy(),
    )
}

#[tokio::test]
async fn list_plugins_returns_every_running_plugin() {
    let _ = tracing_subscriber::fmt::try_init();
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    let cfg_path = tmp.path().join("snaca.toml");
    std::fs::write(&cfg_path, config_with_two_plugins(&data_root)).unwrap();

    let config = Config::load(&cfg_path).unwrap();
    let llm = Arc::new(ConstantLlm::new("noop"));
    let runtime = Runtime::build_with_llm(config, llm).await.unwrap();

    let url = format!(
        "http://{}/admin/plugins",
        runtime.http_handle.local_addr
    );
    let body: serde_json::Value = reqwest::get(&url)
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let plugins = body["plugins"].as_array().expect("plugins array");
    assert_eq!(plugins.len(), 2, "got: {body:?}");
    let names: Vec<&str> = plugins
        .iter()
        .map(|p| p["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"alpha"), "got names: {names:?}");
    assert!(names.contains(&"beta"), "got names: {names:?}");

    // Each entry carries manifest metadata. The mock plugin advertises
    // protocol version "1.0".
    for p in plugins {
        assert_eq!(p["manifest_version"], "1.0", "got: {p:?}");
        assert_eq!(p["reload_count"], 0);
    }

    runtime.shutdown().await;
}

#[tokio::test]
async fn reload_plugin_increments_count_and_refreshes_start_time() {
    let _ = tracing_subscriber::fmt::try_init();
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    let cfg_path = tmp.path().join("snaca.toml");
    std::fs::write(&cfg_path, config_with_two_plugins(&data_root)).unwrap();

    let config = Config::load(&cfg_path).unwrap();
    let llm = Arc::new(ConstantLlm::new("noop"));
    let runtime = Runtime::build_with_llm(config, llm).await.unwrap();

    // Snapshot before.
    let before: serde_json::Value = reqwest::get(format!(
        "http://{}/admin/plugins",
        runtime.http_handle.local_addr
    ))
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let alpha_started_before = before["plugins"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["name"] == "alpha")
        .unwrap()["started_at"]
        .as_str()
        .unwrap()
        .to_string();

    // Sleep enough to make the timestamp comparison meaningful, even on
    // sub-second clocks.
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Reload alpha.
    let url = format!(
        "http://{}/admin/plugins/alpha/reload",
        runtime.http_handle.local_addr
    );
    let resp = reqwest::Client::new()
        .post(&url)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["status"], "reloaded");
    assert_eq!(body["plugin"]["name"], "alpha");
    assert_eq!(body["plugin"]["reload_count"], 1);

    // List again — alpha's reload_count is 1, beta's is still 0, and
    // alpha's start time is strictly newer.
    let after: serde_json::Value = reqwest::get(format!(
        "http://{}/admin/plugins",
        runtime.http_handle.local_addr
    ))
    .await
    .unwrap()
    .json()
    .await
    .unwrap();
    let plugins = after["plugins"].as_array().unwrap();
    let alpha = plugins.iter().find(|p| p["name"] == "alpha").unwrap();
    let beta = plugins.iter().find(|p| p["name"] == "beta").unwrap();
    assert_eq!(alpha["reload_count"], 1);
    assert_eq!(beta["reload_count"], 0);
    let alpha_started_after = alpha["started_at"].as_str().unwrap();
    assert!(
        alpha_started_after > alpha_started_before.as_str(),
        "expected refreshed timestamp: before={alpha_started_before} after={alpha_started_after}"
    );

    runtime.shutdown().await;
}

#[tokio::test]
async fn abort_unknown_thread_returns_200_with_aborted_false() {
    let _ = tracing_subscriber::fmt::try_init();
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    let cfg_path = tmp.path().join("snaca.toml");
    std::fs::write(&cfg_path, config_with_two_plugins(&data_root)).unwrap();

    let config = Config::load(&cfg_path).unwrap();
    let llm = Arc::new(ConstantLlm::new("noop"));
    let runtime = Runtime::build_with_llm(config, llm).await.unwrap();

    // Idempotent semantics: aborting a thread that isn't running is
    // not a 404 — the operation succeeds and reports aborted = false.
    let url = format!(
        "http://{}/admin/threads/no-such-thread/abort",
        runtime.http_handle.local_addr
    );
    let resp = reqwest::Client::new().post(&url).send().await.unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(body["aborted"], serde_json::json!(false));

    runtime.shutdown().await;
}

#[tokio::test]
async fn reload_unknown_plugin_returns_404() {
    let _ = tracing_subscriber::fmt::try_init();
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    let cfg_path = tmp.path().join("snaca.toml");
    std::fs::write(&cfg_path, config_with_two_plugins(&data_root)).unwrap();

    let config = Config::load(&cfg_path).unwrap();
    let llm = Arc::new(ConstantLlm::new("noop"));
    let runtime = Runtime::build_with_llm(config, llm).await.unwrap();

    let url = format!(
        "http://{}/admin/plugins/nope/reload",
        runtime.http_handle.local_addr
    );
    let resp = reqwest::Client::new()
        .post(&url)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body["error"]
        .as_str()
        .unwrap()
        .contains("not registered"));

    runtime.shutdown().await;
}
