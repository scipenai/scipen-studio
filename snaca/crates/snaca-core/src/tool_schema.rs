//! [`ToolSchema`] — JSON-Schema-shaped tool description.
//!
//! Lives in `snaca-core` so both `snaca-llm` (which forwards the schema to
//! the provider) and `snaca-tools-api` (which builds it from a registered
//! `Tool`) can share one type without taking on each other's dependencies.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSchema {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}
