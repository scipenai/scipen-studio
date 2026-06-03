//! Live streaming probe.
//!
//! Skipped by default. Run with:
//!
//! ```bash
//! ANTHROPIC_API_KEY=sk-... \
//! ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
//! ANTHROPIC_MODEL='deepseek-v4-pro[1m]' \
//!     cargo test -p snaca-llm --test live_anthropic_stream \
//!         -- --ignored --nocapture
//! ```

use futures::StreamExt;
use snaca_core::Message;
use snaca_llm::anthropic::AnthropicConfig;
use snaca_llm::{
    AnthropicClient, ContentDelta, LlmClient, MessageRequest, StopReason, StreamEvent,
};

#[tokio::test]
#[ignore = "requires ANTHROPIC_API_KEY; live network call"]
async fn anthropic_streaming_responds_with_typewriter_deltas() {
    let key = std::env::var("ANTHROPIC_API_KEY").expect("ANTHROPIC_API_KEY env var not set");
    let model = std::env::var("ANTHROPIC_MODEL").unwrap_or_else(|_| "claude-sonnet-4-5".into());
    let base = std::env::var("ANTHROPIC_BASE_URL")
        .unwrap_or_else(|_| "https://api.anthropic.com".into());

    let client = AnthropicClient::new(
        AnthropicConfig::new(&key)
            .with_model(&model)
            .with_base_url(&base),
    )
    .expect("build client");

    let req = MessageRequest::new(&model)
        .with_system("You are SNACA. Reply in one short English sentence.")
        .with_messages(vec![Message::user_text(
            "Count to three, comma-separated.",
        )])
        .with_max_tokens(512);

    let mut stream = client.create_message_stream(req).await.expect("open stream");

    let mut accumulated = String::new();
    let mut event_count = 0;
    let mut delta_count = 0;
    let mut got_message_start = false;
    let mut got_message_stop = false;
    let mut final_stop_reason: Option<StopReason> = None;

    while let Some(ev) = stream.next().await {
        let ev = ev.expect("stream item");
        event_count += 1;
        match &ev {
            StreamEvent::MessageStart { message_id, .. } => {
                got_message_start = true;
                println!("message_start: id={message_id}");
            }
            StreamEvent::ContentBlockDelta {
                delta: ContentDelta::Text { text },
                ..
            } => {
                accumulated.push_str(text);
                delta_count += 1;
            }
            StreamEvent::MessageDelta {
                stop_reason: Some(sr),
                ..
            } => {
                final_stop_reason = Some(sr.clone());
            }
            StreamEvent::MessageStop => {
                got_message_stop = true;
            }
            _ => {}
        }
    }

    println!("--- streaming summary ---");
    println!("events={event_count}, deltas={delta_count}");
    println!("stop_reason: {final_stop_reason:?}");
    println!("text: {accumulated:?}");
    println!("-------------------------");

    assert!(got_message_start, "missing message_start");
    assert!(got_message_stop, "missing message_stop");
    assert!(event_count > 3, "expected several events; got {event_count}");
    assert!(
        delta_count >= 1,
        "expected at least one text_delta; got {delta_count}"
    );
    assert!(!accumulated.trim().is_empty(), "accumulated text was empty");
    assert_eq!(final_stop_reason, Some(StopReason::EndTurn));
}
