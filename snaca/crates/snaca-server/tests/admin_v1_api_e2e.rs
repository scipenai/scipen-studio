//! End-to-end tests for the new authenticated `/api/v1/*` surface.
//!
//! These complement [`admin_api_e2e.rs`], which only covers the legacy
//! unauthenticated `/admin/*` paths. The shared fixture builds a real
//! `Runtime` with a mock LLM and a single mock plugin so handlers run
//! against a populated `PluginRegistry` and `Database`.

use async_trait::async_trait;
use snaca_core::{Message, MessageId, Role, Usage};
use snaca_llm::{LlmClient, LlmResult, MessageRequest, MessageResponse, ProviderCaps, StopReason};
use snaca_server::{Config, Runtime};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

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

fn config_text(data_root: &std::path::Path, token: &str) -> String {
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

[admin]
enabled = true
token = "{token}"

[[plugins]]
name = "alpha"
command = {cli:?}
args = ["mock-plugin"]
"#,
        data_root = data_root.to_string_lossy(),
        cli = cli.to_string_lossy(),
        token = token,
    )
}

async fn build_runtime(token: &str) -> (Runtime, tempfile::TempDir) {
    let _ = tracing_subscriber::fmt::try_init();
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    let cfg_path = tmp.path().join("snaca.toml");
    std::fs::write(&cfg_path, config_text(&data_root, token)).unwrap();
    let config = Config::load(&cfg_path).unwrap();
    let llm = Arc::new(ConstantLlm::new("noop"));
    let runtime = Runtime::build_with_llm(config, llm).await.unwrap();
    (runtime, tmp)
}

#[tokio::test]
async fn rejects_missing_token() {
    let (runtime, _tmp) = build_runtime("test-token-xyz").await;
    let url = format!("http://{}/api/v1/status", runtime.http_handle.local_addr);
    let resp = reqwest::get(&url).await.unwrap();
    assert_eq!(resp.status(), 401);
    runtime.shutdown().await;
}

#[tokio::test]
async fn rejects_wrong_token() {
    let (runtime, _tmp) = build_runtime("test-token-xyz").await;
    let url = format!("http://{}/api/v1/status", runtime.http_handle.local_addr);
    let resp = reqwest::Client::new()
        .get(&url)
        .bearer_auth("not-the-token")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 401);
    runtime.shutdown().await;
}

#[tokio::test]
async fn accepts_correct_token_on_status() {
    let token = "test-token-xyz";
    let (runtime, _tmp) = build_runtime(token).await;
    let url = format!("http://{}/api/v1/status", runtime.http_handle.local_addr);
    let resp = reqwest::Client::new()
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 200);
    let body: serde_json::Value = resp.json().await.unwrap();
    assert!(body["version"].as_str().is_some());
    assert_eq!(body["llm_provider"], "deepseek");
    assert_eq!(body["plugin_count"], 1);
    assert_eq!(body["tenant_id"], "default");
    runtime.shutdown().await;
}

#[tokio::test]
async fn accepts_token_via_query_string() {
    let token = "test-token-xyz";
    let (runtime, _tmp) = build_runtime(token).await;
    let url = format!(
        "http://{}/api/v1/status?token={token}",
        runtime.http_handle.local_addr,
    );
    let resp = reqwest::get(&url).await.unwrap();
    assert_eq!(resp.status(), 200);
    runtime.shutdown().await;
}

#[tokio::test]
async fn lists_plugins_via_v1() {
    let token = "test-token-xyz";
    let (runtime, _tmp) = build_runtime(token).await;
    let url = format!("http://{}/api/v1/plugins", runtime.http_handle.local_addr);
    let body: serde_json::Value = reqwest::Client::new()
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let plugins = body["plugins"].as_array().expect("plugins array");
    assert_eq!(plugins.len(), 1);
    assert_eq!(plugins[0]["name"], "alpha");
    runtime.shutdown().await;
}

#[tokio::test]
async fn creates_schedule_via_v1() {
    let token = "test-token-xyz";
    let (runtime, _tmp) = build_runtime(token).await;
    let client = reqwest::Client::new();
    let url = format!("http://{}/api/v1/schedules", runtime.http_handle.local_addr);
    let next_fire_at = chrono::Utc::now() + chrono::Duration::minutes(5);

    let created: serde_json::Value = client
        .post(&url)
        .bearer_auth(token)
        .json(&serde_json::json!({
            "tenant_id": "default",
            "project_id": "proj-web",
            "chat_id": "chat-web",
            "plugin": "alpha",
            "prompt": "scheduled from admin",
            "interval_secs": 3600,
            "next_fire_at": next_fire_at.to_rfc3339(),
        }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(created["tenant_id"], "default");
    assert_eq!(created["project_id"], "proj-web");
    assert_eq!(created["chat_id"], "chat-web");
    assert_eq!(created["plugin"], "alpha");
    assert_eq!(created["prompt"], "scheduled from admin");
    assert_eq!(created["interval_secs"], 3600);
    assert_eq!(created["enabled"], true);

    let listed: serde_json::Value = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let rows = listed["schedules"].as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["id"], created["id"]);
    runtime.shutdown().await;
}

#[tokio::test]
async fn rejects_invalid_schedule_create_via_v1() {
    let token = "test-token-xyz";
    let (runtime, _tmp) = build_runtime(token).await;
    let url = format!("http://{}/api/v1/schedules", runtime.http_handle.local_addr);
    let resp = reqwest::Client::new()
        .post(&url)
        .bearer_auth(token)
        .json(&serde_json::json!({
            "tenant_id": "default",
            "project_id": "proj-web",
            "chat_id": "chat-web",
            "plugin": "alpha",
            "prompt": "",
            "interval_secs": 0,
            "next_fire_at": "not-a-date",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 400);
    runtime.shutdown().await;
}

#[tokio::test]
async fn admin_shutdown_request_stops_http_server() {
    let token = "test-token-xyz";
    let (runtime, _tmp) = build_runtime(token).await;
    let url = format!(
        "http://{}/api/v1/system/shutdown",
        runtime.http_handle.local_addr
    );
    let resp = reqwest::Client::new()
        .post(&url)
        .bearer_auth(token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 202);

    let mut rx = runtime.admin_shutdown_rx.clone();
    tokio::time::timeout(std::time::Duration::from_secs(2), rx.changed())
        .await
        .unwrap()
        .unwrap();
    assert!(*rx.borrow());
    runtime.shutdown().await;
}

#[tokio::test]
async fn reads_and_updates_config_file_via_v1() {
    let token = "test-token-xyz";
    let (runtime, tmp) = build_runtime(token).await;
    let cfg_path = tmp.path().join("snaca.toml");
    runtime.shutdown().await;
    let llm = Arc::new(ConstantLlm::new("noop"));
    let runtime = Runtime::build_with_llm_and_config_path(
        Config::load(&cfg_path).unwrap(),
        llm,
        Some(cfg_path.clone()),
    )
    .await
    .unwrap();
    let client = reqwest::Client::new();
    let url = format!(
        "http://{}/api/v1/config/file",
        runtime.http_handle.local_addr
    );

    let body: serde_json::Value = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["path"], cfg_path.display().to_string());
    let original = body["toml"].as_str().unwrap();
    assert!(original.contains("model = \"constant\""));

    let updated = original.replace("model = \"constant\"", "model = \"constant-next\"");
    let save: serde_json::Value = client
        .put(&url)
        .bearer_auth(token)
        .json(&serde_json::json!({ "toml": updated }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(save["restart_required"], true);
    assert!(std::fs::read_to_string(&cfg_path)
        .unwrap()
        .contains("model = \"constant-next\""));
    let tmp_files = std::fs::read_dir(tmp.path())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().contains(".snaca.toml."))
        .count();
    assert_eq!(tmp_files, 0, "atomic config write left temp files behind");

    runtime.shutdown().await;
}

#[tokio::test]
async fn config_file_get_reports_restart_required_after_change() {
    let token = "test-token-xyz";
    let (runtime, tmp) = build_runtime(token).await;
    let cfg_path = tmp.path().join("snaca.toml");
    runtime.shutdown().await;
    let llm = Arc::new(ConstantLlm::new("noop"));
    let runtime = Runtime::build_with_llm_and_config_path(
        Config::load(&cfg_path).unwrap(),
        llm,
        Some(cfg_path.clone()),
    )
    .await
    .unwrap();
    let client = reqwest::Client::new();
    let url = format!(
        "http://{}/api/v1/config/file",
        runtime.http_handle.local_addr
    );

    // Fresh boot: live file == startup snapshot, so no restart pending.
    let before: serde_json::Value = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(before["restart_required"], false);

    // Save a change, then GET again: the on-disk config has now diverged
    // from what this process booted with, so the hint persists on reload.
    let updated = before["toml"]
        .as_str()
        .unwrap()
        .replace("model = \"constant\"", "model = \"constant-next\"");
    client
        .put(&url)
        .bearer_auth(token)
        .json(&serde_json::json!({ "toml": updated }))
        .send()
        .await
        .unwrap();
    let after: serde_json::Value = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(after["restart_required"], true);

    runtime.shutdown().await;
}

#[tokio::test]
async fn rejects_invalid_config_file_update() {
    let token = "test-token-xyz";
    let (runtime, tmp) = build_runtime(token).await;
    let cfg_path = tmp.path().join("snaca.toml");
    let before = std::fs::read_to_string(&cfg_path).unwrap();
    runtime.shutdown().await;
    let llm = Arc::new(ConstantLlm::new("noop"));
    let runtime = Runtime::build_with_llm_and_config_path(
        Config::load(&cfg_path).unwrap(),
        llm,
        Some(cfg_path.clone()),
    )
    .await
    .unwrap();
    let url = format!(
        "http://{}/api/v1/config/file",
        runtime.http_handle.local_addr
    );

    let resp = reqwest::Client::new()
        .put(&url)
        .bearer_auth(token)
        .json(&serde_json::json!({ "toml": "[server]\nhttp_listen = 42\n" }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 400);
    assert_eq!(std::fs::read_to_string(&cfg_path).unwrap(), before);
    runtime.shutdown().await;
}

#[tokio::test]
async fn config_file_update_allows_unresolved_env_placeholders() {
    let token = "test-token-xyz";
    let (runtime, tmp) = build_runtime(token).await;
    let cfg_path = tmp.path().join("snaca.toml");
    runtime.shutdown().await;
    let llm = Arc::new(ConstantLlm::new("noop"));
    let runtime = Runtime::build_with_llm_and_config_path(
        Config::load(&cfg_path).unwrap(),
        llm,
        Some(cfg_path.clone()),
    )
    .await
    .unwrap();
    let url = format!(
        "http://{}/api/v1/config/file",
        runtime.http_handle.local_addr
    );
    let edited = std::fs::read_to_string(&cfg_path).unwrap().replace(
        "api_key = \"ignored-by-mock\"",
        "api_key = \"${SNACA_TEST_MISSING_KEY}\"",
    );

    let resp = reqwest::Client::new()
        .put(&url)
        .bearer_auth(token)
        .json(&serde_json::json!({ "toml": edited }))
        .send()
        .await
        .unwrap();

    assert_eq!(resp.status(), 200);
    assert!(std::fs::read_to_string(&cfg_path)
        .unwrap()
        .contains("${SNACA_TEST_MISSING_KEY}"));
    let strict_err = Config::load(&cfg_path).unwrap_err();
    assert!(
        strict_err.to_string().contains("resolving llm.api_key"),
        "got: {strict_err:#}"
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn legacy_admin_routes_still_work_without_token() {
    // Critical regression check: existing `snaca admin` CLI / scripts
    // talk to /admin/* without auth. The new v1 surface must not change
    // that.
    let token = "test-token-xyz";
    let (runtime, _tmp) = build_runtime(token).await;
    let url = format!("http://{}/admin/plugins", runtime.http_handle.local_addr);
    let resp = reqwest::get(&url).await.unwrap();
    assert_eq!(resp.status(), 200);
    runtime.shutdown().await;
}

#[tokio::test]
async fn healthz_remains_unauthenticated() {
    let (runtime, _tmp) = build_runtime("test-token-xyz").await;
    let url = format!("http://{}/healthz", runtime.http_handle.local_addr);
    let resp = reqwest::get(&url).await.unwrap();
    assert_eq!(resp.status(), 200);
    runtime.shutdown().await;
}

#[tokio::test]
async fn spa_fallback_serves_index_or_404_json() {
    // Two modes, depending on whether `npm run build` was run before
    // `cargo test`:
    // - SPA built: GET / returns the embedded index.html (HTML, 200).
    // - SPA missing: GET / returns a JSON 404 with the build hint.
    // Both are valid runtime states; the test asserts both ends behave.
    let token = "test-token-xyz";
    let (runtime, _tmp) = build_runtime(token).await;
    let url = format!("http://{}/", runtime.http_handle.local_addr);
    let resp = reqwest::get(&url).await.unwrap();
    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = resp.text().await.unwrap();
    if status == 200 {
        assert!(
            content_type.starts_with("text/html"),
            "expected html, got {content_type}",
        );
        assert!(
            body.contains("<div id=\"root\"></div>") || body.contains("SNACA"),
            "expected index.html marker in body, got: {body:.200}",
        );
    } else {
        assert_eq!(status, 404, "unexpected status: {status}");
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let err = json["error"].as_str().unwrap_or_default();
        assert!(
            err.contains("admin SPA not built") || err.contains("npm"),
            "unexpected body: {body}"
        );
    }
    runtime.shutdown().await;
}

#[tokio::test]
async fn api_disabled_returns_503() {
    let _ = tracing_subscriber::fmt::try_init();
    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    let cfg_path = tmp.path().join("snaca.toml");
    let cli = snaca_cli_binary();
    // Explicitly set `enabled = false` to confirm the middleware short
    // circuits with 503 instead of 401.
    std::fs::write(
        &cfg_path,
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

[admin]
enabled = false

[[plugins]]
name = "alpha"
command = {cli:?}
args = ["mock-plugin"]
"#,
            data_root = data_root.to_string_lossy(),
            cli = cli.to_string_lossy(),
        ),
    )
    .unwrap();
    let config = Config::load(&cfg_path).unwrap();
    let llm = Arc::new(ConstantLlm::new("noop"));
    let runtime = Runtime::build_with_llm(config, llm).await.unwrap();
    let url = format!("http://{}/api/v1/status", runtime.http_handle.local_addr);
    let resp = reqwest::Client::new()
        .get(&url)
        .bearer_auth("anything")
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 503);
    runtime.shutdown().await;
}
