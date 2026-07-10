# SNACA SDK

[中文](./SDK.zh-CN.md) | English

SNACA can now be used in two ways:

1. Run `snaca-server` as the IM-native multi-tenant agent system.
2. Embed the core runtime from Rust through `snaca-sdk`.

The SDK facade is intentionally thin in the first refactor phase. It wraps the
existing `snaca-engine`, re-exports stable contracts, and gives applications a
compact `AgentBuilder` entry point without requiring the HTTP server or IM
plugin stack.

Architecture details live in [SDK_ARCHITECTURE.md](./SDK_ARCHITECTURE.md).
Migration notes live in [SDK_MIGRATION.md](./SDK_MIGRATION.md).
Release preparation notes live in
[SDK_RELEASE_CHECKLIST.md](./SDK_RELEASE_CHECKLIST.md).

## Minimal Agent

```rust
use snaca_sdk::AgentBuilder;

#[tokio::main]
async fn main() -> snaca_sdk::Result<()> {
    let agent = AgentBuilder::new()
        .llm(snaca_sdk::llm::deepseek_from_env("deepseek-chat")?)
        .read_only_agent_defaults()
        .data_root("./data-sdk")
        .build()
        .await?;

    let out = agent.run("用一句话介绍 SNACA").await?;
    println!("{}", out.text);
    Ok(())
}
```

Run the example:

```bash
DEEPSEEK_API_KEY=... cargo run -p snaca-sdk --example basic_agent
```

## Streaming Agent

`Agent::stream()` runs the same engine turn as `Agent::run()`, but returns an
`AgentStream` that yields low-level LLM stream events and then a final
`AgentOutput`.

```rust
use std::io::{self, Write};
use snaca_sdk::{AgentBuilder, AgentStreamEvent};

#[tokio::main]
async fn main() -> snaca_sdk::Result<()> {
    let agent = AgentBuilder::new()
        .llm(snaca_sdk::llm::deepseek_from_env("deepseek-chat")?)
        .read_only_agent_defaults()
        .data_root("./data-sdk")
        .build()
        .await?;

    let mut stream = agent.stream("用三句话介绍 SNACA");
    while let Some(event) = stream.next().await {
        match event? {
            event @ AgentStreamEvent::Llm(_) => {
                if let Some(delta) = event.into_text_delta() {
                    print!("{delta}");
                    io::stdout().flush().ok();
                }
            }
            AgentStreamEvent::Completed(out) => {
                println!("\niterations: {}", out.outcome.iterations);
                break;
            }
        }
    }

    Ok(())
}
```

Run the example:

```bash
DEEPSEEK_API_KEY=... cargo run -p snaca-sdk --example streaming
```

The SDK currently forwards canonical `snaca_llm::StreamEvent` values. Helper
methods on `AgentStreamEvent` expose common text and thinking deltas without
requiring callers to pattern-match the full LLM event enum.

## Custom Tool

SDK users implement the same `Tool` trait used internally by SNACA:

```rust
use async_trait::async_trait;
use serde_json::{json, Value};
use snaca_sdk::{
    ApprovalRequirement, Tool, ToolCapabilities, ToolContext, ToolOutput, ToolResult,
};

struct EchoTool;

#[async_trait]
impl Tool for EchoTool {
    fn name(&self) -> &str { "echo" }
    fn description(&self) -> &str { "Echo input text." }
    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "text": { "type": "string" } },
            "required": ["text"]
        })
    }
    fn capabilities(&self) -> ToolCapabilities { ToolCapabilities::default() }
    fn approval_requirement(&self) -> ApprovalRequirement { ApprovalRequirement::Never }
    async fn execute(&self, input: Value, _ctx: &ToolContext) -> ToolResult {
        Ok(ToolOutput::text(input["text"].as_str().unwrap_or_default()))
    }
}
```

See `examples/sdk/custom_tool.rs` for a complete runnable example.

## Custom LLM

Any application-owned type that implements `snaca_sdk::LlmClientTrait` can be
used with `AgentBuilder::llm(...)`. See `examples/sdk/custom_llm.rs` for a
minimal static LLM implementation:

```bash
cargo run -p snaca-sdk --example custom_llm
```

## Tool Presets

`snaca_sdk::tools` exposes the first set of SDK-oriented presets:

| Function | Contents |
|---|---|
| `tools::empty()` | No tools |
| `tools::read_only()` | `Read`, `Grep`, `Glob`, `Ls`, `WebFetch` |
| `tools::web()` | `WebFetch`, `WebSearch` when enabled |
| `tools::coding()` | Current full built-in coding tool set |

`read_only()` deliberately excludes `Bash`; command execution should be an
explicit SDK choice.

`snaca-tools` now exposes feature-gated capability groups. Default features
preserve the current server behavior, while embedders can depend on a smaller
tool set with `default-features = false` and selected features such as
`fs-read` or `web-fetch`.

| Feature | Capability |
|---|---|
| `fs-read` | `Read`, `Grep`, `Glob`, `LS` |
| `fs-write` | `Write`, `Edit`, `MultiEdit` |
| `shell` | `Bash` |
| `tasks` | `TaskOutput`, `TaskStop`, `TaskRegistry` |
| `todo` | `TodoWrite` |
| `web-fetch` | `WebFetch` |
| `web-search` | `WebSearch` |
| `memory` | `MemoryRead`, `MemoryWrite` |
| `skills` | `Skill` |
| `interactive` | `AskUserQuestion` |
| `send-file` | `SendFile` |
| `pdf` | PDF parsing support used by `Read` |

## Agent Config

`AgentConfig` is a lightweight SDK-side code config. It is intentionally not
`snaca.toml`: server-only concerns such as IM plugins, admin HTTP, outbox
workers, and schedulers stay in `snaca-server`.

```rust
let config = snaca_sdk::AgentConfig::read_only()
    .single_project_workspace("./repo");

let agent = snaca_sdk::AgentBuilder::from_config(config)?
    .llm(snaca_sdk::llm::deepseek_from_env("deepseek-chat")?)
    .build()
    .await?;
```

The config currently covers tool preset, workspace mode, default
tenant/project/thread IDs, and optional `EngineConfig` overrides. Lower-level
builder methods such as `memory_provider_arc(...)` remain available after
`from_config(...)`.

## Store And Workspace Helpers

The SDK re-exports the runtime traits from `snaca-agent-api` and provides
default adapters for the current SQLite store, local workspace layout, and
file-tree memory store:

```rust
let store = snaca_sdk::store::in_memory().await?;
let workspace = snaca_sdk::workspace::local("./data-sdk")?;
let repo_workspace = snaca_sdk::workspace::single_project("./repo")?;
let memory = snaca_sdk::memory::file_tree("./data-sdk")?;
```

These helpers return concrete adapters that implement:

| Trait | Default adapter |
|---|---|
| `ConversationStore` | `snaca_state::SqliteConversationStore` |
| `WorkspaceProvider` | `snaca_workspace::LocalWorkspaceProvider` |
| `MemoryProvider` | `snaca_memory::FileTreeMemoryProvider` |

`AgentBuilder::memory_provider_arc(...)` lets an embedder replace SNACA's
file-tree memory with an application-owned backend. When attached, built-in
`MemoryRead` / `MemoryWrite` tools, the frozen prompt memory snapshot, and
extractor writes all go through that provider.
Without a provider, the current file-tree behavior remains unchanged.

See `examples/sdk/with_memory.rs` for a file-tree provider example:

```bash
DEEPSEEK_API_KEY=... cargo run -p snaca-sdk --example with_memory
```

`store::in_memory()` returns the SQLite-backed in-memory adapter used by the
current engine. `store::in_memory_conversation()` returns a pure
`snaca-agent-api` in-memory `ConversationStore` for SDK code that only needs
the trait contract.

See `examples/sdk/custom_store.rs` for using the `ConversationStore` trait
directly. The current `AgentBuilder` still runs the engine on
`snaca_state::Database`; arbitrary `ConversationStore` injection into the turn
loop is a later engine refactor.

`workspace::local()` keeps SNACA's multi-tenant data-root layout. For an
embedder that wants tools to operate directly inside one existing repository,
use `AgentBuilder::single_project_workspace("./repo")`; SNACA metadata then
lives under `./repo/.snaca/`.

The current `AgentBuilder` still wraps `snaca-engine`, so conversation
execution keeps using `snaca_state::Database` internally. The adapter traits
are in place so future engine/SDK iterations can accept alternate stores,
workspace providers, and memory providers without changing tool or server
crates.

## Shared Runtime Builder

`snaca_sdk::EngineRuntimeBuilder` exposes the reusable engine wiring used by
the SDK facade and by `snaca-server` startup. It accepts the shared runtime
pieces directly:

```rust
let engine = snaca_sdk::EngineRuntimeBuilder::new()
    .llm_arc(llm)
    .tools(snaca_sdk::tools::coding())
    .state(db)
    .workspace(workspace)
    .config(engine_config)
    .build()?;
```

Advanced applications can also attach a `RuntimeToolFactory`, task registry,
memory provider, or memory extractor. Server-only wiring such as IM plugins,
MCP lifecycle, outbox workers, admin HTTP, and input assembly remains in
`snaca-server`.

## Optional Channel Feature

The IM channel protocol and stdio plugin host are optional SDK features. They
are not enabled for ordinary embedded agents:

```toml
snaca-sdk = { features = ["channel-protocol"] }
snaca-sdk = { features = ["channel-host"] }
```

With these enabled, `snaca_sdk::channel::protocol` and
`snaca_sdk::channel::host` re-export the lower-level channel crates.

## Current Scope

Implemented in this refactor phase:

- `snaca-agent-api` contains shared approval and question contracts.
- `snaca-tools` no longer depends on `snaca-engine`.
- `snaca-sdk` exposes `Agent`, `AgentBuilder`, `AgentInput`, `AgentOutput`,
  `AgentStream`, `AgentStreamEvent`, provider helpers, tool presets, and
  common re-exports.
- SDK examples currently cover basic agent usage, custom tools, streaming,
  custom LLMs, `ConversationStore` trait usage, and file-tree memory provider
  injection.
- `ConversationStore` and `WorkspaceProvider` are defined in
  `snaca-agent-api`, with SQLite/local adapters exposed through the SDK.
- A pure `InMemoryConversationStore` is available from `snaca-agent-api` and
  `snaca_sdk::store::in_memory_conversation()`.
- `AgentBuilder::single_project_workspace()` lets SDK tools operate directly
  in an existing repo/workspace.
- `MemoryProvider` is defined in `snaca-agent-api`, with index/list/read/write
  and recall methods, a file-tree adapter exposed through the SDK, and
  injection support in `AgentBuilder`, `EngineRuntimeBuilder`, engine prompts,
  built-in memory tools, and extractor writes.
- `AgentConfig` provides SDK-side code configuration for tool presets,
  workspace mode, default IDs, and engine knobs without depending on server
  config.
- `snaca-sdk` exposes optional `channel-protocol` and `channel-host` features
  for applications that want IM plugin integration; default SDK users do not
  pull in the channel host.
- `EngineRuntimeBuilder` and `llm::LlmOptions` provide shared construction
  logic now reused by `snaca-server`.
- `snaca-server` still builds and keeps the existing IM system behavior.
- `scripts/check-sdk-boundaries.sh` verifies the key dependency boundaries.

Still planned:

- Deeper engine use of `ConversationStore` and `WorkspaceProvider` traits
  instead of concrete defaults.
