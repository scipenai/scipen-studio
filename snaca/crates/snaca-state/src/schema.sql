-- SNACA SQLite schema (M1).
-- Statements separated by `;`; the migration runner splits on `;` and
-- executes each individually because sqlx::query takes one statement at a
-- time.

CREATE TABLE IF NOT EXISTS threads (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL,
    project_id  TEXT NOT NULL,
    -- scipen-studio fork: editor-mode thread title.
    title       TEXT NOT NULL DEFAULT 'New conversation',
    created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threads_tenant_project
    ON threads(tenant_id, project_id);

CREATE TABLE IF NOT EXISTS messages (
    id          TEXT PRIMARY KEY,
    thread_id   TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    role        TEXT NOT NULL,
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    -- Set when the engine localizes this message as the cause of a
    -- provider content-moderation rejection (e.g. DeepSeek "Content
    -- Exists Risk"). `load_history` then replaces its body with a neutral
    -- placeholder so the flagged content stops re-triggering the filter
    -- on every replayed turn. NULL = not redacted. Legacy DBs acquire the
    -- column via the in-place ALTER migration in db.rs.
    redacted_at TEXT,
    -- scipen-studio fork: turn association for host UIs.
    turn_id     TEXT,
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_thread_created
    ON messages(thread_id, created_at);

-- One-shot migration markers for data migrations that cannot be inferred
-- reliably from table shape alone.
CREATE TABLE IF NOT EXISTS schema_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_calls (
    id            TEXT PRIMARY KEY,
    message_id    TEXT NOT NULL,
    tool_name     TEXT NOT NULL,
    input         TEXT NOT NULL,
    output        TEXT,
    is_error      INTEGER NOT NULL DEFAULT 0,
    started_at    TEXT NOT NULL,
    completed_at  TEXT,
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_message
    ON tool_calls(message_id);

CREATE TABLE IF NOT EXISTS chat_session_binding (
    chat_id     TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    project_id  TEXT NOT NULL,
    bound_at    TEXT NOT NULL,
    PRIMARY KEY (chat_id, user_id)
);

-- M2: rolling per-thread compaction summary. One row per thread (PK is the
-- thread itself); upserts replace the prior summary so the table stays small.
-- `summary_until_message_id` is the id of the last message folded into the
-- summary — `load_history` returns a synthetic preamble plus messages strictly
-- newer than that id. Token / message counts are kept for diagnostics.
--
-- M6: `summary_from_message_id` is the id of the *first* message folded into
-- the summary. Empty string ('') is the legacy "compress from the beginning"
-- value; concrete ids mark the start of the compressed range so
-- `load_history` can splice the verbatim head messages back in front of the
-- synthetic preamble. The column tolerates the legacy empty default so older
-- databases upgrade in place via the `migrate_thread_compactions_add_summary_from`
-- migration in db.rs.
CREATE TABLE IF NOT EXISTS thread_compactions (
    thread_id                 TEXT PRIMARY KEY,
    summary                   TEXT NOT NULL,
    summary_until_message_id  TEXT NOT NULL,
    summary_from_message_id   TEXT NOT NULL DEFAULT '',
    msg_count_before          INTEGER NOT NULL,
    input_tokens_before       INTEGER NOT NULL,
    compacted_at              TEXT NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

-- M2/M5: per-(tenant, project, tool, input) approval decisions remembered
-- across turns. Decision values are 'allow' or 'deny'; 'allow_once' is not
-- persisted (it expires with the turn it was granted in).
--
-- `input_signature` is a short blake3 fingerprint of the tool input as
-- approved. Empty string ('') is the legacy catch-all that pre-M5 rows
-- still use and engine lookups fall back to when no per-input match
-- exists. M5 widens the PK so the user can say "Always" to one Bash
-- command without auto-approving every other Bash invocation.
CREATE TABLE IF NOT EXISTS approval_decisions (
    tenant_id        TEXT NOT NULL,
    project_id       TEXT NOT NULL,
    tool_name        TEXT NOT NULL,
    input_signature  TEXT NOT NULL DEFAULT '',
    decision         TEXT NOT NULL,
    decided_at       TEXT NOT NULL,
    PRIMARY KEY (tenant_id, project_id, tool_name, input_signature)
);

-- M4: durable outbox for outbound IM deliveries. One row per send_message /
-- update_message / file_upload the dispatcher decides to perform. Inserted
-- before the RPC is attempted; the caller path then tries the RPC and, on
-- success, marks the row 'delivered'. On retryable failure (plugin died,
-- timeout) the row stays 'pending' and a per-plugin background worker (see
-- crates/snaca-server/src/outbox.rs) drives the retry loop. `id` doubles
-- as the platform-side idempotency key (Lark's `?uuid=...`) so retries don't
-- double-send. `kind` strings are pinned: 'send_message', 'update_message',
-- 'file_upload'. `payload` is JSON-serialised params for the matching kind,
-- including bytes_base64 for files (small enough at SNACA's scale).
-- M5: durable scheduled tasks for the cron-style proactive injector.
-- Each row is one "at time T, deliver this prompt to (tenant, chat,
-- plugin) as if the user had typed it" rule. Cron / interval is
-- intentionally minimal — `next_fire_at` is the authoritative "when
-- next" and the firing path adds `interval_secs` after each fire
-- (None → one-shot, deleted after first fire). Operators can update
-- the row to reschedule.
--
-- The unbound `enabled` flag lets admins quickly pause a rule
-- without deleting it. `created_at` is for ordering / audit only.
CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL,
    project_id      TEXT NOT NULL,
    chat_id         TEXT NOT NULL,
    plugin          TEXT NOT NULL,
    prompt          TEXT NOT NULL,
    interval_secs   INTEGER,
    next_fire_at    TEXT NOT NULL,
    last_fired_at   TEXT,
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL
);

-- Hot path: scheduler polls for due rows every tick. A composite
-- index on (enabled, next_fire_at) makes the predicate
-- `WHERE enabled = 1 AND next_fire_at <= ?` a range scan over
-- enabled-only rows.
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due
    ON scheduled_tasks(enabled, next_fire_at);

CREATE TABLE IF NOT EXISTS outbox (
    id                   TEXT PRIMARY KEY,
    plugin               TEXT NOT NULL,
    tenant_id            TEXT NOT NULL,
    chat_id              TEXT NOT NULL,
    kind                 TEXT NOT NULL,
    payload              TEXT NOT NULL,
    attempts             INTEGER NOT NULL DEFAULT 0,
    next_attempt_at      TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'pending',
    last_error           TEXT,
    platform_message_id  TEXT,
    created_at           TEXT NOT NULL,
    delivered_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
    ON outbox(plugin, status, next_attempt_at);

-- M4: dedup table for inbound IM messages. The Lark plugin maintains an
-- in-process HashMap to drop WS-level redeliveries cheaply, but that
-- map dies with the plugin process. After a watchdog-triggered restart,
-- Lark's WS reconnect may replay the recent backlog and the plugin
-- has no recollection that those `message_id`s were already processed.
-- This table is the durable second gate, consulted in the server's
-- dispatch loop *after* the plugin's fast-path check. `seen_at` is
-- only used by the purge job — uniqueness is enforced by the primary
-- key, so the lookup is a cheap PK probe.
CREATE TABLE IF NOT EXISTS inbound_dedup (
    plugin       TEXT NOT NULL,
    message_id   TEXT NOT NULL,
    seen_at      TEXT NOT NULL,
    PRIMARY KEY (plugin, message_id)
);
CREATE INDEX IF NOT EXISTS idx_inbound_dedup_seen_at
    ON inbound_dedup(seen_at);

-- FTS5 virtual table mirroring the text content of `messages`.
-- Drives the `session_search` tool: BM25-ranked full-text search
-- over conversation history, with no LLM / embedding cost. The
-- `content='messages'` clause makes this an "external content"
-- table — it stores its own index but reads bodies back from
-- `messages.content` (kept in sync by the triggers below).
--
-- `tokenize='unicode61 remove_diacritics 2 tokenchars _'` keeps
-- ASCII identifiers like `snake_case` and Unicode CJK both
-- searchable; `porter` stemming is deliberately omitted so
-- "deploys" doesn't drift from "deploy" and surprise the model.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    content,
    content='messages',
    content_rowid='rowid',
    tokenize='unicode61 remove_diacritics 2 tokenchars _'
);

-- Keep the FTS5 index in sync with INSERTs/UPDATEs/DELETEs against
-- the base `messages` table. SQLite runs these triggers inside the
-- same transaction as the row change so the index can never lag
-- in the read path.
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content);
    INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
