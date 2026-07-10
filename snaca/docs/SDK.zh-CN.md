# SNACA SDK 指南

[English](./SDK.md) | 中文

本文是 [SDK.md](./SDK.md) 的中文版本入口，面向希望把 SNACA 作为 Rust 库嵌入的开发者。

## 核心入口

- `snaca_sdk::Agent`
- `AgentBuilder`
- `AgentConfig`
- `AgentInput`
- `AgentOutput`
- `AgentStream`
- `AgentStreamEvent`

SDK 适用于不启动 `snaca-server`、不接入 IM 插件，但希望复用 SNACA turn loop、工具、记忆、workspace 和 LLM 客户端的 Rust 应用。

## 基本形态

典型使用方式：

```rust
use snaca_sdk::{Agent, AgentInput};

# async fn example() -> anyhow::Result<()> {
let agent = Agent::builder()
    .deepseek_from_env("deepseek-chat")
    .coding_tools()
    .sqlite_store("state.sqlite").await?
    .data_root("/tmp/snaca-data")
    .build().await?;

let output = agent.run(AgentInput::text("hello")).await?;
println!("{}", output.text());
# Ok(())
# }
```

## 工具预设

- `tools::read_only()`：只读文件和检索类工具。
- `tools::coding()`：包含 Bash 和写文件能力，适合可信 workspace。
- `tools::web()`：WebFetch / WebSearch 等网络工具。

## 稳定性

当前仍是 `0.x` 阶段。常用 SDK 门面会尽量保持兼容，但 server 内部类型、admin API 类型、插件 supervisor 细节不应被视为稳定 API。

完整英文规范仍以 [SDK.md](./SDK.md) 为准；修改 SDK 行为时请同步维护两个版本。
