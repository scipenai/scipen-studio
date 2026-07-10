//! `MemoryRead` / `MemoryWrite` — agent-facing tools for the file-tree
//! memory system. Both resolve the per-project memory dir from the tool
//! context's `workspace_root`: the workspace is `<project>/workspace/`,
//! its sibling `<project>/memory/` is the [`MemoryStore`] root.
//!
//! ## Why two tools, not one
//!
//! The model usually wants to *list* what memory exists before *reading*
//! a specific entry. We collapse list+read into a single `MemoryRead`
//! tool with two arms:
//! - omit `name` → return the index (same content as `MEMORY.md`)
//! - provide `name` → return that entry's body
//!
//! This keeps the schema compact (one tool, one input shape) and means
//! a turn never needs more than two memory calls (one to list, one to
//! read the selected entry).
//!
//! ## Approval
//!
//! Both tools are project-internal scaffolding — no approval. Memory
//! lives entirely under the project's `data_root` so the path-traversal
//! guard inside `MemoryStore::sanitize_name` is what blocks abuse, not
//! the approval gate.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use snaca_agent_api::{
    MemoryIndexRequest, MemoryListRequest, MemoryProvider, MemoryProviderError, MemoryProviderSlot,
    MemoryReadRequest, MemoryWriteAction, MemoryWriteCtx, MemoryWriteRequest,
};
use snaca_memory::{MemoryError, MemoryScope, MemoryStore};
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput, ToolResult,
};
use std::path::Path;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// Convention: tools derive the memory dir as a sibling of the workspace
/// root. The engine builds `ToolContext` from `WorkspaceLayout`, which
/// always sets `workspace_root = <project>/workspace/`.
fn memory_store_for(ctx: &ToolContext) -> MemoryStore {
    if let Some(slot) = ctx.memory_store_opaque() {
        if let Ok(store) = slot.downcast::<MemoryStore>() {
            return (*store).clone();
        }
    }
    let memory_dir = ctx
        .workspace_root()
        .parent()
        .map(|p| p.join("memory"))
        .unwrap_or_else(|| Path::new("memory").to_path_buf());
    MemoryStore::new(memory_dir)
}

fn parse_scope(raw: &str) -> Result<MemoryScope, ToolError> {
    MemoryScope::from_str(raw).map_err(ToolError::InvalidInput)
}

fn map_memory_err(e: MemoryError) -> ToolError {
    match e {
        MemoryError::InvalidName { .. } => ToolError::InvalidInput(e.to_string()),
        MemoryError::NotFound { .. } => ToolError::NotFound(e.to_string()),
        MemoryError::Io(io) => ToolError::Io(io),
        // The memory tool surface doesn't perform Office extraction —
        // this variant only fires from `import_one`. Surface as Execution
        // so the rare CLI/MCP path that bubbles through here gets a
        // structured error rather than a panic.
        MemoryError::ExternalExtractorRequired { .. }
        | MemoryError::EntryTooLarge { .. }
        | MemoryError::ImportScopeBlocked { .. } => ToolError::Execution(e.to_string()),
        // Threat-scanner refusal: surface as InvalidInput so the LLM
        // sees this as "your write was rejected, fix or skip" rather
        // than an internal failure. The error message already carries
        // the rule name + description.
        MemoryError::ThreatBlocked { .. } => ToolError::InvalidInput(e.to_string()),
        // External-drift refusal: surface as Execution so the LLM
        // gets the full message (including the .bak path) and can
        // decide to re-read the entry, merge, or give up. Not
        // InvalidInput — the input itself was fine; the conflict is
        // outside the LLM's control.
        MemoryError::ExternalDrift { .. } => ToolError::Execution(e.to_string()),
    }
}

fn memory_provider_for(ctx: &ToolContext) -> Option<Arc<dyn MemoryProvider>> {
    let slot = ctx.memory_provider_opaque()?;
    let slot = slot.downcast::<MemoryProviderSlot>().ok()?;
    Some(slot.provider())
}

fn map_provider_err(e: MemoryProviderError) -> ToolError {
    match e {
        MemoryProviderError::InvalidScope(scope) => {
            ToolError::InvalidInput(format!("invalid memory scope {scope}"))
        }
        MemoryProviderError::NotFound { scope, name } => {
            ToolError::NotFound(format!("memory entry not found: {scope}/{name}"))
        }
        MemoryProviderError::Io(io) => ToolError::Io(io),
        MemoryProviderError::Other(msg) => ToolError::Execution(msg),
    }
}

async fn provider_read(
    input: MemoryReadInput,
    provider: Arc<dyn MemoryProvider>,
    ctx: &ToolContext,
) -> ToolResult {
    match (input.scope.as_deref(), input.name.as_deref()) {
        (None, None) => {
            let idx = provider
                .index(MemoryIndexRequest {
                    tenant_id: ctx.tenant_id().clone(),
                    project_id: ctx.project_id().clone(),
                })
                .await
                .map_err(map_provider_err)?;
            if idx.trim().is_empty() {
                Ok(ToolOutput::text(
                    "(memory index is empty — no entries recorded yet)",
                ))
            } else {
                Ok(ToolOutput::text(idx))
            }
        }
        (Some(scope), None) => {
            let names = provider
                .list(MemoryListRequest {
                    tenant_id: ctx.tenant_id().clone(),
                    project_id: ctx.project_id().clone(),
                    scope: scope.to_string(),
                })
                .await
                .map_err(map_provider_err)?;
            if names.is_empty() {
                Ok(ToolOutput::text(format!("(no entries under `{scope}`)")))
            } else {
                let mut out = format!("{} entries under `{scope}`:\n", names.len());
                for n in names {
                    out.push_str(&format!("  - {n}\n"));
                }
                Ok(ToolOutput::text(out))
            }
        }
        (Some(scope), Some(name)) => {
            let entry = provider
                .read(MemoryReadRequest {
                    tenant_id: ctx.tenant_id().clone(),
                    project_id: ctx.project_id().clone(),
                    scope: scope.to_string(),
                    name: name.to_string(),
                })
                .await
                .map_err(map_provider_err)?;
            Ok(ToolOutput::text(entry.content))
        }
        (None, Some(_)) => Err(ToolError::InvalidInput(
            "`name` requires a `scope`; pick one of user/project/reference/feedback".into(),
        )),
    }
}

// ---- MemoryRead ------------------------------------------------------

#[derive(Debug, Deserialize)]
struct MemoryReadInput {
    /// Omit to read the project's MEMORY.md index.
    #[serde(default)]
    scope: Option<String>,
    /// Omit (with scope) to list names under that scope; provide both
    /// to read a single entry.
    #[serde(default)]
    name: Option<String>,
}

pub struct MemoryReadTool;

#[async_trait]
impl Tool for MemoryReadTool {
    fn name(&self) -> &str {
        "MemoryRead"
    }

    fn description(&self) -> &str {
        "Read project memory. Three modes:\n\
         - omit `scope` and `name` → return the MEMORY.md index of every entry\n\
         - provide only `scope` (one of user/project/reference/feedback) → list entry names under that scope\n\
         - provide both `scope` and `name` → return the entry's full Markdown body"
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "scope": {
                    "type": "string",
                    "enum": ["user", "project", "reference", "feedback"],
                    "description": "Which scope to read from. Omit to read the index."
                },
                "name": {
                    "type": "string",
                    "description": "Entry name (no .md). Requires `scope`. Omit with `scope` to list names."
                }
            }
        })
    }

    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::default()
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::Never
    }

    fn is_read_only(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let parsed: MemoryReadInput =
            serde_json::from_value(input).map_err(|e| ToolError::InvalidInput(e.to_string()))?;
        if let Some(provider) = memory_provider_for(ctx) {
            return provider_read(parsed, provider, ctx).await;
        }
        let store = memory_store_for(ctx);

        match (parsed.scope.as_deref(), parsed.name.as_deref()) {
            (None, None) => {
                let idx = store.index_text().await.map_err(map_memory_err)?;
                if idx.trim().is_empty() {
                    Ok(ToolOutput::text(
                        "(memory index is empty — no entries recorded yet)",
                    ))
                } else {
                    Ok(ToolOutput::text(idx))
                }
            }
            (Some(scope), None) => {
                let scope = parse_scope(scope)?;
                let names = store.list(scope).await.map_err(map_memory_err)?;
                if names.is_empty() {
                    Ok(ToolOutput::text(format!("(no entries under `{scope}`)")))
                } else {
                    let mut out = format!("{} entries under `{scope}`:\n", names.len());
                    for n in names {
                        out.push_str(&format!("  - {n}\n"));
                    }
                    Ok(ToolOutput::text(out))
                }
            }
            (Some(scope), Some(name)) => {
                let scope = parse_scope(scope)?;
                let entry = store.read(scope, name).await.map_err(map_memory_err)?;
                Ok(ToolOutput::text(entry.content))
            }
            (None, Some(_)) => Err(ToolError::InvalidInput(
                "`name` requires a `scope`; pick one of user/project/reference/feedback".into(),
            )),
        }
    }
}

// ---- MemoryWrite -----------------------------------------------------

#[derive(Debug, Deserialize)]
struct MemoryWriteInput {
    scope: String,
    name: String,
    content: String,
}

pub struct MemoryWriteTool;

#[async_trait]
impl Tool for MemoryWriteTool {
    fn name(&self) -> &str {
        "MemoryWrite"
    }

    fn description(&self) -> &str {
        "Write or overwrite a memory entry. Choose `scope` thoughtfully:\n\
         - user      → facts about the human(s)\n\
         - project   → facts/decisions/conventions about this project\n\
         - reference → pointers to external systems (URLs, dashboards, repos)\n\
         - feedback  → corrections from the user that should never repeat\n\
         `name` will be lowercased and stripped of `.md` if present. Each call \
         replaces the entry's body verbatim — submit the full new text."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "scope": {
                    "type": "string",
                    "enum": ["user", "project", "reference", "feedback"]
                },
                "name": {
                    "type": "string",
                    "description": "Entry name. Lowercased; [a-z0-9_-]+, max 64 chars."
                },
                "content": {
                    "type": "string",
                    "description": "Full Markdown body. Replaces any prior content."
                }
            },
            "required": ["scope", "name", "content"]
        })
    }

    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::writes_filesystem()
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        // No approval — writes land in `<project>/memory/` only and
        // can't escape via name (sanitised).
        ApprovalRequirement::Never
    }

    fn is_read_only(&self) -> bool {
        false
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let parsed: MemoryWriteInput =
            serde_json::from_value(input).map_err(|e| ToolError::InvalidInput(e.to_string()))?;

        // Approval gate: when the engine has memory_write_approval
        // turned on for this turn, the tool doesn't write through
        // the provider/store at all. Instead we stage a pending
        // JSON file and surface a clear placeholder back to the
        // LLM so the conversation can keep moving. An operator
        // approves with `snaca-cli memory approve <id>` (or
        // rejects with `reject <id>`).
        if ctx.memory_write_approval() {
            if memory_provider_for(ctx).is_some() {
                return Err(ToolError::Execution(
                    "memory_write_approval is only supported by the built-in file-tree memory \
                     store; disable it or approve writes in the custom memory provider"
                        .into(),
                ));
            }
            // Validate the scope name through the same parser the
            // unstaged path uses — this surfaces "you typed a
            // bad scope name" before the entry sits in pending
            // limbo.
            let _ = parse_scope(&parsed.scope)?;
            snaca_memory::sanitize_name(&parsed.name).map_err(map_memory_err)?;
            let memory_root = derive_memory_root(ctx);
            let id = pending_id(&parsed.scope, &parsed.name);
            let pending = snaca_memory::Pending {
                id: id.clone(),
                scope: parsed.scope.clone(),
                name: parsed.name.clone(),
                content: parsed.content.clone(),
                requested_by: "memory_write".into(),
                requested_at: chrono::Utc::now().to_rfc3339(),
            };
            snaca_memory::stage_pending(&memory_root, &pending)
                .await
                .map_err(map_memory_err)?;
            return Ok(ToolOutput::text(format!(
                "MemoryWrite was staged for human approval as `{id}` (scope `{scope}`, name `{name}`, {bytes} bytes). \
                 An operator will run `snaca-cli memory approve {id}` to apply it, or `reject {id}` to drop it. \
                 Don't restage the same write — assume the operator will action it.",
                id = id,
                scope = parsed.scope,
                name = parsed.name,
                bytes = parsed.content.len(),
            )));
        }

        if let Some(provider) = memory_provider_for(ctx) {
            let entry = provider
                .write(MemoryWriteRequest {
                    tenant_id: ctx.tenant_id().clone(),
                    project_id: ctx.project_id().clone(),
                    scope: parsed.scope,
                    name: parsed.name,
                    content: parsed.content,
                })
                .await
                .map_err(map_provider_err)?;
            let _ = provider
                .on_memory_write(&MemoryWriteCtx {
                    tenant_id: ctx.tenant_id().clone(),
                    project_id: ctx.project_id().clone(),
                    action: MemoryWriteAction::Tool,
                    scope: entry.scope.clone(),
                    name: entry.name.clone(),
                })
                .await;
            return Ok(ToolOutput::text(format!(
                "wrote `{}/{}` ({} bytes)",
                entry.scope,
                entry.name,
                entry.content.len()
            )));
        }
        let scope = parse_scope(&parsed.scope)?;
        let store = memory_store_for(ctx);
        let entry = store
            .write(scope, &parsed.name, &parsed.content)
            .await
            .map_err(map_memory_err)?;
        Ok(ToolOutput::text(format!(
            "wrote `{}/{}` ({} bytes)",
            entry.scope.as_str(),
            entry.name,
            entry.content.len()
        )))
    }
}

/// Where staged-pending JSON files land. Mirrors `memory_store_for`'s
/// "sibling-of-workspace" convention so an operator running
/// `snaca-cli memory pending` against the same `data_root` sees
/// what the tool wrote.
fn derive_memory_root(ctx: &ToolContext) -> std::path::PathBuf {
    ctx.workspace_root()
        .parent()
        .map(|p| p.join("memory"))
        .unwrap_or_else(|| std::path::Path::new("memory").to_path_buf())
}

/// Generate a stable-ish id for a pending write. We use a short
/// hash of `scope + name + ts` so two concurrent writes of the
/// same `(scope, name)` don't collide, and so the id stays inside
/// `[a-z0-9_-]+` (sanitized by `pending_id_is_safe` on stage).
fn pending_id(scope: &str, name: &str) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let ts = chrono::Utc::now().timestamp_micros();
    let counter = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut hasher = blake3::Hasher::new();
    hasher.update(scope.as_bytes());
    hasher.update(b"/");
    hasher.update(name.as_bytes());
    hasher.update(b":");
    hasher.update(&ts.to_le_bytes());
    hasher.update(b":");
    hasher.update(&counter.to_le_bytes());
    let h = hasher.finalize();
    // 16 hex chars = 64 bits per scope/name; collision chance after
    // thousands of staged writes is vanishing. (The monotonic counter
    // already disambiguates same-microsecond writes.)
    let s = h.to_hex();
    format!("mw-{}", &s.as_str()[..16])
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_agent_api::{MemoryEntryData, MemoryIndexRequest, MemoryListRequest, MemoryProvider};
    use snaca_core::{ProjectId, SessionId, TenantId};
    use std::any::Any;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    /// Build a `ToolContext` whose workspace_root has a sibling
    /// `memory/` dir, matching the real layout the engine creates.
    fn ctx_for(tmp: &Path) -> ToolContext {
        let workspace = tmp.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        ToolContext::new(
            TenantId::new("t"),
            ProjectId::from_raw("p"),
            SessionId::new(),
            workspace,
        )
    }

    #[tokio::test]
    async fn write_then_read_round_trips_through_tools() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_for(dir.path());

        MemoryWriteTool
            .execute(
                json!({"scope": "user", "name": "prefs", "content": "terse output"}),
                &ctx,
            )
            .await
            .unwrap();

        let body = MemoryReadTool
            .execute(json!({"scope": "user", "name": "prefs"}), &ctx)
            .await
            .unwrap()
            .render_text();
        assert_eq!(body, "terse output");
    }

    #[tokio::test]
    async fn read_with_no_args_returns_index() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_for(dir.path());
        MemoryWriteTool
            .execute(
                json!({"scope": "project", "name": "convention", "content": "use kebab-case"}),
                &ctx,
            )
            .await
            .unwrap();

        let idx = MemoryReadTool
            .execute(json!({}), &ctx)
            .await
            .unwrap()
            .render_text();
        assert!(idx.contains("# Memory"));
        assert!(idx.contains("project/convention"));
    }

    #[tokio::test]
    async fn read_with_only_scope_lists_entries() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_for(dir.path());
        for n in ["alpha", "beta"] {
            MemoryWriteTool
                .execute(
                    json!({"scope": "reference", "name": n, "content": "x"}),
                    &ctx,
                )
                .await
                .unwrap();
        }
        let listing = MemoryReadTool
            .execute(json!({"scope": "reference"}), &ctx)
            .await
            .unwrap()
            .render_text();
        assert!(listing.contains("alpha"));
        assert!(listing.contains("beta"));
        assert!(listing.contains("2 entries"));
    }

    #[tokio::test]
    async fn read_missing_entry_surfaces_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_for(dir.path());
        let err = MemoryReadTool
            .execute(json!({"scope": "user", "name": "ghost"}), &ctx)
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::NotFound(_)), "got: {err:?}");
    }

    #[tokio::test]
    async fn write_rejects_invalid_name_via_sanitiser() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_for(dir.path());
        let err = MemoryWriteTool
            .execute(
                json!({"scope": "user", "name": "../escape", "content": "x"}),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)), "got: {err:?}");
    }

    #[tokio::test]
    async fn read_rejects_unknown_scope() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_for(dir.path());
        let err = MemoryReadTool
            .execute(json!({"scope": "secret", "name": "x"}), &ctx)
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)), "got: {err:?}");
    }

    #[tokio::test]
    async fn write_persists_under_project_memory_sibling_dir() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_for(dir.path());
        MemoryWriteTool
            .execute(
                json!({"scope": "feedback", "name": "tone", "content": "no emojis"}),
                &ctx,
            )
            .await
            .unwrap();
        let on_disk = dir.path().join("memory/feedback/tone.md");
        assert!(on_disk.exists(), "expected file at {}", on_disk.display());
    }

    #[tokio::test]
    async fn shared_memory_store_detects_external_drift_between_read_and_write() {
        let dir = tempfile::tempdir().unwrap();
        let memory_root = dir.path().join("memory");
        let store = MemoryStore::new(&memory_root);
        let ctx = ctx_for(dir.path())
            .with_memory_store(Arc::new(store.clone()) as Arc<dyn Any + Send + Sync>);

        MemoryWriteTool
            .execute(
                json!({"scope": "project", "name": "prefs", "content": "first"}),
                &ctx,
            )
            .await
            .unwrap();

        let body = MemoryReadTool
            .execute(json!({"scope": "project", "name": "prefs"}), &ctx)
            .await
            .unwrap()
            .render_text();
        assert_eq!(body, "first");

        let path = memory_root.join("project").join("prefs.md");
        tokio::fs::write(&path, "external edit").await.unwrap();

        let err = MemoryWriteTool
            .execute(
                json!({"scope": "project", "name": "prefs", "content": "tool overwrite"}),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, ToolError::Execution(ref msg) if msg.contains("modified externally")),
            "expected drift error, got: {err:?}"
        );
        let still_external = tokio::fs::read_to_string(&path).await.unwrap();
        assert_eq!(still_external, "external edit");
    }

    #[derive(Default)]
    struct TestMemoryProvider {
        entries: Mutex<HashMap<(String, String), String>>,
        hooks: Mutex<Vec<MemoryWriteCtx>>,
    }

    #[async_trait]
    impl MemoryProvider for TestMemoryProvider {
        async fn index(&self, _request: MemoryIndexRequest) -> Result<String, MemoryProviderError> {
            let mut names: Vec<String> = self
                .entries
                .lock()
                .unwrap()
                .keys()
                .map(|(scope, name)| format!("{scope}/{name}"))
                .collect();
            names.sort();
            Ok(names.join("\n"))
        }

        async fn list(
            &self,
            request: MemoryListRequest,
        ) -> Result<Vec<String>, MemoryProviderError> {
            let mut names: Vec<String> = self
                .entries
                .lock()
                .unwrap()
                .keys()
                .filter(|(scope, _)| scope == &request.scope)
                .map(|(_, name)| name.clone())
                .collect();
            names.sort();
            Ok(names)
        }

        async fn write(
            &self,
            request: MemoryWriteRequest,
        ) -> Result<MemoryEntryData, MemoryProviderError> {
            self.entries.lock().unwrap().insert(
                (request.scope.clone(), request.name.clone()),
                request.content.clone(),
            );
            Ok(MemoryEntryData {
                scope: request.scope,
                name: request.name,
                content: request.content,
            })
        }

        async fn read(
            &self,
            request: MemoryReadRequest,
        ) -> Result<MemoryEntryData, MemoryProviderError> {
            let content = self
                .entries
                .lock()
                .unwrap()
                .get(&(request.scope.clone(), request.name.clone()))
                .cloned()
                .ok_or_else(|| MemoryProviderError::NotFound {
                    scope: request.scope.clone(),
                    name: request.name.clone(),
                })?;
            Ok(MemoryEntryData {
                scope: request.scope,
                name: request.name,
                content,
            })
        }

        async fn on_memory_write(&self, ctx: &MemoryWriteCtx) -> Result<(), MemoryProviderError> {
            self.hooks.lock().unwrap().push(ctx.clone());
            Ok(())
        }
    }

    #[tokio::test]
    async fn injected_provider_overrides_file_tree_memory_tools() {
        let dir = tempfile::tempdir().unwrap();
        let provider = Arc::new(TestMemoryProvider::default());
        let ctx = ctx_for(dir.path())
            .with_memory_provider(Arc::new(MemoryProviderSlot::new(
                provider.clone() as Arc<dyn MemoryProvider>
            )) as Arc<dyn Any + Send + Sync>);

        MemoryWriteTool
            .execute(
                json!({"scope": "user", "name": "prefs", "content": "provider memory"}),
                &ctx,
            )
            .await
            .unwrap();

        let body = MemoryReadTool
            .execute(json!({"scope": "user", "name": "prefs"}), &ctx)
            .await
            .unwrap()
            .render_text();
        assert_eq!(body, "provider memory");

        let listing = MemoryReadTool
            .execute(json!({"scope": "user"}), &ctx)
            .await
            .unwrap()
            .render_text();
        assert!(listing.contains("prefs"));

        let index = MemoryReadTool
            .execute(json!({}), &ctx)
            .await
            .unwrap()
            .render_text();
        assert!(index.contains("user/prefs"));
        assert!(!dir.path().join("memory/user/prefs.md").exists());

        let hooks = provider.hooks.lock().unwrap();
        assert_eq!(hooks.len(), 1);
        assert_eq!(hooks[0].tenant_id, ctx.tenant_id().clone());
        assert_eq!(hooks[0].project_id, ctx.project_id().clone());
        assert_eq!(hooks[0].action, MemoryWriteAction::Tool);
        assert_eq!(hooks[0].scope, "user");
        assert_eq!(hooks[0].name, "prefs");
    }

    #[tokio::test]
    async fn memory_write_with_approval_on_stages_pending_file() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_for(dir.path()).with_memory_write_approval(true);
        let out = MemoryWriteTool
            .execute(
                json!({"scope": "user", "name": "tone", "content": "user prefers terse"}),
                &ctx,
            )
            .await
            .unwrap()
            .render_text();
        assert!(out.contains("staged"), "got: {out}");
        // The actual entry was NOT written.
        let body = MemoryReadTool
            .execute(json!({"scope": "user", "name": "tone"}), &ctx)
            .await;
        assert!(body.is_err(), "memory entry should not exist yet");

        // The pending JSON should be on disk under
        // <workspace>/../memory/pending/.
        let pending_dir = dir.path().join("memory").join("pending");
        let entries: Vec<_> = std::fs::read_dir(&pending_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(entries.len(), 1, "expected one pending file");
        let body = std::fs::read_to_string(entries[0].path()).unwrap();
        assert!(body.contains("\"scope\": \"user\""));
        assert!(body.contains("\"name\": \"tone\""));
        assert!(body.contains("memory_write"));
    }

    #[tokio::test]
    async fn memory_write_with_approval_off_writes_directly() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_for(dir.path()); // approval defaults to false
        MemoryWriteTool
            .execute(
                json!({"scope": "user", "name": "tone", "content": "user prefers terse"}),
                &ctx,
            )
            .await
            .unwrap();
        // Entry landed.
        assert!(dir.path().join("memory/user/tone.md").exists());
        // No pending dir was created.
        assert!(!dir.path().join("memory/pending").exists());
    }

    #[tokio::test]
    async fn memory_write_approval_validates_scope_before_staging() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_for(dir.path()).with_memory_write_approval(true);
        let err = MemoryWriteTool
            .execute(
                json!({"scope": "bogus", "name": "x", "content": "irrelevant"}),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
        // Nothing should have been staged.
        assert!(!dir.path().join("memory/pending").exists());
    }

    #[tokio::test]
    async fn memory_write_approval_validates_name_before_staging() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_for(dir.path()).with_memory_write_approval(true);
        let err = MemoryWriteTool
            .execute(
                json!({"scope": "user", "name": "../escape", "content": "irrelevant"}),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));
        assert!(!dir.path().join("memory/pending").exists());
    }

    #[tokio::test]
    async fn memory_write_approval_rejects_custom_provider() {
        let provider = Arc::new(TestMemoryProvider::default());
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_for(dir.path())
            .with_memory_provider(
                Arc::new(MemoryProviderSlot::new(provider)) as Arc<dyn Any + Send + Sync>
            )
            .with_memory_write_approval(true);
        let err = MemoryWriteTool
            .execute(
                json!({"scope": "user", "name": "tone", "content": "user prefers terse"}),
                &ctx,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(err, ToolError::Execution(ref msg) if msg.contains("built-in file-tree")),
            "got: {err:?}"
        );
        assert!(!dir.path().join("memory/pending").exists());
    }
}
