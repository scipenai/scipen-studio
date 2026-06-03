//! JSON-RPC 2.0 envelope.
//!
//! Untagged enum [`JsonRpcMessage`] handles all three message shapes
//! (request / response / notification) on a single deserialize, so callers
//! reading a stream can match on the variant without two-pass parsing.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// JSON-RPC request id. The spec allows string, number, or null.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(i64),
    String(String),
    Null,
}

impl RequestId {
    pub fn from_u64(n: u64) -> Self {
        Self::Number(n as i64)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: RequestId,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

impl JsonRpcRequest {
    pub fn new(id: RequestId, method: impl Into<String>, params: Option<Value>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            method: method.into(),
            params,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: RequestId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

impl JsonRpcResponse {
    pub fn ok(id: RequestId, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: RequestId, error: JsonRpcError) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(error),
        }
    }

    pub fn is_ok(&self) -> bool {
        self.error.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

impl JsonRpcNotification {
    pub fn new(method: impl Into<String>, params: Option<Value>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            method: method.into(),
            params,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl JsonRpcError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }

    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
}

/// Untagged union: a single byte-string deserialized as `JsonRpcMessage`
/// dispatches to the right variant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum JsonRpcMessage {
    /// Order matters: `Response` must precede `Request` because both have
    /// `id`, but a request also has `method` — serde's untagged matching
    /// would otherwise pick `Response` for a request payload. We instead
    /// put `Request` first and let `Response`'s missing `method` distinguish.
    Request(JsonRpcRequest),
    Response(JsonRpcResponse),
    Notification(JsonRpcNotification),
}

impl JsonRpcMessage {
    pub fn id(&self) -> Option<&RequestId> {
        match self {
            JsonRpcMessage::Request(r) => Some(&r.id),
            JsonRpcMessage::Response(r) => Some(&r.id),
            JsonRpcMessage::Notification(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_roundtrips() {
        let r = JsonRpcRequest::new(
            RequestId::Number(7),
            "message.send",
            Some(json!({"chat_id": "c1"})),
        );
        let s = serde_json::to_string(&r).unwrap();
        let back: JsonRpcRequest = serde_json::from_str(&s).unwrap();
        assert_eq!(r, back);
    }

    #[test]
    fn response_omits_unset_fields() {
        let r = JsonRpcResponse::ok(RequestId::Number(1), json!({"ok": true}));
        let s = serde_json::to_string(&r).unwrap();
        assert!(!s.contains("error"));
    }

    #[test]
    fn notification_has_no_id() {
        let n = JsonRpcNotification::new("event.message_received", Some(json!({})));
        let s = serde_json::to_string(&n).unwrap();
        assert!(!s.contains("\"id\""));
    }

    #[test]
    fn untagged_message_dispatches() {
        let req = json!({"jsonrpc": "2.0", "id": 1, "method": "x", "params": {}}).to_string();
        let resp = json!({"jsonrpc": "2.0", "id": 1, "result": {}}).to_string();
        let notif = json!({"jsonrpc": "2.0", "method": "y", "params": {}}).to_string();

        assert!(matches!(
            serde_json::from_str::<JsonRpcMessage>(&req).unwrap(),
            JsonRpcMessage::Request(_)
        ));
        assert!(matches!(
            serde_json::from_str::<JsonRpcMessage>(&resp).unwrap(),
            JsonRpcMessage::Response(_)
        ));
        assert!(matches!(
            serde_json::from_str::<JsonRpcMessage>(&notif).unwrap(),
            JsonRpcMessage::Notification(_)
        ));
    }

    #[test]
    fn error_response_carries_code() {
        let r = JsonRpcResponse::err(
            RequestId::Number(1),
            JsonRpcError::new(-32601, "method_not_found"),
        );
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains("-32601"));
        assert!(s.contains("method_not_found"));
        assert!(!s.contains("\"result\""));
    }
}
