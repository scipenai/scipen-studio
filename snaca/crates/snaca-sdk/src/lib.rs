//! `snaca-sdk` — public facade for embedding SNACA as an agent runtime.
//!
//! This crate gives Rust applications a compact entry point while the
//! lower-level crates continue to host the actual implementations. The first
//! SDK layer is intentionally thin: it wraps `snaca-engine` without changing
//! server behavior, re-exports the stable contracts most applications need,
//! and provides safe starter presets.

use async_trait::async_trait;
use snaca_agent_api::{NoopApprovalGate, NoopQuestionGate};
use snaca_engine::{Engine, EngineConfig, NoopListener, TurnEventListener, TurnRequest};
use snaca_llm::{ContentDelta as LlmDelta, LlmClient};
use snaca_state::{Database, SqliteConversationStore};
use snaca_workspace::{LocalWorkspaceProvider, WorkspaceLayout};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::mpsc;

#[cfg(any(feature = "channel-protocol", feature = "channel-host"))]
pub mod channel;
pub mod config;
pub mod llm;
pub mod memory;
pub mod runtime;
pub mod store;
pub mod tools;
pub mod workspace;

pub use config::{AgentConfig, AgentToolPreset, AgentWorkspaceConfig};
pub use runtime::EngineRuntimeBuilder;
pub use snaca_agent_api::{
    ApprovalDecision, ApprovalError, ApprovalGate, ApprovalRequest, ConversationMessage,
    ConversationStore, EnsureThread, HistoryQuery, InMemoryConversationStore, MemoryEntryData,
    MemoryIndexRequest, MemoryListRequest, MemoryProvider, MemoryProviderError, MemoryProviderSlot,
    MemoryReadRequest, MemoryWriteRequest, QuestionAnswer, QuestionAnswers, QuestionError,
    QuestionGate, QuestionOption, QuestionRequest, QuestionSpec, StoreError, StoreMessageResult,
    ToolCallCompletion, ToolCallStart, WorkspaceProvider, WorkspaceProviderError, WorkspaceRequest,
};
pub use snaca_core::{
    ContentBlock, Message, MessageId, ProjectId, Role, SessionId, TenantId, ThreadId, ToolSchema,
    ToolUseId, Usage,
};
pub use snaca_engine::{
    MemoryExtractor, RuntimeToolFactory, SharedExtractor, TurnOutcome,
    TurnRequest as EngineTurnRequest,
};
pub use snaca_llm::{
    AnthropicClient, ContentBlockStart, ContentDelta, DeepSeekClient, LlmClient as LlmClientTrait,
    LlmError, LlmResult, MessageRequest, MessageResponse, ProviderCaps, RetryConfig,
    RetryingLlmClient, StopReason, StreamEvent,
};
pub use snaca_tools_api::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolError, ToolOutput, ToolRegistry,
    ToolResult,
};

pub type Result<T> = std::result::Result<T, SdkError>;

#[derive(Debug, thiserror::Error)]
pub enum SdkError {
    #[error("missing required builder field: {0}")]
    MissingField(&'static str),

    #[error("data root must be absolute: {0}")]
    DataRootNotAbsolute(PathBuf),

    #[error(transparent)]
    Llm(#[from] snaca_llm::LlmError),

    #[error(transparent)]
    State(#[from] snaca_state::StateError),

    #[error(transparent)]
    Workspace(#[from] snaca_workspace::WorkspaceError),

    #[error("runtime build failed: {0}")]
    Runtime(String),

    #[error(transparent)]
    Engine(#[from] snaca_engine::EngineError),

    #[error("environment variable {name} is not set")]
    MissingEnv { name: &'static str },
}

/// Embedded agent facade. Clone is cheap; it clones an `Arc` to the runtime.
#[derive(Clone)]
pub struct Agent {
    engine: Arc<Engine>,
    defaults: AgentDefaults,
}

#[derive(Debug, Clone)]
struct AgentDefaults {
    tenant_id: TenantId,
    project_id: ProjectId,
    thread_id: ThreadId,
}

impl Agent {
    pub async fn run(&self, input: impl Into<AgentInput>) -> Result<AgentOutput> {
        let input = input.into().with_defaults(&self.defaults);
        let outcome = self
            .engine
            .handle_turn_full(
                TurnRequest {
                    tenant_id: input.tenant_id,
                    project_id: input.project_id,
                    thread_id: input.thread_id,
                    user_text: input.text,
                    message_id: input.message_id,
                    ephemeral_system: None,
                },
                Arc::new(NoopApprovalGate),
                Arc::new(NoopListener),
                Arc::new(NoopQuestionGate),
            )
            .await?;
        Ok(AgentOutput::from(outcome))
    }

    /// Run a turn and receive every low-level LLM stream event followed by a
    /// final [`AgentOutput`].
    ///
    /// Dropping the returned stream stops delivery to the caller; the in-flight
    /// engine turn is allowed to finish normally.
    pub fn stream(&self, input: impl Into<AgentInput>) -> AgentStream {
        let input = input.into().with_defaults(&self.defaults);
        let engine = Arc::clone(&self.engine);
        let (tx, rx) = mpsc::channel(128);
        let listener = Arc::new(SdkStreamListener { tx: tx.clone() });

        tokio::spawn(async move {
            let result = engine
                .handle_turn_full(
                    TurnRequest {
                        tenant_id: input.tenant_id,
                        project_id: input.project_id,
                        thread_id: input.thread_id,
                        user_text: input.text,
                        message_id: input.message_id,
                        ephemeral_system: None,
                    },
                    Arc::new(NoopApprovalGate),
                    listener,
                    Arc::new(NoopQuestionGate),
                )
                .await
                .map(AgentOutput::from)
                .map(AgentStreamEvent::Completed)
                .map_err(SdkError::from);

            let _ = tx.send(result).await;
        });

        AgentStream { rx }
    }

    /// Access the underlying engine for advanced integrations that have not
    /// yet been lifted into the SDK facade.
    pub fn engine(&self) -> &Engine {
        self.engine.as_ref()
    }
}

#[derive(Debug)]
pub enum AgentStreamEvent {
    Llm(StreamEvent),
    Completed(AgentOutput),
}

impl AgentStreamEvent {
    pub fn as_llm_event(&self) -> Option<&StreamEvent> {
        match self {
            Self::Llm(event) => Some(event),
            Self::Completed(_) => None,
        }
    }

    pub fn text_delta(&self) -> Option<&str> {
        match self {
            Self::Llm(StreamEvent::ContentBlockDelta {
                delta: LlmDelta::Text { text },
                ..
            }) => Some(text.as_str()),
            _ => None,
        }
    }

    pub fn into_text_delta(self) -> Option<String> {
        match self {
            Self::Llm(StreamEvent::ContentBlockDelta {
                delta: LlmDelta::Text { text },
                ..
            }) => Some(text),
            _ => None,
        }
    }

    pub fn thinking_delta(&self) -> Option<&str> {
        match self {
            Self::Llm(StreamEvent::ContentBlockDelta {
                delta: LlmDelta::Thinking { text },
                ..
            }) => Some(text.as_str()),
            _ => None,
        }
    }

    pub fn into_thinking_delta(self) -> Option<String> {
        match self {
            Self::Llm(StreamEvent::ContentBlockDelta {
                delta: LlmDelta::Thinking { text },
                ..
            }) => Some(text),
            _ => None,
        }
    }
}

pub struct AgentStream {
    rx: mpsc::Receiver<Result<AgentStreamEvent>>,
}

impl AgentStream {
    pub async fn next(&mut self) -> Option<Result<AgentStreamEvent>> {
        self.rx.recv().await
    }
}

struct SdkStreamListener {
    tx: mpsc::Sender<Result<AgentStreamEvent>>,
}

#[async_trait]
impl TurnEventListener for SdkStreamListener {
    async fn on_event(&self, event: &StreamEvent) {
        let _ = self.tx.send(Ok(AgentStreamEvent::Llm(event.clone()))).await;
    }
}

#[derive(Debug, Clone)]
pub struct AgentInput {
    pub text: String,
    pub tenant_id: Option<TenantId>,
    pub project_id: Option<ProjectId>,
    pub thread_id: Option<ThreadId>,
    pub message_id: Option<String>,
}

impl AgentInput {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            tenant_id: None,
            project_id: None,
            thread_id: None,
            message_id: None,
        }
    }

    pub fn tenant_id(mut self, tenant_id: TenantId) -> Self {
        self.tenant_id = Some(tenant_id);
        self
    }

    pub fn project_id(mut self, project_id: ProjectId) -> Self {
        self.project_id = Some(project_id);
        self
    }

    pub fn thread_id(mut self, thread_id: ThreadId) -> Self {
        self.thread_id = Some(thread_id);
        self
    }

    pub fn message_id(mut self, message_id: impl Into<String>) -> Self {
        self.message_id = Some(message_id.into());
        self
    }

    fn with_defaults(self, defaults: &AgentDefaults) -> ResolvedAgentInput {
        ResolvedAgentInput {
            text: self.text,
            tenant_id: self.tenant_id.unwrap_or_else(|| defaults.tenant_id.clone()),
            project_id: self
                .project_id
                .unwrap_or_else(|| defaults.project_id.clone()),
            thread_id: self.thread_id.unwrap_or_else(|| defaults.thread_id.clone()),
            message_id: self.message_id,
        }
    }
}

impl From<&str> for AgentInput {
    fn from(value: &str) -> Self {
        Self::new(value)
    }
}

impl From<String> for AgentInput {
    fn from(value: String) -> Self {
        Self::new(value)
    }
}

#[derive(Debug, Clone)]
struct ResolvedAgentInput {
    text: String,
    tenant_id: TenantId,
    project_id: ProjectId,
    thread_id: ThreadId,
    message_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AgentOutput {
    pub text: String,
    pub outcome: TurnOutcome,
}

impl From<TurnOutcome> for AgentOutput {
    fn from(outcome: TurnOutcome) -> Self {
        Self {
            text: outcome.assistant_text.clone(),
            outcome,
        }
    }
}

#[derive(Default)]
pub struct AgentBuilder {
    llm: Option<Arc<dyn LlmClient>>,
    tools: Option<ToolRegistry>,
    state: Option<Database>,
    conversation_store: Option<SqliteConversationStore>,
    data_root: Option<PathBuf>,
    workspace_provider: Option<LocalWorkspaceProvider>,
    config: Option<EngineConfig>,
    memory_provider: Option<Arc<dyn MemoryProvider>>,
    tenant_id: Option<TenantId>,
    project_id: Option<ProjectId>,
    thread_id: Option<ThreadId>,
}

impl AgentBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_config(config: AgentConfig) -> Result<Self> {
        let mut builder = Self::new()
            .tenant_id(config.tenant_id)
            .project_id(config.project_id)
            .thread_id(config.thread_id);
        builder = match config.tool_preset {
            AgentToolPreset::Empty => builder.no_tools(),
            AgentToolPreset::ReadOnly => builder.read_only_tools(),
            AgentToolPreset::Coding => builder.coding_tools(),
            AgentToolPreset::Web => builder.tools(tools::web()),
        };
        builder = match config.workspace {
            AgentWorkspaceConfig::DefaultDataRoot => builder,
            AgentWorkspaceConfig::DataRoot(root) => builder.data_root(root),
            AgentWorkspaceConfig::SingleProject(root) => builder.single_project_workspace(root)?,
        };
        if let Some(engine) = config.engine {
            builder = builder.engine_config(engine);
        }
        Ok(builder)
    }

    pub fn llm(mut self, llm: impl LlmClient + 'static) -> Self {
        self.llm = Some(Arc::new(llm));
        self
    }

    pub fn llm_arc(mut self, llm: Arc<dyn LlmClient>) -> Self {
        self.llm = Some(llm);
        self
    }

    pub fn tools(mut self, tools: ToolRegistry) -> Self {
        self.tools = Some(tools);
        self
    }

    pub fn no_tools(mut self) -> Self {
        self.tools = Some(ToolRegistry::empty());
        self
    }

    pub fn read_only_tools(mut self) -> Self {
        self.tools = Some(tools::read_only());
        self
    }

    pub fn coding_tools(mut self) -> Self {
        self.tools = Some(tools::coding());
        self
    }

    pub fn store(mut self, state: Database) -> Self {
        self.conversation_store = Some(SqliteConversationStore::new(state.clone()));
        self.state = Some(state);
        self
    }

    pub async fn sqlite_store(mut self, path: impl AsRef<Path>) -> Result<Self> {
        let state = Database::open(path).await?;
        self.conversation_store = Some(SqliteConversationStore::new(state.clone()));
        self.state = Some(state);
        Ok(self)
    }

    pub async fn in_memory_store(mut self) -> Result<Self> {
        let state = Database::open_in_memory().await?;
        self.conversation_store = Some(SqliteConversationStore::new(state.clone()));
        self.state = Some(state);
        Ok(self)
    }

    pub fn data_root(mut self, data_root: impl Into<PathBuf>) -> Self {
        self.data_root = Some(data_root.into());
        self
    }

    pub fn local_workspace(mut self, provider: LocalWorkspaceProvider) -> Self {
        self.workspace_provider = Some(provider);
        self
    }

    pub fn single_project_workspace(mut self, root: impl Into<PathBuf>) -> Result<Self> {
        self.workspace_provider = Some(workspace::single_project(root)?);
        Ok(self)
    }

    pub fn engine_config(mut self, config: EngineConfig) -> Self {
        self.config = Some(config);
        self
    }

    pub fn memory_provider(mut self, provider: impl MemoryProvider + 'static) -> Self {
        self.memory_provider = Some(Arc::new(provider));
        self
    }

    pub fn memory_provider_arc(mut self, provider: Arc<dyn MemoryProvider>) -> Self {
        self.memory_provider = Some(provider);
        self
    }

    pub fn tenant_id(mut self, tenant_id: TenantId) -> Self {
        self.tenant_id = Some(tenant_id);
        self
    }

    pub fn project_id(mut self, project_id: ProjectId) -> Self {
        self.project_id = Some(project_id);
        self
    }

    pub fn thread_id(mut self, thread_id: ThreadId) -> Self {
        self.thread_id = Some(thread_id);
        self
    }

    pub fn minimal_agent_defaults(mut self) -> Self {
        self.tools.get_or_insert_with(ToolRegistry::empty);
        self.tenant_id
            .get_or_insert_with(|| TenantId::new("default"));
        self.project_id
            .get_or_insert_with(|| ProjectId::from_raw("default"));
        self.thread_id
            .get_or_insert_with(|| ThreadId::new("default"));
        self
    }

    pub fn read_only_agent_defaults(mut self) -> Self {
        self.tools.get_or_insert_with(tools::read_only);
        self.tenant_id
            .get_or_insert_with(|| TenantId::new("default"));
        self.project_id
            .get_or_insert_with(|| ProjectId::from_raw("default"));
        self.thread_id
            .get_or_insert_with(|| ThreadId::new("default"));
        self
    }

    pub fn coding_agent_defaults(mut self) -> Self {
        self.tools.get_or_insert_with(tools::coding);
        self.tenant_id
            .get_or_insert_with(|| TenantId::new("default"));
        self.project_id
            .get_or_insert_with(|| ProjectId::from_raw("default"));
        self.thread_id
            .get_or_insert_with(|| ThreadId::new("default"));
        self
    }

    pub async fn build(self) -> Result<Agent> {
        let AgentBuilder {
            llm,
            tools,
            state,
            conversation_store,
            data_root,
            workspace_provider,
            config,
            memory_provider,
            tenant_id,
            project_id,
            thread_id,
        } = self;

        let llm = llm.ok_or(SdkError::MissingField("llm"))?;
        let model = llm.model().to_string();
        let state = match state {
            Some(state) => state,
            None => Database::open_in_memory().await?,
        };
        let _conversation_store =
            conversation_store.unwrap_or_else(|| SqliteConversationStore::new(state.clone()));
        let data_root = match data_root {
            Some(root) => ensure_absolute(root)?,
            None => std::env::temp_dir().join("snaca-sdk-data"),
        };
        let workspace = match workspace_provider {
            Some(provider) => provider.into_layout(),
            None => WorkspaceLayout::new(data_root)?,
        };
        let tools = tools.unwrap_or_else(ToolRegistry::empty);
        let config = config.unwrap_or_else(|| EngineConfig::default_for(model));
        let mut runtime = EngineRuntimeBuilder::new()
            .llm_arc(llm)
            .tools(tools)
            .state(state)
            .workspace(workspace)
            .config(config);
        if let Some(provider) = memory_provider {
            runtime = runtime.memory_provider(provider);
        }
        let engine = runtime.build()?;
        Ok(Agent {
            engine: Arc::new(engine),
            defaults: AgentDefaults {
                tenant_id: tenant_id.unwrap_or_else(|| TenantId::new("default")),
                project_id: project_id.unwrap_or_else(|| ProjectId::from_raw("default")),
                thread_id: thread_id.unwrap_or_else(|| ThreadId::new("default")),
            },
        })
    }
}

fn ensure_absolute(path: PathBuf) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(std::env::current_dir()
            .map_err(snaca_workspace::WorkspaceError::Io)?
            .join(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use snaca_core::{Message, Usage};
    use snaca_llm::{LlmResult, MessageRequest, MessageResponse, ProviderCaps, StopReason};
    use snaca_tools_api::{ApprovalRequirement, ToolCapabilities, ToolError, ToolOutput};
    use std::collections::HashMap;
    use std::sync::Mutex;

    struct ConstantLlm {
        text: &'static str,
    }

    #[async_trait]
    impl LlmClient for ConstantLlm {
        fn provider_name(&self) -> &'static str {
            "constant"
        }

        fn model(&self) -> &str {
            "constant-model"
        }

        fn capabilities(&self) -> ProviderCaps {
            ProviderCaps {
                tool_use: true,
                ..Default::default()
            }
        }

        async fn create_message(&self, _request: MessageRequest) -> LlmResult<MessageResponse> {
            Ok(MessageResponse {
                id: "msg_1".into(),
                message: Message::assistant_text(self.text),
                usage: Usage {
                    input_tokens: 1,
                    output_tokens: 1,
                    ..Default::default()
                },
                stop_reason: StopReason::EndTurn,
            })
        }
    }

    struct OneToolThenDoneLlm {
        tool_name: &'static str,
        tool_input: serde_json::Value,
        done_text: &'static str,
    }

    #[async_trait]
    impl LlmClient for OneToolThenDoneLlm {
        fn provider_name(&self) -> &'static str {
            "tool-calling"
        }

        fn model(&self) -> &str {
            "tool-calling-model"
        }

        fn capabilities(&self) -> ProviderCaps {
            ProviderCaps {
                tool_use: true,
                ..Default::default()
            }
        }

        async fn create_message(&self, req: MessageRequest) -> LlmResult<MessageResponse> {
            let has_tool_result = req.messages.iter().any(|message| {
                message
                    .content
                    .iter()
                    .any(|block| matches!(block, ContentBlock::ToolResult { .. }))
            });
            let content = if has_tool_result {
                vec![ContentBlock::text(self.done_text)]
            } else {
                vec![ContentBlock::ToolUse {
                    id: ToolUseId::new("toolu_once"),
                    name: self.tool_name.into(),
                    input: self.tool_input.clone(),
                }]
            };
            let stop_reason = if has_tool_result {
                StopReason::EndTurn
            } else {
                StopReason::ToolUse
            };
            Ok(MessageResponse {
                id: "msg_tool".into(),
                message: Message::new(Role::Assistant, content),
                usage: Usage {
                    input_tokens: 1,
                    output_tokens: 1,
                    ..Default::default()
                },
                stop_reason,
            })
        }
    }

    #[tokio::test]
    async fn minimal_agent_runs_with_mock_llm() {
        let agent = AgentBuilder::new()
            .llm(ConstantLlm { text: "hello sdk" })
            .minimal_agent_defaults()
            .build()
            .await
            .unwrap();

        let out = agent.run("hi").await.unwrap();
        assert_eq!(out.text, "hello sdk");
        assert_eq!(out.outcome.iterations, 1);
    }

    #[test]
    fn llm_provider_parses_known_names() {
        assert_eq!(
            "deepseek".parse::<crate::llm::LlmProvider>().unwrap(),
            crate::llm::LlmProvider::DeepSeek
        );
        assert_eq!(
            "anthropic".parse::<crate::llm::LlmProvider>().unwrap(),
            crate::llm::LlmProvider::Anthropic
        );
        assert!("other".parse::<crate::llm::LlmProvider>().is_err());
    }

    #[test]
    fn runtime_builder_reports_missing_required_parts() {
        match EngineRuntimeBuilder::new().build() {
            Err(err) => assert!(matches!(err, SdkError::MissingField("llm"))),
            Ok(_) => panic!("builder should require llm"),
        }
    }

    #[tokio::test]
    async fn agent_config_builds_read_only_agent() {
        let config = AgentConfig::read_only()
            .tenant_id(TenantId::new("tenant_cfg"))
            .project_id(ProjectId::from_raw("project_cfg"))
            .thread_id(ThreadId::new("thread_cfg"));
        let builder = AgentBuilder::from_config(config).unwrap();
        let names: Vec<_> = builder.tools.as_ref().unwrap().names().collect();
        assert!(names.contains(&"Read"));
        assert!(!names.contains(&"Bash"));
        assert!(!names.contains(&"Write"));

        let agent = builder
            .llm(ConstantLlm { text: "configured" })
            .build()
            .await
            .unwrap();

        let out = agent.run("hi").await.unwrap();
        assert_eq!(out.text, "configured");
    }

    #[test]
    fn agent_config_accepts_single_project_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let builder =
            AgentBuilder::from_config(AgentConfig::minimal().single_project_workspace(dir.path()))
                .unwrap();
        let provider = builder.workspace_provider.as_ref().unwrap();
        assert_eq!(provider.workspace_root_hint(), dir.path());
    }

    #[tokio::test]
    async fn agent_stream_forwards_llm_events_and_completion() {
        let agent = AgentBuilder::new()
            .llm(ConstantLlm {
                text: "hello stream",
            })
            .minimal_agent_defaults()
            .build()
            .await
            .unwrap();

        let mut stream = agent.stream("hi");
        let mut saw_llm_event = false;
        let mut text_delta = String::new();
        let mut completed = None;

        while let Some(event) = stream.next().await {
            match event.unwrap() {
                AgentStreamEvent::Llm(event) => {
                    saw_llm_event = true;
                    let wrapped = AgentStreamEvent::Llm(event);
                    if let Some(delta) = wrapped.text_delta() {
                        text_delta.push_str(delta);
                    }
                }
                AgentStreamEvent::Completed(out) => {
                    completed = Some(out);
                    break;
                }
            }
        }

        assert!(saw_llm_event);
        assert_eq!(text_delta, "hello stream");
        assert_eq!(completed.unwrap().text, "hello stream");
    }

    #[test]
    fn read_only_preset_excludes_shell_and_writes() {
        let registry = tools::read_only();
        assert!(registry.get("Read").is_some());
        assert!(registry.get("Grep").is_some());
        assert!(registry.get("Glob").is_some());
        assert!(registry.get("LS").is_some());
        assert!(registry.get("Bash").is_none());
        assert!(registry.get("Write").is_none());
        assert!(registry.get("Edit").is_none());
        assert!(registry.get("MultiEdit").is_none());
    }

    #[tokio::test]
    async fn builder_accepts_explicit_input_ids() {
        let agent = AgentBuilder::new()
            .llm(ConstantLlm { text: "ok" })
            .no_tools()
            .build()
            .await
            .unwrap();

        let out = agent
            .run(
                AgentInput::new("hello")
                    .tenant_id(TenantId::new("tenant_a"))
                    .project_id(ProjectId::from_raw("project_a"))
                    .thread_id(ThreadId::new("thread_a"))
                    .message_id("message_a"),
            )
            .await
            .unwrap();
        assert_eq!(out.text, "ok");
    }

    #[tokio::test]
    async fn sdk_store_and_workspace_helpers_are_trait_usable() {
        let store = crate::store::in_memory().await.unwrap();
        let thread_id = ThreadId::new("thread_helper");
        store
            .ensure_thread(EnsureThread {
                id: thread_id.clone(),
                tenant_id: TenantId::new("tenant"),
                project_id: ProjectId::from_raw("project"),
            })
            .await
            .unwrap();
        let message = store
            .append_message(ConversationMessage {
                thread_id: thread_id.clone(),
                session_id: SessionId::new(),
                role: Role::User,
                content: vec![ContentBlock::text("hello")],
            })
            .await
            .unwrap();
        assert!(!message.id.to_string().is_empty());

        let provider = crate::workspace::local("./target/snaca-sdk-test-workspace").unwrap();
        let root = provider
            .workspace_root(WorkspaceRequest {
                tenant_id: TenantId::new("tenant"),
                project_id: ProjectId::from_raw("project"),
            })
            .await
            .unwrap();
        assert!(root.is_dir());
    }

    #[tokio::test]
    async fn sdk_has_true_in_memory_conversation_store() {
        let store = crate::store::in_memory_conversation();
        let thread_id = ThreadId::new("thread_mem");
        store
            .ensure_thread(EnsureThread {
                id: thread_id.clone(),
                tenant_id: TenantId::new("tenant"),
                project_id: ProjectId::from_raw("project"),
            })
            .await
            .unwrap();
        store
            .append_message(ConversationMessage {
                thread_id: thread_id.clone(),
                session_id: SessionId::new(),
                role: Role::User,
                content: vec![ContentBlock::text("hello")],
            })
            .await
            .unwrap();
        let messages = store
            .recent_messages(HistoryQuery {
                thread_id,
                limit: 10,
            })
            .await
            .unwrap();
        assert_eq!(messages.len(), 1);
    }

    #[tokio::test]
    async fn single_project_workspace_is_used_as_tool_cwd() {
        struct TouchTool;

        #[async_trait]
        impl Tool for TouchTool {
            fn name(&self) -> &str {
                "touch_file"
            }

            fn description(&self) -> &str {
                "Write a marker file in the current workspace."
            }

            fn input_schema(&self) -> serde_json::Value {
                serde_json::json!({"type": "object"})
            }

            fn capabilities(&self) -> ToolCapabilities {
                ToolCapabilities::writes_filesystem()
            }

            fn approval_requirement(&self) -> ApprovalRequirement {
                ApprovalRequirement::Never
            }

            async fn execute(&self, _input: serde_json::Value, ctx: &ToolContext) -> ToolResult {
                tokio::fs::write(ctx.workspace_root().join("marker.txt"), "ok")
                    .await
                    .map_err(ToolError::Io)?;
                Ok(ToolOutput::text("written"))
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let tools = ToolRegistry::builder().add(TouchTool).build();
        let agent = AgentBuilder::new()
            .llm(OneToolThenDoneLlm {
                tool_name: "touch_file",
                tool_input: serde_json::json!({}),
                done_text: "done",
            })
            .tools(tools)
            .single_project_workspace(dir.path())
            .unwrap()
            .build()
            .await
            .unwrap();
        let out = agent.run("touch").await.unwrap();
        assert_eq!(out.text, "done");
        assert_eq!(
            tokio::fs::read_to_string(dir.path().join("marker.txt"))
                .await
                .unwrap(),
            "ok"
        );
    }

    #[tokio::test]
    async fn sdk_memory_helper_roundtrips() {
        // Clean any leftover state from a prior run so the
        // file-tree provider's drift detection sees a fresh dir.
        // The fixture path is intentionally outside tmpfs so the
        // helper exercises the same workspace path a real SDK
        // user would, but that means we own the cleanup.
        let _ = std::fs::remove_dir_all("./target/snaca-sdk-test-memory");
        let provider = crate::memory::file_tree("./target/snaca-sdk-test-memory").unwrap();
        let tenant_id = TenantId::new("tenant");
        let project_id = ProjectId::from_raw("project");
        provider
            .write(MemoryWriteRequest {
                tenant_id: tenant_id.clone(),
                project_id: project_id.clone(),
                scope: "user".into(),
                name: "Preference".into(),
                content: "Prefers concise answers.".into(),
            })
            .await
            .unwrap();
        let entry = provider
            .read(MemoryReadRequest {
                tenant_id,
                project_id,
                scope: "user".into(),
                name: "preference".into(),
            })
            .await
            .unwrap();
        assert_eq!(entry.name, "preference");
        assert_eq!(entry.content, "Prefers concise answers.");
    }

    #[derive(Default)]
    struct InMemoryProvider {
        entries: Mutex<HashMap<(String, String), String>>,
    }

    #[async_trait]
    impl MemoryProvider for InMemoryProvider {
        async fn index(
            &self,
            _request: MemoryIndexRequest,
        ) -> std::result::Result<String, MemoryProviderError> {
            let mut names: Vec<String> = self
                .entries
                .lock()
                .unwrap()
                .keys()
                .map(|(scope, name)| format!("{scope}/{name}"))
                .collect();
            names.sort();
            Ok(names.join("\n"))
        }

        async fn list(
            &self,
            request: MemoryListRequest,
        ) -> std::result::Result<Vec<String>, MemoryProviderError> {
            let mut names: Vec<String> = self
                .entries
                .lock()
                .unwrap()
                .keys()
                .filter(|(scope, _)| scope == &request.scope)
                .map(|(_, name)| name.clone())
                .collect();
            names.sort();
            Ok(names)
        }

        async fn write(
            &self,
            request: MemoryWriteRequest,
        ) -> std::result::Result<MemoryEntryData, MemoryProviderError> {
            self.entries.lock().unwrap().insert(
                (request.scope.clone(), request.name.clone()),
                request.content.clone(),
            );
            Ok(MemoryEntryData {
                scope: request.scope,
                name: request.name,
                content: request.content,
            })
        }

        async fn read(
            &self,
            request: MemoryReadRequest,
        ) -> std::result::Result<MemoryEntryData, MemoryProviderError> {
            let content = self
                .entries
                .lock()
                .unwrap()
                .get(&(request.scope.clone(), request.name.clone()))
                .cloned()
                .ok_or_else(|| MemoryProviderError::NotFound {
                    scope: request.scope.clone(),
                    name: request.name.clone(),
                })?;
            Ok(MemoryEntryData {
                scope: request.scope,
                name: request.name,
                content,
            })
        }
    }

    #[tokio::test]
    async fn agent_builder_injects_memory_provider_into_builtin_tools() {
        let dir = tempfile::tempdir().unwrap();
        let provider = Arc::new(InMemoryProvider::default());
        let agent = AgentBuilder::new()
            .llm(OneToolThenDoneLlm {
                tool_name: "MemoryWrite",
                tool_input: serde_json::json!({
                    "scope": "user",
                    "name": "preference",
                    "content": "Prefers concise answers."
                }),
                done_text: "remembered",
            })
            .tools(
                ToolRegistry::builder()
                    .add(crate::tools::MemoryWriteTool)
                    .build(),
            )
            .single_project_workspace(dir.path())
            .unwrap()
            .memory_provider_arc(provider.clone() as Arc<dyn MemoryProvider>)
            .build()
            .await
            .unwrap();

        let out = agent.run("remember this").await.unwrap();
        assert_eq!(out.text, "remembered");

        let entry = provider
            .read(MemoryReadRequest {
                tenant_id: TenantId::new("default"),
                project_id: ProjectId::from_raw("default"),
                scope: "user".into(),
                name: "preference".into(),
            })
            .await
            .unwrap();
        assert_eq!(entry.content, "Prefers concise answers.");
        assert!(!dir.path().join(".snaca/memory/user/preference.md").exists());
    }
}
