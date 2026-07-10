# SNACA SDK Architecture

[中文](./SDK_ARCHITECTURE.zh-CN.md) | English

SNACA now has two supported shapes:

1. `snaca-server`: the IM-native, multi-tenant agent system.
2. `snaca-sdk`: the embeddable Rust facade for applications that want the
   agent runtime without HTTP, admin APIs, or IM plugins.

## Layering

```text
applications
  snaca-server / snaca-cli / custom Rust apps
        |
snaca-sdk
  Agent / AgentBuilder / AgentConfig / tool presets / provider helpers
        |
runtime and capabilities
  snaca-engine / snaca-tools / snaca-llm / snaca-memory
  snaca-state / snaca-workspace / snaca-skills / snaca-mcp
        |
base contracts
  snaca-core / snaca-agent-api / snaca-tools-api
```

`snaca-server` is an application on top of the runtime. It owns deployment
concerns such as IM plugins, channel host lifecycle, admin HTTP, config files,
outbox workers, and schedulers. SDK embedders should not need those concepts.

## Public SDK Surface

Use `snaca-sdk` for:

- `Agent`, `AgentBuilder`, `AgentInput`, `AgentOutput`
- `AgentStream` and `AgentStreamEvent`
- `AgentConfig` for code-side SDK configuration
- `llm`, `tools`, `store`, `workspace`, and `memory` helper modules
- stable re-exports from `snaca-core`, `snaca-agent-api`,
  `snaca-tools-api`, and `snaca-llm`

Advanced users may still access `Agent::engine()` and
`EngineRuntimeBuilder`, but the preferred entry point is `AgentBuilder`.

## Provider Boundaries

The SDK exposes traits for replaceable infrastructure:

| Contract | Default adapter |
|---|---|
| `ConversationStore` | `snaca_state::SqliteConversationStore` |
| `WorkspaceProvider` | `snaca_workspace::LocalWorkspaceProvider` |
| `MemoryProvider` | `snaca_memory::FileTreeMemoryProvider` |
| `QuestionGate` | `NoopQuestionGate` |
| `ApprovalGate` | `NoopApprovalGate` |

Current state:

- Memory provider injection is wired through built-in memory tools, the
  frozen prompt memory snapshot, and extractor writes.
- Conversation and workspace provider traits are available with default
  adapters. The engine still uses `Database` and `WorkspaceLayout` internally
  in this refactor phase.

The remaining store/workspace engine refactor is intentionally deferred. The
current turn loop uses SQLite for more than plain message history: compaction
summaries, approval decisions, tool-call audit, transcript FTS search, and
server attachment import paths all touch `Database` or `WorkspaceLayout`
directly.
Replacing those safely needs wider runtime contracts than the first SDK
boundary pass introduced.

## Optional Channel Features

Channel support is not in the default SDK dependency tree.

```toml
snaca-sdk = { features = ["channel-protocol"] }
snaca-sdk = { features = ["channel-host"] }
```

Use these only when embedding IM plugin integration. Normal SDK agents should
keep them disabled.

## Boundary Checks

`scripts/check-sdk-boundaries.sh` verifies:

- `snaca-tools` does not depend on `snaca-engine`.
- `snaca-sdk` does not depend on `snaca-server`.
- default `snaca-sdk` does not pull in `snaca-channel-host`.
- `snaca-agent-api` does not depend on implementation crates.
- `snaca-core` remains the dependency floor.
