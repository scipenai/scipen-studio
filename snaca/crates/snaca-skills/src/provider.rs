//! Per-(tenant, project) skill resolution.
//!
//! [`SkillProvider`] is what the engine asks at the start of each turn to
//! get the registry that applies to *this* tenant and project. The engine
//! never holds a static `SkillRegistry`; that mode would either leak skills
//! across tenants or force a single-tenant deployment.
//!
//! Two implementations ship in this crate:
//! - [`StaticSkillProvider`] — returns the same registry no matter the
//!   keys. Used by tests (and single-tenant deployments that don't bother
//!   with the layout-driven loader).
//! - [`LayoutSkillProvider`] — scans an optional operator-supplied global
//!   directory, then `<data_root>/<tenant>/skills/`, then
//!   `<data_root>/<tenant>/projects/<project>/skills/`, merging global +
//!   tenant + project scopes (project wins, tenant overrides global).
//!   Caches the resulting registry per (tenant, project) for `ttl` to
//!   avoid disk-thrashing on every turn.

use crate::registry::{SkillRegistry, SkillRegistryBuilder};
use crate::scope::SkillScope;
use async_trait::async_trait;
use snaca_core::{ProjectId, TenantId};
use snaca_workspace::WorkspaceLayout;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;
use tracing::debug;

#[async_trait]
pub trait SkillProvider: Send + Sync {
    async fn skills_for(&self, tenant: &TenantId, project: &ProjectId) -> SkillRegistry;
}

/// Static implementation — same registry for everyone. Useful for
/// single-tenant deployments and tests.
#[derive(Clone)]
pub struct StaticSkillProvider {
    registry: SkillRegistry,
}

impl StaticSkillProvider {
    pub fn new(registry: SkillRegistry) -> Self {
        Self { registry }
    }

    pub fn empty() -> Self {
        Self {
            registry: SkillRegistry::empty(),
        }
    }
}

#[async_trait]
impl SkillProvider for StaticSkillProvider {
    async fn skills_for(&self, _tenant: &TenantId, _project: &ProjectId) -> SkillRegistry {
        self.registry.clone()
    }
}

/// Loads skills from the on-disk workspace layout. Project-scope files
/// override tenant-scope files of the same name; tenant overrides the
/// optional operator-supplied global directory (see [`SkillScope::rank`]).
pub struct LayoutSkillProvider {
    layout: WorkspaceLayout,
    /// App-shipped read-only skills (`SkillScope::Bundled`, rank 0 — lowest).
    bundled_dir: Option<PathBuf>,
    /// Optional operator-supplied directory whose `*.md` files apply to
    /// every (tenant, project). Lowest on-disk priority — tenant and
    /// project skills with the same name override entries here. `None`
    /// disables the global scope entirely (existing two-scope behaviour).
    global_dir: Option<PathBuf>,
    ttl: Duration,
    cache: Mutex<HashMap<(TenantId, ProjectId), CacheEntry>>,
}

const DEFAULT_TTL: Duration = Duration::from_secs(5);

#[derive(Clone)]
struct CacheEntry {
    registry: SkillRegistry,
    fetched_at: Instant,
}

impl LayoutSkillProvider {
    pub fn new(layout: WorkspaceLayout) -> Self {
        Self::with_ttl(layout, DEFAULT_TTL)
    }

    pub fn with_ttl(layout: WorkspaceLayout, ttl: Duration) -> Self {
        Self {
            layout,
            bundled_dir: None,
            global_dir: None,
            ttl,
            cache: Mutex::new(HashMap::new()),
        }
    }

    /// Build a provider that re-scans on every call. Convenient for tests
    /// that mutate skill files between turns.
    pub fn without_cache(layout: WorkspaceLayout) -> Self {
        Self::with_ttl(layout, Duration::from_secs(0))
    }

    /// Attach an operator-supplied global skills directory. `None` clears
    /// it. The directory is loaded with `SkillScope::Global` (rank 1) so
    /// tenant + project entries with the same name override it.
    pub fn with_global_dir(mut self, dir: Option<PathBuf>) -> Self {
        self.global_dir = dir;
        self
    }

    /// Attach the app-shipped read-only bundled-skills dir (`SkillScope::Bundled`,
    /// rank 0 — overridden by global/tenant/project of the same name).
    pub fn with_bundled_dir(mut self, dir: Option<PathBuf>) -> Self {
        self.bundled_dir = dir;
        self
    }

    /// Drop any cached entry for `(tenant, project)`. The next call will
    /// re-scan disk. Used by the (planned) admin "reload skills" API.
    pub async fn invalidate(&self, tenant: &TenantId, project: &ProjectId) {
        let mut cache = self.cache.lock().await;
        cache.remove(&(tenant.clone(), project.clone()));
    }

    async fn load(&self, tenant: &TenantId, project: &ProjectId) -> SkillRegistry {
        let mut b = SkillRegistryBuilder::default();
        // bundled (rank 0) → global → tenant → project (highest).
        if let Some(bundled_dir) = &self.bundled_dir {
            if let Err(e) = b.add_from_dir(bundled_dir, SkillScope::Bundled) {
                tracing::warn!(error = %e, dir = %bundled_dir.display(), "bundled skill load failed");
            }
        }
        if let Some(global_dir) = &self.global_dir {
            if let Err(e) = b.add_from_dir(global_dir, SkillScope::Global) {
                tracing::warn!(error = %e, dir = %global_dir.display(), "global skill load failed");
            }
        }
        let tenant_dir = self.layout.tenant_skills_dir(tenant);
        if let Err(e) = b.add_from_dir(&tenant_dir, SkillScope::Tenant) {
            tracing::warn!(error = %e, dir = %tenant_dir.display(), "tenant skill load failed");
        }
        let project_dir = self.layout.project_skills_dir(tenant, project);
        if let Err(e) = b.add_from_dir(&project_dir, SkillScope::Project) {
            tracing::warn!(error = %e, dir = %project_dir.display(), "project skill load failed");
        }
        let registry = b.build();
        debug!(
            tenant = tenant.as_str(),
            project = project.as_str(),
            count = registry.len(),
            "loaded skills"
        );
        registry
    }
}

#[async_trait]
impl SkillProvider for LayoutSkillProvider {
    async fn skills_for(&self, tenant: &TenantId, project: &ProjectId) -> SkillRegistry {
        let key = (tenant.clone(), project.clone());
        if !self.ttl.is_zero() {
            let cache = self.cache.lock().await;
            if let Some(entry) = cache.get(&key) {
                if entry.fetched_at.elapsed() < self.ttl {
                    return entry.registry.clone();
                }
            }
            drop(cache);
        }
        let registry = self.load(tenant, project).await;
        let mut cache = self.cache.lock().await;
        cache.insert(
            key,
            CacheEntry {
                registry: registry.clone(),
                fetched_at: Instant::now(),
            },
        );
        registry
    }
}

/// Convenience: trait-object alias used by callers that don't care which
/// concrete provider they got.
pub type DynSkillProvider = Arc<dyn SkillProvider>;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skill::Skill;

    fn skill_md(name: &str, body: &str) -> String {
        format!("---\nname: {name}\ndescription: {name} desc\n---\n{body}\n")
    }

    fn write_skill(dir: &std::path::Path, file: &str, content: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(file), content).unwrap();
    }

    #[tokio::test]
    async fn static_provider_returns_same_registry() {
        let registry = SkillRegistry::from_skills(vec![Skill::from_str(
            &skill_md("hello", "body"),
            SkillScope::Tenant,
            None,
        )
        .unwrap()]);
        let provider = StaticSkillProvider::new(registry);
        let t = TenantId::new("t");
        let p = ProjectId::from_raw("p");
        let r = provider.skills_for(&t, &p).await;
        assert_eq!(r.len(), 1);
        assert!(r.get("hello").is_some());
    }

    #[tokio::test]
    async fn layout_provider_isolates_tenants() {
        let dir = tempfile::tempdir().unwrap();
        let layout = WorkspaceLayout::new(dir.path()).unwrap();
        let t_a = TenantId::new("alpha");
        let t_b = TenantId::new("beta");
        let p = ProjectId::from_raw("proj");

        // Each tenant has its own tenant-scope skill.
        write_skill(
            &layout.tenant_skills_dir(&t_a),
            "audit.md",
            &skill_md("audit", "alpha-audit body"),
        );
        write_skill(
            &layout.tenant_skills_dir(&t_b),
            "review.md",
            &skill_md("review", "beta-review body"),
        );

        let provider = LayoutSkillProvider::without_cache(layout);
        let alpha = provider.skills_for(&t_a, &p).await;
        let beta = provider.skills_for(&t_b, &p).await;

        assert_eq!(alpha.len(), 1);
        assert!(alpha.get("audit").is_some());
        assert!(alpha.get("review").is_none(), "tenants must not see each other");

        assert_eq!(beta.len(), 1);
        assert!(beta.get("review").is_some());
        assert!(beta.get("audit").is_none());
    }

    #[tokio::test]
    async fn project_scope_overrides_tenant_scope_via_provider() {
        let dir = tempfile::tempdir().unwrap();
        let layout = WorkspaceLayout::new(dir.path()).unwrap();
        let t = TenantId::new("t");
        let p = ProjectId::from_raw("p");
        write_skill(
            &layout.tenant_skills_dir(&t),
            "review.md",
            &skill_md("review", "tenant body"),
        );
        write_skill(
            &layout.project_skills_dir(&t, &p),
            "review.md",
            &skill_md("review", "project body"),
        );

        let provider = LayoutSkillProvider::without_cache(layout);
        let registry = provider.skills_for(&t, &p).await;
        assert_eq!(registry.len(), 1);
        let review = registry.get("review").unwrap();
        assert!(review.body.contains("project body"));
        assert_eq!(review.scope, SkillScope::Project);
    }

    #[tokio::test]
    async fn global_scope_is_visible_across_tenants() {
        let dir = tempfile::tempdir().unwrap();
        let layout = WorkspaceLayout::new(dir.path()).unwrap();
        let global_dir = dir.path().join("global-skills");
        write_skill(&global_dir, "house.md", &skill_md("house", "house rules"));

        let provider = LayoutSkillProvider::without_cache(layout)
            .with_global_dir(Some(global_dir));

        let t_a = TenantId::new("alpha");
        let t_b = TenantId::new("beta");
        let p = ProjectId::from_raw("p");
        let a = provider.skills_for(&t_a, &p).await;
        let b = provider.skills_for(&t_b, &p).await;

        assert!(a.get("house").is_some(), "alpha tenant sees global skill");
        assert!(b.get("house").is_some(), "beta tenant sees the same global skill");
        assert_eq!(a.get("house").unwrap().scope, SkillScope::Global);
    }

    #[tokio::test]
    async fn tenant_and_project_override_global_in_that_order() {
        let dir = tempfile::tempdir().unwrap();
        let layout = WorkspaceLayout::new(dir.path()).unwrap();
        let global_dir = dir.path().join("global-skills");
        let t = TenantId::new("t");
        let p = ProjectId::from_raw("p");

        // Same skill name `review` in all three scopes.
        write_skill(&global_dir, "review.md", &skill_md("review", "global body"));
        write_skill(
            &layout.tenant_skills_dir(&t),
            "review.md",
            &skill_md("review", "tenant body"),
        );
        write_skill(
            &layout.project_skills_dir(&t, &p),
            "review.md",
            &skill_md("review", "project body"),
        );

        let provider = LayoutSkillProvider::without_cache(layout.clone())
            .with_global_dir(Some(global_dir));
        let registry = provider.skills_for(&t, &p).await;
        let review = registry.get("review").unwrap();
        assert_eq!(review.scope, SkillScope::Project, "project beats tenant beats global");
        assert!(review.body.contains("project body"));

        // Drop the project copy → tenant should win, with global still in the
        // background but overridden.
        let proj_skill = layout.project_skills_dir(&t, &p).join("review.md");
        std::fs::remove_file(&proj_skill).unwrap();
        let registry = provider.skills_for(&t, &p).await;
        let review = registry.get("review").unwrap();
        assert_eq!(review.scope, SkillScope::Tenant);
        assert!(review.body.contains("tenant body"));
    }

    #[tokio::test]
    async fn missing_global_dir_is_tolerated() {
        let dir = tempfile::tempdir().unwrap();
        let layout = WorkspaceLayout::new(dir.path()).unwrap();
        let t = TenantId::new("t");
        let p = ProjectId::from_raw("p");
        write_skill(
            &layout.tenant_skills_dir(&t),
            "audit.md",
            &skill_md("audit", "tenant body"),
        );
        // Point at a path that doesn't exist on disk — provider must not panic.
        let provider = LayoutSkillProvider::without_cache(layout)
            .with_global_dir(Some(dir.path().join("absent")));
        let registry = provider.skills_for(&t, &p).await;
        assert_eq!(registry.len(), 1);
        assert!(registry.get("audit").is_some());
    }

    #[tokio::test]
    async fn bundled_scope_loads_and_is_overridden_by_tenant() {
        let dir = tempfile::tempdir().unwrap();
        let layout = WorkspaceLayout::new(dir.path()).unwrap();
        let bundled = dir.path().join("bundled-skills");
        let t = TenantId::new("t");
        let p = ProjectId::from_raw("p");
        write_skill(&bundled, "writer.md", &skill_md("writer", "bundled writer"));
        write_skill(&bundled, "reviewer.md", &skill_md("reviewer", "bundled reviewer"));
        write_skill(
            &layout.tenant_skills_dir(&t),
            "writer.md",
            &skill_md("writer", "tenant writer"),
        );

        let provider = LayoutSkillProvider::without_cache(layout).with_bundled_dir(Some(bundled));
        let reg = provider.skills_for(&t, &p).await;
        assert_eq!(reg.len(), 2);
        assert_eq!(reg.get("reviewer").unwrap().scope, SkillScope::Bundled);
        let writer = reg.get("writer").unwrap();
        assert_eq!(writer.scope, SkillScope::Tenant, "tenant overrides bundled");
        assert!(writer.body.contains("tenant writer"));
    }

    #[tokio::test]
    async fn cached_provider_returns_stale_until_ttl_expires() {
        let dir = tempfile::tempdir().unwrap();
        let layout = WorkspaceLayout::new(dir.path()).unwrap();
        let t = TenantId::new("t");
        let p = ProjectId::from_raw("p");

        write_skill(
            &layout.tenant_skills_dir(&t),
            "first.md",
            &skill_md("first", "v1"),
        );
        let provider = LayoutSkillProvider::with_ttl(layout, Duration::from_secs(60));
        let r1 = provider.skills_for(&t, &p).await;
        assert_eq!(r1.len(), 1);
        assert!(r1.get("first").is_some());

        // Add a second skill on disk; cache should still serve the old set.
        let layout2 = WorkspaceLayout::new(dir.path()).unwrap();
        write_skill(
            &layout2.tenant_skills_dir(&t),
            "second.md",
            &skill_md("second", "v2"),
        );

        let r2 = provider.skills_for(&t, &p).await;
        assert_eq!(r2.len(), 1, "cache hit serves stale entry");

        provider.invalidate(&t, &p).await;
        let r3 = provider.skills_for(&t, &p).await;
        assert_eq!(r3.len(), 2, "after invalidate the on-disk addition is visible");
    }
}
