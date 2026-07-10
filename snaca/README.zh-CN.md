# SNACA

中文 | [English](./README.md)

**Snaca is Not A Coding Agent** 是一个面向 IM 场景的 Rust agent 系统，也在逐步抽离为可嵌入的 Rust Agent SDK。

## 这是什么

SNACA 当前完整形态是服务端多租户：一个实例可以服务多个 IM 租户、群和用户。它内置 Read、Grep、Glob、Bash、Write、Edit 等 coding agent 常用工具，支持 MCP 和 Markdown Skills，并为每个 tenant/project 提供隔离的工作目录与文件树记忆。

主要交互入口是 IM。SNACA 通过 stdio JSON-RPC 插件进程接入 IM 平台，主服务不直接依赖具体 IM SDK。仓库内置纯 Rust 的飞书插件 `snaca-plugin-lark`；如需复用 OpenClaw channel 包，也可以另行部署 Node.js OpenClaw sidecar。

核心运行时通过 `snaca-sdk` 暴露，适合 Rust 应用在不启动 HTTP server 或 IM 插件的情况下嵌入 agent 能力。见 [docs/SDK.md](./docs/SDK.md)、[docs/SDK_ARCHITECTURE.md](./docs/SDK_ARCHITECTURE.md) 和 [docs/SDK_MIGRATION.md](./docs/SDK_MIGRATION.md)。

## 架构

```text
IM 用户 <-> IM 平台
          |
          v
IM 插件进程（stdio JSON-RPC）
  - snaca-plugin-lark
  - snaca-plugin-openclaw-host
  - 自研插件
          |
          v
SNACA 主服务
  server -> channel-host -> engine -> llm + tools + mcp + memory
  SQLite 状态、隔离 workspace、文件树记忆
```

## 状态

SNACA 仍处于早期阶段。引擎、工具、MCP、Skills、记忆、admin UI 和飞书插件已经可以端到端运行，但 API 与配置仍可能快速演进。

文档入口见 [docs/README.md](./docs/README.md)。部署、配置和运维见 [docs/USAGE.zh-CN.md](./docs/USAGE.zh-CN.md)，最小配置示例见 [snaca.toml.example](./snaca.toml.example)。

## 快速开始

前置要求：

- Rust 1.88+
- Node.js 22+ 和 npm，仅构建 admin Web UI 时需要
- LLM API key，目前支持 DeepSeek 或 Anthropic-compatible provider

构建和测试：

```sh
cargo fmt --all -- --check
cargo test --workspace --all-targets
cd web && npm ci && npm run build
```

本地运行：

```sh
cp snaca.toml.example snaca.toml
export DEEPSEEK_API_KEY="sk-..."
cargo run -p snaca-server -- --config snaca.toml
```

Docker Compose：

```sh
cp .env.example .env
# 编辑 .env，设置 DEEPSEEK_API_KEY
docker compose up --build
```

Compose 默认在 `http://localhost:8080/` 提供 admin UI，状态保存在 `snaca-data` volume，并用 [docker/snaca.toml](./docker/snaca.toml) 初始化 `/config/snaca.toml`。

## 安全说明

SNACA 可以调用 LLM provider、执行工具、运行插件进程，并读写项目 workspace。对私有仓库或多租户 IM 群启用前，请先审查 `snaca.toml`、插件命令、MCP server 和 workspace 根目录。

不要提交 `snaca.toml`、`.env`、SQLite 数据库、日志、workspace 数据或任何凭证。发布仓库前，轮换所有曾经出现在本地配置文件里的凭证。

## 许可证

MIT。见 [LICENSE](./LICENSE)。
