//! Per-(tenant, project) MCP client cache for one MCP server config.
//!
//! Multi-tenant deployments must not let tenant A's calls reach a server
//! process that's been authenticated as tenant B (e.g. the GitHub MCP
//! server holds tenant-specific tokens in its env). Solution: spawn one
//! `McpClient` per `(tenant, project)` lazily on first use. The `McpPool`
//! caches them; subsequent turns for the same key reuse the existing
//! connection.
//!
//! ## Idle eviction
//!
//! Each cached client has a `last_used` timestamp; on every `client_for`
//! call we sweep the cache and drop any entry whose age exceeds
//! `idle_ttl`. Default 10 minutes. Eviction is *lazy* — no background
//! task; the next look-up does the work. The trade-off: a tenant that
//! goes silent for an hour leaves its subprocess running until somebody
//! else's request triggers the sweep. For deployments with very lopsided
//! traffic, the next iteration adds a periodic reaper.
//!
//! Setting `idle_ttl = Duration::ZERO` keeps every client alive forever
//! — useful for tests and single-tenant deployments where churn is nil.

use crate::client::McpClient;
use crate::config::McpServerConfig;
use crate::error::McpResult;
use crate::tool::McpTool;
use snaca_core::{ProjectId, TenantId};
use snaca_tools_api::Tool;
use snaca_workspace::WorkspaceLayout;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tracing::{debug, info, warn};

/// Default idle TTL — matches the value called out in the architecture
/// plan ("10 min"). 0 disables eviction.
pub const DEFAULT_IDLE_TTL: Duration = Duration::from_secs(600);

/// Exponential-backoff knobs for failed spawns. After N consecutive
/// failures the pool waits `BACKOFF_BASE * BACKOFF_GROWTH^(N-1)`,
/// capped at `BACKOFF_MAX`, before letting `client_for` attempt the
/// spawn again. Aligns with claude-code's mcpSocketClient.ts retry
/// schedule.
const BACKOFF_BASE: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
const BACKOFF_GROWTH: f32 = 1.5;

struct CachedClient {
    client: Arc<McpClient>,
    last_used: Instant,
}

/// One backoff slot per `(tenant, project)`. Records consecutive
/// spawn failures and the wall-clock instant the pool may retry.
#[derive(Debug, Clone, Copy)]
struct BackoffEntry {
    failures: u32,
    retry_after: Instant,
}

pub struct McpPool {
    config: McpServerConfig,
    clients: Mutex<HashMap<(TenantId, ProjectId), CachedClient>>,
    /// Backoff slots for keys whose most recent spawn failed. Cleared
    /// on successful connect. Read on every `client_for` call; if a
    /// key is in backoff and `retry_after > now` we short-circuit
    /// with `McpError::Backoff` so the engine moves on without
    /// MCP tools for the turn.
    backoff: Mutex<HashMap<(TenantId, ProjectId), BackoffEntry>>,
    /// Workspace layout used to compute the sandbox root per
    /// `(tenant, project)`. `None` disables sandboxing — child runs with
    /// the engine's filesystem privileges, matching M1 behavior.
    layout: Option<WorkspaceLayout>,
    idle_ttl: Duration,
}

impl McpPool {
    pub fn new(config: McpServerConfig) -> Self {
        Self {
            config,
            clients: Mutex::new(HashMap::new()),
            backoff: Mutex::new(HashMap::new()),
            layout: None,
            idle_ttl: DEFAULT_IDLE_TTL,
        }
    }

    pub fn with_layout(mut self, layout: WorkspaceLayout) -> Self {
        self.layout = Some(layout);
        self
    }

    /// Override the idle TTL. `Duration::ZERO` disables eviction.
    pub fn with_idle_ttl(mut self, idle_ttl: Duration) -> Self {
        self.idle_ttl = idle_ttl;
        self
    }

    pub fn server_name(&self) -> &str {
        &self.config.name
    }

    /// Return the cached or freshly-spawned client for `(tenant, project)`.
    /// Concurrent calls for the same key may briefly race; the loser of
    /// the race drops its client (it's never added to the pool) and
    /// returns the winner's. Cost: at most one extra subprocess that
    /// exits when its `Arc` is dropped a moment later.
    pub async fn client_for(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
    ) -> McpResult<Arc<McpClient>> {
        let key = (tenant.clone(), project.clone());
        let now = Instant::now();

        // Backoff gate. If a recent spawn for this key failed and we
        // haven't waited out the cooldown, fail fast — caller
        // (`tools_for`) logs and surfaces an empty tool list, the
        // engine continues without MCP for this turn. Avoids
        // spawning a doomed subprocess every turn while the server
        // is down.
        {
            let backoff_map = self.backoff.lock().await;
            if let Some(entry) = backoff_map.get(&key) {
                if entry.retry_after > now {
                    return Err(crate::error::McpError::Backoff {
                        server: self.config.name.clone(),
                        failures: entry.failures,
                        retry_in_ms: entry.retry_after.duration_since(now).as_millis() as u64,
                    });
                }
            }
        }

        // Fast path: cache hit + sweep expired in one critical section.
        let evicted: Vec<Arc<McpClient>> = {
            let mut map = self.clients.lock().await;

            // Lazy eviction. Skip when ttl is zero (disabled) or the cache
            // is empty.
            let mut evicted = Vec::new();
            if !self.idle_ttl.is_zero() && !map.is_empty() {
                let expired_keys: Vec<_> = map
                    .iter()
                    .filter(|(k, c)| {
                        // Don't evict the entry we're about to refresh.
                        **k != key && now.duration_since(c.last_used) >= self.idle_ttl
                    })
                    .map(|(k, _)| k.clone())
                    .collect();
                for k in expired_keys {
                    if let Some(c) = map.remove(&k) {
                        debug!(
                            server = %self.config.name,
                            tenant = k.0.as_str(),
                            project = k.1.as_str(),
                            "evicting idle mcp client"
                        );
                        evicted.push(c.client);
                    }
                }
            }

            if let Some(cached) = map.get_mut(&key) {
                cached.last_used = now;
                let client = cached.client.clone();
                drop(map);
                spawn_shutdowns(&self.config.name, evicted);
                return Ok(client);
            }
            evicted
        };
        // Out-of-band cleanup of evicted clients, on the same call path
        // as the fast-path miss. Ordering: shutdown the evictees first
        // (they're already orphaned) then proceed to spawn.
        spawn_shutdowns(&self.config.name, evicted);

        // Slow path — spawn outside the lock so concurrent (tenant, project)
        // pairs don't serialize on the pool mutex.
        debug!(
            server = %self.config.name,
            tenant = tenant.as_str(),
            project = project.as_str(),
            "spawning new mcp client"
        );
        // The sandbox root is the per-project workspace dir. Computed
        // lazily here (rather than at construction) because pool entries
        // for different projects need different sandboxes.
        let sandbox = self
            .layout
            .as_ref()
            .map(|l| l.workspace_dir(tenant, project));
        let client = match McpClient::connect_sandboxed(&self.config, sandbox.as_deref()).await {
            Ok(c) => Arc::new(c),
            Err(e) => {
                // Bump backoff so the next turn doesn't immediately
                // retry. The growth schedule mirrors the constants at
                // module top.
                let mut backoff_map = self.backoff.lock().await;
                let entry = backoff_map.entry(key.clone()).or_insert(BackoffEntry {
                    failures: 0,
                    retry_after: Instant::now(),
                });
                entry.failures = entry.failures.saturating_add(1);
                entry.retry_after = Instant::now() + backoff_duration(entry.failures);
                warn!(
                    server = %self.config.name,
                    tenant = tenant.as_str(),
                    project = project.as_str(),
                    failures = entry.failures,
                    retry_after_ms = entry.retry_after.duration_since(Instant::now()).as_millis() as u64,
                    error = %e,
                    "mcp connect failed; entering backoff"
                );
                return Err(e);
            }
        };

        // Successful connect — clear any prior backoff state.
        {
            let mut backoff_map = self.backoff.lock().await;
            backoff_map.remove(&key);
        }

        let mut map = self.clients.lock().await;
        // Re-check under the lock — another task may have won the race.
        if let Some(existing) = map.get_mut(&key) {
            existing.last_used = Instant::now();
            return Ok(existing.client.clone());
        }
        let cached = CachedClient {
            client: client.clone(),
            last_used: Instant::now(),
        };
        map.insert(key, cached);
        info!(
            server = %self.config.name,
            tenant = tenant.as_str(),
            project = project.as_str(),
            tool_count = client.tools().len(),
            "mcp client added to pool"
        );
        Ok(client)
    }

    /// Build SNACA `Tool` instances for the given `(tenant, project)`.
    /// Returns an empty Vec on connection failure (logged) so a misbehaving
    /// MCP server doesn't kill the whole turn.
    pub async fn tools_for(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
    ) -> Vec<Arc<dyn Tool>> {
        let client = match self.client_for(tenant, project).await {
            Ok(c) => c,
            Err(e) => {
                warn!(
                    server = %self.config.name,
                    error = %e,
                    "mcp client_for failed; tenant will see no tools from this server"
                );
                return Vec::new();
            }
        };
        client
            .tools()
            .iter()
            .filter_map(|tool| {
                McpTool::new(client.clone(), tool.clone())
                    .map(|t| Arc::new(t) as Arc<dyn Tool>)
            })
            .collect()
    }

    /// Snapshot of the keys currently pooled. Mostly for diagnostics and tests.
    pub async fn active_clients(&self) -> Vec<(TenantId, ProjectId)> {
        self.clients.lock().await.keys().cloned().collect()
    }

    /// Drop every cache entry whose `last_used` exceeds the pool's
    /// `idle_ttl`. Lazy eviction on `client_for` only triggers when
    /// somebody asks for a client; a periodic reaper task calls this
    /// directly so quiet-hour deployments still release subprocess
    /// resources. No-op when `idle_ttl` is zero.
    pub async fn sweep_idle(&self) -> usize {
        if self.idle_ttl.is_zero() {
            return 0;
        }
        let now = Instant::now();
        let evicted: Vec<Arc<McpClient>> = {
            let mut map = self.clients.lock().await;
            let expired_keys: Vec<_> = map
                .iter()
                .filter(|(_, c)| now.duration_since(c.last_used) >= self.idle_ttl)
                .map(|(k, _)| k.clone())
                .collect();
            let mut evicted = Vec::new();
            for k in expired_keys {
                if let Some(c) = map.remove(&k) {
                    debug!(
                        server = %self.config.name,
                        tenant = k.0.as_str(),
                        project = k.1.as_str(),
                        "reaper evicting idle mcp client"
                    );
                    evicted.push(c.client);
                }
            }
            evicted
        };
        let count = evicted.len();
        spawn_shutdowns(&self.config.name, evicted);
        count
    }

    /// Active health probe over every cached client. Failing entries
    /// are evicted from the pool so the next `client_for` triggers a
    /// fresh spawn (subject to backoff). Returns the eviction count;
    /// the manager's reaper task calls this after `sweep_idle` so
    /// quiet pools still catch dead subprocesses without waiting for
    /// the next user request to surface the failure.
    ///
    /// Idle entries that are about to be swept are deliberately
    /// probed too — a connection broken silently while idle deserves
    /// to be cleared eagerly, not after the next `tools_for` turn
    /// pays the timeout. The probe is cheap (one `tools/list` RPC)
    /// and only walks entries not freshly used in the current tick.
    pub async fn health_check(&self) -> usize {
        // Snapshot the (key, client Arc) pairs under the lock, then
        // release before the awaits. Probing under the lock would
        // serialise every other pool operation behind a network
        // round-trip.
        let snapshot: Vec<((TenantId, ProjectId), Arc<McpClient>)> = {
            let map = self.clients.lock().await;
            map.iter()
                .map(|(k, c)| (k.clone(), c.client.clone()))
                .collect()
        };

        if snapshot.is_empty() {
            return 0;
        }

        let mut dead_keys: Vec<(TenantId, ProjectId)> = Vec::new();
        for (key, client) in snapshot {
            if let Err(e) = client.health_check().await {
                warn!(
                    server = %self.config.name,
                    tenant = key.0.as_str(),
                    project = key.1.as_str(),
                    error = %e,
                    "mcp health probe failed; evicting"
                );
                dead_keys.push(key);
            }
        }

        if dead_keys.is_empty() {
            return 0;
        }

        let evicted: Vec<Arc<McpClient>> = {
            let mut map = self.clients.lock().await;
            dead_keys
                .iter()
                .filter_map(|k| map.remove(k).map(|c| c.client))
                .collect()
        };
        let count = evicted.len();
        spawn_shutdowns(&self.config.name, evicted);
        count
    }

    pub async fn shutdown(&self) {
        let mut map = self.clients.lock().await;
        for ((tenant, project), cached) in map.drain() {
            match Arc::try_unwrap(cached.client) {
                Ok(c) => c.shutdown().await,
                Err(_) => debug!(
                    server = %self.config.name,
                    tenant = tenant.as_str(),
                    project = project.as_str(),
                    "client still has live clones; relying on Drop"
                ),
            }
        }
    }
}

/// Exponential backoff schedule: `BACKOFF_BASE * BACKOFF_GROWTH^(failures-1)`,
/// capped at `BACKOFF_MAX`. `failures = 1` → 1s, 2 → 1.5s, 3 → 2.25s,
/// ..., asymptoting at 30s. `failures = 0` is treated as 1 (we only
/// ever call this after recording at least one failure).
fn backoff_duration(failures: u32) -> Duration {
    // Cap the exponent so a wildly-large failures count can't overflow
    // i32 (which would wrap negative and feed `powi` a fractional
    // result — backoff = 444ms instead of the cap). 30 is well past
    // saturation: 1.5^30 ≈ 191k, times the 1s base, far exceeds the
    // 30s cap, so the `min` clamps to BACKOFF_MAX cleanly.
    let exp = failures.max(1).saturating_sub(1).min(30) as i32;
    let base_ms = BACKOFF_BASE.as_millis() as f32;
    let max_ms = BACKOFF_MAX.as_millis() as f32;
    let raw = base_ms * BACKOFF_GROWTH.powi(exp);
    Duration::from_millis(raw.min(max_ms) as u64)
}

/// Fire-and-forget shutdown for evicted clients. Each gets its own
/// task so we don't block the caller on graceful shutdown.
fn spawn_shutdowns(server_name: &str, clients: Vec<Arc<McpClient>>) {
    if clients.is_empty() {
        return;
    }
    let server_name = server_name.to_string();
    for client in clients {
        let server_name = server_name.clone();
        tokio::spawn(async move {
            match Arc::try_unwrap(client) {
                Ok(c) => c.shutdown().await,
                Err(_) => debug!(
                    server = %server_name,
                    "evicted client still has live clones; relying on Drop"
                ),
            }
        });
    }
}

/// Pure helper exposed for unit tests: given a snapshot of `last_used`
/// timestamps, return the keys whose age has exceeded `ttl`. The pool
/// itself uses the equivalent inline logic against its `HashMap<_, CachedClient>`;
/// this freestanding function lets us assert eviction rules without
/// having to spawn real subprocesses.
#[doc(hidden)]
pub fn collect_expired_keys<K: Clone + Eq + std::hash::Hash>(
    last_used: &HashMap<K, Instant>,
    now: Instant,
    ttl: Duration,
) -> Vec<K> {
    if ttl.is_zero() {
        return Vec::new();
    }
    last_used
        .iter()
        .filter(|(_, t)| now.duration_since(**t) >= ttl)
        .map(|(k, _)| k.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(secs_ago: u64) -> Instant {
        Instant::now() - Duration::from_secs(secs_ago)
    }

    #[test]
    fn collect_expired_returns_keys_past_ttl() {
        let mut m = HashMap::new();
        m.insert("fresh", ts(5));
        m.insert("warm", ts(60));
        m.insert("stale", ts(700));
        m.insert("ancient", ts(3600));

        let expired = collect_expired_keys(&m, Instant::now(), Duration::from_secs(600));
        let mut expired = expired;
        expired.sort();
        assert_eq!(expired, vec!["ancient", "stale"]);
    }

    #[test]
    fn collect_expired_no_op_when_ttl_zero() {
        let mut m = HashMap::new();
        m.insert("ancient", ts(99_999));
        let expired = collect_expired_keys(&m, Instant::now(), Duration::ZERO);
        assert!(expired.is_empty(), "ttl=0 must keep every key");
    }

    #[test]
    fn collect_expired_empty_input() {
        let m: HashMap<&str, Instant> = HashMap::new();
        let expired = collect_expired_keys(&m, Instant::now(), Duration::from_secs(60));
        assert!(expired.is_empty());
    }

    #[test]
    fn backoff_grows_geometrically_then_caps() {
        let d1 = backoff_duration(1);
        let d2 = backoff_duration(2);
        let d3 = backoff_duration(3);
        // 1s, 1.5s, 2.25s — strictly increasing.
        assert!(d1 < d2, "got d1={d1:?} d2={d2:?}");
        assert!(d2 < d3, "got d2={d2:?} d3={d3:?}");
        // First step exactly equals the base.
        assert_eq!(d1, BACKOFF_BASE);
        // Far-future caps at BACKOFF_MAX.
        assert_eq!(backoff_duration(50), BACKOFF_MAX);
        assert_eq!(backoff_duration(u32::MAX), BACKOFF_MAX);
    }

    #[test]
    fn backoff_zero_failures_treated_as_one() {
        // Defensive: if a caller ever asks for failures=0, don't
        // collapse to a zero-duration retry (instant-spin).
        assert_eq!(backoff_duration(0), BACKOFF_BASE);
    }
}
