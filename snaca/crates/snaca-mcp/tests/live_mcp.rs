//! Live integration test against a real MCP server.
//!
//! Skipped by default. Run with:
//!
//! ```bash
//! cargo test -p snaca-mcp --test live_mcp -- --ignored --nocapture
//! ```
//!
//! Uses `npx -y @modelcontextprotocol/server-everything` because it ships
//! with several deterministic, side-effect-free tools (`echo`, `add`).
//! Two tests:
//! 1. **single tenant**: spawn the server, call `echo`, assert the
//!    payload round-trips.
//! 2. **per-tenant isolation**: ask the manager for tools twice with
//!    different `(tenant, project)` keys; the pool must produce two
//!    independent subprocesses (different `Arc` identities) and both
//!    `echo` calls succeed.

use serde_json::json;
use snaca_core::{ProjectId, TenantId};
use snaca_mcp::{McpManager, McpServerConfig};
use snaca_tools_api::ToolContext;
use std::path::PathBuf;
use std::sync::Arc;

fn npx_path() -> Option<PathBuf> {
    which::which("npx").ok()
}

fn dummy_ctx(tenant: &TenantId, project: &ProjectId) -> ToolContext {
    use snaca_core::SessionId;
    ToolContext::new(
        tenant.clone(),
        project.clone(),
        SessionId::new(),
        std::env::temp_dir(),
    )
}

#[tokio::test]
#[ignore = "requires npx + network on first run; live MCP server"]
async fn server_everything_echo_round_trips() {
    let _ = tracing_subscriber::fmt::try_init();
    let npx = npx_path().expect("npx not on PATH");

    let config = McpServerConfig::new("everything", npx.to_string_lossy().to_string())
        .with_args(["-y", "@modelcontextprotocol/server-everything"]);

    let manager = Arc::new(McpManager::from_configs(&[config]));

    let tenant = TenantId::new("tenant-a");
    let project = ProjectId::from_raw("proj-x");
    let tools = manager.tools_for(&tenant, &project).await;
    println!("--- tenant-a tools ---");
    for t in &tools {
        println!("  - {}", t.name());
    }
    println!("----------------------");

    let echo = tools
        .iter()
        .find(|t| t.name() == "mcp__everything__echo")
        .cloned()
        .expect("server-everything must expose `echo`");

    let out = echo
        .execute(json!({"message": "ping from snaca"}), &dummy_ctx(&tenant, &project))
        .await
        .expect("echo should succeed");
    let text = out.render_text();
    assert!(
        text.contains("ping from snaca"),
        "echo did not include payload; got: {text}"
    );
    manager.shutdown().await;
}

#[tokio::test]
#[ignore = "spawns two MCP subprocesses; only run on demand"]
async fn per_tenant_subprocess_isolation() {
    let _ = tracing_subscriber::fmt::try_init();
    let npx = npx_path().expect("npx not on PATH");

    let config = McpServerConfig::new("everything", npx.to_string_lossy().to_string())
        .with_args(["-y", "@modelcontextprotocol/server-everything"]);

    let manager = Arc::new(McpManager::from_configs(&[config]));

    let alpha = TenantId::new("alpha");
    let beta = TenantId::new("beta");
    let project = ProjectId::from_raw("p");

    // First call materializes a subprocess for alpha; second for beta.
    let alpha_tools = manager.tools_for(&alpha, &project).await;
    let beta_tools = manager.tools_for(&beta, &project).await;
    assert!(!alpha_tools.is_empty(), "alpha got no tools");
    assert!(!beta_tools.is_empty(), "beta got no tools");

    // Asking again for alpha must reuse the existing pool entry, not
    // spawn a third subprocess.
    let alpha_tools_2 = manager.tools_for(&alpha, &project).await;
    assert_eq!(alpha_tools.len(), alpha_tools_2.len());

    // Both tenants must be able to call the echo tool concurrently with
    // distinct payloads.
    let alpha_echo = alpha_tools
        .iter()
        .find(|t| t.name() == "mcp__everything__echo")
        .cloned()
        .expect("alpha echo");
    let beta_echo = beta_tools
        .iter()
        .find(|t| t.name() == "mcp__everything__echo")
        .cloned()
        .expect("beta echo");

    let alpha_ctx = dummy_ctx(&alpha, &project);
    let beta_ctx = dummy_ctx(&beta, &project);

    let (a, b) = tokio::join!(
        alpha_echo.execute(json!({"message": "from-alpha"}), &alpha_ctx),
        beta_echo.execute(json!({"message": "from-beta"}), &beta_ctx),
    );
    let a_text = a.expect("alpha echo ok").render_text();
    let b_text = b.expect("beta echo ok").render_text();
    assert!(a_text.contains("from-alpha"));
    assert!(b_text.contains("from-beta"));

    manager.shutdown().await;
}

/// Idle eviction: when the configured TTL has elapsed since a client
/// was last used, the *next* `tools_for` call on a *different* key
/// sweeps the cache and reaps it. The pool should keep the freshly
/// requested key, drop the stale one.
#[tokio::test]
#[ignore = "spawns two MCP subprocesses across an idle gap"]
async fn idle_pool_entries_get_evicted_on_next_lookup() {
    use snaca_mcp::McpPool;
    use std::time::Duration;

    let _ = tracing_subscriber::fmt::try_init();
    let npx = npx_path().expect("npx not on PATH");

    let config = McpServerConfig::new("everything", npx.to_string_lossy().to_string())
        .with_args(["-y", "@modelcontextprotocol/server-everything"]);

    // 500 ms TTL — easy to overshoot in a test, hard to reach by accident.
    let pool = Arc::new(McpPool::new(config).with_idle_ttl(Duration::from_millis(500)));

    let alpha = TenantId::new("alpha");
    let beta = TenantId::new("beta");
    let project = ProjectId::from_raw("p");

    // Warm alpha; pool now has one entry.
    let _ = pool.client_for(&alpha, &project).await.expect("alpha spawn");
    assert_eq!(pool.active_clients().await.len(), 1);

    // Sleep past the TTL so alpha is "stale".
    tokio::time::sleep(Duration::from_millis(700)).await;

    // beta look-up triggers a sweep — alpha gets evicted, beta enters fresh.
    let _ = pool.client_for(&beta, &project).await.expect("beta spawn");
    let active = pool.active_clients().await;
    assert_eq!(
        active.len(),
        1,
        "expected 1 active client after eviction, got {active:?}"
    );
    assert!(
        active.iter().any(|(t, _)| t == &beta),
        "beta should be the survivor: {active:?}"
    );
    assert!(
        !active.iter().any(|(t, _)| t == &alpha),
        "alpha should have been evicted: {active:?}"
    );

    // Asking alpha back forces a fresh subprocess.
    let _ = pool.client_for(&alpha, &project).await.expect("alpha respawn");
    let active = pool.active_clients().await;
    assert_eq!(
        active.len(),
        2,
        "after re-warming alpha we should have 2 entries: {active:?}"
    );

    pool.shutdown().await;
}

/// Periodic reaper: a quiet pool whose entries crossed the idle TTL gets
/// reaped by the background task even if nobody calls `tools_for` again.
/// This is the property that lazy eviction *can't* provide.
#[tokio::test]
#[ignore = "spawns one MCP subprocess and sleeps across reaper ticks"]
async fn reaper_actively_sweeps_quiet_pools() {
    use std::time::Duration;

    let _ = tracing_subscriber::fmt::try_init();
    let npx = npx_path().expect("npx not on PATH");

    let config = McpServerConfig::new("everything", npx.to_string_lossy().to_string())
        .with_args(["-y", "@modelcontextprotocol/server-everything"]);

    let tenant = TenantId::new("reaper-tenant");
    let project = ProjectId::from_raw("p");

    let tmp = tempfile::tempdir().unwrap();
    let layout = snaca_workspace::WorkspaceLayout::new(
        std::fs::canonicalize(tmp.path()).unwrap(),
    )
    .unwrap();
    layout.ensure_project(&tenant, &project).unwrap();

    // 400 ms TTL, 150 ms reaper tick. The reaper skips its first
    // immediate tick, so we need to wait > TTL + one full period for
    // the entry to be reaped.
    let manager = Arc::new(
        McpManager::from_configs_with_layout_and_ttl(
            &[config],
            layout,
            Duration::from_millis(400),
        ),
    );
    manager.start_reaper(Duration::from_millis(150));

    // Warm the pool; right after, exactly one entry exists.
    let _tools = manager.tools_for(&tenant, &project).await;
    let pool = &manager.pools()[0];
    assert_eq!(
        pool.active_clients().await.len(),
        1,
        "pool should hold exactly one entry after warm-up"
    );

    // Now go quiet. Sleep past TTL + at least one full reaper period.
    // 800 ms is comfortably > 400 ms TTL + 150 ms reap interval, with
    // slack for tick scheduling.
    tokio::time::sleep(Duration::from_millis(800)).await;

    // No additional traffic — the reaper task is the only thing that
    // could have touched the pool. The entry should be gone.
    let active = pool.active_clients().await;
    assert!(
        active.is_empty(),
        "reaper should have emptied the pool; still active: {active:?}"
    );

    manager.shutdown().await;
}

/// HTTP transport: when the URL is unreachable the connect attempt fails
/// fast with an `Initialization` error rather than hanging or panicking.
/// We don't require a live remote MCP server in CI — the path that
/// matters end-to-end is "transport branches on config and surfaces a
/// network error" — which we can reliably reproduce against a port that
/// nothing is bound to.
#[tokio::test]
async fn http_transport_surfaces_unreachable_url_as_init_error() {
    use snaca_mcp::McpClient;
    use std::time::Duration;

    let _ = tracing_subscriber::fmt::try_init();

    // Bind a TCP socket and immediately drop it — guarantees the port is
    // free during the test (no race with another local process) and
    // unreachable for the duration of the connect attempt.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    drop(listener);

    let mut config = McpServerConfig::http(
        "remote-down",
        format!("http://{}/mcp", addr),
    );
    config.init_timeout_secs = Some(2);

    let result = tokio::time::timeout(
        Duration::from_secs(5),
        McpClient::connect(&config),
    )
    .await
    .expect("connect must not exceed outer 5s deadline");

    assert!(result.is_err(), "connect to dead URL must fail");
}

/// Sanity check: an MCP server spawned through `from_configs_with_layout`
/// (landlock confined to its workspace + /tmp) still serves its tools
/// normally. The tighter "writes outside workspace are blocked" property
/// is covered by `snaca_workspace::sandbox` unit tests; this one just
/// asserts the wiring doesn't break the happy path.
#[tokio::test]
#[ignore = "spawns sandboxed MCP subprocess via npx"]
async fn sandboxed_pool_still_serves_echo() {
    use snaca_workspace::WorkspaceLayout;

    let _ = tracing_subscriber::fmt::try_init();
    let npx = npx_path().expect("npx not on PATH");

    let tmp = tempfile::tempdir().unwrap();
    let layout =
        WorkspaceLayout::new(std::fs::canonicalize(tmp.path()).unwrap()).unwrap();
    let tenant = TenantId::new("sandboxed");
    let project = ProjectId::from_raw("p");
    layout.ensure_project(&tenant, &project).unwrap();

    let config = McpServerConfig::new("everything", npx.to_string_lossy().to_string())
        .with_args(["-y", "@modelcontextprotocol/server-everything"]);
    let manager = Arc::new(McpManager::from_configs_with_layout(
        &[config],
        layout.clone(),
    ));

    let tools = manager.tools_for(&tenant, &project).await;
    let echo = tools
        .iter()
        .find(|t| t.name() == "mcp__everything__echo")
        .cloned()
        .expect("echo present");

    let out = echo
        .execute(
            json!({"message": "ping from sandbox"}),
            &dummy_ctx(&tenant, &project),
        )
        .await
        .expect("echo through sandbox");
    let text = out.render_text();
    assert!(
        text.contains("ping from sandbox"),
        "echo through sandboxed pool dropped payload: {text}"
    );

    manager.shutdown().await;
}
