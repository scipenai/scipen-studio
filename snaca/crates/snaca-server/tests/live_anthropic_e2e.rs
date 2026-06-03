//! Live end-to-end test against an Anthropic-compatible endpoint.
//!
//! Mirrors `live_e2e.rs` but runs through the `AnthropicClient` provider.
//! Uses DeepSeek's anthropic-compatible endpoint by default, so a single
//! API key gives us coverage of both code paths.
//!
//! ```bash
//! ANTHROPIC_API_KEY=sk-... \
//! ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
//! ANTHROPIC_MODEL='deepseek-v4-pro[1m]' \
//!     cargo test -p snaca-server --test live_anthropic_e2e \
//!         -- --ignored --nocapture
//! ```

use snaca_llm::anthropic::AnthropicConfig;
use snaca_llm::AnthropicClient;
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
#[ignore = "requires ANTHROPIC_API_KEY; live network call"]
async fn live_anthropic_e2e_uses_ls_tool_and_replies() {
    let _ = tracing_subscriber::fmt::try_init();

    let api_key = std::env::var("ANTHROPIC_API_KEY").expect("ANTHROPIC_API_KEY env var not set");
    let model = std::env::var("ANTHROPIC_MODEL")
        .unwrap_or_else(|_| "claude-sonnet-4-5".into());
    let base = std::env::var("ANTHROPIC_BASE_URL")
        .unwrap_or_else(|_| "https://api.anthropic.com".into());

    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    let record_path = tmp.path().join("sends.jsonl");
    let cfg_path = tmp.path().join("snaca.toml");
    let cli_bin = snaca_cli_binary();

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
provider = "anthropic"
api_key = "{api_key}"
model = "{model}"
base_url = "{base}"

[engine]
max_iterations = 4
max_tokens = 1024

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
        AnthropicClient::new(
            AnthropicConfig::new(&api_key)
                .with_model(&model)
                .with_base_url(&base),
        )
        .unwrap(),
    );
    let runtime = Runtime::build_with_llm(config, llm).await.expect("runtime");

    let deadline = Instant::now() + Duration::from_secs(120);
    let mut record_text = String::new();
    while Instant::now() < deadline {
        if record_path.exists() {
            record_text = std::fs::read_to_string(&record_path).unwrap_or_default();
            if !record_text.is_empty() && !record_text.contains("\"content\":\"(no reply)\"") {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    println!("--- live anthropic e2e record ---");
    println!("{record_text}");
    println!("---------------------------------");

    runtime.shutdown().await;

    assert!(
        !record_text.is_empty(),
        "no message.send was recorded within 120s"
    );
    let line = record_text.lines().last().unwrap_or("");
    assert!(
        line.contains("Cargo.toml") || line.to_lowercase().contains("toml"),
        "expected reply to mention .toml file(s); got: {line}"
    );
}
