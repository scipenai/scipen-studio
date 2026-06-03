//! Plugin manifest returned from `initialize`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub protocol_version: String,
    pub plugin: PluginInfo,
    /// Human-readable hint about how `tenant_id` is sourced. SNACA does not
    /// parse this — it is for operators inspecting plugin behavior.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tenant_id_format: Option<String>,
    pub capabilities: ChannelCapabilities,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ChannelCapabilities {
    #[serde(default)]
    pub send_message: bool,
    #[serde(default)]
    pub update_message: bool,
    #[serde(default)]
    pub send_card: bool,
    #[serde(default)]
    pub interactive_card: bool,
    #[serde(default)]
    pub file_upload: bool,
    #[serde(default)]
    pub file_download: bool,
    /// 0 means "no limit declared" — host should treat as 30 KB conservative
    /// default to be safe.
    #[serde(default)]
    pub max_message_bytes: u64,
    #[serde(default)]
    pub supports_thread: bool,
    #[serde(default)]
    pub supports_streaming: bool,
}

impl ChannelCapabilities {
    /// Sensible defaults for a minimal text-only plugin.
    pub fn minimal() -> Self {
        Self {
            send_message: true,
            update_message: false,
            send_card: false,
            interactive_card: false,
            file_upload: false,
            file_download: false,
            max_message_bytes: 30_720,
            supports_thread: false,
            supports_streaming: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn manifest_uses_camelcase_top_level_fields() {
        let m = PluginManifest {
            protocol_version: "1.0".into(),
            plugin: PluginInfo {
                name: "lark".into(),
                version: "0.1.0".into(),
            },
            tenant_id_format: Some("lark.tenant_key".into()),
            capabilities: ChannelCapabilities::minimal(),
        };
        let v = serde_json::to_value(&m).unwrap();
        assert!(v.get("protocolVersion").is_some(), "expected camelCase 'protocolVersion'");
        assert!(v.get("tenantIdFormat").is_some());
    }

    #[test]
    fn capabilities_use_snake_case() {
        let c = ChannelCapabilities::minimal();
        let v = serde_json::to_value(&c).unwrap();
        assert!(v.get("send_message").is_some());
        assert!(v.get("max_message_bytes").is_some());
    }

    #[test]
    fn manifest_parses_minimal_form() {
        let raw = json!({
            "protocolVersion": "1.0",
            "plugin": {"name": "x", "version": "0.0.1"},
            "capabilities": {}
        });
        let m: PluginManifest = serde_json::from_value(raw).unwrap();
        assert_eq!(m.plugin.name, "x");
        assert!(!m.capabilities.send_message);
    }
}
