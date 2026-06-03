//! `ToolRegistry` — tool lookup + LLM-facing schema export.
//!
//! Tools are stored as `Arc<dyn Tool>`. Schemas are computed once at build
//! time and cached so repeated `to_api_tools()` calls don't re-serialize.

use crate::tool::Tool;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Clone)]
pub struct ToolRegistry {
    tools: Arc<HashMap<String, Arc<dyn Tool>>>,
    schemas: Arc<Vec<ToolSchema>>,
}

impl ToolRegistry {
    pub fn builder() -> ToolRegistryBuilder {
        ToolRegistryBuilder::default()
    }

    pub fn empty() -> Self {
        Self::builder().build()
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).cloned()
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.tools.keys().map(String::as_str)
    }

    pub fn schemas(&self) -> &[ToolSchema] {
        &self.schemas
    }

    pub fn len(&self) -> usize {
        self.tools.len()
    }

    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }
}

#[derive(Default)]
pub struct ToolRegistryBuilder {
    tools: HashMap<String, Arc<dyn Tool>>,
}

impl ToolRegistryBuilder {
    /// Builder-style accumulator for `Tool` impls. Named `add` so call
    /// sites read `builder.add(t1).add(t2).build()`; clippy's
    /// `should_implement_trait` lint mistakes this for `std::ops::Add`
    /// — silenced here because the builder API is established and
    /// renaming would churn every internal/test call site.
    #[allow(clippy::should_implement_trait)]
    pub fn add<T: Tool + 'static>(mut self, tool: T) -> Self {
        self.tools.insert(tool.name().to_string(), Arc::new(tool));
        self
    }

    pub fn add_arc(mut self, tool: Arc<dyn Tool>) -> Self {
        self.tools.insert(tool.name().to_string(), tool);
        self
    }

    pub fn build(self) -> ToolRegistry {
        let mut schemas: Vec<ToolSchema> = self
            .tools
            .values()
            .map(|t| ToolSchema {
                name: t.name().to_string(),
                description: t.description().to_string(),
                input_schema: t.input_schema(),
            })
            .collect();
        schemas.sort_by(|a, b| a.name.cmp(&b.name));
        ToolRegistry {
            tools: Arc::new(self.tools),
            schemas: Arc::new(schemas),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::ToolContext;
    use crate::error::ToolResult;
    use crate::output::ToolOutput;
    use crate::tool::{ApprovalRequirement, Tool, ToolCapabilities};
    use async_trait::async_trait;
    use serde_json::json;
    use snaca_core::{ProjectId, SessionId, TenantId};
    use std::path::PathBuf;

    struct EchoTool;
    #[async_trait]
    impl Tool for EchoTool {
        fn name(&self) -> &str {
            "echo"
        }
        fn description(&self) -> &str {
            "echo input"
        }
        fn input_schema(&self) -> Value {
            json!({"type": "object"})
        }
        fn capabilities(&self) -> ToolCapabilities {
            ToolCapabilities::default()
        }
        fn approval_requirement(&self) -> ApprovalRequirement {
            ApprovalRequirement::Never
        }
        async fn execute(&self, input: Value, _ctx: &ToolContext) -> ToolResult {
            Ok(ToolOutput::json(input))
        }
    }

    fn ctx() -> ToolContext {
        ToolContext::new(
            TenantId::new("t"),
            ProjectId::from_raw("p"),
            SessionId::new(),
            PathBuf::from("/tmp"),
        )
    }

    #[tokio::test]
    async fn registry_executes_registered_tool() {
        let reg = ToolRegistry::builder().add(EchoTool).build();
        let tool = reg.get("echo").unwrap();
        let out = tool.execute(json!({"a": 1}), &ctx()).await.unwrap();
        match out {
            ToolOutput::Json(v) => assert_eq!(v, json!({"a": 1})),
            _ => panic!("expected json output"),
        }
    }

    #[test]
    fn registry_schemas_sorted_and_complete() {
        let reg = ToolRegistry::builder().add(EchoTool).build();
        assert_eq!(reg.len(), 1);
        let schemas = reg.schemas();
        assert_eq!(schemas[0].name, "echo");
        assert!(schemas[0].input_schema.is_object());
    }

    #[test]
    fn empty_registry_works() {
        let reg = ToolRegistry::empty();
        assert!(reg.is_empty());
        assert!(reg.get("anything").is_none());
    }
}
