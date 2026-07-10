# SNACA SDK 发布检查清单

[English](./SDK_RELEASE_CHECKLIST.md) | 中文

此清单用于准备 `0.x` SDK release，并区分公开 SDK facade 和 server 内部实现。

## 公开 API

面向 SDK 用户的主要入口：

- `snaca_sdk::Agent`、`AgentBuilder`、`AgentConfig`
- `AgentInput`、`AgentOutput`、`AgentStream`、`AgentStreamEvent`
- `snaca_sdk::llm`、`tools`、`store`、`workspace`、`memory`
- 重新导出的核心 ID 和消息类型
- 重新导出的 Tool、Store、Workspace、Memory、Question、Approval 契约
- 面向高级嵌入方的 `EngineRuntimeBuilder`

避免把 server-only 内部类型写成 SDK API。

## 发布前命令

```sh
cargo fmt --all --check
cargo check --workspace
cargo check -p snaca-sdk --examples
cargo test -p snaca-agent-api -p snaca-memory -p snaca-engine -p snaca-sdk
cargo test -p snaca-tools -- --test-threads=1
cargo test -p snaca-server
./scripts/check-sdk-boundaries.sh
```

## Crate 元数据

- 确认 `description`、`license`、`repository`、`authors`、`rust-version` 已设置。
- 确认 workspace-local path dependencies 带版本号。
- 确认示例能通过 `cargo check -p snaca-sdk --examples`。
- 确认 README 和 SDK 文档解释两种使用形态。
- 确认可选 channel features 默认关闭。
