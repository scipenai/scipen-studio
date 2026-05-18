//! Live end-to-end test against the real DeepSeek service.
//!
//! Skipped by default (`#[ignore]`). Run with:
//!
//! ```bash
//! DEEPSEEK_API_KEY=sk-... cargo test -p snaca-server \
//!     --test live_e2e -- --ignored --nocapture
//! ```
//!
//! Drives the same chain as `e2e_smoke.rs` but with the real DeepSeek
//! client instead of `ConstantLlm`. Pre-seeds the project workspace with
//! a couple of files and asks the model to use the `LS` tool, then
//! verifies the assistant reply mentions one of them.

use snaca_llm::deepseek::DeepSeekConfig;
use snaca_llm::DeepSeekClient;
use snaca_server::{Config, Runtime};
use std::path::PathBuf;
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

#[tokio::test]
#[ignore = "requires DEEPSEEK_API_KEY; live network call"]
async fn live_deepseek_e2e_uses_ls_tool_and_replies() {
    let _ = tracing_subscriber::fmt::try_init();

    let api_key = std::env::var("DEEPSEEK_API_KEY").expect("DEEPSEEK_API_KEY env var not set");
    let model = std::env::var("DEEPSEEK_MODEL").unwrap_or_else(|_| "deepseek-chat".into());
    let base = std::env::var("DEEPSEEK_BASE_URL")
        .unwrap_or_else(|_| "https://api.deepseek.com".into());

    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    let record_path = tmp.path().join("sends.jsonl");
    let cfg_path = tmp.path().join("snaca.toml");
    let cli_bin = snaca_cli_binary();

    // Pre-seed the project workspace. ProjectId for chat_id="mock-chat" is
    // deterministic via blake3 — same workspace path every time.
    use snaca_core::{ProjectId, TenantId};
    use snaca_workspace::WorkspaceLayout;
    std::fs::create_dir_all(&data_root).unwrap();
    let layout = WorkspaceLayout::new(std::fs::canonicalize(&data_root).unwrap()).unwrap();
    let tenant = TenantId::new("default");
    let project = ProjectId::auto_from_chat("mock-chat");
    layout.ensure_project(&tenant, &project).unwrap();
    let ws = layout.workspace_dir(&tenant, &project);
    std::fs::write(ws.join("RECIPE.md"), "# project recipe\n").unwrap();
    std::fs::write(ws.join("Cargo.toml"), "[package]\nname=\"demo\"\n").unwrap();

    let cfg = format!(
        r#"
[server]
http_listen = "127.0.0.1:0"
data_root = {data_root:?}

[tenant]
id = "default"

[llm]
provider = "deepseek"
api_key = "{api_key}"
model = "{model}"
base_url = "{base}"

[engine]
max_iterations = 4
max_tokens = 256

[[plugins]]
name = "mock"
command = {cli_bin:?}
args = [
    "mock-plugin",
    "--auto-inject",
    "Use the LS tool with no arguments to list files in the project workspace, then tell me which .toml files are present in one short sentence."
]

[plugins.env]
SNACA_MOCK_RECORD_SENDS = {record_path:?}
"#,
        data_root = data_root.to_string_lossy(),
        api_key = api_key,
        model = model,
        base = base,
        cli_bin = cli_bin.to_string_lossy(),
        record_path = record_path.to_string_lossy(),
    );
    std::fs::write(&cfg_path, cfg).unwrap();

    let config = Config::load(&cfg_path).expect("config loads");
    let llm = Arc::new(
        DeepSeekClient::new(
            DeepSeekConfig::new(&api_key)
                .with_model(&model)
                .with_base_url(&base),
        )
        .unwrap(),
    );
    let runtime = Runtime::build_with_llm(config, llm).await.expect("runtime");

    // Wait for at least one `message.send` to land in the record file.
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut record_text = String::new();
    while Instant::now() < deadline {
        if record_path.exists() {
            record_text = std::fs::read_to_string(&record_path).unwrap_or_default();
            // Look for a non-empty content field (not the "(no reply)" sentinel).
            if !record_text.is_empty() && !record_text.contains("\"content\":\"(no reply)\"") {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    println!("--- live e2e record ---");
    println!("{record_text}");
    println!("-----------------------");

    runtime.shutdown().await;

    assert!(!record_text.is_empty(), "no message.send was recorded within 60s");
    let line = record_text.lines().last().unwrap_or("");
    assert!(
        line.contains("Cargo.toml") || line.to_lowercase().contains("toml"),
        "expected reply to mention .toml file(s); got: {line}"
    );
}
