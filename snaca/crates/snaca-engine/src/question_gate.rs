//! Question gating re-exports.
//!
//! The stable interaction contracts live in `snaca-agent-api` so tools and
//! embedders do not need to depend on `snaca-engine`. This module preserves
//! the historical `snaca_engine::question_gate::*` path.

pub use snaca_agent_api::question::*;
