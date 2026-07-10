//! Live end-to-end test for `AskUserQuestion` against the real
//! DeepSeek service. No real IM channel involved — the mock plugin
//! plays the part of the user and answers the question card
//! automatically via `--auto-answer`.
//!
//! The point is to validate that:
//! 1. The real LLM, given an ambiguous task and access to the tool,
//!    actually decides to call `AskUserQuestion` (i.e. the tool's
//!    schema + description is persuasive enough).
//! 2. The tool's JSON output, when fed back into the model's context,
//!    is recognised and the model proceeds based on the chosen option.
//!
//! Skipped by default (`#[ignore]`). Run with:
//!
//! ```bash
//! DEEPSEEK_API_KEY=sk-... cargo test -p snaca-server \
//!     --test live_question_e2e -- --ignored --nocapture
//! ```
//!
//! Optional overrides:
//!   DEEPSEEK_MODEL    (default: deepseek-chat)
//!   DEEPSEEK_BASE_URL (default: https://api.deepseek.com)

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

/// The prompt deliberately frames the request as ambiguous between a
/// small set of choices, then explicitly tells the model to consult
/// the user. Without the "use the AskUserQuestion tool" nudge a
/// well-aligned model would just pick — we want the tool call.
const NUDGE_PROMPT: &str = "I'm starting a new auth feature for my Rust web service \
and I'm undecided between three approaches: \
(A) OAuth2 with a third-party provider, \
(B) self-hosted JWT tokens, \
(C) session cookies in Redis. \
Before recommending anything, please use the AskUserQuestion tool to ask me which \
approach I want to use. Phrase the choices clearly, then wait for my answer. \
After I answer, write one short paragraph explaining the trade-offs of my pick.";

#[tokio::test]
#[ignore = "requires DEEPSEEK_API_KEY; live network call"]
async fn live_deepseek_asks_user_question_and_uses_answer() {
    let _ = tracing_subscriber::fmt::try_init();

    let api_key = std::env::var("DEEPSEEK_API_KEY")
        .expect("DEEPSEEK_API_KEY env var not set (use the key from snaca.toml)");
    let model = std::env::var("DEEPSEEK_MODEL").unwrap_or_else(|_| "deepseek-chat".into());
    let base =
        std::env::var("DEEPSEEK_BASE_URL").unwrap_or_else(|_| "https://api.deepseek.com".into());

    let tmp = tempfile::tempdir().unwrap();
    let data_root = tmp.path().join("data");
    let record_path = tmp.path().join("sends.jsonl");
    let questions_path = tmp.path().join("questions.jsonl");
    let cfg_path = tmp.path().join("snaca.toml");
    let cli_bin = snaca_cli_binary();

    use snaca_core::{ProjectId, TenantId};
    use snaca_workspace::WorkspaceLayout;
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

[tenant]
id = "default"

[llm]
provider = "deepseek"
api_key = "{api_key}"
model = "{model}"
base_url = "{base}"

[engine]
max_iterations = 6
max_tokens = 1024

[[plugins]]
name = "mock"
command = {cli_bin:?}
args = [
    "mock-plugin",
    "--auto-inject",
    "{NUDGE_PROMPT}",
    "--auto-answer",
    "1"
]

[plugins.env]
SNACA_MOCK_RECORD_SENDS = {record_path:?}
SNACA_MOCK_RECORD_QUESTIONS = {questions_path:?}
"#,
        data_root = data_root.to_string_lossy(),
        api_key = api_key,
        model = model,
        base = base,
        cli_bin = cli_bin.to_string_lossy(),
        record_path = record_path.to_string_lossy(),
        questions_path = questions_path.to_string_lossy(),
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

    // Live LLM + tool round-trip can take a while; allow 2 minutes.
    let deadline = Instant::now() + Duration::from_secs(120);
    let mut record_text = String::new();
    let mut question_text = String::new();
    while Instant::now() < deadline {
        if record_path.exists() {
            record_text = std::fs::read_to_string(&record_path).unwrap_or_default();
        }
        if questions_path.exists() {
            question_text = std::fs::read_to_string(&questions_path).unwrap_or_default();
        }
        // We need both halves of the loop:
        //   1. the model really invoked AskUserQuestion and the channel
        //      rendered `question.present`;
        //   2. after the mock user's auto-answer, the final reply talks
        //      about the selected JWT option.
        if !question_text.is_empty() && record_text.to_lowercase().contains("jwt") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    println!("--- live question e2e record ---");
    println!("questions:");
    println!("{question_text}");
    println!("sends:");
    println!("{record_text}");
    println!("--------------------------------");

    runtime.shutdown().await;

    assert!(
        !record_text.is_empty(),
        "no message.send was recorded within 120s — model may not have produced any reply"
    );
    assert!(
        question_text.contains("\"question_count\":"),
        "no question.present was recorded within 120s — model may have skipped AskUserQuestion"
    );
    let lower = record_text.to_lowercase();
    assert!(
        lower.contains("jwt") || lower.contains("self-hosted"),
        "final reply does not reference the picked option (JWT / self-hosted): {record_text}"
    );
}
