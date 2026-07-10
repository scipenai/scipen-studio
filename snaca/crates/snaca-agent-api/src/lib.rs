//! `snaca-agent-api` — lightweight agent runtime contracts.
//!
//! This crate contains traits and DTOs that sit above `snaca-core` but below
//! concrete runtimes such as `snaca-engine` and concrete tool packs such as
//! `snaca-tools`. Keeping these contracts here lets tools, engines, servers,
//! and future SDK wrappers share interaction types without introducing
//! reverse dependencies between implementation crates.

pub mod approval;
pub mod memory;
pub mod question;
pub mod store;
pub mod workspace;

pub use approval::{
    ApprovalDecision, ApprovalError, ApprovalGate, ApprovalRequest, CountingGate,
    DenyAllApprovalGate, NoopApprovalGate,
};
pub use memory::{
    CompactReason, MemoryEntryData, MemoryIndexRequest, MemoryListRequest, MemoryProvider,
    MemoryProviderError, MemoryProviderSlot, MemoryReadRequest, MemoryWriteAction, MemoryWriteCtx,
    MemoryWriteRequest, PreCompactCtx, SessionSwitchCtx,
};
pub use question::{
    FixedQuestionGate, NoopQuestionGate, QuestionAnswer, QuestionAnswers, QuestionError,
    QuestionGate, QuestionGateSlot, QuestionOption, QuestionRequest, QuestionSpec,
};
pub use store::{
    ConversationMessage, ConversationStore, EnsureThread, HistoryQuery, InMemoryConversationStore,
    StoreError, StoreMessageResult, ToolCallCompletion, ToolCallStart,
};
pub use workspace::{WorkspaceProvider, WorkspaceProviderError, WorkspaceRequest};
