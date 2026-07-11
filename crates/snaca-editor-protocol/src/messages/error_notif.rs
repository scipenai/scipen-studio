//! `error` notification — non-turn-scoped error broadcast.
//!
//! Used for LLM auth failures, SQLite outages, etc. Turn-scoped errors flow
//! through `turn.delta { kind: error }` instead.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorNotificationParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    pub recoverable: bool,
}
