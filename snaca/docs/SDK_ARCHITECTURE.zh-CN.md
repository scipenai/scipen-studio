# SNACA SDK 架构

[English](./SDK_ARCHITECTURE.md) | 中文

本文是 [SDK_ARCHITECTURE.md](./SDK_ARCHITECTURE.md) 的中文版本入口，概述 SDK 的 crate 边界和公开门面。

## 目标

`snaca-sdk` 的目标是把可嵌入 agent 能力暴露为稳定门面，同时避免应用直接依赖 server、admin、插件 supervisor 等部署层内部实现。

## 分层

- `snaca-core`：消息、ID、内容块和错误类型。
- `snaca-agent-api`：approval、question 等运行时交互契约。
- `snaca-tools-api`：Tool trait 和 registry。
- `snaca-llm`：LLM client 抽象和 provider 实现。
- `snaca-engine`：turn loop、压缩、审批、工具调度。
- `snaca-sdk`：面向嵌入方的 `Agent` / `AgentBuilder` 门面。

## 边界

SDK 应公开可组合能力，不应泄漏：

- `snaca-server` 配置和 HTTP 类型。
- admin dashboard request/response。
- plugin supervisor 和 outbox worker 内部细节。
- 仅服务端部署使用的状态机。

## 维护原则

优先在 `snaca-sdk` 增加稳定包装，而不是让外部用户直接拼接 engine/server 内部结构。架构细节的英文规范见 [SDK_ARCHITECTURE.md](./SDK_ARCHITECTURE.md)。
