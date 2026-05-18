//! `turn.delta` (SNACA → host streaming) and `turn.cancel` (host → SNACA).

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TurnDeltaParams {
    pub turn_id: String,
    /// Monotonically increasing within a turn; host orders by this.
    pub seq: u64,
    #[serde(flatten)]
    pub kind: TurnDeltaKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TurnDeltaKind {
    /// Appendable assistant text.
    Text { text: String },
    /// Appendable reasoning text (for reasoning models).
    Thinking { text: String },
    /// A tool call beginning.
    ToolUse {
        tool_call_id: String,
        tool: String,
        args: Value,
    },
    /// Progress message during long-running tool execution.
    ToolProgress {
        tool_call_id: String,
        message: String,
    },
    /// Final tool result.
    ToolResult {
        tool_call_id: String,
        ok: bool,
        content: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        truncated: Option<bool>,
    },
    /// Turn finished.
    Done {
        reason: DoneReason,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cancelled: Option<bool>,
    },
    /// Turn aborted with an error.
    Error {
        code: i32,
        message: String,
        recoverable: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DoneReason {
    Completed,
    Cancelled,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TurnCancelParams {
    pub turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn turn_delta_text_serializes_flat() {
        let p = TurnDeltaParams {
            turn_id: "tu-1".into(),
            seq: 0,
            kind: TurnDeltaKind::Text {
                text: "hi".into(),
            },
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["kind"], "text");
        assert_eq!(v["text"], "hi");
        assert_eq!(v["seq"], 0);
    }

    #[test]
    fn turn_delta_tool_use_carries_args() {
        let p = TurnDeltaParams {
            turn_id: "tu-1".into(),
            seq: 1,
            kind: TurnDeltaKind::ToolUse {
                tool_call_id: "tc-1".into(),
                tool: "Read".into(),
                args: json!({"path": "a.tex"}),
            },
        };
        let s = serde_json::to_string(&p).unwrap();
        assert!(s.contains("\"kind\":\"tool_use\""));
        assert!(s.contains("\"tool\":\"Read\""));
    }

    #[test]
    fn done_optional_cancelled() {
        let p = TurnDeltaParams {
            turn_id: "tu-1".into(),
            seq: 9,
            kind: TurnDeltaKind::Done {
                reason: DoneReason::Cancelled,
                cancelled: Some(true),
            },
        };
        let v = serde_json::to_value(&p).unwrap();
        assert_eq!(v["reason"], "cancelled");
        assert_eq!(v["cancelled"], true);
    }
}
