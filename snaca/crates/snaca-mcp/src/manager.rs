//! `McpManager` — fans out across multiple MCP server configs, lazily.
//!
//! A pool per server, each pool cached per `(tenant, project)`. The first
//! turn for a `(tenant, project)` pays subprocess startup; subsequent turns
//! reuse the connection. Failures on individual servers don't bubble up —
//! the offending tenant just sees no tools from that server.
//!
//! ## Reaper
//!
//! Eviction inside [`McpPool`] is *lazy* — it only runs when somebody
//! calls `client_for`. For deployments with very lopsided traffic
//! (one tenant idle for hours while others stay busy), a quiet pool's
//! subprocesses would never get reclaimed. `start_reaper(period)`
//! spawns a periodic background task that calls `pool.sweep_idle()` on
//! every pool, so subprocesses always die a bounded time after going
//! idle. Manager `shutdown()` aborts the reaper.

use crate::config::McpServerConfig;
use crate::pool::{McpPool, DEFAULT_IDLE_TTL};
use snaca_core::{ProjectId, TenantId};
use snaca_tools_api::Tool;
use snaca_workspace::WorkspaceLayout;
use std::sync::{Arc, Mutex as StdMutex, Weak};
use std::time::Duration;
use tokio::task::JoinHandle;
use tracing::debug;

/// Default reaper period. The reaper itself is cheap (a hash-map walk
/// per pool); 60s is the lowest cadence that still keeps p99
/// subprocess-kill latency tolerable for hour-scale idle TTLs.
pub const DEFAULT_REAPER_PERIOD: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct McpManager {
    pools: Vec<Arc<McpPool>>,
    reaper: StdMutex<Option<JoinHandle<()>>>,
}

impl McpManager {
    /// Construct a manager with one pool per config. No subprocesses are
    /// spawned until `tools_for(...)` is called for some `(tenant, project)`.
    /// MCP children run unsandboxed — appropriate for trusted single-tenant
    /// deployments.
    pub fn from_configs(configs: &[McpServerConfig]) -> Self {
        Self {
            pools: configs
                .iter()
                .cloned()
                .map(|c| Arc::new(McpPool::new(c)))
                .collect(),
            reaper: StdMutex::new(None),
        }
    }

    /// Same as `from_configs` but with an explicit idle TTL. No sandboxing.
    /// `Duration::ZERO` keeps every spawned client alive forever.
    pub fn from_configs_with_ttl(configs: &[McpServerConfig], idle_ttl: Duration) -> Self {
        Self {
            pools: configs
                .iter()
                .cloned()
                .map(|c| Arc::new(McpPool::new(c).with_idle_ttl(idle_ttl)))
                .collect(),
            reaper: StdMutex::new(None),
        }
    }

    /// Multi-tenant constructor — each spawned MCP child is confined via
    /// landlock to its `(tenant, project)` workspace plus `/tmp` and the
    /// standard read-only system dirs (Linux only; ignored on other
    /// platforms). Use this for any deployment where MCP servers run
    /// untrusted code or are shared across tenants. Idle TTL defaults to
    /// 10 minutes.
    pub fn from_configs_with_layout(
        configs: &[McpServerConfig],
        layout: WorkspaceLayout,
    ) -> Self {
        Self::from_configs_with_layout_and_ttl(configs, layout, DEFAULT_IDLE_TTL)
    }

    /// Same as `from_configs_with_layout` but with an explicit idle TTL.
    /// Pass `Duration::ZERO` to keep every spawned client alive forever.
    pub fn from_configs_with_layout_and_ttl(
        configs: &[McpServerConfig],
        layout: WorkspaceLayout,
        idle_ttl: Duration,
    ) -> Self {
        Self {
            pools: configs
                .iter()
                .cloned()
                .map(|c| {
                    Arc::new(
                        McpPool::new(c)
                            .with_layout(layout.clone())
                            .with_idle_ttl(idle_ttl),
                    )
                })
                .collect(),
            reaper: StdMutex::new(None),
        }
    }

    pub fn empty() -> Self {
        Self::default()
    }

    /// Aggregate tools from every configured server for one `(tenant, project)`.
    /// Per-server failures are swallowed (logged inside `McpPool::tools_for`)
    /// so the engine can still surface base tools and skills even if an MCP
    /// server is misconfigured.
    pub async fn tools_for(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
    ) -> Vec<Arc<dyn Tool>> {
        let mut out = Vec::new();
        for pool in &self.pools {
            let mut tools = pool.tools_for(tenant, project).await;
            out.append(&mut tools);
        }
        out
    }

    pub fn server_count(&self) -> usize {
        self.pools.len()
    }

    pub fn server_names(&self) -> impl Iterator<Item = &str> {
        self.pools.iter().map(|p| p.server_name())
    }

    /// Snapshot of the manager's pools. Exposed for tests and diagnostics
    /// that need to peek at per-pool state (e.g. `active_clients()`)
    /// without going through `tools_for` (which itself triggers eviction).
    #[doc(hidden)]
    pub fn pools(&self) -> &[Arc<McpPool>] {
        &self.pools
    }

    /// Spawn the periodic reaper. Each `period` interval the task walks
    /// every pool and calls `sweep_idle()`. Idempotent — calling twice
    /// aborts the previous task before starting the new one.
    ///
    /// `period == Duration::ZERO` is treated as "no reaper" (the
    /// previous reaper, if any, is aborted and nothing is spawned).
    /// Pools that hold `Duration::ZERO` for their `idle_ttl` accept
    /// the sweep call as a no-op, so the reaper is safe to leave on
    /// for them too.
    pub fn start_reaper(&self, period: Duration) {
        let mut slot = self.reaper.lock().expect("reaper mutex");
        if let Some(prev) = slot.take() {
            prev.abort();
        }
        if period.is_zero() {
            return;
        }
        // Use weak refs so the reaper task doesn't keep pools alive
        // past `shutdown()`. Walking the snapshot is fine even if a
        // pool gets dropped mid-tick — `Weak::upgrade` returns None.
        let pools: Vec<Weak<McpPool>> = self.pools.iter().map(Arc::downgrade).collect();
        let handle = tokio::spawn(async move {
            // Skip the very first tick (which fires immediately) so we
            // don't trigger eviction on freshly-spawned clients.
            let mut interval = tokio::time::interval(period);
            interval.tick().await;
            loop {
                interval.tick().await;
                let mut any_alive = false;
                for w in &pools {
                    if let Some(pool) = w.upgrade() {
                        any_alive = true;
                        let evicted = pool.sweep_idle().await;
                        if evicted > 0 {
                            debug!(
                                server = pool.server_name(),
                                count = evicted,
                                "reaper swept idle clients"
                            );
                        }
                        // Active health probe over the entries that
                        // survived the idle sweep. Dead connections
                        // get evicted now rather than on the next
                        // user request, which would otherwise pay
                        // the full RPC timeout to discover the
                        // breakage.
                        let probed_out = pool.health_check().await;
                        if probed_out > 0 {
                            debug!(
                                server = pool.server_name(),
                                count = probed_out,
                                "reaper evicted unhealthy clients"
                            );
                        }
                    }
                }
                if !any_alive {
                    debug!("all pools dropped; reaper exiting");
                    break;
                }
            }
        });
        *slot = Some(handle);
    }

    /// Drain every pool, killing the subprocesses they hold. Best-effort.
    pub async fn shutdown(&self) {
        let reaper = self.reaper.lock().expect("reaper mutex").take();
        if let Some(h) = reaper {
            h.abort();
            let _ = h.await;
        }
        for pool in &self.pools {
            pool.shutdown().await;
        }
    }
}
