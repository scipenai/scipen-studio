//! `init`, `shutdown`, `health.ping`, `config.reload`.

use crate::types::{HostCapabilities, SnacaCapabilities, SnacaConfig};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InitParams {
    pub protocol_version: String,
    pub host: HostInfo,
    pub snaca_config: SnacaConfig,
    pub host_caps: HostCapabilities,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InitResult {
    pub protocol_version: String,
    pub engine_version: String,
    pub capabilities: SnacaCapabilities,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShutdownParams {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShutdownResult {
    pub ok: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HealthPingParams {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HealthPingResult {
    pub pong: bool,
    pub engine_uptime_secs: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConfigReloadParams {
    pub snaca_config: SnacaConfig,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ConfigReloadResult {
    pub applied: bool,
    pub restart_required: bool,
}
