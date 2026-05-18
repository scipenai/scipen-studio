//! Method-name constants and typed params/results for each method.
//!
//! Names live as `pub const` strings (cheap to compare, no allocation in hot
//! paths). Typed shapes are parallel structs that the host and plugins can
//! `serde_json::from_value` against `params`.

use crate::manifest::PluginManifest;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub mod host_to_plugin {
    pub const INITIALIZE: &str = "initialize";
    pub const SHUTDOWN: &str = "shutdown";
    pub const HEALTH_PING: &str = "health.ping";
    pub const MESSAGE_SEND: &str = "message.send";
    pub const MESSAGE_UPDATE: &str = "message.update";
    pub const CARD_SEND: &str = "card.send";
    pub const APPROVAL_PRESENT: &str = "approval.present";
    pub const FILE_UPLOAD: &str = "file.upload";
    pub const FILE_DOWNLOAD: &str = "file.download";
    pub const ACKNOWLEDGE: &str = "acknowledge";
    /// Invoke a plugin-supplied tool by name (host -> plugin). The plugin
    /// must have advertised the tool first via `tool.advertise`.
    pub const TOOL_INVOKE: &str = "tool.invoke";
    /// Invoke a plugin-supplied IM command by name (host -> plugin). The
    /// plugin must have advertised the command via `command.advertise`.
    pub const COMMAND_INVOKE: &str = "command.invoke";
}

pub mod plugin_to_host {
    pub const EVENT_MESSAGE_RECEIVED: &str = "event.message_received";
    /// User retracted (recalled) a previously sent IM message. Host
    /// treats this as a signal to abort any in-flight turn on the
    /// corresponding thread — the user changed their mind, no reason
    /// to keep burning tokens / tools.
    pub const EVENT_MESSAGE_RECALLED: &str = "event.message_recalled";
    pub const EVENT_APPROVAL_CALLBACK: &str = "event.approval_callback";
    pub const EVENT_ERROR: &str = "event.error";
    pub const LOG_WRITE: &str = "log.write";
    pub const TOOL_ADVERTISE: &str = "tool.advertise";
    pub const COMMAND_ADVERTISE: &str = "command.advertise";
}

// ---------------- host -> plugin ----------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_version: String,
    /// Plugin-specific configuration, e.g. Lark `app_id`/`app_secret`.
    /// Type-erased intentionally; each plugin defines its own schema.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
}

pub type InitializeResult = PluginManifest;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MessageSendParams {
    pub tenant_id: String,
    pub chat_id: String,
    pub content: String,
    /// `markdown` (default) or `text`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    /// Platform-side dedup key. Plugins pass this through to the IM
    /// provider's idempotency parameter (Lark: `?uuid=…`) so an outbox
    /// retry after a transient failure won't double-deliver.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MessageSendResult {
    pub message_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MessageUpdateParams {
    pub tenant_id: String,
    pub message_id: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApprovalPresentParams {
    pub tenant_id: String,
    pub chat_id: String,
    pub request: String,
    pub options: Vec<String>,
    pub callback_token: String,
    pub timeout_sec: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AcknowledgeParams {
    pub event_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileUploadParams {
    pub tenant_id: String,
    pub chat_id: String,
    /// Filename to display in IM. The plugin uses this when calling
    /// the platform's upload + send APIs; trailing path components
    /// from the originating workspace are stripped before send.
    pub filename: String,
    /// Plugin-side hint. Mirrors what we accept on `FileDownloadResult`.
    /// Plugins should treat this as a hint, not authoritative.
    pub mime_type: String,
    /// Base64-encoded file bytes. JSON-RPC has no native binary frame.
    pub bytes_base64: String,
    /// Platform-side dedup key passed through to the IM provider's
    /// message-send call (Lark: `?uuid=…`). The file-upload step itself
    /// does not need an idempotency key — Lark's upload returns a fresh
    /// `file_key` per call and the message-send step is the actual
    /// delivery boundary the user observes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileUploadResult {
    /// Platform-side message id of the file message we just sent. The
    /// dispatcher echoes this back into its own logs but doesn't use
    /// it for routing today.
    pub message_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileDownloadParams {
    pub tenant_id: String,
    /// Opaque identifier the IM platform uses to reference an attachment.
    /// Mirrors `Attachment.id` from the corresponding inbound message.
    pub file_id: String,
}

/// JSON-RPC has no native binary frame; bytes are base64-encoded for
/// the wire. The host decodes back to `Vec<u8>` before handing off to
/// the import pipeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileDownloadResult {
    pub bytes_base64: String,
    pub filename: String,
    /// Plugin-reported MIME type. Not authoritative — the import
    /// pipeline still sniffs by extension.
    pub mime_type: String,
}

// ---------------- plugin -> host ----------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MessageReceivedParams {
    /// Plugin authentication; host drops requests with missing/wrong token.
    pub auth: String,
    pub tenant_id: String,
    pub chat_id: String,
    pub user_id: String,
    pub message_id: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mentions: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<String>,
    /// ISO-8601 UTC timestamp, plugin-clock.
    pub received_at: String,
}

/// Notification a plugin sends when the IM platform reports that
/// `message_id` was recalled by `user_id`. Host uses `(tenant_id,
/// chat_id, user_id)` to compute the thread_id (binding lookup
/// shared with `event.message_received`) and fires
/// `Engine::abort_thread` on the result.
///
/// `message_id` and `recalled_at` are kept for logs / observability;
/// the abort path itself doesn't consume them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MessageRecalledParams {
    /// Plugin authentication; host drops requests with missing/wrong token.
    pub auth: String,
    pub tenant_id: String,
    pub chat_id: String,
    pub user_id: String,
    pub message_id: String,
    /// ISO-8601 UTC timestamp, plugin-clock.
    pub recalled_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Attachment {
    pub id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalDecision {
    Allow,
    Deny,
    AllowOnce,
    AllowAlways,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApprovalCallbackParams {
    pub auth: String,
    pub callback_token: String,
    pub decision: ApprovalDecision,
    pub user_id: String,
    pub decided_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LogWriteParams {
    pub auth: String,
    pub level: LogLevel,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<Value>,
}

/// Plugin advertises a tool to the host.
///
/// `name` is namespaced by the host as `plugin__<plugin_id>__<name>` when
/// surfaced to the engine to avoid collision with built-in or MCP tools.
/// `input_schema` is an arbitrary JSON Schema the engine forwards to the LLM.
///
/// In M1 the host accepts and ack's these (so the wire path is exercised)
/// but does not yet register them in `ToolRegistry`. Engine integration is
/// a follow-up; the protocol shape is stable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolAdvertiseParams {
    pub auth: String,
    pub name: String,
    pub description: String,
    /// JSON Schema for the tool's input. Pass-through to the LLM.
    pub input_schema: Value,
    /// Optional: declares this tool is read-only so approval can be skipped.
    #[serde(default)]
    pub is_read_only: bool,
}

/// Plugin advertises an IM slash-command handler.
///
/// When the host's dispatcher sees a message that matches `name`, it routes
/// to `command.invoke` instead of through the LLM.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandAdvertiseParams {
    pub auth: String,
    pub name: String,
    pub description: String,
    /// Optional usage hint shown to the user (e.g. `<arg1> <arg2>`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<String>,
}

/// Host invokes a plugin-supplied tool by name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolInvokeParams {
    pub name: String,
    pub arguments: Value,
}

/// Result of a `tool.invoke` call. `is_error` mirrors Anthropic's tool_result
/// `is_error` so engine-side conversion is direct.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolInvokeResult {
    pub content: String,
    #[serde(default)]
    pub is_error: bool,
}

/// Host invokes a plugin-supplied IM command.
///
/// `arguments` is the raw user text after the command name.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandInvokeParams {
    pub tenant_id: String,
    pub chat_id: String,
    pub user_id: String,
    pub name: String,
    pub arguments: String,
}

/// Plugin's reply for a `command.invoke`. Empty `reply` means no message
/// (the plugin handled it side-channel).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CommandInvokeResult {
    #[serde(default)]
    pub reply: String,
    #[serde(default)]
    pub is_error: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn message_received_roundtrips() {
        let p = MessageReceivedParams {
            auth: "tok".into(),
            tenant_id: "t1".into(),
            chat_id: "c1".into(),
            user_id: "u1".into(),
            message_id: "m1".into(),
            content: "hi".into(),
            mentions: vec!["@SNACA".into()],
            attachments: vec![],
            reply_to: None,
            received_at: "2026-05-06T08:00:00Z".into(),
        };
        let s = serde_json::to_string(&p).unwrap();
        let back: MessageReceivedParams = serde_json::from_str(&s).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn approval_decision_serialises_snake_case() {
        let s = serde_json::to_string(&ApprovalDecision::AllowAlways).unwrap();
        assert_eq!(s, "\"allow_always\"");
    }

    #[test]
    fn initialize_params_skip_optional_config() {
        let p = InitializeParams {
            protocol_version: "1.0".into(),
            config: None,
        };
        let s = serde_json::to_string(&p).unwrap();
        assert!(!s.contains("config"), "got {s}");
    }

    #[test]
    fn method_constants_are_strings_in_use() {
        assert_eq!(host_to_plugin::INITIALIZE, "initialize");
        assert_eq!(host_to_plugin::HEALTH_PING, "health.ping");
        assert_eq!(plugin_to_host::EVENT_MESSAGE_RECEIVED, "event.message_received");
    }

    #[test]
    fn message_send_params_minimal() {
        let p: MessageSendParams = serde_json::from_value(json!({
            "tenant_id": "t1",
            "chat_id": "c1",
            "content": "hello"
        }))
        .unwrap();
        assert_eq!(p.format, None);
        assert_eq!(p.reply_to, None);
    }
}
