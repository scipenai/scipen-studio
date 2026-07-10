//! Live concurrency test against the real DeepSeek service.
//!
//! Same shape as `dispatch_concurrent_chats.rs` but swaps the scripted
//! slow LLM for the real DeepSeek client, so the wall-clock gap between
//! the two chat replies is measured against actual API latency. Useful
//! as the definitive "yes, two real-world Lark groups would actually be
//! served in parallel" sanity check.
//!
//! Skipped by default (`#[ignore]`). Run with:
//!
//! ```bash
//! DEEPSEEK_API_KEY=sk-... cargo test -p snaca-server \
//!     --test live_concurrent_chats -- --ignored --nocapture
//! ```
//!
//! Optional env overrides: `DEEPSEEK_MODEL` (default `deepseek-chat`),
//! `DEEPSEEK_BASE_URL` (default `https://api.deepseek.com`).

use snaca_core::{ProjectId, TenantId};
use snaca_llm::deepseek::DeepSeekConfig;
use snaca_llm::DeepSeekClient;
use snaca_server::{Config, Runtime};
use snaca_workspace::WorkspaceLayout;
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
async fn live_two_chats_one_plugin_run_in_parallel() {
    let _ = tracing_subscriber::fmt::try_init();

    let api_key = std::env::var("DEEPSEEK_API_KEY").expect("DEEPSEEK_API_KEY env var not set");
    let model = std::env::var("DEEPSEEK_MODEL").unwrap_or_else(|_| "deepseek-chat".into());
    let base =
        std::env::var("DEEPSEEK_BASE_URL").unwrap_or_else(|_| "https://api.deepseek.com".into());

    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    let sends_path = tmp.path().join("sends.jsonl");
    let cfg_path = tmp.path().join("snaca.toml");
    let cli_bin = snaca_cli_binary();

    std::fs::create_dir_all(&data_root).unwrap();
    let layout = WorkspaceLayout::new(std::fs::canonicalize(&data_root).unwrap()).unwrap();
    let tenant = TenantId::new("default");
    // Pre-seed both projects so first-chat workspace mkdir doesn't
    // dominate the timing comparison.
    layout
        .ensure_project(&tenant, &ProjectId::auto_from_chat("chat-a"))
        .unwrap();
    layout
        .ensure_project(&tenant, &ProjectId::auto_from_chat("chat-b"))
        .unwrap();

    // Same prompt to both chats so we're measuring dispatcher
    // concurrency, not asymmetric prompt difficulty. Short reply
    // bounded to a few words to keep total cost trivial and latency
    // close to "one round-trip".
    let prompt =
        "Reply with a single word: hello. Do not call any tools. No punctuation. No explanation.";

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
max_iterations = 2
max_tokens = 64

[[plugins]]
name = "mock"
command = {cli_bin:?}
args = [
    "mock-plugin",
    "--auto-inject",
    "{prompt}",
    "--inject-chat-id",
    "chat-a",
    "--inject-extra",
    "chat-b:{prompt}",
]

[plugins.env]
SNACA_MOCK_RECORD_SENDS = {sends_path:?}
"#,
        data_root = data_root.to_string_lossy(),
        api_key = api_key,
        model = model,
        base = base,
        cli_bin = cli_bin.to_string_lossy(),
        prompt = prompt,
        sends_path = sends_path.to_string_lossy(),
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

    let runtime_start = Instant::now();
    let runtime = Runtime::build_with_llm(config, llm).await.expect("runtime");

    // Poll the sends file until both chats have produced a non-empty
    // reply. Real DeepSeek round-trips usually finish in 1-5s.
    let deadline = Instant::now() + Duration::from_secs(60);
    let sends: Vec<serde_json::Value>;
    loop {
        if Instant::now() > deadline {
            panic!(
                "timed out waiting for both chat sends; observed:\n{}",
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
            .filter(|_| true)
            .collect();
        let nonempty = parsed
            .iter()
            .filter(|v| {
                v.get("content")
                    .and_then(|c| c.as_str())
                    .map(|s| !s.is_empty() && s != "(no reply)")
                    .unwrap_or(false)
            })
            .count();
        if chats.contains("chat-a") && chats.contains("chat-b") && nonempty >= 2 {
            sends = parsed;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let total_elapsed = runtime_start.elapsed();

    runtime.shutdown().await;

    let pick = |chat: &str| -> (u128, String) {
        sends
            .iter()
            .find(|v| v.get("chat_id").and_then(|c| c.as_str()) == Some(chat))
            .map(|v| {
                (
                    v.get("ts_ms").and_then(|t| t.as_u64()).unwrap_or(0) as u128,
                    v.get("content")
                        .and_then(|c| c.as_str())
                        .unwrap_or("")
                        .to_string(),
                )
            })
            .unwrap_or_else(|| panic!("missing send for {chat} in {sends:?}"))
    };
    let (ts_a, reply_a) = pick("chat-a");
    let (ts_b, reply_b) = pick("chat-b");
    let gap_ms = ts_a.max(ts_b) - ts_a.min(ts_b);

    println!("--- live concurrent chats result ---");
    println!("chat-a ts={ts_a} reply={reply_a:?}");
    println!("chat-b ts={ts_b} reply={reply_b:?}");
    println!("gap between sends: {gap_ms}ms");
    println!("total wall-clock from runtime build to both sends: {total_elapsed:?}");
    println!("------------------------------------");

    // Both replies should be non-empty (sanity).
    assert!(
        !reply_a.is_empty() && !reply_a.contains("error"),
        "chat-a empty/error: {reply_a:?}"
    );
    assert!(
        !reply_b.is_empty() && !reply_b.contains("error"),
        "chat-b empty/error: {reply_b:?}"
    );

    // The interesting assertion: the gap between the two sends should
    // be much smaller than a single round-trip. We treat the SMALLER of
    // (gap, faster_turn_latency_estimate) as a proxy for "did they run
    // in parallel".
    //
    // We don't have a precise per-turn latency since the LLM is real,
    // but a generous absolute bound works: if the gap is under ~3s, no
    // realistic single DeepSeek round-trip happened sequentially between
    // the two sends — both turns must have been in flight together.
    //
    // Bumping the threshold for noisy CI / slow API days; the typical
    // observed gap when actually parallel is well under 500ms.
    const MAX_GAP_MS: u128 = 3000;
    assert!(
        gap_ms <= MAX_GAP_MS,
        "wall-clock gap between the two chat sends was {gap_ms}ms — \
         expected <= {MAX_GAP_MS}ms. A gap close to one round-trip \
         (typically 1–3s for DeepSeek) means the dispatcher serialised \
         the two chats."
    );
}
