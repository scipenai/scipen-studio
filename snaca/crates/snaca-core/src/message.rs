//! Conversation messages.
//!
//! [`Message`] is the canonical conversation unit — a [`Role`] plus an ordered
//! list of [`crate::ContentBlock`]s. Stored as-is in `snaca-state`; LLM
//! providers convert into provider-native shapes at the boundary.

use crate::content::ContentBlock;
use crate::ids::MessageId;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    /// Synthetic role for tool result envelopes — Anthropic packages tool
    /// results as user-role messages, but we keep them logically tagged so
    /// the engine can route them correctly.
    Tool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub id: MessageId,
    pub role: Role,
    pub content: Vec<ContentBlock>,
    pub created_at: DateTime<Utc>,
}

impl Message {
    pub fn new(role: Role, content: Vec<ContentBlock>) -> Self {
        Self {
            id: MessageId::new(),
            role,
            content,
            created_at: Utc::now(),
        }
    }

    pub fn user_text(text: impl Into<String>) -> Self {
        Self::new(Role::User, vec![ContentBlock::text(text)])
    }

    pub fn assistant_text(text: impl Into<String>) -> Self {
        Self::new(Role::Assistant, vec![ContentBlock::text(text)])
    }

    pub fn system_text(text: impl Into<String>) -> Self {
        Self::new(Role::System, vec![ContentBlock::text(text)])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_message_has_text_content() {
        let m = Message::user_text("hi");
        assert!(matches!(m.role, Role::User));
        assert_eq!(m.content.len(), 1);
        assert!(matches!(&m.content[0], ContentBlock::Text { text } if text == "hi"));
    }

    #[test]
    fn role_serialises_lowercase() {
        let json = serde_json::to_string(&Role::Assistant).unwrap();
        assert_eq!(json, "\"assistant\"");
    }
}
