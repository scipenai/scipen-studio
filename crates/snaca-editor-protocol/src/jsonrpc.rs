//! JSON-RPC 2.0 envelope.
//!
//! Mirrors the structure of `snaca-channel-protocol::jsonrpc` but is kept
//! intentionally independent: the editor protocol may diverge (e.g.
//! `Content-Length` framing for big payloads) without coupling to IM.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// JSON-RPC request id. Spec allows string, number, or null.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum JsonRpcRequestId {
    Number(i64),
    String(String),
    Null,
}

impl JsonRpcRequestId {
    pub fn from_u64(n: u64) -> Self {
        Self::Number(n as i64)
    }

    pub fn from_uuid(uuid: &str) -> Self {
        Self::String(uuid.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: JsonRpcRequestId,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

impl JsonRpcRequest {
    pub fn new(id: JsonRpcRequestId, method: impl Into<String>, params: Option<Value>) -> Self {
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
    pub id: JsonRpcRequestId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

impl JsonRpcResponse {
    pub fn ok(id: JsonRpcRequestId, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: JsonRpcRequestId, error: JsonRpcError) -> Self {
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
///
/// Order is significant: `Request` must precede `Response` because both have
/// `id`, and a request additionally has `method`. Serde's untagged matcher
/// uses the first variant that fully deserializes; `Response`'s missing
/// `method` distinguishes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum JsonRpcMessage {
    Request(JsonRpcRequest),
    Response(JsonRpcResponse),
    Notification(JsonRpcNotification),
}

impl JsonRpcMessage {
    pub fn id(&self) -> Option<&JsonRpcRequestId> {
        match self {
            JsonRpcMessage::Request(r) => Some(&r.id),
            JsonRpcMessage::Response(r) => Some(&r.id),
            JsonRpcMessage::Notification(_) => None,
        }
    }

    pub fn method(&self) -> Option<&str> {
        match self {
            JsonRpcMessage::Request(r) => Some(r.method.as_str()),
            JsonRpcMessage::Notification(n) => Some(n.method.as_str()),
            JsonRpcMessage::Response(_) => None,
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
            JsonRpcRequestId::Number(7),
            "chat.send",
            Some(json!({"content": "hi"})),
        );
        let s = serde_json::to_string(&r).unwrap();
        let back: JsonRpcRequest = serde_json::from_str(&s).unwrap();
        assert_eq!(r, back);
    }

    #[test]
    fn response_omits_unset_fields() {
        let r = JsonRpcResponse::ok(JsonRpcRequestId::Number(1), json!({"ok": true}));
        let s = serde_json::to_string(&r).unwrap();
        assert!(!s.contains("error"));
    }

    #[test]
    fn notification_has_no_id() {
        let n = JsonRpcNotification::new("turn.delta", Some(json!({})));
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
    fn message_id_helper() {
        let req = JsonRpcMessage::Request(JsonRpcRequest::new(
            JsonRpcRequestId::Number(3),
            "x",
            None,
        ));
        assert_eq!(req.id(), Some(&JsonRpcRequestId::Number(3)));

        let notif =
            JsonRpcMessage::Notification(JsonRpcNotification::new("y", None));
        assert_eq!(notif.id(), None);
    }
}
