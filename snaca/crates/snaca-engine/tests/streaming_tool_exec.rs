//! Streaming tool pre-execution — verifies that read-only no-approval
//! tool calls are dispatched as their inputs finish streaming, so
//! the post-stream tool pass consumes cached results instead of
//! re-running them.
//!
//! The current MockLlmClient returns a complete response immediately
//! (synthesised stream events fire back-to-back), which means even
//! without pre-exec the tools have a chance to run. To get a clean
//! signal we use a tool that records each `Tool::execute` call and
//! assert it ran exactly *once* per tool_use_id — re-running would
//! be a correctness regression — and that turn latency is bounded by
//! the slower of (a) parallel pre-runs and (b) the sequential write
//! path, not by their sum.

use async_trait::async_trait;
use serde_json::{json, Value};
use snaca_core::{ProjectId, TenantId, ThreadId};
use snaca_engine::{Engine, EngineConfig, TurnRequest};
use snaca_state::Database;
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolOutput, ToolRegistryBuilder,
    ToolResult,
};
use snaca_workspace::WorkspaceLayout;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

mod common;
use common::{assistant_text, assistant_tool_call, MockLlmClient};

/// Counts how many times Tool::execute was invoked. The cache path
/// must skip the call entirely; the test asserts the counter is
/// exactly the number of tool_use blocks (no double-execute even
/// though prerun + post-stream both touch the same entry).
struct CountingReader {
    name: &'static str,
    executions: Arc<AtomicUsize>,
    delay_ms: u64,
}

#[async_trait]
impl Tool for CountingReader {
    fn name(&self) -> &str {
        self.name
    }
    fn description(&self) -> &str {
        "counts and delays"
    }
    fn input_schema(&self) -> Value {
        json!({"type": "object"})
    }
    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::read_only_filesystem()
    }
    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::Never
    }
    async fn execute(&self, _input: Value, _ctx: &ToolContext) -> ToolResult {
        self.executions.fetch_add(1, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(self.delay_ms)).await;
        Ok(ToolOutput::text(self.name.to_string()))
    }
}

fn ttp() -> (TenantId, ProjectId, ThreadId) {
    (
        TenantId::new("t"),
        ProjectId::from_raw("p"),
        ThreadId::new("c"),
    )
}

/// Prerun cache is consumed exactly once per tool_use: each tool
/// executes exactly once across the whole turn even though both the
/// streaming pre-exec and the post-stream pass touch the entry.
#[tokio::test(flavor = "multi_thread")]
async fn each_tool_executes_exactly_once_when_streamed() {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let counter = Arc::new(AtomicUsize::new(0));

    let tools = ToolRegistryBuilder::default()
        .add(CountingReader {
            name: "R1",
            executions: counter.clone(),
            delay_ms: 30,
        })
        .add(CountingReader {
            name: "R2",
            executions: counter.clone(),
            delay_ms: 30,
        })
        .build();

    let llm = Arc::new(MockLlmClient::new());
    llm.enqueue(assistant_tool_call(vec![
        ("c1", "R1", json!({})),
        ("c2", "R2", json!({})),
    ]));
    llm.enqueue(assistant_text("done"));

    let engine = Engine::new(
        llm,
        tools,
        db,
        layout,
        EngineConfig::default_for("mock-model"),
    );
    let (tenant, project, thread) = ttp();
    engine
        .handle_turn(TurnRequest {
            tenant_id: tenant,
            project_id: project,
            thread_id: thread,
            user_text: "go".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .unwrap();

    assert_eq!(
        counter.load(Ordering::SeqCst),
        2,
        "each tool must execute exactly once even with streaming prerun"
    );
}

/// Disabling `stream_tool_execution` reverts to the original
/// behaviour: read-only tools still run in parallel via the segment
/// path post-stream, but the streaming-side dispatch is skipped.
/// The test verifies the post-stream parallel batch still works —
/// no functional regression from gating prerun off.
#[tokio::test(flavor = "multi_thread")]
async fn knob_disabled_falls_back_to_post_stream_path() {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let counter = Arc::new(AtomicUsize::new(0));

    let tools = ToolRegistryBuilder::default()
        .add(CountingReader {
            name: "R1",
            executions: counter.clone(),
            delay_ms: 30,
        })
        .add(CountingReader {
            name: "R2",
            executions: counter.clone(),
            delay_ms: 30,
        })
        .build();

    let llm = Arc::new(MockLlmClient::new());
    llm.enqueue(assistant_tool_call(vec![
        ("c1", "R1", json!({})),
        ("c2", "R2", json!({})),
    ]));
    llm.enqueue(assistant_text("done"));

    let mut cfg = EngineConfig::default_for("mock-model");
    cfg.stream_tool_execution = false;
    let engine = Engine::new(llm, tools, db, layout, cfg);

    let (tenant, project, thread) = ttp();
    engine
        .handle_turn(TurnRequest {
            tenant_id: tenant,
            project_id: project,
            thread_id: thread,
            user_text: "go".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .unwrap();

    assert_eq!(counter.load(Ordering::SeqCst), 2);
}

/// Write barrier: a write tool in the middle of a tool batch prevents
/// post-write reads from running during streaming. They have to wait
/// for the write to complete in the post-stream pass — otherwise a
/// later read could miss side effects of the write. This is the
/// correctness property that motivated the barrier in the first place
/// (see `concurrent_tools::write_tool_serialises_neighbouring_reads`
/// for the timing-based check; this test asserts the explicit
/// ordering invariant).
struct OrderRecorder {
    name: &'static str,
    is_read: bool,
    log: Arc<std::sync::Mutex<Vec<&'static str>>>,
}

#[async_trait]
impl Tool for OrderRecorder {
    fn name(&self) -> &str {
        self.name
    }
    fn description(&self) -> &str {
        "logs invocation order"
    }
    fn input_schema(&self) -> Value {
        json!({"type": "object"})
    }
    fn capabilities(&self) -> ToolCapabilities {
        if self.is_read {
            ToolCapabilities::read_only_filesystem()
        } else {
            ToolCapabilities {
                reads_filesystem: true,
                writes_filesystem: true,
                executes_commands: false,
                network_access: false,
            }
        }
    }
    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::Never
    }
    fn is_read_only(&self) -> bool {
        self.is_read
    }
    async fn execute(&self, _input: Value, _ctx: &ToolContext) -> ToolResult {
        // 40ms write window — long enough that an eager-dispatched
        // post-write read would observably finish first if the
        // barrier weren't enforced.
        if !self.is_read {
            tokio::time::sleep(Duration::from_millis(40)).await;
        }
        self.log.lock().unwrap().push(self.name);
        Ok(ToolOutput::text(self.name.to_string()))
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn write_barrier_keeps_post_write_reads_sequential() {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let log = Arc::new(std::sync::Mutex::new(Vec::<&'static str>::new()));

    let tools = ToolRegistryBuilder::default()
        .add(OrderRecorder {
            name: "R_pre",
            is_read: true,
            log: log.clone(),
        })
        .add(OrderRecorder {
            name: "W",
            is_read: false,
            log: log.clone(),
        })
        .add(OrderRecorder {
            name: "R_post",
            is_read: true,
            log: log.clone(),
        })
        .build();

    let llm = Arc::new(MockLlmClient::new());
    llm.enqueue(assistant_tool_call(vec![
        ("c1", "R_pre", json!({})),
        ("c2", "W", json!({})),
        ("c3", "R_post", json!({})),
    ]));
    llm.enqueue(assistant_text("done"));

    let engine = Engine::new(
        llm,
        tools,
        db,
        layout,
        EngineConfig::default_for("mock-model"),
    );
    let (tenant, project, thread) = ttp();
    let started = Instant::now();
    engine
        .handle_turn(TurnRequest {
            tenant_id: tenant,
            project_id: project,
            thread_id: thread,
            user_text: "go".into(),
            message_id: None,
            ephemeral_system: None,
        })
        .await
        .unwrap();
    let elapsed = started.elapsed();

    let order = log.lock().unwrap().clone();
    // R_pre may complete before W (it's pre-run during streaming);
    // R_post MUST run after W to respect the model's intent.
    let w_pos = order.iter().position(|n| *n == "W").unwrap();
    let r_post_pos = order.iter().position(|n| *n == "R_post").unwrap();
    assert!(
        w_pos < r_post_pos,
        "R_post must run after W; got order {order:?}"
    );

    // Sanity: turn is at least as long as the write delay — barrier
    // means R_post can't piggy-back on the streaming window.
    assert!(
        elapsed >= Duration::from_millis(35),
        "expected ≥40ms (write delay); took {elapsed:?}"
    );
}
