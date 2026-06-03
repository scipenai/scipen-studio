//! Live streaming probe against `api.deepseek.com /v1/chat/completions`.
//!
//! Skipped by default. Run with:
//!
//! ```bash
//! DEEPSEEK_API_KEY=sk-... cargo test -p snaca-llm \
//!     --test live_deepseek_stream -- --ignored --nocapture
//! ```

use futures::StreamExt;
use snaca_core::Message;
use snaca_llm::deepseek::DeepSeekConfig;
use snaca_llm::{
    ContentDelta, DeepSeekClient, LlmClient, MessageRequest, StopReason, StreamEvent,
};

#[tokio::test]
#[ignore = "requires DEEPSEEK_API_KEY; live network call"]
async fn deepseek_streaming_responds_with_typewriter_deltas() {
    let key = std::env::var("DEEPSEEK_API_KEY").expect("DEEPSEEK_API_KEY env var not set");
    let model = std::env::var("DEEPSEEK_MODEL").unwrap_or_else(|_| "deepseek-chat".into());
    let base = std::env::var("DEEPSEEK_BASE_URL")
        .unwrap_or_else(|_| "https://api.deepseek.com".into());

    let client = DeepSeekClient::new(
        DeepSeekConfig::new(&key)
            .with_model(&model)
            .with_base_url(&base),
    )
    .expect("build client");

    let req = MessageRequest::new(&model)
        .with_system("You are SNACA. Reply in one short English sentence.")
        .with_messages(vec![Message::user_text(
            "Count to three, comma-separated.",
        )])
        .with_max_tokens(64);

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

    println!("--- DeepSeek streaming summary ---");
    println!("events={event_count}, deltas={delta_count}");
    println!("stop_reason: {final_stop_reason:?}");
    println!("text: {accumulated:?}");
    println!("----------------------------------");

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
