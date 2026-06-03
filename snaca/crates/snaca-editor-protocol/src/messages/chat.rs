//! `chat.send` — the Ctrl+L path.

use crate::types::{Attachment, ChatContext};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatSendParams {
    pub session_id: String,
    pub thread_id: String,
    pub content: String,
    pub context: ChatContext,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Attachment>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatSendResult {
    pub turn_id: String,
}
