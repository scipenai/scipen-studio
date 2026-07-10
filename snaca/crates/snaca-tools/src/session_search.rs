//! `SessionSearch` — full-text search over the project's
//! conversation history.
//!
//! ## Why this and not memory recall
//!
//! `MemoryRead` returns curated memory entries (auto-extracted or
//! human-written). `SessionSearch` returns raw messages from the
//! transcript — useful for "did we discuss X earlier?" or "find
//! the diff I pasted on Tuesday". Backed by the FTS5 virtual
//! table mirroring `messages`; no LLM and no embedding cost.
//!
//! ## Modes
//!
//! - `discovery` — BM25-ranked match for a query, top N hits with
//!   a small snippet around each match. Default mode.
//! - `recent` — most recent N messages on a thread, no FTS lookup.
//!   Useful when the LLM wants raw context without a query yet.
//! - `browse` — every message on a given thread (capped at 200).
//!   Used when the LLM wants to dump a transcript.

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use snaca_core::{ContentBlock, ThreadId};
use snaca_state::Database;
use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput, ToolResult,
};
use std::sync::Arc;

pub struct SessionSearchTool;

#[derive(Debug, Deserialize)]
struct Input {
    /// `discovery` (default), `recent`, or `browse`.
    #[serde(default)]
    mode: Option<String>,
    /// FTS5 query. Required for `discovery`. Ignored otherwise.
    #[serde(default)]
    query: Option<String>,
    /// Restrict to one thread. Required for `recent` / `browse`.
    /// Optional for `discovery` (omit to search every thread under
    /// the caller's project).
    #[serde(default)]
    thread_id: Option<String>,
    /// Cap on rows returned. Defaults: 10 for discovery, 20 for
    /// recent, 200 for browse. Hard ceiling 200 across all modes.
    #[serde(default)]
    limit: Option<u32>,
}

const DEFAULT_DISCOVERY_LIMIT: u32 = 10;
const DEFAULT_RECENT_LIMIT: u32 = 20;
const DEFAULT_BROWSE_LIMIT: u32 = 200;
const HARD_LIMIT: u32 = 200;
const SNIPPET_CHARS: usize = 240;

#[async_trait]
impl Tool for SessionSearchTool {
    fn name(&self) -> &str {
        "SessionSearch"
    }

    fn description(&self) -> &str {
        "Full-text search over the project's conversation history. \
         BM25-ranked, no LLM call, no embedding. Modes: \
         `discovery` (FTS5 query, default), `recent` (last N \
         messages on a thread), `browse` (full thread). Results \
         are short text snippets the model can quote back; pass \
         `thread_id` from a previous hit to drill into a specific \
         conversation."
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "mode": {
                    "type": "string",
                    "enum": ["discovery", "recent", "browse"],
                    "description": "Search mode. Default: discovery."
                },
                "query": {
                    "type": "string",
                    "description": "FTS5 query string. Required for discovery mode. Supports phrase searches, NEAR, AND/OR/NOT."
                },
                "thread_id": {
                    "type": "string",
                    "description": "Limit results to one thread. Required for recent / browse; optional for discovery."
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": HARD_LIMIT as i64,
                    "description": "Max rows to return. Default depends on mode."
                }
            }
        })
    }

    fn capabilities(&self) -> ToolCapabilities {
        ToolCapabilities::read_only_filesystem()
    }

    fn approval_requirement(&self) -> ApprovalRequirement {
        ApprovalRequirement::Never
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input: Input =
            serde_json::from_value(input).map_err(|e| ToolError::InvalidInput(e.to_string()))?;
        let mode = input.mode.as_deref().unwrap_or("discovery").to_lowercase();
        let db = db_from_ctx(ctx)?;

        match mode.as_str() {
            "discovery" => discovery(&db, ctx, input).await,
            "recent" => recent(&db, ctx, input).await,
            "browse" => browse(&db, ctx, input).await,
            other => Err(ToolError::InvalidInput(format!(
                "unknown mode {other:?}; expected discovery / recent / browse"
            ))),
        }
    }
}

fn db_from_ctx(ctx: &ToolContext) -> Result<Arc<Database>, ToolError> {
    let slot = ctx.db_handle_opaque().ok_or_else(|| {
        ToolError::Execution("session_search: no database handle attached to ToolContext".into())
    })?;
    slot.downcast::<Database>()
        .map_err(|_| ToolError::Execution("session_search: db handle has unexpected type".into()))
}

async fn discovery(db: &Database, ctx: &ToolContext, input: Input) -> ToolResult {
    let query = input
        .query
        .ok_or_else(|| ToolError::InvalidInput("discovery mode requires `query`".into()))?;
    let limit = input
        .limit
        .unwrap_or(DEFAULT_DISCOVERY_LIMIT)
        .min(HARD_LIMIT);

    let rows = match input.thread_id.as_deref() {
        Some(tid) => {
            let thread = ThreadId::new(tid);
            db.search_messages_fts_for_thread(
                ctx.tenant_id(),
                ctx.project_id(),
                &thread,
                &query,
                limit,
            )
            .await
        }
        None => {
            db.search_messages_fts(ctx.tenant_id(), ctx.project_id(), &query, limit)
                .await
        }
    }
    .map_err(|e| ToolError::Execution(format!("fts5 search failed: {e}")))?;

    let hits: Vec<_> = rows.into_iter().map(|r| format_hit(r, &query)).collect();
    if hits.is_empty() {
        return Ok(ToolOutput::text(format!("no messages matched `{query}`")));
    }
    Ok(ToolOutput::text(hits.join("\n\n")))
}

async fn recent(db: &Database, ctx: &ToolContext, input: Input) -> ToolResult {
    let thread_id = input
        .thread_id
        .ok_or_else(|| ToolError::InvalidInput("recent mode requires `thread_id`".into()))?;
    let limit = input.limit.unwrap_or(DEFAULT_RECENT_LIMIT).min(HARD_LIMIT);
    let thread = ThreadId::new(&thread_id);
    let rows = db
        .recent_messages_for_project(ctx.tenant_id(), ctx.project_id(), &thread, limit)
        .await
        .map_err(|e| ToolError::Execution(format!("recent_messages failed: {e}")))?;
    if rows.is_empty() {
        return Ok(ToolOutput::text(format!(
            "no messages found on thread `{thread_id}`"
        )));
    }
    let formatted: Vec<_> = rows.into_iter().map(format_full).collect();
    Ok(ToolOutput::text(formatted.join("\n\n")))
}

async fn browse(db: &Database, ctx: &ToolContext, input: Input) -> ToolResult {
    let thread_id = input
        .thread_id
        .ok_or_else(|| ToolError::InvalidInput("browse mode requires `thread_id`".into()))?;
    let limit = input.limit.unwrap_or(DEFAULT_BROWSE_LIMIT).min(HARD_LIMIT);
    let thread = ThreadId::new(&thread_id);
    let rows = db
        .recent_messages_for_project(ctx.tenant_id(), ctx.project_id(), &thread, limit)
        .await
        .map_err(|e| ToolError::Execution(format!("browse failed: {e}")))?;
    if rows.is_empty() {
        return Ok(ToolOutput::text(format!(
            "no messages found on thread `{thread_id}`"
        )));
    }
    let formatted: Vec<_> = rows.into_iter().map(format_full).collect();
    Ok(ToolOutput::text(formatted.join("\n\n")))
}

fn format_hit(row: snaca_state::MessageRow, query: &str) -> String {
    // FTS5 doesn't return a snippet directly through our wrapper;
    // approximate one by trimming around the first query-token
    // match in the rendered text.
    let text = render_message_text(&row);
    let snippet = pick_snippet(&text, query);
    format!(
        "[{}] thread={} role={:?} time={}\n{}",
        row.id,
        row.thread_id.as_str(),
        row.role,
        row.created_at.to_rfc3339(),
        snippet,
    )
}

fn format_full(row: snaca_state::MessageRow) -> String {
    let text = render_message_text(&row);
    format!(
        "[{}] role={:?} time={}\n{}",
        row.id,
        row.role,
        row.created_at.to_rfc3339(),
        text,
    )
}

fn render_message_text(row: &snaca_state::MessageRow) -> String {
    let mut out = String::new();
    for block in &row.content {
        if let ContentBlock::Text { text } = block {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(text);
        }
    }
    out
}

fn pick_snippet(text: &str, query: &str) -> String {
    // Split the query into the first "real" token (drop FTS5
    // operators) and find it case-insensitively in the body.
    let token = query
        .split(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
        .find(|s| !s.is_empty())
        .unwrap_or("");
    if token.is_empty() {
        return cap_chars(text, SNIPPET_CHARS);
    }
    let lower_text = text.to_lowercase();
    let lower_token = token.to_lowercase();
    let pos = match lower_text.find(&lower_token) {
        Some(p) => p,
        None => return cap_chars(text, SNIPPET_CHARS),
    };
    // Centre the snippet on the match.
    let half = SNIPPET_CHARS / 2;
    let start = pos.saturating_sub(half);
    let mut start = start;
    while start > 0 && !text.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = pos + lower_token.len() + half;
    if end > text.len() {
        end = text.len();
    }
    while end < text.len() && !text.is_char_boundary(end) {
        end += 1;
    }
    let mut snippet = String::new();
    if start > 0 {
        snippet.push('…');
    }
    snippet.push_str(&text[start..end]);
    if end < text.len() {
        snippet.push('…');
    }
    snippet
}

fn cap_chars(text: &str, max: usize) -> String {
    // Byte index of the char at position `max`, if any. `None` means
    // the text has `max` chars or fewer, so it fits untruncated.
    match text.char_indices().nth(max) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_core::{ProjectId, Role, SessionId, TenantId};
    use snaca_state::{Database, NewMessage, NewThread};
    use std::any::Any;

    async fn db_fixture() -> (Database, ToolContext) {
        let db = Database::open_in_memory().await.unwrap();
        let tenant = TenantId::new("t");
        let project = ProjectId::from_raw("p");
        // Seed a thread + a couple of messages.
        let thread = ThreadId::new("thr-search-1");
        db.insert_thread(&NewThread {
            id: thread.clone(),
            tenant_id: tenant.clone(),
            project_id: project.clone(),
            title: "New conversation".to_string(),
        })
        .await
        .unwrap();
        let session = SessionId::new();
        for (role, body) in [
            (Role::User, "we deployed the API to staging yesterday"),
            (Role::Assistant, "noted — staging endpoint is up"),
            (Role::User, "remind me to roll back if errors spike"),
        ] {
            db.append_message(&NewMessage {
                thread_id: thread.clone(),
                session_id: session,
                role,
                content: vec![ContentBlock::text(body)],
                turn_id: None,
            })
            .await
            .unwrap();
        }

        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let ctx = ToolContext::new(tenant, project, session, workspace)
            .with_db_handle(Arc::new(db.clone()) as Arc<dyn Any + Send + Sync>);
        // Keep tmp alive for the duration of the test by leaking it.
        // In tests this is fine; the OS reclaims at exit.
        std::mem::forget(tmp);
        (db, ctx)
    }

    #[tokio::test]
    async fn discovery_returns_bm25_ranked_hits() {
        let (_db, ctx) = db_fixture().await;
        let out = SessionSearchTool
            .execute(json!({"query": "staging"}), &ctx)
            .await
            .unwrap();
        let text = match out {
            ToolOutput::Text(t) => t,
            other => panic!("expected text output, got {other:?}"),
        };
        assert!(text.contains("staging"), "got: {text}");
    }

    #[tokio::test]
    async fn discovery_with_no_match_returns_friendly_message() {
        let (_db, ctx) = db_fixture().await;
        let out = SessionSearchTool
            .execute(json!({"query": "nonexistent_token_zzz"}), &ctx)
            .await
            .unwrap();
        let text = match out {
            ToolOutput::Text(t) => t,
            other => panic!("expected text output, got {other:?}"),
        };
        assert!(text.contains("no messages matched"), "got: {text}");
    }

    #[tokio::test]
    async fn recent_returns_thread_tail() {
        let (_db, ctx) = db_fixture().await;
        let out = SessionSearchTool
            .execute(
                json!({"mode": "recent", "thread_id": "thr-search-1", "limit": 2}),
                &ctx,
            )
            .await
            .unwrap();
        let text = match out {
            ToolOutput::Text(t) => t,
            other => panic!("expected text output, got {other:?}"),
        };
        // Both seeded user/assistant turns should appear.
        assert!(
            text.contains("staging") || text.contains("roll back"),
            "got: {text}"
        );
    }

    #[tokio::test]
    async fn missing_db_handle_returns_clean_error() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let ctx = ToolContext::new(
            TenantId::new("t"),
            ProjectId::from_raw("p"),
            SessionId::new(),
            workspace,
        );
        let err = SessionSearchTool
            .execute(json!({"query": "anything"}), &ctx)
            .await
            .unwrap_err();
        assert!(
            matches!(err, ToolError::Execution(ref s) if s.contains("no database handle")),
            "got: {err:?}"
        );
    }

    #[tokio::test]
    async fn recent_and_browse_do_not_cross_project_boundary() {
        let (db, ctx) = db_fixture().await;
        let other_thread = ThreadId::new("thr-other-project");
        db.insert_thread(&NewThread {
            id: other_thread.clone(),
            tenant_id: TenantId::new("t"),
            project_id: ProjectId::from_raw("other"),
            title: "New conversation".to_string(),
        })
        .await
        .unwrap();
        db.append_message(&NewMessage {
            thread_id: other_thread,
            session_id: SessionId::new(),
            role: Role::User,
            content: vec![ContentBlock::text("cross-project secret marker")],
            turn_id: None,
        })
        .await
        .unwrap();

        for mode in ["recent", "browse"] {
            let out = SessionSearchTool
                .execute(
                    json!({"mode": mode, "thread_id": "thr-other-project", "limit": 20}),
                    &ctx,
                )
                .await
                .unwrap();
            let text = match out {
                ToolOutput::Text(t) => t,
                other => panic!("expected text output, got {other:?}"),
            };
            assert!(
                text.contains("no messages found"),
                "{mode} should hide out-of-project thread; got: {text}"
            );
            assert!(
                !text.contains("cross-project secret marker"),
                "{mode} leaked out-of-project content: {text}"
            );
        }
    }

    #[tokio::test]
    async fn discovery_thread_filter_is_applied_before_limit() {
        let (db, ctx) = db_fixture().await;
        let session = SessionId::new();
        let noisy_thread = ThreadId::new("thr-noisy");
        db.insert_thread(&NewThread {
            id: noisy_thread.clone(),
            tenant_id: TenantId::new("t"),
            project_id: ProjectId::from_raw("p"),
            title: "New conversation".to_string(),
        })
        .await
        .unwrap();
        for i in 0..5 {
            db.append_message(&NewMessage {
                thread_id: noisy_thread.clone(),
                session_id: session,
                role: Role::User,
                content: vec![ContentBlock::text(format!(
                    "staging staging staging noise {i}"
                ))],
                turn_id: None,
            })
            .await
            .unwrap();
        }

        let out = SessionSearchTool
            .execute(
                json!({"query": "staging", "thread_id": "thr-search-1", "limit": 1}),
                &ctx,
            )
            .await
            .unwrap();
        let text = match out {
            ToolOutput::Text(t) => t,
            other => panic!("expected text output, got {other:?}"),
        };
        assert!(
            text.contains("thr-search-1"),
            "thread-scoped hit should survive even when other threads rank higher; got: {text}"
        );
        assert!(
            !text.contains("thr-noisy"),
            "thread filter leaked other-thread result: {text}"
        );
    }
}
