//! Live test against the real DeepSeek service.
//!
//! Skipped by default (`#[ignore]`). Run with:
//!
//! ```bash
//! DEEPSEEK_API_KEY=sk-... cargo test -p snaca-llm \
//!     --test live_deepseek -- --ignored --nocapture
//! ```

use snaca_core::{ContentBlock, Message};
use snaca_llm::deepseek::DeepSeekConfig;
use snaca_llm::{DeepSeekClient, LlmClient, MessageRequest, StopReason};

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
#[ignore = "requires DEEPSEEK_API_KEY; live network call"]
async fn deepseek_chat_responds_to_simple_prompt() {
    let key = std::env::var("DEEPSEEK_API_KEY").expect("DEEPSEEK_API_KEY env var not set");
    let model = std::env::var("DEEPSEEK_MODEL").unwrap_or_else(|_| "deepseek-chat".into());
    let base = std::env::var("DEEPSEEK_BASE_URL")
        .unwrap_or_else(|_| "https://api.deepseek.com".into());

    let client = DeepSeekClient::new(
        DeepSeekConfig::new(key)
            .with_model(&model)
            .with_base_url(base.clone()),
    )
    .expect("build client");

    let req = MessageRequest::new(&model)
        .with_system("You are SNACA, a helpful assistant. Answer in one sentence.")
        .with_messages(vec![Message::user_text(
            "What is your name? Reply in one short English sentence.",
        )])
        .with_max_tokens(64);

    let resp = client.create_message(req).await.expect("LLM call");
    let text = render_text(&resp.message.content);
    println!("--- DeepSeek live response ---");
    println!("model:        {model}");
    println!("base_url:     {base}");
    println!("stop_reason:  {:?}", resp.stop_reason);
    println!(
        "tokens:       in={} out={}",
        resp.usage.input_tokens, resp.usage.output_tokens
    );
    println!("text:         {text}");
    println!("------------------------------");

    assert_eq!(resp.stop_reason, StopReason::EndTurn);
    assert!(!text.is_empty(), "response text was empty");
}
