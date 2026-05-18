# SNACA

**Snaca is Not A Coding Agent** — 一个面向 IM 场景的 Rust agent 系统。

## 这是什么

SNACA 是一个用 Rust 实现的 agent 系统，目标形态是**服务端多租户**：一个 SNACA 实例同时服务多个 IM 租户/群/用户。它内置了一组 coding agent 通用工具（Read / Grep / Glob / Bash / Write / Edit 等），通过 MCP 与 Skills 两种方式扩展，并为每个 tenant × project 提供隔离的工作目录与文件树记忆。

主要交互入口是 IM（飞书 / 钉钉 / 企微 / Slack 等），通过**热插拔的 IM 插件协议**接入——主仓不直接依赖任何 IM SDK。任何符合协议（JSON-RPC 2.0 over stdio）的子进程都可作为 IM 插件接入。仓内自带纯 Rust 的飞书插件 `snaca-plugin-lark`；如果希望复用 OpenClaw 生态的现成 channel 包，可以另行部署独立仓库 `snaca-plugin-openclaw-host`（Node.js sidecar，零代码改动桥接 OpenClaw → SNACA channel-protocol）。

## 架构概览

```
┌──────────────────────────────────────────────────────────────┐
│ IM 用户  ←→  飞书/钉钉/企微/...                                │
└──────────────────────────────────────────────────────────────┘
                  ↓ 走 IM 自身协议
┌──────────────────────────────────────────────────────────────┐
│ IM 插件子进程（独立进程，stdio JSON-RPC）                       │
│   - snaca-plugin-lark          (纯 Rust, 仓内)                │
│   - snaca-plugin-openclaw-host (Node.js, 独立仓库, 可选)      │
│   - 用户自研插件 ...                                            │
└──────────────────────────────────────────────────────────────┘
                  ↓ SNACA channel-protocol（JSON-RPC 2.0）
┌──────────────────────────────────────────────────────────────┐
│ SNACA 主进程（Rust）                                           │
│   server → channel-host → engine → llm + tools + mcp + ...    │
│   SQLite 持久化、按 tenant/project 隔离的 workspace 与记忆     │
└──────────────────────────────────────────────────────────────┘
```

## Workspace 结构

| Crate | 职责 |
|---|---|
| `snaca-core` | 基础类型：Message / ContentBlock / IDs / Error |
| `snaca-tools-api` | Tool trait + ToolRegistry |
| `snaca-llm` | LlmClient trait + DeepSeek / Anthropic 双后端（含结构化错误分类与重试） |
| `snaca-tools` | 内置工具实现（Read/Grep/Glob/Bash/Write/Edit/MultiEdit/...）|
| `snaca-mcp` | rmcp 封装 + transport 切换 + 健康探活与指数退避重连 |
| `snaca-skills` | 带 frontmatter 的 markdown 技能加载 |
| `snaca-workspace` | 路径解析 + 按项目隔离的配置层叠 |
| `snaca-state` | SQLite (sqlx) 持久化 |
| `snaca-memory` | 文件树记忆 + 批量导入 + 检索（可选 fastembed 向量召回）|
| `snaca-engine` | turn loop / 压缩 / approval 状态机 / 并发只读工具调度 |
| `snaca-channel-protocol` | IM 插件协议定义 |
| `snaca-channel-host` | 插件子进程管理 + 持久化 outbox |
| `snaca-server` | axum HTTP（含 admin/threads abort）+ 主进程 wiring |
| `snaca-cli` | 调试 CLI（含 mock 插件） |
| `snaca-plugin-lark` | 飞书插件子进程：openlark WebSocket + Open API |

## 状态

⚠️ 早期开发阶段。骨架已完成，引擎、工具、MCP、Skills、记忆、飞书插件均可端到端跑通；接口与配置仍在快速迭代。

部署、配置与扩展指南见 [docs/USAGE.md](./docs/USAGE.md)；IM 插件协议细节见 [docs/im-plugin-protocol.md](./docs/im-plugin-protocol.md)；最小配置示例见 [snaca.toml.example](./snaca.toml.example)。

## License

Apache-2.0
