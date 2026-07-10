//! Reusable engine wiring for SDK embedders and higher-level applications.

use crate::{Result, SdkError};
use snaca_agent_api::MemoryProvider;
use snaca_engine::{Engine, EngineConfig, RuntimeToolFactory, SharedExtractor};
use snaca_llm::LlmClient;
use snaca_state::Database;
use snaca_tools_api::ToolRegistry;
use snaca_workspace::WorkspaceLayout;
use std::any::Any;
use std::sync::Arc;

#[derive(Default)]
pub struct EngineRuntimeBuilder {
    llm: Option<Arc<dyn LlmClient>>,
    tools: Option<ToolRegistry>,
    state: Option<Database>,
    workspace: Option<WorkspaceLayout>,
    config: Option<EngineConfig>,
    tool_factory: Option<Arc<dyn RuntimeToolFactory>>,
    task_registry: Option<Arc<dyn Any + Send + Sync>>,
    extractor: Option<SharedExtractor>,
    memory_provider: Option<Arc<dyn MemoryProvider>>,
}

impl EngineRuntimeBuilder {
    pub fn new() -> Self {
        Self::default()
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

    pub fn state(mut self, state: Database) -> Self {
        self.state = Some(state);
        self
    }

    pub fn workspace(mut self, workspace: WorkspaceLayout) -> Self {
        self.workspace = Some(workspace);
        self
    }

    pub fn config(mut self, config: EngineConfig) -> Self {
        self.config = Some(config);
        self
    }

    pub fn tool_factory(mut self, factory: Arc<dyn RuntimeToolFactory>) -> Self {
        self.tool_factory = Some(factory);
        self
    }

    pub fn task_registry(mut self, registry: Arc<dyn Any + Send + Sync>) -> Self {
        self.task_registry = Some(registry);
        self
    }

    pub fn memory_extractor(mut self, extractor: SharedExtractor) -> Self {
        self.extractor = Some(extractor);
        self
    }

    pub fn memory_provider(mut self, provider: Arc<dyn MemoryProvider>) -> Self {
        self.memory_provider = Some(provider);
        self
    }

    pub fn build(self) -> Result<Engine> {
        let llm = self.llm.ok_or(SdkError::MissingField("llm"))?;
        let tools = self.tools.ok_or(SdkError::MissingField("tools"))?;
        let state = self.state.ok_or(SdkError::MissingField("state"))?;
        let workspace = self.workspace.ok_or(SdkError::MissingField("workspace"))?;
        let config = self.config.unwrap_or_else(|| {
            let model = llm.model().to_string();
            EngineConfig::default_for(model)
        });

        let mut engine = Engine::new(llm, tools, state, workspace, config);
        if let Some(factory) = self.tool_factory {
            engine = engine.with_tool_factory(factory);
        }
        if let Some(registry) = self.task_registry {
            engine = engine.with_task_registry(registry);
        }
        if let Some(extractor) = self.extractor {
            engine = engine.with_memory_extractor(extractor);
        }
        if let Some(provider) = self.memory_provider {
            engine = engine.with_memory_provider(provider);
        }
        Ok(engine)
    }
}
