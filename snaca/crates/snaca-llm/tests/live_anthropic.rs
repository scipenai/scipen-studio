//! Live probe for the Anthropic-compatible endpoint.
//!
//! Skipped by default. Run with:
//!
//! ```bash
//! ANTHROPIC_API_KEY=sk-... \
//! ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
//! ANTHROPIC_MODEL='deepseek-v4-pro[1m]' \
//!     cargo test -p snaca-llm --test live_anthropic -- --ignored --nocapture
//! ```

use snaca_core::{ContentBlock, Message};
use snaca_llm::anthropic::AnthropicConfig;
use snaca_llm::{AnthropicClient, LlmClient, MessageRequest, StopReason};

fn render_text(blocks: &[ContentBlock]) -> String {
    let mut s = String::new();
    for b in blocks {
        if let ContentBlock::Text { text } = b {
            if !s.is_empty() {
                s.push('\n');
            }
            s.push_str(text);
        }
    }
    s
}

#[tokio::test]
#[ignore = "requires ANTHROPIC_API_KEY; live network call"]
async fn anthropic_endpoint_responds() {
    let key = std::env::var("ANTHROPIC_API_KEY").expect("ANTHROPIC_API_KEY env var not set");
    let model =
        std::env::var("ANTHROPIC_MODEL").unwrap_or_else(|_| "claude-sonnet-4-5".into());
    let base = std::env::var("ANTHROPIC_BASE_URL")
        .unwrap_or_else(|_| "https://api.anthropic.com".into());

    let client = AnthropicClient::new(
        AnthropicConfig::new(&key)
            .with_model(&model)
            .with_base_url(&base),
    )
    .expect("build client");

    // Some Anthropic-compatible models (e.g. DeepSeek's `*-pro[1m]`) emit a
    // `thinking` block before the visible text, so a small `max_tokens`
    // budget can be exhausted before any text is produced. Give it room.
    let req = MessageRequest::new(&model)
        .with_system("You are SNACA. Reply in one short English sentence.")
        .with_messages(vec![Message::user_text(
            "What's your name? Use one short sentence.",
        )])
        .with_max_tokens(512);

    let resp = client.create_message(req).await.expect("LLM call");
    let text = render_text(&resp.message.content);
    println!("--- Anthropic-endpoint live response ---");
    println!("base_url:    {base}");
    println!("model:       {model}");
    println!("stop_reason: {:?}", resp.stop_reason);
    println!(
        "tokens:      in={} out={} cache_creation={:?} cache_read={:?}",
        resp.usage.input_tokens,
        resp.usage.output_tokens,
        resp.usage.cache_creation_input_tokens,
        resp.usage.cache_read_input_tokens
    );
    println!("text:        {text}");
    println!("----------------------------------------");

    assert_eq!(resp.stop_reason, StopReason::EndTurn);
    assert!(!text.is_empty(), "empty response");
}
