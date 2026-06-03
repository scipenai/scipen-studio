//! Plugin → host inbound events, after auth check and parameter parsing.

use serde_json::Value;
use snaca_channel_protocol::methods::{
    ApprovalCallbackParams, LogWriteParams, MessageReceivedParams, MessageRecalledParams,
};

#[derive(Debug, Clone)]
pub enum InboundEvent {
    /// User sent a message in IM.
    MessageReceived {
        plugin: String,
        params: MessageReceivedParams,
    },

    /// User recalled (retracted) a previously-sent message. Host
    /// aborts the in-flight turn on the corresponding thread.
    MessageRecalled {
        plugin: String,
        params: MessageRecalledParams,
    },

    /// User clicked a button on a previously-sent approval card.
    ApprovalCallback {
        plugin: String,
        params: ApprovalCallbackParams,
    },

    /// Plugin reported an internal error (e.g. lost connection).
    PluginError {
        plugin: String,
        severity: String,
        message: String,
        data: Option<Value>,
    },

    /// Plugin forwarded a structured log line.
    Log {
        plugin: String,
        params: LogWriteParams,
    },

    /// Plugin sent a method we don't recognize. Surfaced for observability so
    /// operators can spot protocol-version skew.
    Unknown {
        plugin: String,
        method: String,
        params: Option<Value>,
    },
}

impl InboundEvent {
    pub fn plugin_name(&self) -> &str {
        match self {
            InboundEvent::MessageReceived { plugin, .. }
            | InboundEvent::MessageRecalled { plugin, .. }
            | InboundEvent::ApprovalCallback { plugin, .. }
            | InboundEvent::PluginError { plugin, .. }
            | InboundEvent::Log { plugin, .. }
            | InboundEvent::Unknown { plugin, .. } => plugin,
        }
    }
}
