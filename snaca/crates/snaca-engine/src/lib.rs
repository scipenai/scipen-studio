//! `snaca-engine` — agent runtime.
//!
//! Owns the *turn loop*: receive a user message, ask the LLM, dispatch any
//! requested tool calls, feed the results back, and keep going until the
//! model stops with a terminal reason.
//!
//! M1 scope:
//! - non-streaming round trips (delegated to [`snaca_llm::LlmClient`])
//! - tool execution via [`snaca_tools_api::ToolRegistry`]
//! - SQLite persistence of every message + tool call ([`snaca_state::Database`])
//! - per-tenant/project workspace cwd ([`snaca_workspace::WorkspaceLayout`])
//! - hard cap on iterations to prevent runaway loops
//!
//! M2 will add: compaction, LoopGuard (anti-infinite-tool-loop heuristic),
//! capacity controller, approval state machine, streaming output.

pub mod approval;
pub mod config;
pub mod engine;
pub mod error;
pub mod listener;
pub mod loop_guard;
pub mod memory_extractor;
pub mod reranker;
pub mod tools_factory;

pub use approval::{
    ApprovalDecision, ApprovalError, ApprovalGate, ApprovalRequest, CountingGate,
    DenyAllApprovalGate, NoopApprovalGate,
};
pub use config::EngineConfig;
pub use engine::{Engine, TurnOutcome, TurnRequest};
pub use error::{EngineError, EngineResult};
pub use listener::{NoopListener, RecordingListener, TurnEventListener};
pub use loop_guard::{LoopGuard, LoopGuardConfig};
pub use memory_extractor::{
    ConstantExtractor, FilteredMemoryExtractor, LlmMemoryExtractor, MemoryExtractor,
    MemoryProposal, SensitiveFilter, SharedExtractor,
};
pub use reranker::{IdentityReranker, LlmReranker, RerankCandidate, Reranker, SharedReranker};
pub use tools_factory::RuntimeToolFactory;
