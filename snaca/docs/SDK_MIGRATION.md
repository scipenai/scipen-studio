# Migrating To `snaca-sdk`

[中文](./SDK_MIGRATION.zh-CN.md) | English

This guide is for Rust applications that want to embed SNACA's agent runtime
instead of running the full IM server.

## From Direct Engine Wiring

Before, an embedder had to manually assemble `Engine`, `Database`,
`WorkspaceLayout`, an LLM client, and a tool registry.

Prefer `AgentBuilder`:

```rust
let agent = snaca_sdk::AgentBuilder::new()
    .llm(snaca_sdk::llm::deepseek_from_env("deepseek-chat")?)
    .read_only_agent_defaults()
    .data_root("./data-sdk")
    .build()
    .await?;

let out = agent.run("summarize this project").await?;
println!("{}", out.text);
```

Use `EngineRuntimeBuilder` only when you are building a higher-level runtime
that still needs direct engine access.

## Tool Selection

Replace ad-hoc tool registry assembly with SDK presets where possible:

```rust
let read_only = snaca_sdk::tools::read_only();
let coding = snaca_sdk::tools::coding();
let web = snaca_sdk::tools::web();
```

`read_only` excludes Bash and write tools. Use `coding` only when the agent
should be allowed to edit files and run shell commands in the workspace.

## Workspace Mode

For the historical multi-tenant data layout:

```rust
let agent = snaca_sdk::AgentBuilder::new()
    .data_root("./data")
    // ...
    .build()
    .await?;
```

For a single existing repository or project directory:

```rust
let agent = snaca_sdk::AgentBuilder::new()
    .single_project_workspace("./repo")?
    // ...
    .build()
    .await?;
```

In single-project mode, tool cwd is `./repo`; SNACA metadata lives under
`./repo/.snaca/`.

## Memory

The default file-tree memory adapter is available through:

```rust
let memory = snaca_sdk::memory::file_tree("./data")?;
```

To replace memory with an application-owned backend, implement
`MemoryProvider` and attach it:

```rust
let agent = snaca_sdk::AgentBuilder::new()
    .memory_provider_arc(custom_memory_provider)
    // ...
    .build()
    .await?;
```

The built-in `MemoryRead` and `MemoryWrite` tools, prompt memory index, recall
block, and extractor writes use the injected provider.

## Store And Workspace Traits

`ConversationStore` and `WorkspaceProvider` are public SDK contracts. Use them
when building code that should not depend on SQLite or the local filesystem
layout directly.

```rust
let store = snaca_sdk::store::in_memory_conversation();
```

See `examples/sdk/custom_store.rs` for direct trait usage.

Current limitation: `AgentBuilder` still wraps `snaca-engine`, whose turn loop
uses `snaca_state::Database` and `snaca_workspace::WorkspaceLayout`
internally. Full arbitrary store/workspace injection into engine execution is
a later refactor because the engine also needs summary, approval, audit,
transcript-search, and attachment-import operations.

## Configuration

Use `AgentConfig` for code-side SDK configuration:

```rust
let config = snaca_sdk::AgentConfig::read_only()
    .single_project_workspace("./repo");

let agent = snaca_sdk::AgentBuilder::from_config(config)?
    .llm(snaca_sdk::llm::deepseek_from_env("deepseek-chat")?)
    .build()
    .await?;
```

Do not use `snaca.toml` for SDK embedding unless you are intentionally building
a server-compatible wrapper. IM plugins, admin HTTP, outbox workers, and
schedulers stay in `snaca-server`.

## Server Deployments

Existing `snaca-server` deployments should continue to use:

```bash
cargo run -p snaca-server -- --config snaca.toml
```

The server reuses shared SDK/runtime construction where it is useful, but the
server remains responsible for IM-specific behavior.
