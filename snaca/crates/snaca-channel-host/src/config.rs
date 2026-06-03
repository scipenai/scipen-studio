//! Plugin configuration.
//!
//! Each registered plugin is described by a `PluginConfig` — used by the
//! supervisor to spawn the child process and pass plugin-specific
//! configuration through `initialize`.

use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct PluginConfig {
    /// Logical name (used in logs, routing, admin API). Distinct from the
    /// plugin's self-reported name in its manifest, which is informational.
    pub name: String,
    /// Executable path or command in PATH.
    pub command: String,
    /// CLI arguments.
    pub args: Vec<String>,
    /// Environment variables passed to the child process. The supervisor
    /// also injects `SNACA_PLUGIN_TOKEN` automatically; user-supplied entries
    /// of that name are overridden.
    pub env: HashMap<String, String>,
    /// Working directory for the child process. `None` = inherit.
    pub cwd: Option<PathBuf>,
    /// Plugin-specific configuration passed in `initialize.params.config`.
    pub plugin_config: Option<Value>,
}

impl PluginConfig {
    pub fn builder(name: impl Into<String>, command: impl Into<String>) -> PluginConfigBuilder {
        PluginConfigBuilder {
            inner: PluginConfig {
                name: name.into(),
                command: command.into(),
                args: vec![],
                env: HashMap::new(),
                cwd: None,
                plugin_config: None,
            },
        }
    }
}

pub struct PluginConfigBuilder {
    inner: PluginConfig,
}

impl PluginConfigBuilder {
    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.inner.args.push(arg.into());
        self
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.inner.args.extend(args.into_iter().map(Into::into));
        self
    }

    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.inner.env.insert(key.into(), value.into());
        self
    }

    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.inner.cwd = Some(cwd.into());
        self
    }

    pub fn plugin_config(mut self, value: Value) -> Self {
        self.inner.plugin_config = Some(value);
        self
    }

    pub fn build(self) -> PluginConfig {
        self.inner
    }
}
