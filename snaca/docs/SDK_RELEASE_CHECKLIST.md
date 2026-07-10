# SNACA SDK Release Checklist

[中文](./SDK_RELEASE_CHECKLIST.zh-CN.md) | English

This checklist is for preparing a `0.x` SDK release. It separates the public
SDK facade from application/server internals.

## Public API

Treat these as the intended SDK-facing surface:

- `snaca_sdk::Agent`, `AgentBuilder`, `AgentConfig`
- `AgentInput`, `AgentOutput`, `AgentStream`, `AgentStreamEvent`
- `snaca_sdk::llm`, `tools`, `store`, `workspace`, `memory`
- Re-exported core IDs and message types:
  `TenantId`, `ProjectId`, `ThreadId`, `Message`, `ContentBlock`
- Re-exported contracts:
  `Tool`, `ToolRegistry`, `ConversationStore`, `WorkspaceProvider`,
  `MemoryProvider`, `QuestionGate`, `ApprovalGate`
- `EngineRuntimeBuilder` for advanced embedders and server wiring

Avoid documenting server-only internals as SDK API:

- `snaca-server` config structs
- admin HTTP request/response types
- plugin supervisor internals
- outbox worker internals
- engine compaction and loop-guard internals, except through stable knobs

## Feature Matrix

| Crate / feature | Default | Purpose |
|---|---:|---|
| `snaca-sdk` | yes | Agent facade and default helpers |
| `snaca-sdk/channel-protocol` | no | Re-export IM plugin protocol |
| `snaca-sdk/channel-host` | no | Re-export stdio channel host |
| `snaca-tools/fs-read` | yes in `snaca-tools` default | Read/Grep/Glob/LS |
| `snaca-tools/fs-write` | yes in `snaca-tools` default | Write/Edit/MultiEdit |
| `snaca-tools/shell` | yes in `snaca-tools` default | Bash |
| `snaca-tools/web-fetch` | yes in `snaca-tools` default | WebFetch |
| `snaca-tools/web-search` | yes in `snaca-tools` default | WebSearch |
| `snaca-tools/memory` | yes in `snaca-tools` default | MemoryRead/MemoryWrite |
| `snaca-tools/interactive` | yes in `snaca-tools` default | AskUserQuestion |

SDK presets should remain explicit about risk:

- `tools::read_only()` excludes Bash and writes.
- `tools::coding()` includes Bash and write tools.
- `tools::web()` includes network tools only.

## Semver Policy

For `0.x`:

- Keep common SDK paths source-compatible within a minor version when practical.
- Prefer adding methods/types over changing existing signatures.
- Document any breaking change in release notes.
- Keep `snaca-server` config compatibility separate from `snaca-sdk` API
  compatibility.

Before a `1.0` release:

- Decide which re-exports are stable.
- Decide whether `EngineRuntimeBuilder` is stable or advanced/experimental.
- Complete or explicitly defer engine-level `ConversationStore` and
  `WorkspaceProvider` injection.
- Audit every public type for rustdoc coverage.

## Pre-release Commands

Run:

```bash
cargo fmt --all --check
cargo check --workspace
cargo check -p snaca-sdk --examples
cargo test -p snaca-agent-api -p snaca-memory -p snaca-engine -p snaca-sdk
cargo test -p snaca-tools -- --test-threads=1
cargo test -p snaca-server
./scripts/check-sdk-boundaries.sh
```

Note: `snaca-tools` has Bash tests that can race when run in parallel because
some tests manipulate process-wide environment. Use the single-threaded form
above for release validation until those tests are isolated.

## Crate Metadata

Before publishing any crate:

- Confirm `description`, `license`, `repository`, `authors`, and
  `rust-version` are set.
- Confirm workspace-local path dependencies have versions.
- Confirm examples compile with `cargo check -p snaca-sdk --examples`.
- Confirm README and SDK docs explain both usage shapes.
- Confirm optional channel features stay disabled by default.
