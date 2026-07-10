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
    /// Present a structured multiple-choice question (1-4 questions, each
    /// with 2-4 options, optional Other) to the user via the plugin. The
    /// plugin renders an interactive card; the user's selection arrives
    /// later as `event.question_callback` keyed by `callback_token`.
    pub const QUESTION_PRESENT: &str = "question.present";
    /// Tell the plugin a previously-presented question is no longer
    /// answerable (host-side timeout / turn cancel). Plugin should
    /// finalize the card (replace interactive elements with a "已取消"
    /// / "已超时" note) and drop its local state for `callback_token`.
    /// Fire-and-forget from the host's perspective — the plugin acks
    /// but the host doesn't block on it.
    pub const QUESTION_CANCEL: &str = "question.cancel";
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
    /// User submitted an answer to a `question.present` card. Plugin sends
    /// this once per card (form submit on multi-question cards delivers
    /// all answers at once). Routed by `callback_token` to wake the
    /// pending `request_question` future in the supervisor's question
    /// registry.
    pub const EVENT_QUESTION_CALLBACK: &str = "event.question_callback";
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

/// One option in a [`Question`]. `id` is the stable wire identifier the
/// plugin echoes back in [`QuestionAnswer::selected_option_ids`]; `label`
/// is what the user sees on the card button / select item.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuestionOption {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Optional preview content (markdown) the plugin may render next to
    /// the option. Used for visual comparisons (code snippets, ASCII
    /// mockups). Plugins without preview support ignore this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

/// One question in a [`QuestionPresentParams`]. `id` is the stable wire
/// identifier (qid) the plugin echoes back in
/// [`QuestionAnswer::question_id`]; `question` is the user-facing prompt.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Question {
    pub id: String,
    pub question: String,
    /// Short label (~12 chars) the plugin may render as a chip/tag above
    /// the question. Optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    /// 2-4 options, IDs unique within this question.
    pub options: Vec<QuestionOption>,
    /// When true, render as multi-select (checkbox / multi-select picker)
    /// and accept multiple `selected_option_ids`. Default single-select.
    #[serde(default)]
    pub multi_select: bool,
    /// When true (default), the plugin appends an implicit "Other" choice
    /// that lets the user type free-form text. Answer is delivered via
    /// [`QuestionAnswer::other_text`].
    #[serde(default = "default_true")]
    pub allow_other: bool,
}

fn default_true() -> bool {
    true
}

/// Host -> plugin: present 1-4 structured multiple-choice questions to
/// the user. Plugin renders an interactive card (or falls back to text
/// for non-interactive channels) and eventually fires
/// `event.question_callback` carrying the matching `callback_token`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuestionPresentParams {
    pub tenant_id: String,
    pub chat_id: String,
    pub questions: Vec<Question>,
    pub callback_token: String,
    pub timeout_sec: u64,
}

/// Host -> plugin: cancel a previously-presented question. Plugin
/// should finalize the card (e.g. PATCH to "⏰ 已超时" / "❌ 已取消")
/// and forget any local state keyed by `callback_token`. Idempotent —
/// plugins should treat an unknown token as a no-op so a late cancel
/// after the user has already answered doesn't crash.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuestionCancelParams {
    pub tenant_id: String,
    pub chat_id: String,
    pub callback_token: String,
    /// Short human-readable reason rendered into the finalized card
    /// ("timeout", "turn cancelled", ...). Plugin may localise.
    #[serde(default)]
    pub reason: String,
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

/// One question's answer in a [`QuestionCallbackParams`]. `question_id`
/// matches the [`Question::id`] the host sent. For single-select
/// questions `selected_option_ids` holds 0 or 1 element; for multi-select
/// it may hold 0..N. When the user picked the "Other" affordance the
/// option ids are empty (or absent) and `other_text` carries the
/// free-form input.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuestionAnswer {
    pub question_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selected_option_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub other_text: Option<String>,
    /// Optional free-text annotation the user attached to this answer
    /// (e.g. a note explaining their choice). Reserved for future card
    /// UIs that surface a notes field; plugins without that affordance
    /// leave it unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

/// Plugin -> host: user finished answering a `question.present`. All
/// answers for the card's questions arrive in one notification (form
/// submit), keyed back to the host's pending future via
/// `callback_token`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuestionCallbackParams {
    pub auth: String,
    pub callback_token: String,
    pub answers: Vec<QuestionAnswer>,
    /// IM user who actually clicked submit. In group chats this is how
    /// the host attributes the answer; in DMs it equals the
    /// conversation's sole participant.
    pub user_id: String,
    /// ISO-8601 UTC timestamp, plugin-clock.
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
        assert_eq!(
            plugin_to_host::EVENT_MESSAGE_RECEIVED,
            "event.message_received"
        );
        assert_eq!(host_to_plugin::QUESTION_PRESENT, "question.present");
        assert_eq!(
            plugin_to_host::EVENT_QUESTION_CALLBACK,
            "event.question_callback"
        );
    }

    #[test]
    fn question_roundtrips_with_all_fields() {
        let p = QuestionPresentParams {
            tenant_id: "t1".into(),
            chat_id: "c1".into(),
            questions: vec![Question {
                id: "q_0".into(),
                question: "Pick one?".into(),
                header: Some("Choice".into()),
                options: vec![
                    QuestionOption {
                        id: "opt_0".into(),
                        label: "A".into(),
                        description: Some("first".into()),
                        preview: None,
                    },
                    QuestionOption {
                        id: "opt_1".into(),
                        label: "B".into(),
                        description: None,
                        preview: Some("```rust\nfn x() {}\n```".into()),
                    },
                ],
                multi_select: false,
                allow_other: true,
            }],
            callback_token: "tok-1".into(),
            timeout_sec: 300,
        };
        let s = serde_json::to_string(&p).unwrap();
        let back: QuestionPresentParams = serde_json::from_str(&s).unwrap();
        assert_eq!(p, back);
    }

    #[test]
    fn question_allow_other_defaults_true() {
        // `allow_other` is omitted on the wire — deserialization should
        // fall back to true so existing plugins keep the Other affordance.
        let raw = json!({
            "id": "q_0", "question": "?",
            "options": [{"id":"a","label":"A"}, {"id":"b","label":"B"}]
        });
        let q: Question = serde_json::from_value(raw).unwrap();
        assert!(q.allow_other);
        assert!(!q.multi_select);
    }

    #[test]
    fn question_cancel_roundtrips_and_constant_present() {
        assert_eq!(host_to_plugin::QUESTION_CANCEL, "question.cancel");
        let p = QuestionCancelParams {
            tenant_id: "t".into(),
            chat_id: "c".into(),
            callback_token: "tok".into(),
            reason: "timeout".into(),
        };
        let s = serde_json::to_string(&p).unwrap();
        let back: QuestionCancelParams = serde_json::from_str(&s).unwrap();
        assert_eq!(p, back);
        // Reason is `#[serde(default)]` — wire round-trip with empty
        // string must still work.
        let raw = json!({"tenant_id": "t", "chat_id": "c", "callback_token": "tok"});
        let parsed: QuestionCancelParams = serde_json::from_value(raw).unwrap();
        assert_eq!(parsed.reason, "");
    }

    #[test]
    fn question_callback_roundtrips() {
        let p = QuestionCallbackParams {
            auth: "tok".into(),
            callback_token: "cb-1".into(),
            answers: vec![
                QuestionAnswer {
                    question_id: "q_0".into(),
                    selected_option_ids: vec!["opt_1".into()],
                    other_text: None,
                    notes: None,
                },
                QuestionAnswer {
                    question_id: "q_1".into(),
                    selected_option_ids: vec![],
                    other_text: Some("free-form".into()),
                    notes: Some("note text".into()),
                },
            ],
            user_id: "u1".into(),
            decided_at: "2026-05-24T10:00:00Z".into(),
        };
        let s = serde_json::to_string(&p).unwrap();
        let back: QuestionCallbackParams = serde_json::from_str(&s).unwrap();
        assert_eq!(p, back);
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
