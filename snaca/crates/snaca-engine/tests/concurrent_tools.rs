//! Concurrent read-only tool execution.
//!
//! Verifies the segment-aware run_tool_calls path:
//! - Multiple read-only tools in one assistant message run in parallel.
//! - tool_result order matches tool_use order regardless of which
//!   future completed first.
//! - A write tool between two read-only tools serialises both
//!   neighbours (each ends up in its own segment).

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

/// Read-only tool that sleeps for a configurable duration before
/// returning. Records start/finish wall-clock offsets so the test
/// can prove the executions overlapped.
struct SlowReader {
    name: &'static str,
    delay_ms: u64,
    start_at: Arc<std::sync::Mutex<Vec<u64>>>,
    epoch: Instant,
}

#[async_trait]
impl Tool for SlowReader {
    fn name(&self) -> &str {
        self.name
    }
    fn description(&self) -> &str {
        "slow read"
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
        let elapsed = self.epoch.elapsed().as_millis() as u64;
        self.start_at.lock().unwrap().push(elapsed);
        tokio::time::sleep(Duration::from_millis(self.delay_ms)).await;
        Ok(ToolOutput::text(self.name.to_string()))
    }
}

/// Write tool that just notes it ran. Used to verify segment
/// boundaries — its presence must split a concurrent read run.
struct SlowWriter {
    name: &'static str,
    delay_ms: u64,
    order: Arc<AtomicUsize>,
    write_order: Arc<std::sync::Mutex<Vec<&'static str>>>,
}

#[async_trait]
impl Tool for SlowWriter {
    fn name(&self) -> &str {
        self.name
    }
    fn description(&self) -> &str {
        "slow write"
    }
    fn input_schema(&self) -> Value {
        json!({"type": "object"})
    }
    fn capabilities(&self) -> ToolCapabilities {
        // executes_commands flips is_read_only() to false in the
        // shared helper — same shape Bash uses on Linux.
        ToolCapabilities {
            reads_filesystem: true,
            writes_filesystem: true,
            executes_commands: false,
            network_access: false,
        }
    }
    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::Never
    }
    fn is_read_only(&self) -> bool {
        false
    }
    async fn execute(&self, _input: Value, _ctx: &ToolContext) -> ToolResult {
        let _ = self.order.fetch_add(1, Ordering::SeqCst);
        self.write_order.lock().unwrap().push(self.name);
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

#[tokio::test(flavor = "multi_thread")]
async fn read_only_tools_run_in_parallel() {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let start_at = Arc::new(std::sync::Mutex::new(Vec::<u64>::new()));
    let epoch = Instant::now();
    let tools = ToolRegistryBuilder::default()
        .add(SlowReader {
            name: "R1",
            delay_ms: 200,
            start_at: start_at.clone(),
            epoch,
        })
        .add(SlowReader {
            name: "R2",
            delay_ms: 200,
            start_at: start_at.clone(),
            epoch,
        })
        .add(SlowReader {
            name: "R3",
            delay_ms: 200,
            start_at: start_at.clone(),
            epoch,
        })
        .build();

    let llm = Arc::new(MockLlmClient::new());
    llm.enqueue(assistant_tool_call(vec![
        ("c1", "R1", json!({})),
        ("c2", "R2", json!({})),
        ("c3", "R3", json!({})),
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

    // Sequential would take ~600ms; parallel ~200ms. Allow generous
    // slack for CI noise but stay well clear of the serial floor.
    assert!(
        elapsed < Duration::from_millis(400),
        "expected ~200ms parallel, took {elapsed:?}"
    );

    // All three tools should have started within a tight window of
    // each other.
    let starts = start_at.lock().unwrap().clone();
    assert_eq!(starts.len(), 3);
    let spread = starts.iter().max().unwrap() - starts.iter().min().unwrap();
    assert!(
        spread < 50,
        "read tools should start in parallel; got spread {spread}ms across {starts:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn write_tool_serialises_neighbouring_reads() {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let read_starts = Arc::new(std::sync::Mutex::new(Vec::<u64>::new()));
    let write_order = Arc::new(std::sync::Mutex::new(Vec::<&'static str>::new()));
    let order = Arc::new(AtomicUsize::new(0));
    let epoch = Instant::now();

    let tools = ToolRegistryBuilder::default()
        .add(SlowReader {
            name: "R1",
            delay_ms: 100,
            start_at: read_starts.clone(),
            epoch,
        })
        .add(SlowWriter {
            name: "W1",
            delay_ms: 100,
            order: order.clone(),
            write_order: write_order.clone(),
        })
        .add(SlowReader {
            name: "R2",
            delay_ms: 100,
            start_at: read_starts.clone(),
            epoch,
        })
        .build();

    let llm = Arc::new(MockLlmClient::new());
    // [R1, W1, R2] — three single-element segments; everything serial.
    llm.enqueue(assistant_tool_call(vec![
        ("c1", "R1", json!({})),
        ("c2", "W1", json!({})),
        ("c3", "R2", json!({})),
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

    // Three single-element segments → ~300ms serial.
    assert!(
        elapsed >= Duration::from_millis(280),
        "expected ~300ms serial, took {elapsed:?}"
    );

    // R1 must run before R2; checked by their recorded start times.
    let starts = read_starts.lock().unwrap().clone();
    assert_eq!(starts.len(), 2);
    assert!(
        starts[1] - starts[0] >= 150,
        "R2 should not start until after W1 — got starts {starts:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn tool_result_order_matches_tool_use_order() {
    let tmp = tempfile::tempdir().unwrap();
    let layout = WorkspaceLayout::new(tmp.path()).unwrap();
    let db = Database::open_in_memory().await.unwrap();
    let starts = Arc::new(std::sync::Mutex::new(Vec::<u64>::new()));
    let epoch = Instant::now();

    // Three readers with different delays: the *last* one finishes
    // *first*. Order in the result list must still be A → B → C.
    let tools = ToolRegistryBuilder::default()
        .add(SlowReader {
            name: "A",
            delay_ms: 200,
            start_at: starts.clone(),
            epoch,
        })
        .add(SlowReader {
            name: "B",
            delay_ms: 150,
            start_at: starts.clone(),
            epoch,
        })
        .add(SlowReader {
            name: "C",
            delay_ms: 50,
            start_at: starts.clone(),
            epoch,
        })
        .build();

    let llm = Arc::new(MockLlmClient::new());
    llm.enqueue(assistant_tool_call(vec![
        ("c1", "A", json!({})),
        ("c2", "B", json!({})),
        ("c3", "C", json!({})),
    ]));
    llm.enqueue(assistant_text("done"));

    let engine = Engine::new(
        llm.clone(),
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

    // Inspect the second LLM request — it carries the tool_result
    // message. The tool_use_id sequence has to be c1, c2, c3.
    let reqs = llm.observed_requests();
    let second_req = &reqs[1];
    let tool_msg = second_req
        .messages
        .iter()
        .rev()
        .find(|m| matches!(m.role, snaca_core::Role::Tool))
        .expect("expected a tool message in the second request");
    let ids: Vec<String> = tool_msg
        .content
        .iter()
        .filter_map(|b| match b {
            snaca_core::ContentBlock::ToolResult { tool_use_id, .. } => {
                Some(tool_use_id.as_str().to_string())
            }
            _ => None,
        })
        .collect();
    assert_eq!(ids, vec!["c1", "c2", "c3"], "tool_result order mismatch");
}
