# SNACA

[中文](./README.zh-CN.md) | English

**Snaca is Not A Coding Agent** is a Rust agent system for IM-first workflows,
and is gradually exposing its runtime as an embeddable Rust Agent SDK.

## What It Is

SNACA currently runs as a multi-tenant server: one instance can serve multiple
IM tenants, chats, and users. It provides common coding-agent tools such as
Read, Grep, Glob, Bash, Write, and Edit; supports MCP and Markdown skills; and
keeps isolated workspaces and file-tree memory for each tenant/project.

The primary entry point is IM. SNACA talks to IM platforms through hot-pluggable
JSON-RPC-over-stdio plugin processes, so the main server does not need to link
IM SDKs directly. This repository includes the Rust Lark/Feishu plugin
`snaca-plugin-lark`; a Node.js OpenClaw sidecar can be deployed separately when
you want to reuse OpenClaw channel packages.

The runtime is also exposed through `snaca-sdk` for Rust applications that want
agent capabilities without running the HTTP server or IM plugins. See
[docs/SDK.md](./docs/SDK.md), [docs/SDK_ARCHITECTURE.md](./docs/SDK_ARCHITECTURE.md),
and [docs/SDK_MIGRATION.md](./docs/SDK_MIGRATION.md).

## Architecture

```text
IM user <-> IM platform
          |
          v
IM plugin process (stdio JSON-RPC)
  - snaca-plugin-lark
  - snaca-plugin-openclaw-host
  - custom plugins
          |
          v
SNACA server
  server -> channel-host -> engine -> llm + tools + mcp + memory
  SQLite state, isolated workspaces, file-tree memory
```

## Workspace

| Crate | Responsibility |
|---|---|
| `snaca-core` | Core IDs, messages, content blocks, errors |
| `snaca-agent-api` | Runtime contracts such as approval and questions |
| `snaca-sdk` | Embeddable Agent / AgentBuilder facade |
| `snaca-tools-api` | Tool trait and registry |
| `snaca-llm` | LLM client trait plus DeepSeek / Anthropic-compatible clients |
| `snaca-tools` | Built-in tools |
| `snaca-mcp` | MCP client manager and transports |
| `snaca-skills` | Markdown skill loading |
| `snaca-workspace` | Workspace path and config layering |
| `snaca-state` | SQLite persistence |
| `snaca-memory` | File-tree memory and retrieval |
| `snaca-engine` | Turn loop, compaction, approvals, tool scheduling |
| `snaca-channel-protocol` | IM plugin protocol types |
| `snaca-channel-host` | Plugin process supervision and outbox |
| `snaca-server` | Axum HTTP server and runtime wiring |
| `snaca-cli` | Debug and operations CLI |
| `snaca-plugin-lark` | Lark/Feishu IM plugin |

## Status

SNACA is early-stage. The engine, tools, MCP, skills, memory, admin UI, and
Lark/Feishu plugin can run end to end, but APIs and configuration are still
expected to evolve.

Documentation starts at [docs/README.md](./docs/README.md). For deployment and
operations, see [docs/USAGE.md](./docs/USAGE.md). For a minimal config, see
[snaca.toml.example](./snaca.toml.example).

## Quick Start

Prerequisites:

- Rust 1.88+
- Node.js 22+ and npm, only needed for the admin Web UI build
- An LLM API key, currently DeepSeek or Anthropic-compatible

Build and test:

```sh
cargo fmt --all -- --check
cargo test --workspace --all-targets
cd web && npm ci && npm run build
```

Run locally:

```sh
cp snaca.toml.example snaca.toml
export DEEPSEEK_API_KEY="sk-..."
cargo run -p snaca-server -- --config snaca.toml
```

Run with Docker Compose:

```sh
cp .env.example .env
# edit .env and set DEEPSEEK_API_KEY
docker compose up --build
```

The compose setup serves the admin UI on `http://localhost:8080/`, stores state
in the `snaca-data` volume, and initializes `/config/snaca.toml` from
[docker/snaca.toml](./docker/snaca.toml).

## Security Notes

SNACA can call LLM providers, execute tools, run plugin processes, and read or
write project workspaces. Review `snaca.toml`, plugin commands, MCP servers,
and workspace roots before using it with private repositories or multi-tenant
IM channels.

Do not commit `snaca.toml`, `.env` files, SQLite databases, logs, workspace
data, or credentials. Rotate any credential that has ever appeared in a local
config file before publishing a repository.

## License

MIT. See [LICENSE](./LICENSE).
