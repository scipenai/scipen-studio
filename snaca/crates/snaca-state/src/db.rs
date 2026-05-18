//! SQLite database wrapper + schema migration.

use crate::error::{StateError, StateResult};
use crate::models::{
    ChatBinding, MemoryVector, MessageRow, NewMessage, NewOutboxEntry, NewScheduledTask,
    NewThread, OutboxKind, OutboxRow, OutboxStatus, PersistedDecision, ScheduledTask,
    StoredApprovalDecision, ThreadCompaction, ThreadRow, ThreadSummaryRow, ToolCallRow,
};
use chrono::{DateTime, Utc};
use snaca_core::{
    ContentBlock, MessageId, ProjectId, Role, SessionId, TenantId, ThreadId, ToolUseId,
};
use sqlx::{
    sqlite::{SqliteConnectOptions, SqlitePoolOptions},
    Row, SqlitePool,
};
use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

const SCHEMA_SQL: &str = include_str!("schema.sql");

/// Owns a `SqlitePool` and exposes typed CRUD helpers. Cheap to clone.
#[derive(Clone)]
pub struct Database {
    pool: SqlitePool,
}

impl Database {
    /// Open (or create) a SQLite database at `path` and run migrations.
    pub async fn open(path: impl AsRef<Path>) -> StateResult<Self> {
        let path_str = path.as_ref().to_string_lossy().to_string();
        let opts = SqliteConnectOptions::from_str(&format!("sqlite://{path_str}"))?
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(8)
            .connect_with(opts)
            .await?;
        let db = Database { pool };
        db.run_migrations().await?;
        Ok(db)
    }

    /// In-memory database — useful for tests and CI.
    pub async fn open_in_memory() -> StateResult<Self> {
        let opts = SqliteConnectOptions::from_str("sqlite::memory:")?.foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1) // shared cache only works with single connection
            .connect_with(opts)
            .await?;
        let db = Database { pool };
        db.run_migrations().await?;
        Ok(db)
    }

    pub async fn run_migrations(&self) -> StateResult<()> {
        // SCHEMA_SQL is a single string with multiple statements separated by `;`.
        // sqlx::query can only run one statement at a time; iterate.
        for stmt in split_statements(SCHEMA_SQL) {
            sqlx::query(&stmt)
                .execute(&self.pool)
                .await
                .map_err(|e| StateError::Migration(format!("{stmt}: {e}")))?;
        }
        // Post-schema migrations: each step inspects the current shape
        // and upgrades in place when needed. Idempotent — running twice
        // is a no-op.
        self.migrate_approval_decisions_add_input_signature().await?;
        self.migrate_thread_compactions_add_summary_from().await?;
        self.migrate_threads_add_title().await?;
        Ok(())
    }

    /// Editor-mode migration: add `title` to `threads`. Fresh DBs get the
    /// column from `schema.sql`; legacy DBs (IM-mode pre-editor) backfill
    /// in place with the default string. SQLite's `ALTER TABLE ADD COLUMN`
    /// with `NOT NULL DEFAULT` is safe here — the default value populates
    /// existing rows atomically.
    async fn migrate_threads_add_title(&self) -> StateResult<()> {
        let rows = sqlx::query("PRAGMA table_info(threads)")
            .fetch_all(&self.pool)
            .await?;
        let has_col = rows.iter().any(|r| {
            r.try_get::<String, _>("name")
                .map(|n| n == "title")
                .unwrap_or(false)
        });
        if has_col {
            return Ok(());
        }
        sqlx::query(
            "ALTER TABLE threads \
             ADD COLUMN title TEXT NOT NULL DEFAULT 'New conversation'",
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// M6 migration: add `summary_from_message_id` to
    /// `thread_compactions`. Fresh DBs get the column via `schema.sql`;
    /// legacy DBs need an in-place `ALTER TABLE`. SQLite's `ALTER TABLE
    /// ADD COLUMN` is safe here because we use a non-NULL default of
    /// `''` (the legacy "compress from the beginning" sentinel), so
    /// existing rows backfill in a single statement.
    async fn migrate_thread_compactions_add_summary_from(&self) -> StateResult<()> {
        let rows = sqlx::query("PRAGMA table_info(thread_compactions)")
            .fetch_all(&self.pool)
            .await?;
        let has_col = rows.iter().any(|r| {
            r.try_get::<String, _>("name")
                .map(|n| n == "summary_from_message_id")
                .unwrap_or(false)
        });
        if has_col {
            return Ok(());
        }
        sqlx::query(
            "ALTER TABLE thread_compactions \
             ADD COLUMN summary_from_message_id TEXT NOT NULL DEFAULT ''",
        )
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// M5 migration: widen the `approval_decisions` PK to include
    /// `input_signature`. Fresh DBs already get the new shape via
    /// `schema.sql`; this only runs on legacy DBs created before the
    /// column existed. SQLite doesn't allow modifying a PK in place, so
    /// we rebuild the table in a transaction and backfill existing rows
    /// with `input_signature = ''` (the catch-all that preserves the
    /// pre-M5 "applies to any input" semantics).
    async fn migrate_approval_decisions_add_input_signature(&self) -> StateResult<()> {
        let rows = sqlx::query("PRAGMA table_info(approval_decisions)")
            .fetch_all(&self.pool)
            .await?;
        let has_sig = rows.iter().any(|r| {
            r.try_get::<String, _>("name")
                .map(|n| n == "input_signature")
                .unwrap_or(false)
        });
        if has_sig {
            return Ok(());
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query(
            "CREATE TABLE approval_decisions_new (\
                tenant_id        TEXT NOT NULL,\
                project_id       TEXT NOT NULL,\
                tool_name        TEXT NOT NULL,\
                input_signature  TEXT NOT NULL DEFAULT '',\
                decision         TEXT NOT NULL,\
                decided_at       TEXT NOT NULL,\
                PRIMARY KEY (tenant_id, project_id, tool_name, input_signature)\
            )",
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO approval_decisions_new \
                 (tenant_id, project_id, tool_name, input_signature, decision, decided_at) \
             SELECT tenant_id, project_id, tool_name, '', decision, decided_at \
             FROM approval_decisions",
        )
        .execute(&mut *tx)
        .await?;
        sqlx::query("DROP TABLE approval_decisions")
            .execute(&mut *tx)
            .await?;
        sqlx::query("ALTER TABLE approval_decisions_new RENAME TO approval_decisions")
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        // No tracing dep in `snaca-state`; the caller of `run_migrations`
        // already logs success on the wider migration.
        Ok(())
    }

    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    // -------- threads --------

    pub async fn insert_thread(&self, t: &NewThread) -> StateResult<ThreadRow> {
        let now = Utc::now();
        sqlx::query(
            "INSERT INTO threads (id, tenant_id, project_id, title, created_at) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(t.id.as_str())
        .bind(t.tenant_id.as_str())
        .bind(t.project_id.as_str())
        .bind(&t.title)
        .bind(now.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(ThreadRow {
            id: t.id.clone(),
            tenant_id: t.tenant_id.clone(),
            project_id: t.project_id.clone(),
            title: t.title.clone(),
            created_at: now,
        })
    }

    pub async fn find_thread(&self, id: &ThreadId) -> StateResult<Option<ThreadRow>> {
        let row = sqlx::query(
            "SELECT id, tenant_id, project_id, title, created_at FROM threads WHERE id = ?",
        )
        .bind(id.as_str())
        .fetch_optional(&self.pool)
        .await?;
        row.map(thread_from_row).transpose()
    }

    /// Update only the `title` column. Returns `true` when a row was
    /// affected; callers can treat `false` as "thread vanished".
    pub async fn update_thread_title(&self, id: &ThreadId, title: &str) -> StateResult<bool> {
        let affected = sqlx::query("UPDATE threads SET title = ? WHERE id = ?")
            .bind(title)
            .bind(id.as_str())
            .execute(&self.pool)
            .await?
            .rows_affected();
        Ok(affected > 0)
    }

    /// Delete a thread. Messages (and their tool_calls / compactions)
    /// cascade via FK. Returns `true` when a row was removed.
    pub async fn delete_thread(&self, id: &ThreadId) -> StateResult<bool> {
        let affected = sqlx::query("DELETE FROM threads WHERE id = ?")
            .bind(id.as_str())
            .execute(&self.pool)
            .await?
            .rows_affected();
        Ok(affected > 0)
    }

    /// Distinct tenant ids that have at least one thread on file. Used
    /// by the admin CLI's `tenant list` command.
    pub async fn list_tenants(&self) -> StateResult<Vec<TenantId>> {
        let rows = sqlx::query(
            "SELECT tenant_id, MAX(created_at) AS last_seen FROM threads \
             GROUP BY tenant_id ORDER BY last_seen DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| TenantId::new(r.get::<String, _>("tenant_id")))
            .collect())
    }

    /// Every chat binding on file. Cheap query — only used by admin CLI.
    pub async fn list_bindings(&self) -> StateResult<Vec<ChatBinding>> {
        let rows = sqlx::query(
            "SELECT chat_id, user_id, project_id, bound_at FROM chat_session_binding \
             ORDER BY bound_at DESC",
        )
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(binding_from_row).collect()
    }

    /// Distinct project ids that have at least one thread under `tenant`.
    /// Used by `/snaca list` and admin tooling. Ordered by most-recent
    /// thread within each project.
    pub async fn list_projects_for_tenant(
        &self,
        tenant: &TenantId,
    ) -> StateResult<Vec<ProjectId>> {
        let rows = sqlx::query(
            "SELECT project_id, MAX(created_at) AS last_seen FROM threads \
             WHERE tenant_id = ? GROUP BY project_id ORDER BY last_seen DESC",
        )
        .bind(tenant.as_str())
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|r| ProjectId::from_raw(r.get::<String, _>("project_id")))
            .collect())
    }

    pub async fn list_threads_for_project(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
    ) -> StateResult<Vec<ThreadRow>> {
        let rows = sqlx::query(
            "SELECT id, tenant_id, project_id, title, created_at FROM threads \
             WHERE tenant_id = ? AND project_id = ? ORDER BY created_at DESC",
        )
        .bind(tenant.as_str())
        .bind(project.as_str())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(thread_from_row).collect()
    }

    /// List threads under `(tenant, project)` with derived stats:
    ///   * `last_active_at` = MAX(messages.created_at), falling back to
    ///     `threads.created_at` when the thread has no messages yet.
    ///   * `turn_count` = number of user-role messages.
    ///
    /// Ordered most-recently-active first so the editor protocol's
    /// `list_thread_summaries` contract holds without a second sort.
    pub async fn list_threads_with_stats(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
    ) -> StateResult<Vec<ThreadSummaryRow>> {
        let rows = sqlx::query(
            "SELECT t.id, t.tenant_id, t.project_id, t.title, t.created_at, \
                    COALESCE( \
                        (SELECT MAX(m.created_at) FROM messages m WHERE m.thread_id = t.id), \
                        t.created_at \
                    ) AS last_active_at, \
                    (SELECT COUNT(*) FROM messages m \
                       WHERE m.thread_id = t.id AND m.role = 'user') AS turn_count \
             FROM threads t \
             WHERE t.tenant_id = ? AND t.project_id = ? \
             ORDER BY last_active_at DESC",
        )
        .bind(tenant.as_str())
        .bind(project.as_str())
        .fetch_all(&self.pool)
        .await?;
        // SqliteRow isn't Clone, so we extract the derived columns first,
        // then hand the row to thread_from_row.
        rows.into_iter()
            .map(|row| {
                let last_active_at = parse_dt(&row.try_get::<String, _>("last_active_at")?)?;
                let turn_count: i64 = row.try_get("turn_count")?;
                let thread = thread_from_row(row)?;
                Ok(ThreadSummaryRow {
                    thread,
                    last_active_at,
                    turn_count: turn_count.max(0) as u32,
                })
            })
            .collect()
    }

    // -------- messages --------

    pub async fn append_message(&self, msg: &NewMessage) -> StateResult<MessageRow> {
        let id = MessageId::new();
        let now = Utc::now();
        let content_json = serde_json::to_string(&msg.content)?;
        let role_str = role_to_str(msg.role);
        sqlx::query(
            "INSERT INTO messages (id, thread_id, session_id, role, content, created_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id.to_string())
        .bind(msg.thread_id.as_str())
        .bind(msg.session_id.to_string())
        .bind(role_str)
        .bind(&content_json)
        .bind(now.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(MessageRow {
            id,
            thread_id: msg.thread_id.clone(),
            session_id: msg.session_id,
            role: msg.role,
            content: msg.content.clone(),
            created_at: now,
        })
    }

    pub async fn recent_messages(
        &self,
        thread: &ThreadId,
        limit: u32,
    ) -> StateResult<Vec<MessageRow>> {
        let rows = sqlx::query(
            "SELECT id, thread_id, session_id, role, content, created_at FROM messages \
             WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?",
        )
        .bind(thread.as_str())
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await?;
        let mut msgs: Vec<MessageRow> = rows.into_iter().map(message_from_row).collect::<StateResult<_>>()?;
        msgs.reverse();
        Ok(msgs)
    }

    /// Symmetric counterpart to `messages_after`: return the messages
    /// of `thread` whose `created_at` is strictly *less than* the
    /// cutoff message's, ordered oldest first. Used by `load_history`
    /// to splice the verbatim head messages (the first N protected by
    /// `protect_first_n`) back in front of the synthetic preamble
    /// without re-loading the entire thread.
    ///
    /// If the cutoff row has been deleted, falls back to "all
    /// messages" rather than silently returning empty — same defensive
    /// pattern as `messages_after`.
    pub async fn messages_before(
        &self,
        thread: &ThreadId,
        cutoff_message_id: &MessageId,
        limit: u32,
    ) -> StateResult<Vec<MessageRow>> {
        let rows = sqlx::query(
            "SELECT id, thread_id, session_id, role, content, created_at FROM messages \
             WHERE thread_id = ? \
               AND created_at < COALESCE( \
                     (SELECT created_at FROM messages WHERE id = ?), \
                     '9999-12-31T23:59:59+00:00' \
                   ) \
             ORDER BY created_at ASC LIMIT ?",
        )
        .bind(thread.as_str())
        .bind(cutoff_message_id.to_string())
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(message_from_row).collect()
    }

    /// Return the messages of `thread` whose `created_at` is strictly
    /// greater than the cutoff message's. Used by the engine after a
    /// compaction lands: the summary covers everything up to and
    /// including the cutoff, and `messages_after` is the still-live tail.
    pub async fn messages_after(
        &self,
        thread: &ThreadId,
        cutoff_message_id: &MessageId,
        limit: u32,
    ) -> StateResult<Vec<MessageRow>> {
        // Subquery: look up the cutoff's `created_at`. If the cutoff row
        // has been deleted (foreign-key cascade etc.), fall back to the
        // earliest possible time so the query degrades to "all messages"
        // instead of returning empty silently.
        let rows = sqlx::query(
            "SELECT id, thread_id, session_id, role, content, created_at FROM messages \
             WHERE thread_id = ? \
               AND created_at > COALESCE( \
                     (SELECT created_at FROM messages WHERE id = ?), \
                     '0000-01-01T00:00:00+00:00' \
                   ) \
             ORDER BY created_at ASC LIMIT ?",
        )
        .bind(thread.as_str())
        .bind(cutoff_message_id.to_string())
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(message_from_row).collect()
    }

    // -------- thread compactions --------

    /// Upsert the compaction summary for `thread`. The latest call wins —
    /// callers that want to detect concurrent compactions should compare
    /// `compacted_at` before and after.
    pub async fn set_thread_summary(
        &self,
        thread: &ThreadId,
        summary: &str,
        summary_until_message_id: &MessageId,
        summary_from_message_id: Option<&MessageId>,
        msg_count_before: u32,
        input_tokens_before: u32,
    ) -> StateResult<ThreadCompaction> {
        let now = Utc::now();
        // Empty string is the legacy "compress from the beginning"
        // sentinel; the migration backfills older rows the same way.
        let from_str = summary_from_message_id
            .map(|m| m.to_string())
            .unwrap_or_default();
        sqlx::query(
            "INSERT INTO thread_compactions \
                 (thread_id, summary, summary_until_message_id, \
                  summary_from_message_id, msg_count_before, \
                  input_tokens_before, compacted_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(thread_id) DO UPDATE SET \
                 summary = excluded.summary, \
                 summary_until_message_id = excluded.summary_until_message_id, \
                 summary_from_message_id = excluded.summary_from_message_id, \
                 msg_count_before = excluded.msg_count_before, \
                 input_tokens_before = excluded.input_tokens_before, \
                 compacted_at = excluded.compacted_at",
        )
        .bind(thread.as_str())
        .bind(summary)
        .bind(summary_until_message_id.to_string())
        .bind(from_str)
        .bind(msg_count_before as i64)
        .bind(input_tokens_before as i64)
        .bind(now.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(ThreadCompaction {
            thread_id: thread.clone(),
            summary: summary.to_string(),
            summary_until_message_id: *summary_until_message_id,
            summary_from_message_id: summary_from_message_id.copied(),
            msg_count_before,
            input_tokens_before,
            compacted_at: now,
        })
    }

    pub async fn get_thread_summary(
        &self,
        thread: &ThreadId,
    ) -> StateResult<Option<ThreadCompaction>> {
        let row = sqlx::query(
            "SELECT thread_id, summary, summary_until_message_id, \
                    summary_from_message_id, msg_count_before, \
                    input_tokens_before, compacted_at \
             FROM thread_compactions WHERE thread_id = ?",
        )
        .bind(thread.as_str())
        .fetch_optional(&self.pool)
        .await?;
        row.map(compaction_from_row).transpose()
    }

    // -------- tool_calls --------

    pub async fn record_tool_start(
        &self,
        id: &ToolUseId,
        message_id: &MessageId,
        tool_name: &str,
        input: &serde_json::Value,
    ) -> StateResult<()> {
        let now = Utc::now();
        sqlx::query(
            "INSERT INTO tool_calls (id, message_id, tool_name, input, output, is_error, started_at, completed_at) \
             VALUES (?, ?, ?, ?, NULL, 0, ?, NULL)",
        )
        .bind(id.as_str())
        .bind(message_id.to_string())
        .bind(tool_name)
        .bind(serde_json::to_string(input)?)
        .bind(now.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn record_tool_completion(
        &self,
        id: &ToolUseId,
        output: &serde_json::Value,
        is_error: bool,
    ) -> StateResult<()> {
        let now = Utc::now();
        sqlx::query(
            "UPDATE tool_calls SET output = ?, is_error = ?, completed_at = ? WHERE id = ?",
        )
        .bind(serde_json::to_string(output)?)
        .bind(if is_error { 1 } else { 0 })
        .bind(now.to_rfc3339())
        .bind(id.as_str())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn find_tool_call(&self, id: &ToolUseId) -> StateResult<Option<ToolCallRow>> {
        let row = sqlx::query(
            "SELECT id, message_id, tool_name, input, output, is_error, started_at, completed_at \
             FROM tool_calls WHERE id = ?",
        )
        .bind(id.as_str())
        .fetch_optional(&self.pool)
        .await?;
        row.map(tool_call_from_row).transpose()
    }

    // -------- chat_session_binding --------

    pub async fn upsert_binding(
        &self,
        chat_id: &str,
        user_id: &str,
        project: &ProjectId,
    ) -> StateResult<ChatBinding> {
        let now = Utc::now();
        sqlx::query(
            "INSERT INTO chat_session_binding (chat_id, user_id, project_id, bound_at) \
             VALUES (?, ?, ?, ?) \
             ON CONFLICT(chat_id, user_id) DO UPDATE SET project_id = excluded.project_id, bound_at = excluded.bound_at",
        )
        .bind(chat_id)
        .bind(user_id)
        .bind(project.as_str())
        .bind(now.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(ChatBinding {
            chat_id: chat_id.to_string(),
            user_id: user_id.to_string(),
            project_id: project.clone(),
            bound_at: now,
        })
    }

    pub async fn find_binding(
        &self,
        chat_id: &str,
        user_id: &str,
    ) -> StateResult<Option<ChatBinding>> {
        let row = sqlx::query(
            "SELECT chat_id, user_id, project_id, bound_at FROM chat_session_binding \
             WHERE chat_id = ? AND user_id = ?",
        )
        .bind(chat_id)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(binding_from_row).transpose()
    }

    // -------- approval_decisions --------

    /// Persist a remembered approval decision for
    /// `(tenant, project, tool_name, input_signature)`. Upserts on the
    /// full key — passing the same signature twice replaces the row.
    ///
    /// `input_signature = ""` is the catch-all that legacy rows used
    /// and that `find_decision` falls back to when no per-input row
    /// matches. The engine never writes the catch-all from the gate
    /// path — it's reserved for explicit operator-installed rules.
    pub async fn remember_decision(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
        tool_name: &str,
        input_signature: &str,
        decision: PersistedDecision,
    ) -> StateResult<StoredApprovalDecision> {
        let now = Utc::now();
        sqlx::query(
            "INSERT INTO approval_decisions \
                 (tenant_id, project_id, tool_name, input_signature, decision, decided_at) \
             VALUES (?, ?, ?, ?, ?, ?) \
             ON CONFLICT(tenant_id, project_id, tool_name, input_signature) DO UPDATE SET \
                 decision = excluded.decision, decided_at = excluded.decided_at",
        )
        .bind(tenant.as_str())
        .bind(project.as_str())
        .bind(tool_name)
        .bind(input_signature)
        .bind(decision.as_str())
        .bind(now.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(StoredApprovalDecision {
            tenant_id: tenant.clone(),
            project_id: project.clone(),
            tool_name: tool_name.to_string(),
            input_signature: input_signature.to_string(),
            decision,
            decided_at: now,
        })
    }

    /// Look up a remembered decision for `(tenant, project, tool,
    /// input_signature)`. Tries the exact signature first, then falls
    /// back to the catch-all (`input_signature = ''`) so legacy rows
    /// and operator-installed "always allow this tool" rules still
    /// match. Pass `""` for `input_signature` to force the catch-all
    /// lookup only (e.g. when the input isn't known yet).
    pub async fn find_decision(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
        tool_name: &str,
        input_signature: &str,
    ) -> StateResult<Option<StoredApprovalDecision>> {
        if !input_signature.is_empty() {
            let exact = sqlx::query(
                "SELECT tenant_id, project_id, tool_name, input_signature, decision, decided_at \
                 FROM approval_decisions \
                 WHERE tenant_id = ? AND project_id = ? AND tool_name = ? \
                       AND input_signature = ?",
            )
            .bind(tenant.as_str())
            .bind(project.as_str())
            .bind(tool_name)
            .bind(input_signature)
            .fetch_optional(&self.pool)
            .await?;
            if let Some(r) = exact {
                return decision_from_row(r).map(Some);
            }
        }
        let row = sqlx::query(
            "SELECT tenant_id, project_id, tool_name, input_signature, decision, decided_at \
             FROM approval_decisions \
             WHERE tenant_id = ? AND project_id = ? AND tool_name = ? \
                   AND input_signature = ''",
        )
        .bind(tenant.as_str())
        .bind(project.as_str())
        .bind(tool_name)
        .fetch_optional(&self.pool)
        .await?;
        row.map(decision_from_row).transpose()
    }

    /// Delete a remembered decision for a specific `(tool, input_signature)`
    /// pair. Pass `""` to drop the catch-all only — see
    /// [`Database::forget_decisions_for_tool`] to wipe every rule for a tool.
    pub async fn forget_decision(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
        tool_name: &str,
        input_signature: &str,
    ) -> StateResult<()> {
        sqlx::query(
            "DELETE FROM approval_decisions \
             WHERE tenant_id = ? AND project_id = ? AND tool_name = ? \
                   AND input_signature = ?",
        )
        .bind(tenant.as_str())
        .bind(project.as_str())
        .bind(tool_name)
        .bind(input_signature)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Drop every remembered decision (per-input and catch-all) for
    /// `(tenant, project, tool_name)`. Used by the admin path that
    /// re-prompts the user for a tool wholesale.
    pub async fn forget_decisions_for_tool(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
        tool_name: &str,
    ) -> StateResult<()> {
        sqlx::query(
            "DELETE FROM approval_decisions \
             WHERE tenant_id = ? AND project_id = ? AND tool_name = ?",
        )
        .bind(tenant.as_str())
        .bind(project.as_str())
        .bind(tool_name)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    // -------- memory_vectors --------

    /// Upsert an embedding for one memory entry. Replaces any existing
    /// row with the same `(tenant, project, scope, name)`. The embedding
    /// is serialised as little-endian f32 bytes for compact storage and
    /// portable reads from any platform we run on.
    pub async fn upsert_memory_vector(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
        scope: &str,
        name: &str,
        model_id: &str,
        embedding: &[f32],
    ) -> StateResult<MemoryVector> {
        let now = Utc::now();
        let bytes = embedding_to_bytes(embedding);
        sqlx::query(
            "INSERT INTO memory_vectors \
                 (tenant_id, project_id, scope, name, model_id, dim, embedding, updated_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(tenant_id, project_id, scope, name) DO UPDATE SET \
                 model_id = excluded.model_id, \
                 dim = excluded.dim, \
                 embedding = excluded.embedding, \
                 updated_at = excluded.updated_at",
        )
        .bind(tenant.as_str())
        .bind(project.as_str())
        .bind(scope)
        .bind(name)
        .bind(model_id)
        .bind(embedding.len() as i64)
        .bind(&bytes)
        .bind(now.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(MemoryVector {
            tenant_id: tenant.clone(),
            project_id: project.clone(),
            scope: scope.to_string(),
            name: name.to_string(),
            model_id: model_id.to_string(),
            embedding: embedding.to_vec(),
            updated_at: now,
        })
    }

    /// Drop the embedding for a single entry. No-op when absent so
    /// callers can call this from a delete path without first checking.
    pub async fn delete_memory_vector(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
        scope: &str,
        name: &str,
    ) -> StateResult<()> {
        sqlx::query(
            "DELETE FROM memory_vectors \
             WHERE tenant_id = ? AND project_id = ? AND scope = ? AND name = ?",
        )
        .bind(tenant.as_str())
        .bind(project.as_str())
        .bind(scope)
        .bind(name)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Every embedding under one project. Brute-force search lives on
    /// top of this — load → cosine → sort → top-k. Fine for the
    /// hundred-or-so entries a typical project ever holds; swap to
    /// sqlite-vec when somebody actually exercises that scale.
    pub async fn list_memory_vectors(
        &self,
        tenant: &TenantId,
        project: &ProjectId,
    ) -> StateResult<Vec<MemoryVector>> {
        let rows = sqlx::query(
            "SELECT tenant_id, project_id, scope, name, model_id, dim, embedding, updated_at \
             FROM memory_vectors WHERE tenant_id = ? AND project_id = ?",
        )
        .bind(tenant.as_str())
        .bind(project.as_str())
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(memory_vector_from_row).collect()
    }

    // -------- scheduled_tasks --------

    /// Persist a new scheduled task. The caller assigns
    /// `next_fire_at` — usually `now()` for immediate fire or a
    /// future timestamp. `interval_secs = None` makes the task
    /// one-shot; the scheduler disables it after the first fire.
    pub async fn schedule_task(&self, t: &NewScheduledTask) -> StateResult<ScheduledTask> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now();
        sqlx::query(
            "INSERT INTO scheduled_tasks \
                 (id, tenant_id, project_id, chat_id, plugin, prompt, \
                  interval_secs, next_fire_at, last_fired_at, enabled, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)",
        )
        .bind(&id)
        .bind(t.tenant_id.as_str())
        .bind(t.project_id.as_str())
        .bind(&t.chat_id)
        .bind(&t.plugin)
        .bind(&t.prompt)
        .bind(t.interval_secs)
        .bind(t.next_fire_at.to_rfc3339())
        .bind(now.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(ScheduledTask {
            id,
            tenant_id: t.tenant_id.clone(),
            project_id: t.project_id.clone(),
            chat_id: t.chat_id.clone(),
            plugin: t.plugin.clone(),
            prompt: t.prompt.clone(),
            interval_secs: t.interval_secs,
            next_fire_at: t.next_fire_at,
            last_fired_at: None,
            enabled: true,
            created_at: now,
        })
    }

    /// Return up to `limit` enabled tasks whose `next_fire_at <= now`.
    /// Caller is the scheduler's poll loop — it fires each task,
    /// then calls [`Database::reschedule_task`] to either bump the
    /// next-fire forward (recurring) or disable the row (one-shot).
    pub async fn list_due_scheduled_tasks(
        &self,
        now: DateTime<Utc>,
        limit: u32,
    ) -> StateResult<Vec<ScheduledTask>> {
        let rows = sqlx::query(
            "SELECT id, tenant_id, project_id, chat_id, plugin, prompt, \
                    interval_secs, next_fire_at, last_fired_at, enabled, created_at \
             FROM scheduled_tasks \
             WHERE enabled = 1 AND next_fire_at <= ? \
             ORDER BY next_fire_at ASC \
             LIMIT ?",
        )
        .bind(now.to_rfc3339())
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(scheduled_task_from_row).collect()
    }

    /// List every scheduled task for a chat. Admin / `/snaca schedule
    /// list` path uses this to surface what's queued up.
    pub async fn list_scheduled_tasks_for_chat(
        &self,
        tenant: &TenantId,
        chat_id: &str,
    ) -> StateResult<Vec<ScheduledTask>> {
        let rows = sqlx::query(
            "SELECT id, tenant_id, project_id, chat_id, plugin, prompt, \
                    interval_secs, next_fire_at, last_fired_at, enabled, created_at \
             FROM scheduled_tasks \
             WHERE tenant_id = ? AND chat_id = ? \
             ORDER BY next_fire_at ASC",
        )
        .bind(tenant.as_str())
        .bind(chat_id)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(scheduled_task_from_row).collect()
    }

    /// After a fire: bump `last_fired_at` to `fired_at`, and either
    /// schedule the next fire (recurring) or disable the row
    /// (one-shot). `next_fire_at = fired_at + interval` for recurring;
    /// the scheduler may also pass `Some(explicit_next)` to override.
    pub async fn reschedule_task(
        &self,
        id: &str,
        fired_at: DateTime<Utc>,
        next_fire_at: Option<DateTime<Utc>>,
    ) -> StateResult<()> {
        match next_fire_at {
            Some(next) => {
                sqlx::query(
                    "UPDATE scheduled_tasks SET last_fired_at = ?, next_fire_at = ? \
                     WHERE id = ?",
                )
                .bind(fired_at.to_rfc3339())
                .bind(next.to_rfc3339())
                .bind(id)
                .execute(&self.pool)
                .await?;
            }
            None => {
                sqlx::query(
                    "UPDATE scheduled_tasks SET last_fired_at = ?, enabled = 0 \
                     WHERE id = ?",
                )
                .bind(fired_at.to_rfc3339())
                .bind(id)
                .execute(&self.pool)
                .await?;
            }
        }
        Ok(())
    }

    pub async fn set_scheduled_task_enabled(
        &self,
        id: &str,
        enabled: bool,
    ) -> StateResult<()> {
        sqlx::query("UPDATE scheduled_tasks SET enabled = ? WHERE id = ?")
            .bind(if enabled { 1i64 } else { 0i64 })
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn delete_scheduled_task(&self, id: &str) -> StateResult<()> {
        sqlx::query("DELETE FROM scheduled_tasks WHERE id = ?")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // -------- outbox --------

    /// Persist a pending outbound delivery. The caller controls
    /// `next_attempt_at`: pass `now()` to make the row immediately
    /// claimable by the worker, or `now() + cushion` to reserve a window
    /// for an inline first-try (avoids worker-vs-inline races). If the
    /// inline try fails, [`outbox_reschedule`] overrides this with the
    /// retry backoff.
    pub async fn outbox_enqueue(&self, entry: &NewOutboxEntry) -> StateResult<()> {
        let now = Utc::now();
        sqlx::query(
            "INSERT INTO outbox \
                (id, plugin, tenant_id, chat_id, kind, payload, attempts, next_attempt_at, \
                 status, last_error, platform_message_id, created_at, delivered_at) \
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'pending', NULL, NULL, ?, NULL)",
        )
        .bind(&entry.id)
        .bind(&entry.plugin)
        .bind(&entry.tenant_id)
        .bind(&entry.chat_id)
        .bind(entry.kind.as_str())
        .bind(serde_json::to_string(&entry.payload)?)
        .bind(entry.next_attempt_at.to_rfc3339())
        .bind(now.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Mark an outbox row delivered. `platform_message_id` is the IM
    /// platform's own message id, returned for traceability — we don't
    /// route on it today.
    pub async fn outbox_mark_delivered(
        &self,
        id: &str,
        platform_message_id: Option<&str>,
    ) -> StateResult<()> {
        let now = Utc::now();
        sqlx::query(
            "UPDATE outbox SET status = 'delivered', platform_message_id = ?, \
                 delivered_at = ?, last_error = NULL WHERE id = ?",
        )
        .bind(platform_message_id)
        .bind(now.to_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Terminal failure — row will not be retried. Set when the error is
    /// classified non-retryable or attempts have exceeded MAX_ATTEMPTS.
    pub async fn outbox_mark_failed(&self, id: &str, last_error: &str) -> StateResult<()> {
        sqlx::query("UPDATE outbox SET status = 'failed', last_error = ? WHERE id = ?")
            .bind(last_error)
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    /// Bump attempts, record the error, push `next_attempt_at` out. Row
    /// stays `pending` so the worker keeps re-claiming it on its tick.
    pub async fn outbox_reschedule(
        &self,
        id: &str,
        last_error: &str,
        next_attempt_at: DateTime<Utc>,
    ) -> StateResult<()> {
        sqlx::query(
            "UPDATE outbox SET attempts = attempts + 1, last_error = ?, \
                 next_attempt_at = ? WHERE id = ?",
        )
        .bind(last_error)
        .bind(next_attempt_at.to_rfc3339())
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Claim up to `limit` pending rows whose `next_attempt_at <= now()`,
    /// in FIFO order so the user sees replies in send order.
    ///
    /// "Claim" is a misnomer at SQLite scale — we don't lock or mark them
    /// in-flight; per-plugin workers are single-threaded, so concurrent
    /// claim is impossible.
    pub async fn outbox_claim_pending(
        &self,
        plugin: &str,
        limit: u32,
    ) -> StateResult<Vec<OutboxRow>> {
        let now = Utc::now();
        let rows = sqlx::query(
            "SELECT id, plugin, tenant_id, chat_id, kind, payload, attempts, next_attempt_at, \
                    status, last_error, platform_message_id, created_at, delivered_at \
             FROM outbox \
             WHERE plugin = ? AND status = 'pending' AND next_attempt_at <= ? \
             ORDER BY created_at ASC \
             LIMIT ?",
        )
        .bind(plugin)
        .bind(now.to_rfc3339())
        .bind(limit as i64)
        .fetch_all(&self.pool)
        .await?;
        rows.into_iter().map(outbox_from_row).collect()
    }

    pub async fn outbox_find(&self, id: &str) -> StateResult<Option<OutboxRow>> {
        let row = sqlx::query(
            "SELECT id, plugin, tenant_id, chat_id, kind, payload, attempts, next_attempt_at, \
                    status, last_error, platform_message_id, created_at, delivered_at \
             FROM outbox WHERE id = ?",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;
        row.map(outbox_from_row).transpose()
    }

    /// Drop delivered rows older than `cutoff`. Housekeeping to keep the
    /// table bounded; called periodically by the worker.
    pub async fn outbox_purge_delivered_older_than(
        &self,
        cutoff: DateTime<Utc>,
    ) -> StateResult<u64> {
        let res = sqlx::query(
            "DELETE FROM outbox WHERE status = 'delivered' AND delivered_at IS NOT NULL \
                 AND delivered_at < ?",
        )
        .bind(cutoff.to_rfc3339())
        .execute(&self.pool)
        .await?;
        Ok(res.rows_affected())
    }

    // -------- inbound_dedup --------

    /// Atomically check whether we've seen `(plugin, message_id)` before
    /// and, if not, record it. Returns `true` if this was a duplicate
    /// (caller should drop the message), `false` if it's the first time
    /// (caller should proceed).
    ///
    /// Implemented as `INSERT OR IGNORE` so the check and record happen
    /// in a single SQL statement — no separate `SELECT then INSERT` race
    /// window where two callers could each see "absent" and both proceed.
    pub async fn inbound_dedup_check_and_record(
        &self,
        plugin: &str,
        message_id: &str,
    ) -> StateResult<bool> {
        let now = Utc::now();
        let res = sqlx::query(
            "INSERT OR IGNORE INTO inbound_dedup (plugin, message_id, seen_at) VALUES (?, ?, ?)",
        )
        .bind(plugin)
        .bind(message_id)
        .bind(now.to_rfc3339())
        .execute(&self.pool)
        .await?;
        // `rows_affected == 0` ⇔ the row already existed (PK conflict).
        Ok(res.rows_affected() == 0)
    }

    /// Drop rows older than `cutoff`. Lark webhook redelivery only
    /// targets a small recent window, so we don't need to keep dedup
    /// records for long.
    pub async fn inbound_dedup_purge_older_than(
        &self,
        cutoff: DateTime<Utc>,
    ) -> StateResult<u64> {
        let res = sqlx::query("DELETE FROM inbound_dedup WHERE seen_at < ?")
            .bind(cutoff.to_rfc3339())
            .execute(&self.pool)
            .await?;
        Ok(res.rows_affected())
    }
}

/// Strip line comments (`-- ...`) before splitting on `;`. SQLite's parser
/// understands inline comments but our manual splitter does not — without
/// this, semicolons in comments would chop statements in half.
fn split_statements(sql: &str) -> impl Iterator<Item = String> {
    let cleaned: String = sql
        .lines()
        .map(|l| {
            if l.trim_start().starts_with("--") {
                ""
            } else {
                l
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    cleaned
        .split(';')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .into_iter()
}

fn role_to_str(role: Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}

fn role_from_str(s: &str) -> StateResult<Role> {
    match s {
        "system" => Ok(Role::System),
        "user" => Ok(Role::User),
        "assistant" => Ok(Role::Assistant),
        "tool" => Ok(Role::Tool),
        other => Err(StateError::Migration(format!(
            "unknown role variant in DB: {other}"
        ))),
    }
}

fn parse_dt(s: &str) -> StateResult<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|e| StateError::Migration(format!("invalid datetime in DB: {e}")))
}

fn parse_uuid(s: &str) -> StateResult<uuid::Uuid> {
    uuid::Uuid::parse_str(s)
        .map_err(|e| StateError::Migration(format!("invalid uuid in DB: {e}")))
}

fn thread_from_row(row: sqlx::sqlite::SqliteRow) -> StateResult<ThreadRow> {
    Ok(ThreadRow {
        id: ThreadId::new(row.try_get::<String, _>("id")?),
        tenant_id: TenantId::new(row.try_get::<String, _>("tenant_id")?),
        project_id: ProjectId::from_raw(row.try_get::<String, _>("project_id")?),
        title: row.try_get::<String, _>("title")?,
        created_at: parse_dt(&row.try_get::<String, _>("created_at")?)?,
    })
}

fn message_from_row(row: sqlx::sqlite::SqliteRow) -> StateResult<MessageRow> {
    let content_json: String = row.try_get("content")?;
    let content: Vec<ContentBlock> = serde_json::from_str(&content_json)?;
    Ok(MessageRow {
        id: MessageId::from_uuid(parse_uuid(&row.try_get::<String, _>("id")?)?),
        thread_id: ThreadId::new(row.try_get::<String, _>("thread_id")?),
        session_id: SessionId::from_uuid(parse_uuid(&row.try_get::<String, _>("session_id")?)?),
        role: role_from_str(&row.try_get::<String, _>("role")?)?,
        content,
        created_at: parse_dt(&row.try_get::<String, _>("created_at")?)?,
    })
}

fn tool_call_from_row(row: sqlx::sqlite::SqliteRow) -> StateResult<ToolCallRow> {
    let input_json: String = row.try_get("input")?;
    let output_json: Option<String> = row.try_get("output")?;
    let completed_at: Option<String> = row.try_get("completed_at")?;
    Ok(ToolCallRow {
        id: ToolUseId::new(row.try_get::<String, _>("id")?),
        message_id: MessageId::from_uuid(parse_uuid(&row.try_get::<String, _>("message_id")?)?),
        tool_name: row.try_get("tool_name")?,
        input: serde_json::from_str(&input_json)?,
        output: output_json.map(|s| serde_json::from_str(&s)).transpose()?,
        is_error: row.try_get::<i64, _>("is_error")? != 0,
        started_at: parse_dt(&row.try_get::<String, _>("started_at")?)?,
        completed_at: completed_at.map(|s| parse_dt(&s)).transpose()?,
    })
}

fn binding_from_row(row: sqlx::sqlite::SqliteRow) -> StateResult<ChatBinding> {
    Ok(ChatBinding {
        chat_id: row.try_get("chat_id")?,
        user_id: row.try_get("user_id")?,
        project_id: ProjectId::from_raw(row.try_get::<String, _>("project_id")?),
        bound_at: parse_dt(&row.try_get::<String, _>("bound_at")?)?,
    })
}

fn embedding_to_bytes(v: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(v.len() * 4);
    for f in v {
        bytes.extend_from_slice(&f.to_le_bytes());
    }
    bytes
}

fn bytes_to_embedding(bytes: &[u8], dim: usize) -> StateResult<Vec<f32>> {
    if bytes.len() != dim * 4 {
        return Err(StateError::Migration(format!(
            "memory_vectors blob length {} does not match dim {} (expected {} bytes)",
            bytes.len(),
            dim,
            dim * 4
        )));
    }
    let mut out = Vec::with_capacity(dim);
    for chunk in bytes.chunks_exact(4) {
        out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Ok(out)
}

fn memory_vector_from_row(row: sqlx::sqlite::SqliteRow) -> StateResult<MemoryVector> {
    let dim: i64 = row.try_get("dim")?;
    let bytes: Vec<u8> = row.try_get("embedding")?;
    let embedding = bytes_to_embedding(&bytes, dim.max(0) as usize)?;
    Ok(MemoryVector {
        tenant_id: TenantId::new(row.try_get::<String, _>("tenant_id")?),
        project_id: ProjectId::from_raw(row.try_get::<String, _>("project_id")?),
        scope: row.try_get::<String, _>("scope")?,
        name: row.try_get::<String, _>("name")?,
        model_id: row.try_get::<String, _>("model_id")?,
        embedding,
        updated_at: parse_dt(&row.try_get::<String, _>("updated_at")?)?,
    })
}

fn compaction_from_row(row: sqlx::sqlite::SqliteRow) -> StateResult<ThreadCompaction> {
    // Legacy rows backfilled by the migration carry an empty string;
    // surface them as `None` so the engine renders the preamble at the
    // head of the loaded history (pre-M6 behaviour).
    let from_raw: String = row.try_get("summary_from_message_id").unwrap_or_default();
    let summary_from_message_id = if from_raw.is_empty() {
        None
    } else {
        Some(MessageId::from_uuid(parse_uuid(&from_raw)?))
    };
    Ok(ThreadCompaction {
        thread_id: ThreadId::new(row.try_get::<String, _>("thread_id")?),
        summary: row.try_get::<String, _>("summary")?,
        summary_until_message_id: MessageId::from_uuid(parse_uuid(
            &row.try_get::<String, _>("summary_until_message_id")?,
        )?),
        summary_from_message_id,
        msg_count_before: row.try_get::<i64, _>("msg_count_before")?.max(0) as u32,
        input_tokens_before: row.try_get::<i64, _>("input_tokens_before")?.max(0) as u32,
        compacted_at: parse_dt(&row.try_get::<String, _>("compacted_at")?)?,
    })
}

fn outbox_from_row(row: sqlx::sqlite::SqliteRow) -> StateResult<OutboxRow> {
    let kind_raw: String = row.try_get("kind")?;
    let kind = OutboxKind::parse(&kind_raw).ok_or_else(|| {
        StateError::Migration(format!("unknown outbox kind in DB: {kind_raw}"))
    })?;
    let status_raw: String = row.try_get("status")?;
    let status = OutboxStatus::parse(&status_raw).ok_or_else(|| {
        StateError::Migration(format!("unknown outbox status in DB: {status_raw}"))
    })?;
    let payload_json: String = row.try_get("payload")?;
    let delivered_at: Option<String> = row.try_get("delivered_at")?;
    Ok(OutboxRow {
        id: row.try_get("id")?,
        plugin: row.try_get("plugin")?,
        tenant_id: row.try_get("tenant_id")?,
        chat_id: row.try_get("chat_id")?,
        kind,
        payload: serde_json::from_str(&payload_json)?,
        attempts: row.try_get::<i64, _>("attempts")?.max(0) as u32,
        next_attempt_at: parse_dt(&row.try_get::<String, _>("next_attempt_at")?)?,
        status,
        last_error: row.try_get("last_error")?,
        platform_message_id: row.try_get("platform_message_id")?,
        created_at: parse_dt(&row.try_get::<String, _>("created_at")?)?,
        delivered_at: delivered_at.map(|s| parse_dt(&s)).transpose()?,
    })
}

fn scheduled_task_from_row(row: sqlx::sqlite::SqliteRow) -> StateResult<ScheduledTask> {
    // `try_get::<Option<String>, _>` is the explicit form — relying on
    // `try_get::<String, _>().ok()` to coerce SQLite NULL into None
    // tripped a subtle bug where some sqlx-sqlite paths return Ok("")
    // rather than Err for NULL.
    let last_fired_at: Option<String> = row.try_get("last_fired_at")?;
    let interval_secs: Option<i64> = row.try_get("interval_secs")?;
    let enabled: i64 = row.try_get("enabled")?;
    Ok(ScheduledTask {
        id: row.try_get::<String, _>("id")?,
        tenant_id: TenantId::new(row.try_get::<String, _>("tenant_id")?),
        project_id: ProjectId::from_raw(row.try_get::<String, _>("project_id")?),
        chat_id: row.try_get::<String, _>("chat_id")?,
        plugin: row.try_get::<String, _>("plugin")?,
        prompt: row.try_get::<String, _>("prompt")?,
        interval_secs,
        next_fire_at: parse_dt(&row.try_get::<String, _>("next_fire_at")?)?,
        last_fired_at: last_fired_at
            .filter(|s| !s.is_empty())
            .map(|s| parse_dt(&s))
            .transpose()?,
        enabled: enabled != 0,
        created_at: parse_dt(&row.try_get::<String, _>("created_at")?)?,
    })
}

fn decision_from_row(row: sqlx::sqlite::SqliteRow) -> StateResult<StoredApprovalDecision> {
    let raw: String = row.try_get("decision")?;
    let decision = match raw.as_str() {
        "allow" => PersistedDecision::Allow,
        "deny" => PersistedDecision::Deny,
        other => {
            return Err(StateError::Migration(format!(
                "unknown approval decision in DB: {other}"
            )));
        }
    };
    Ok(StoredApprovalDecision {
        tenant_id: TenantId::new(row.try_get::<String, _>("tenant_id")?),
        project_id: ProjectId::from_raw(row.try_get::<String, _>("project_id")?),
        tool_name: row.try_get("tool_name")?,
        input_signature: row.try_get("input_signature")?,
        decision,
        decided_at: parse_dt(&row.try_get::<String, _>("decided_at")?)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use snaca_core::ContentBlock;

    async fn db() -> Database {
        Database::open_in_memory().await.unwrap()
    }

    #[tokio::test]
    async fn migrations_run_idempotent() {
        let db = db().await;
        // Re-run; must not error.
        db.run_migrations().await.unwrap();
    }

    #[tokio::test]
    async fn thread_insert_and_find() {
        let db = db().await;
        let new = NewThread {
            id: ThreadId::new("chat_1"),
            tenant_id: TenantId::new("tenant_a"),
            project_id: ProjectId::from_raw("proj_x"),
            title: String::new(),
        };
        let row = db.insert_thread(&new).await.unwrap();
        assert_eq!(row.id.as_str(), "chat_1");
        let found = db.find_thread(&new.id).await.unwrap().unwrap();
        assert_eq!(found.tenant_id.as_str(), "tenant_a");
        assert_eq!(found.project_id.as_str(), "proj_x");
    }

    #[tokio::test]
    async fn message_append_and_list() {
        let db = db().await;
        let thread = NewThread {
            id: ThreadId::new("chat_2"),
            tenant_id: TenantId::new("t"),
            project_id: ProjectId::from_raw("p"),
            title: String::new(),
        };
        db.insert_thread(&thread).await.unwrap();
        let session = SessionId::new();
        db.append_message(&NewMessage {
            thread_id: thread.id.clone(),
            session_id: session,
            role: Role::User,
            content: vec![ContentBlock::text("hi")],
        })
        .await
        .unwrap();
        db.append_message(&NewMessage {
            thread_id: thread.id.clone(),
            session_id: session,
            role: Role::Assistant,
            content: vec![ContentBlock::text("hello")],
        })
        .await
        .unwrap();

        let msgs = db.recent_messages(&thread.id, 10).await.unwrap();
        assert_eq!(msgs.len(), 2);
        assert!(matches!(msgs[0].role, Role::User));
        assert!(matches!(msgs[1].role, Role::Assistant));
        match &msgs[0].content[0] {
            ContentBlock::Text { text } => assert_eq!(text, "hi"),
            _ => panic!(),
        }
    }

    #[tokio::test]
    async fn tool_call_lifecycle() {
        let db = db().await;
        let thread = NewThread {
            id: ThreadId::new("chat_3"),
            tenant_id: TenantId::new("t"),
            project_id: ProjectId::from_raw("p"),
            title: String::new(),
        };
        db.insert_thread(&thread).await.unwrap();
        let msg = db
            .append_message(&NewMessage {
                thread_id: thread.id,
                session_id: SessionId::new(),
                role: Role::Assistant,
                content: vec![ContentBlock::tool_use(
                    "tu_1",
                    "Read",
                    serde_json::json!({"path": "x"}),
                )],
            })
            .await
            .unwrap();

        let id = ToolUseId::new("tu_1");
        db.record_tool_start(&id, &msg.id, "Read", &serde_json::json!({"path": "x"}))
            .await
            .unwrap();
        let row = db.find_tool_call(&id).await.unwrap().unwrap();
        assert_eq!(row.tool_name, "Read");
        assert!(row.output.is_none());
        assert!(!row.is_error);

        db.record_tool_completion(&id, &serde_json::json!({"text": "ok"}), false)
            .await
            .unwrap();
        let row = db.find_tool_call(&id).await.unwrap().unwrap();
        assert!(row.output.is_some());
        assert!(row.completed_at.is_some());
    }

    #[tokio::test]
    async fn binding_upsert_and_find() {
        let db = db().await;
        let project = ProjectId::from_raw("proj_v1");
        let project2 = ProjectId::from_raw("proj_v2");

        db.upsert_binding("chat_x", "user_y", &project).await.unwrap();
        let found = db.find_binding("chat_x", "user_y").await.unwrap().unwrap();
        assert_eq!(found.project_id.as_str(), "proj_v1");

        // upsert overwrites.
        db.upsert_binding("chat_x", "user_y", &project2).await.unwrap();
        let found = db.find_binding("chat_x", "user_y").await.unwrap().unwrap();
        assert_eq!(found.project_id.as_str(), "proj_v2");

        // missing returns None.
        let none = db.find_binding("nope", "nope").await.unwrap();
        assert!(none.is_none());
    }

    #[tokio::test]
    async fn approval_decision_remember_and_recall() {
        let db = db().await;
        let tenant = TenantId::new("t");
        let project = ProjectId::from_raw("p");
        assert!(db
            .find_decision(&tenant, &project, "Bash", "")
            .await
            .unwrap()
            .is_none());

        // Catch-all rule (input_signature = "").
        db.remember_decision(&tenant, &project, "Bash", "", PersistedDecision::Allow)
            .await
            .unwrap();
        let found = db
            .find_decision(&tenant, &project, "Bash", "")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(found.decision, PersistedDecision::Allow);
        assert_eq!(found.tool_name, "Bash");
        assert_eq!(found.input_signature, "");

        // upsert: changing decision overwrites the prior one.
        db.remember_decision(&tenant, &project, "Bash", "", PersistedDecision::Deny)
            .await
            .unwrap();
        let found = db
            .find_decision(&tenant, &project, "Bash", "")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(found.decision, PersistedDecision::Deny);

        db.forget_decision(&tenant, &project, "Bash", "")
            .await
            .unwrap();
        assert!(db
            .find_decision(&tenant, &project, "Bash", "")
            .await
            .unwrap()
            .is_none());
    }

    /// Per-input signatures don't collide: approving one Bash command
    /// doesn't auto-approve another.
    #[tokio::test]
    async fn approval_decision_per_input_signature_isolated() {
        let db = db().await;
        let tenant = TenantId::new("t");
        let project = ProjectId::from_raw("p");

        db.remember_decision(&tenant, &project, "Bash", "sig_ls", PersistedDecision::Allow)
            .await
            .unwrap();

        // Exact match → hit.
        let hit = db
            .find_decision(&tenant, &project, "Bash", "sig_ls")
            .await
            .unwrap();
        assert!(hit.is_some());

        // Different signature, no catch-all rule → miss.
        let miss = db
            .find_decision(&tenant, &project, "Bash", "sig_rm_rf")
            .await
            .unwrap();
        assert!(miss.is_none(), "different input must NOT inherit approval");

        // Now add a catch-all DENY — the per-input ALLOW still wins by
        // exact match, the other input falls back to the catch-all.
        db.remember_decision(&tenant, &project, "Bash", "", PersistedDecision::Deny)
            .await
            .unwrap();
        let hit = db
            .find_decision(&tenant, &project, "Bash", "sig_ls")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            hit.decision,
            PersistedDecision::Allow,
            "exact-signature row must take precedence over catch-all"
        );
        let fallback = db
            .find_decision(&tenant, &project, "Bash", "sig_rm_rf")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            fallback.decision,
            PersistedDecision::Deny,
            "no exact match → catch-all applies"
        );
    }

    /// `forget_decisions_for_tool` drops every rule for the tool, both
    /// per-input rows and the catch-all.
    #[tokio::test]
    async fn forget_decisions_for_tool_wipes_all_rules() {
        let db = db().await;
        let tenant = TenantId::new("t");
        let project = ProjectId::from_raw("p");
        db.remember_decision(&tenant, &project, "Bash", "", PersistedDecision::Allow)
            .await
            .unwrap();
        db.remember_decision(&tenant, &project, "Bash", "sig_a", PersistedDecision::Allow)
            .await
            .unwrap();
        db.remember_decision(&tenant, &project, "Bash", "sig_b", PersistedDecision::Deny)
            .await
            .unwrap();
        db.forget_decisions_for_tool(&tenant, &project, "Bash")
            .await
            .unwrap();
        for sig in ["", "sig_a", "sig_b"] {
            assert!(db
                .find_decision(&tenant, &project, "Bash", sig)
                .await
                .unwrap()
                .is_none());
        }
    }

    #[tokio::test]
    async fn memory_vector_round_trips() {
        let db = db().await;
        let tenant = TenantId::new("t");
        let project = ProjectId::from_raw("p");
        let v: Vec<f32> = (0..32).map(|i| i as f32 * 0.1).collect();

        db.upsert_memory_vector(&tenant, &project, "user", "prefs", "hash/v1", &v)
            .await
            .unwrap();
        let stored = db
            .list_memory_vectors(&tenant, &project)
            .await
            .unwrap();
        assert_eq!(stored.len(), 1);
        let row = &stored[0];
        assert_eq!(row.scope, "user");
        assert_eq!(row.name, "prefs");
        assert_eq!(row.model_id, "hash/v1");
        assert_eq!(row.embedding.len(), 32);
        // f32 round-trip is exact for our inputs (i*0.1 fits cleanly).
        for (i, x) in row.embedding.iter().enumerate() {
            let expected = i as f32 * 0.1;
            assert!((x - expected).abs() < 1e-6);
        }
    }

    #[tokio::test]
    async fn memory_vector_upsert_replaces_existing() {
        let db = db().await;
        let tenant = TenantId::new("t");
        let project = ProjectId::from_raw("p");
        db.upsert_memory_vector(&tenant, &project, "user", "x", "v1", &[1.0, 2.0])
            .await
            .unwrap();
        db.upsert_memory_vector(&tenant, &project, "user", "x", "v2", &[3.0, 4.0, 5.0])
            .await
            .unwrap();
        let stored = db.list_memory_vectors(&tenant, &project).await.unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].model_id, "v2");
        assert_eq!(stored[0].embedding, vec![3.0, 4.0, 5.0]);
    }

    #[tokio::test]
    async fn memory_vectors_isolated_across_projects() {
        let db = db().await;
        let tenant = TenantId::new("t");
        let p1 = ProjectId::from_raw("p1");
        let p2 = ProjectId::from_raw("p2");
        db.upsert_memory_vector(&tenant, &p1, "user", "shared", "h", &[1.0])
            .await
            .unwrap();
        db.upsert_memory_vector(&tenant, &p2, "user", "shared", "h", &[2.0])
            .await
            .unwrap();
        let p1_rows = db.list_memory_vectors(&tenant, &p1).await.unwrap();
        let p2_rows = db.list_memory_vectors(&tenant, &p2).await.unwrap();
        assert_eq!(p1_rows[0].embedding, vec![1.0]);
        assert_eq!(p2_rows[0].embedding, vec![2.0]);
    }

    #[tokio::test]
    async fn delete_memory_vector_removes_row_and_is_idempotent() {
        let db = db().await;
        let tenant = TenantId::new("t");
        let project = ProjectId::from_raw("p");
        db.upsert_memory_vector(&tenant, &project, "user", "tmp", "h", &[1.0])
            .await
            .unwrap();
        db.delete_memory_vector(&tenant, &project, "user", "tmp")
            .await
            .unwrap();
        assert!(db
            .list_memory_vectors(&tenant, &project)
            .await
            .unwrap()
            .is_empty());
        // No-op when absent.
        db.delete_memory_vector(&tenant, &project, "user", "tmp")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn approval_decisions_are_scoped_per_project() {
        let db = db().await;
        let tenant = TenantId::new("t");
        let p1 = ProjectId::from_raw("p1");
        let p2 = ProjectId::from_raw("p2");
        db.remember_decision(&tenant, &p1, "Edit", "", PersistedDecision::Allow)
            .await
            .unwrap();
        // Same tool, different project — should be independent.
        assert!(db
            .find_decision(&tenant, &p2, "Edit", "")
            .await
            .unwrap()
            .is_none());
    }

    fn new_scheduled(
        chat: &str,
        prompt: &str,
        interval_secs: Option<i64>,
        next_fire_at: DateTime<Utc>,
    ) -> NewScheduledTask {
        NewScheduledTask {
            tenant_id: TenantId::new("t"),
            project_id: ProjectId::from_raw("p"),
            chat_id: chat.into(),
            plugin: "lark".into(),
            prompt: prompt.into(),
            interval_secs,
            next_fire_at,
        }
    }

    #[tokio::test]
    async fn schedule_task_round_trips_and_returns_due_rows() {
        let db = db().await;
        let now = Utc::now();
        // Two due rows + one future row.
        let due_1 = db
            .schedule_task(&new_scheduled(
                "chat_a",
                "remind A",
                None,
                now - chrono::Duration::seconds(10),
            ))
            .await
            .unwrap();
        let due_2 = db
            .schedule_task(&new_scheduled(
                "chat_b",
                "remind B",
                Some(3600),
                now - chrono::Duration::seconds(1),
            ))
            .await
            .unwrap();
        let _future = db
            .schedule_task(&new_scheduled(
                "chat_c",
                "remind C",
                None,
                now + chrono::Duration::hours(1),
            ))
            .await
            .unwrap();

        let due = db.list_due_scheduled_tasks(now, 10).await.unwrap();
        let ids: Vec<&str> = due.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&due_1.id.as_str()));
        assert!(ids.contains(&due_2.id.as_str()));
        assert_eq!(due.len(), 2, "future task must not appear");

        // Ordering: oldest next_fire_at first.
        assert_eq!(due[0].id, due_1.id);
    }

    #[tokio::test]
    async fn reschedule_one_shot_disables_row() {
        let db = db().await;
        let now = Utc::now();
        let t = db
            .schedule_task(&new_scheduled(
                "chat_x",
                "fire once",
                None,
                now,
            ))
            .await
            .unwrap();
        db.reschedule_task(&t.id, now, None).await.unwrap();
        let due = db.list_due_scheduled_tasks(now + chrono::Duration::hours(1), 10)
            .await
            .unwrap();
        assert!(
            due.iter().all(|r| r.id != t.id),
            "one-shot row must not be due again after fire"
        );
        // Row still in DB, just disabled.
        let listed = db
            .list_scheduled_tasks_for_chat(&TenantId::new("t"), "chat_x")
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].enabled);
        assert!(listed[0].last_fired_at.is_some());
    }

    #[tokio::test]
    async fn reschedule_recurring_advances_next_fire() {
        let db = db().await;
        let t0 = Utc::now();
        let t = db
            .schedule_task(&new_scheduled(
                "chat_recur",
                "every 5m",
                Some(300),
                t0,
            ))
            .await
            .unwrap();

        let fired_at = t0;
        let next = fired_at + chrono::Duration::seconds(300);
        db.reschedule_task(&t.id, fired_at, Some(next))
            .await
            .unwrap();

        // Now: due rows up to t0+299 should not include this task.
        let early = db
            .list_due_scheduled_tasks(t0 + chrono::Duration::seconds(299), 10)
            .await
            .unwrap();
        assert!(early.iter().all(|r| r.id != t.id));
        // At t0+300 (or later) it's due again.
        let on_time = db
            .list_due_scheduled_tasks(t0 + chrono::Duration::seconds(301), 10)
            .await
            .unwrap();
        assert!(on_time.iter().any(|r| r.id == t.id));
    }

    #[tokio::test]
    async fn set_enabled_pauses_and_resumes_task() {
        let db = db().await;
        let now = Utc::now();
        let t = db
            .schedule_task(&new_scheduled(
                "chat_x",
                "fire",
                Some(60),
                now - chrono::Duration::seconds(1),
            ))
            .await
            .unwrap();
        // Disabled → not due.
        db.set_scheduled_task_enabled(&t.id, false).await.unwrap();
        let due = db.list_due_scheduled_tasks(now, 10).await.unwrap();
        assert!(due.iter().all(|r| r.id != t.id));
        // Re-enable.
        db.set_scheduled_task_enabled(&t.id, true).await.unwrap();
        let due = db.list_due_scheduled_tasks(now, 10).await.unwrap();
        assert!(due.iter().any(|r| r.id == t.id));
    }

    #[tokio::test]
    async fn delete_scheduled_task_removes_row() {
        let db = db().await;
        let now = Utc::now();
        let t = db
            .schedule_task(&new_scheduled("chat_x", "fire", None, now))
            .await
            .unwrap();
        db.delete_scheduled_task(&t.id).await.unwrap();
        let listed = db
            .list_scheduled_tasks_for_chat(&TenantId::new("t"), "chat_x")
            .await
            .unwrap();
        assert!(listed.is_empty());
    }

    fn outbox_entry(id: &str, plugin: &str) -> NewOutboxEntry {
        NewOutboxEntry {
            id: id.to_string(),
            plugin: plugin.to_string(),
            tenant_id: "tenant_a".to_string(),
            chat_id: "chat_x".to_string(),
            kind: OutboxKind::SendMessage,
            payload: serde_json::json!({"content": "hi"}),
            next_attempt_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn outbox_enqueue_claim_deliver() {
        let db = db().await;
        db.outbox_enqueue(&outbox_entry("ob_1", "lark")).await.unwrap();
        let rows = db.outbox_claim_pending("lark", 10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "ob_1");
        assert!(matches!(rows[0].kind, OutboxKind::SendMessage));
        assert!(matches!(rows[0].status, OutboxStatus::Pending));
        assert_eq!(rows[0].attempts, 0);

        db.outbox_mark_delivered("ob_1", Some("om_lark_42")).await.unwrap();
        let rows = db.outbox_claim_pending("lark", 10).await.unwrap();
        assert!(rows.is_empty(), "delivered rows must not be re-claimed");
        let found = db.outbox_find("ob_1").await.unwrap().unwrap();
        assert!(matches!(found.status, OutboxStatus::Delivered));
        assert_eq!(found.platform_message_id.as_deref(), Some("om_lark_42"));
    }

    #[tokio::test]
    async fn outbox_reschedule_pushes_next_attempt() {
        let db = db().await;
        db.outbox_enqueue(&outbox_entry("ob_2", "lark")).await.unwrap();
        let future = Utc::now() + chrono::Duration::seconds(60);
        db.outbox_reschedule("ob_2", "transient: broken pipe", future)
            .await
            .unwrap();

        // Claiming with now()<=next_attempt_at must skip.
        let rows = db.outbox_claim_pending("lark", 10).await.unwrap();
        assert!(rows.is_empty());
        let found = db.outbox_find("ob_2").await.unwrap().unwrap();
        assert_eq!(found.attempts, 1);
        assert_eq!(
            found.last_error.as_deref(),
            Some("transient: broken pipe")
        );
    }

    #[tokio::test]
    async fn outbox_claim_filters_by_plugin() {
        let db = db().await;
        db.outbox_enqueue(&outbox_entry("ob_l", "lark")).await.unwrap();
        db.outbox_enqueue(&outbox_entry("ob_m", "mock")).await.unwrap();
        let lark = db.outbox_claim_pending("lark", 10).await.unwrap();
        let mock = db.outbox_claim_pending("mock", 10).await.unwrap();
        assert_eq!(lark.len(), 1);
        assert_eq!(mock.len(), 1);
        assert_eq!(lark[0].id, "ob_l");
        assert_eq!(mock[0].id, "ob_m");
    }

    #[tokio::test]
    async fn outbox_purge_deletes_only_old_delivered() {
        let db = db().await;
        db.outbox_enqueue(&outbox_entry("ob_p1", "lark")).await.unwrap();
        db.outbox_enqueue(&outbox_entry("ob_p2", "lark")).await.unwrap();
        db.outbox_mark_delivered("ob_p1", None).await.unwrap();
        // Cutoff in the future means everything delivered-so-far gets nuked.
        let n = db
            .outbox_purge_delivered_older_than(Utc::now() + chrono::Duration::seconds(60))
            .await
            .unwrap();
        assert_eq!(n, 1);
        // Pending row untouched.
        assert!(db.outbox_find("ob_p2").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn outbox_failed_is_terminal() {
        let db = db().await;
        db.outbox_enqueue(&outbox_entry("ob_f", "lark")).await.unwrap();
        db.outbox_mark_failed("ob_f", "card expired").await.unwrap();
        let rows = db.outbox_claim_pending("lark", 10).await.unwrap();
        assert!(rows.is_empty(), "failed rows must not be re-claimed");
    }

    #[tokio::test]
    async fn outbox_enqueue_with_future_next_attempt_is_not_claimable() {
        let db = db().await;
        let mut entry = outbox_entry("ob_future", "lark");
        entry.next_attempt_at = Utc::now() + chrono::Duration::seconds(60);
        db.outbox_enqueue(&entry).await.unwrap();
        let rows = db.outbox_claim_pending("lark", 10).await.unwrap();
        assert!(
            rows.is_empty(),
            "row with future next_attempt_at must not be claimable yet"
        );
    }

    #[tokio::test]
    async fn inbound_dedup_first_call_records_subsequent_reports_duplicate() {
        let db = db().await;
        let first = db
            .inbound_dedup_check_and_record("lark", "om_abc")
            .await
            .unwrap();
        assert!(!first, "first sighting should not be flagged duplicate");
        let second = db
            .inbound_dedup_check_and_record("lark", "om_abc")
            .await
            .unwrap();
        assert!(second, "second sighting must be flagged duplicate");
    }

    #[tokio::test]
    async fn inbound_dedup_is_scoped_per_plugin() {
        let db = db().await;
        let larkside = db
            .inbound_dedup_check_and_record("lark", "om_x")
            .await
            .unwrap();
        let mockside = db
            .inbound_dedup_check_and_record("mock", "om_x")
            .await
            .unwrap();
        assert!(!larkside);
        assert!(!mockside, "same message_id under different plugin is a new event");
    }

    #[tokio::test]
    async fn inbound_dedup_purge_drops_old_rows() {
        let db = db().await;
        db.inbound_dedup_check_and_record("lark", "om_old")
            .await
            .unwrap();
        let n = db
            .inbound_dedup_purge_older_than(Utc::now() + chrono::Duration::seconds(60))
            .await
            .unwrap();
        assert_eq!(n, 1);
        // After purge, the same id is treated as fresh again.
        let after = db
            .inbound_dedup_check_and_record("lark", "om_old")
            .await
            .unwrap();
        assert!(!after);
    }
}
