//! Method-name constants + typed `Params` / `Result` shapes.
//!
//! Method names live as `pub const` strings under [`host_to_snaca`] and
//! [`snaca_to_host`] for cheap comparison without allocation. Each
//! submodule then provides typed structs callers can
//! `serde_json::from_value` against `params`.

pub mod chat;
pub mod composer;
pub mod context_req;
pub mod edit;
pub mod error_notif;
pub mod init;
pub mod inline_edit;
pub mod log;
pub mod memory;
pub mod plan;
pub mod session;
pub mod tool;
pub mod turn;
pub mod usage;

/// Method-name constants for host → SNACA.
pub mod host_to_snaca {
    // Lifecycle
    pub const INIT: &str = "init";
    pub const SHUTDOWN: &str = "shutdown";
    pub const HEALTH_PING: &str = "health.ping";
    pub const CONFIG_RELOAD: &str = "config.reload";

    // Session
    pub const SESSION_OPEN: &str = "session.open";
    pub const SESSION_CLOSE: &str = "session.close";
    pub const SESSION_LIST_THREADS: &str = "session.list_threads";
    pub const SESSION_NEW_THREAD: &str = "session.new_thread";
    pub const SESSION_SWITCH_THREAD: &str = "session.switch_thread";
    pub const SESSION_DELETE_THREAD: &str = "session.delete_thread";
    pub const SESSION_RENAME_THREAD: &str = "session.rename_thread";
    pub const SESSION_GET_MESSAGES: &str = "session.get_messages";

    // Agent surfaces
    pub const CHAT_SEND: &str = "chat.send";
    pub const INLINE_EDIT_START: &str = "inline_edit.start";
    pub const COMPOSER_START: &str = "composer.start";
    pub const PLAN_CONFIRM: &str = "plan.confirm";

    // Control
    pub const TURN_CANCEL: &str = "turn.cancel";
    pub const EDIT_CONFIRM: &str = "edit.confirm";
    pub const TOOL_CONFIRM: &str = "tool.confirm";
    pub const CONTEXT_RESPOND: &str = "context.respond";
}

/// Method-name constants for SNACA → host.
pub mod snaca_to_host {
    pub const TURN_DELTA: &str = "turn.delta";

    pub const EDIT_PROPOSE: &str = "edit.propose";
    pub const EDIT_PROPOSE_DELTA: &str = "edit.propose_delta";
    pub const EDIT_PROPOSE_COMPLETE: &str = "edit.propose_complete";

    pub const PLAN_UPDATE: &str = "plan.update";

    /// SNACA → host **request** (with id). Host responds via `context.respond`.
    pub const CONTEXT_REQUEST: &str = "context.request";

    pub const TOOL_APPROVAL_REQUEST: &str = "tool.approval_request";
    pub const USAGE_UPDATE: &str = "usage.update";
    pub const MEMORY_UPDATED: &str = "memory.updated";
    pub const ERROR: &str = "error";
    pub const LOG_WRITE: &str = "log.write";
}
