//! Integration tests for content-filter (poison-pill) recovery.
//!
//! Reproduces the failure captured in `data-lark/snaca-poison-repro.md`: a
//! persisted tool_result carrying provider-flagged content makes DeepSeek
//! reject every replayed turn with `Content Exists Risk`, bricking the
//! thread. The engine must localize the offending message, mark it
//! redacted, and let the thread heal.

use async_trait::async_trait;
use snaca_core::{
    ContentBlock, Message, ProjectId, Role, SessionId, TenantId, ThreadId, ToolUseId,
};
use snaca_engine::{Engine, EngineConfig, TurnRequest};
use snaca_llm::{
    LlmClient, LlmError, LlmResult, MessageRequest, MessageResponse, ProviderCaps, StopReason,
};
use snaca_state::{Database, NewMessage, NewThread};
use snaca_tools_api::ToolRegistryBuilder;
use snaca_workspace::WorkspaceLayout;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

mod common;
use common::EchoTool;

/// Marker string that stands in for provider-flagged content. Any request
/// whose (unredacted) history still contains it is rejected as if the
/// provider's moderation layer fired.
const POISON: &str = "MARKER_CONTENT_EXISTS_RISK";

/// Content-aware mock: rejects any request whose history still carries the
/// poison marker (mirroring a moderation filter that inspects the input),
/// and otherwise returns a plain assistant reply. Because the default
/// `create_message_stream` routes through `create_message`, this single
/// method drives both the streaming turn and the `max_tokens=1` probes.
struct PoisonAwareLlm {
    reply: String,
    calls: AtomicUsize,
}

impl PoisonAwareLlm {
    fn new(reply: &str) -> Self {
        Self {
            reply: reply.to_string(),
            calls: AtomicUsize::new(0),
        }
    }
    fn call_count(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

fn block_contains_poison(b: &ContentBlock) -> bool {
    match b {
        ContentBlock::Text { text } | ContentBlock::Thinking { text, .. } => text.contains(POISON),
        ContentBlock::ToolResult { content, .. } => content.iter().any(block_contains_poison),
        ContentBlock::ToolUse { input, .. } => serde_json::to_string(input)
            .unwrap_or_default()
            .contains(POISON),
        ContentBlock::Image { .. } => false,
    }
}

fn request_contains_poison(req: &MessageRequest) -> bool {
    req.messages
        .iter()
        .any(|m| m.content.iter().any(block_contains_poison))
}

#[async_trait]
impl LlmClient for PoisonAwareLlm {
    fn provider_name(&self) -> &'static str {
        "poison-aware-mock"
    }
    fn model(&self) -> &str {
        "mock-model"
    }
    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps {
            tool_use: true,
            prompt_cache: false,
            thinking: false,
            streaming: false,
        }
    }
    async fn create_message(&self, req: MessageRequest) -> LlmResult<MessageResponse> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if request_contains_poison(&req) {
            return Err(LlmError::ContentFiltered {
                code: "invalid_request_error".into(),
                message: "Content Exists Risk".into(),
            });
        }
        Ok(MessageResponse {
            id: "mock".into(),
            message: Message {
                id: snaca_core::MessageId::new(),
                role: Role::Assistant,
                content: vec![ContentBlock::text(&self.reply)],
                created_at: chrono::Utc::now(),
            },
            usage: Default::default(),
            stop_reason: StopReason::EndTurn,
        })
    }
}

async fn seed_thread_with_poison(db: &Database, thread: &ThreadId) {
    db.insert_thread(&NewThread {
        id: thread.clone(),
        tenant_id: TenantId::new("tenant_a"),
        project_id: ProjectId::from_raw("proj_x"),
        title: "New conversation".to_string(),
    })
    .await
    .unwrap();
    let session = SessionId::new();
    // Assistant tool_use that "searched", paired with a poison tool_result.
    db.append_message(&NewMessage {
        thread_id: thread.clone(),
        session_id: session,
        role: Role::Assistant,
        content: vec![ContentBlock::tool_use(
            "call_poison",
            "WebSearch",
            serde_json::json!({ "query": "today headlines" }),
        )],
        turn_id: None,
    })
    .await
    .unwrap();
    db.append_message(&NewMessage {
        thread_id: thread.clone(),
        session_id: session,
        role: Role::Tool,
        content: vec![ContentBlock::tool_result(
            ToolUseId::new("call_poison"),
            vec![ContentBlock::text(format!(
                "search results: {POISON} some flagged text"
            ))],
        )],
        turn_id: None,
    })
    .await
    .unwrap();
}

/// Seed `thread` with `poison_count` poison tool_results interleaved with
/// innocent ones, so localization must peel off multiple poisons across
/// rounds (exercising the both-halves branch of the binary search).
async fn seed_thread_with_multiple_poisons(db: &Database, thread: &ThreadId, poison_count: usize) {
    db.insert_thread(&NewThread {
        id: thread.clone(),
        tenant_id: TenantId::new("tenant_a"),
        project_id: ProjectId::from_raw("proj_x"),
        title: "New conversation".to_string(),
    })
    .await
    .unwrap();
    let session = SessionId::new();
    for i in 0..poison_count {
        // An innocent tool_result between poisons so redaction can't just
        // blanket the tail.
        let call_ok = format!("call_ok_{i}");
        db.append_message(&NewMessage {
            thread_id: thread.clone(),
            session_id: session,
            role: Role::Assistant,
            content: vec![ContentBlock::tool_use(
                call_ok.as_str(),
                "WebSearch",
                serde_json::json!({ "query": "safe topic" }),
            )],
            turn_id: None,
        })
        .await
        .unwrap();
        db.append_message(&NewMessage {
            thread_id: thread.clone(),
            session_id: session,
            role: Role::Tool,
            content: vec![ContentBlock::tool_result(
                ToolUseId::new(call_ok.as_str()),
                vec![ContentBlock::text(format!("innocent result {i}"))],
            )],
            turn_id: None,
        })
        .await
        .unwrap();
        let call_bad = format!("call_bad_{i}");
        db.append_message(&NewMessage {
            thread_id: thread.clone(),
            session_id: session,
            role: Role::Assistant,
            content: vec![ContentBlock::tool_use(
                call_bad.as_str(),
                "WebSearch",
                serde_json::json!({ "query": "headlines" }),
            )],
            turn_id: None,
        })
        .await
        .unwrap();
        db.append_message(&NewMessage {
            thread_id: thread.clone(),
            session_id: session,
            role: Role::Tool,
            content: vec![ContentBlock::tool_result(
                ToolUseId::new(call_bad.as_str()),
                vec![ContentBlock::text(format!("result {i}: {POISON} flagged"))],
            )],
            turn_id: None,
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn multiple_poisons_are_peeled_off_across_rounds() {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let tools = ToolRegistryBuilder::default().add(EchoTool).build();
    let llm = Arc::new(PoisonAwareLlm::new("all clean now"));
    let mut cfg = EngineConfig::default_for("mock-model");
    cfg.content_filter_max_retries = 6;
    let engine = Engine::new(llm.clone(), tools, db.clone(), workspace, cfg);

    let thread = ThreadId::new("chat_multi_poison");
    let poison_count = 3;
    seed_thread_with_multiple_poisons(&db, &thread, poison_count).await;

    let outcome = engine
        .handle_turn(TurnRequest {
            tenant_id: TenantId::new("tenant_a"),
            project_id: ProjectId::from_raw("proj_x"),
            thread_id: thread.clone(),
            user_text: "please continue".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .expect("thread with several poisons should still heal");

    assert_eq!(outcome.assistant_text, "all clean now");

    let rows = db.recent_messages(&thread, 100).await.unwrap();
    // Exactly the poison tool_results are redacted — no more, no less.
    let redacted_poison = rows
        .iter()
        .filter(|r| r.redacted_at.is_some())
        .filter(|r| {
            r.content.iter().any(|b| {
                matches!(b, ContentBlock::ToolResult { tool_use_id, .. }
                    if tool_use_id.to_string().starts_with("call_bad_"))
            })
        })
        .count();
    assert_eq!(
        redacted_poison, poison_count,
        "every poison tool_result should be redacted"
    );
    // Innocent tool_results are preserved.
    let redacted_innocent = rows
        .iter()
        .filter(|r| r.redacted_at.is_some())
        .filter(|r| {
            r.content.iter().any(|b| {
                matches!(b, ContentBlock::ToolResult { tool_use_id, .. }
                    if tool_use_id.to_string().starts_with("call_ok_"))
            })
        })
        .count();
    assert_eq!(
        redacted_innocent, 0,
        "innocent tool_results must never be redacted"
    );
}

#[tokio::test]
async fn poison_tool_result_is_localized_and_thread_heals() {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let tools = ToolRegistryBuilder::default().add(EchoTool).build();
    let llm = Arc::new(PoisonAwareLlm::new("here is your answer"));
    let engine = Engine::new(
        llm.clone(),
        tools,
        db.clone(),
        workspace,
        EngineConfig::default_for("mock-model"),
    );

    let thread = ThreadId::new("chat_poison");
    seed_thread_with_poison(&db, &thread).await;

    let outcome = engine
        .handle_turn(TurnRequest {
            tenant_id: TenantId::new("tenant_a"),
            project_id: ProjectId::from_raw("proj_x"),
            thread_id: thread.clone(),
            user_text: "please continue".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .expect("turn should recover, not error");

    // The turn completed with the clean reply rather than bricking.
    assert_eq!(outcome.assistant_text, "here is your answer");
    // At least: 1 filtered turn call + ≥1 probe + 1 successful retry.
    assert!(
        llm.call_count() >= 3,
        "expected filtered call + probe(s) + retry, got {}",
        llm.call_count()
    );

    // The poison tool_result row is now marked redacted; innocent rows are not.
    let rows = db.recent_messages(&thread, 50).await.unwrap();
    let poison_row = rows
        .iter()
        .find(|r| matches!(r.role, Role::Tool))
        .expect("poison tool row present");
    assert!(
        poison_row.redacted_at.is_some(),
        "poison tool_result must be redacted"
    );
    let assistant_tooluse = rows
        .iter()
        .find(|r| {
            matches!(r.role, Role::Assistant)
                && r.content
                    .iter()
                    .any(|b| matches!(b, ContentBlock::ToolUse { .. }))
        })
        .expect("assistant tool_use row present");
    assert!(
        assistant_tooluse.redacted_at.is_none(),
        "innocent assistant tool_use must be preserved (not over-redacted)"
    );
}

/// Real end-to-end verification against the DeepSeek API and the captured
/// poison DB from `data-lark/`. Ignored by default (needs network + a key
/// + the state file). Run with:
///
/// ```text
/// DEEPSEEK_API_KEY=sk-... \
/// SNACA_VERIFY_DB=/tmp/poison-verify.sqlite \
///   cargo test -p snaca-engine --test content_filter -- --ignored --nocapture live_deepseek_poison_thread_heals
/// ```
///
/// The DB path MUST be a *copy* — the test mutates it (marks rows redacted).
#[tokio::test]
#[ignore = "hits the live DeepSeek API; needs DEEPSEEK_API_KEY + SNACA_VERIFY_DB"]
async fn live_deepseek_poison_thread_heals() {
    use snaca_llm::{DeepSeekConfig, RetryConfig, RetryingLlmClient};

    let _ = tracing_subscriber::fmt()
        .with_env_filter("snaca_engine=warn,snaca_llm=warn")
        .with_test_writer()
        .try_init();

    let api_key = std::env::var("DEEPSEEK_API_KEY").expect("DEEPSEEK_API_KEY not set");
    let db_path = std::env::var("SNACA_VERIFY_DB").expect("SNACA_VERIFY_DB not set (use a COPY)");

    // Open the captured DB (migrations add `redacted_at` in place).
    let db = Database::open(&db_path).await.unwrap();

    let thread = ThreadId::new("ou_136c5fb4f49462d8291e60f6e76a8fda::auto-otz3lewraz");
    let tenant = TenantId::new("154ec583b3dad75f");
    let project = ProjectId::from_raw("auto-otz3lewraz");

    // Sanity: the injected poison tool_result is present and NOT yet redacted.
    let before = db.recent_messages(&thread, 100).await.unwrap();
    let injected = before
        .iter()
        .find(|r| {
            r.id.to_string()
                .starts_with("aaaaaaaa-0000-0000-0000-000000000002")
        })
        .expect("injected poison tool_result present in the captured DB");
    assert!(
        injected.redacted_at.is_none(),
        "poison row should start un-redacted"
    );

    // Real DeepSeek client + retry wrapper, matching snaca.toml (v4-pro).
    let ds =
        snaca_llm::DeepSeekClient::new(DeepSeekConfig::new(api_key).with_model("deepseek-v4-pro"))
            .unwrap();
    let llm = Arc::new(RetryingLlmClient::new(ds, RetryConfig::default()));

    let tmp = tempfile::tempdir().unwrap();
    let workspace = WorkspaceLayout::new(tmp.path()).unwrap();
    let tools = ToolRegistryBuilder::default().build();

    let mut cfg = EngineConfig::default_for("deepseek-v4-pro");
    // Several captured "今日热点" tool_results may each be flagged; allow
    // enough rounds to peel them off one per round.
    cfg.content_filter_max_retries = 12;
    cfg.max_iterations = 8;

    let engine = Engine::new(llm.clone(), tools, db.clone(), workspace, cfg);

    // A benign message that should NOT need tools once the thread is clean.
    let outcome = engine
        .handle_turn(TurnRequest {
            tenant_id: tenant,
            project_id: project,
            thread_id: thread.clone(),
            user_text: "只用一句话跟我打个招呼就好，不要调用任何工具，不要搜索。".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .expect("thread must heal and the turn must succeed, not surface ContentFiltered");

    eprintln!("=== assistant reply ===\n{}", outcome.assistant_text);
    assert!(
        !outcome.assistant_text.is_empty(),
        "healed turn should produce a reply"
    );

    // The injected poison row is now marked redacted.
    let after = db.recent_messages(&thread, 100).await.unwrap();
    let injected_after = after
        .iter()
        .find(|r| {
            r.id.to_string()
                .starts_with("aaaaaaaa-0000-0000-0000-000000000002")
        })
        .unwrap();
    assert!(
        injected_after.redacted_at.is_some(),
        "the injected poison tool_result must be localized and redacted"
    );

    // Report what got redacted vs preserved (visibility, not a hard assert
    // beyond the injected row — the API decides which extra rows are flagged).
    let redacted: Vec<_> = after
        .iter()
        .filter(|r| r.redacted_at.is_some())
        .map(|r| format!("{} ({:?})", &r.id.to_string()[..13], r.role))
        .collect();
    eprintln!("=== redacted rows: {} ===\n{:#?}", redacted.len(), redacted);
    // Innocent, non-flagged rows (e.g. the very first "hi") stay intact.
    let first_user = after.iter().find(|r| matches!(r.role, Role::User)).unwrap();
    assert!(
        first_user.redacted_at.is_none(),
        "user messages are never redacted"
    );
}

#[tokio::test]
async fn poison_in_user_message_degrades_gracefully() {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let tools = ToolRegistryBuilder::default().add(EchoTool).build();
    let llm = Arc::new(PoisonAwareLlm::new("unused"));
    let engine = Engine::new(
        llm.clone(),
        tools,
        db.clone(),
        workspace,
        EngineConfig::default_for("mock-model"),
    );

    let thread = ThreadId::new("chat_user_poison");
    // The new user message itself carries the flagged content — nothing the
    // engine may safely auto-redact.
    let outcome = engine
        .handle_turn(TurnRequest {
            tenant_id: TenantId::new("tenant_a"),
            project_id: ProjectId::from_raw("proj_x"),
            thread_id: thread.clone(),
            user_text: format!("tell me about {POISON}"),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .expect("turn should degrade gracefully, not error");

    // Degraded notice returned rather than a hard error or infinite loop.
    assert!(
        !outcome.assistant_text.is_empty(),
        "a graceful notice should be returned"
    );
    // No message was redacted (the user message is off-limits).
    let rows = db.recent_messages(&thread, 50).await.unwrap();
    assert!(
        rows.iter().all(|r| r.redacted_at.is_none()),
        "user messages must never be silently redacted"
    );
}
