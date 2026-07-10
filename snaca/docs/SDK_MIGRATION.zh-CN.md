# SNACA SDK 迁移指南

[English](./SDK_MIGRATION.md) | 中文

本文是 [SDK_MIGRATION.md](./SDK_MIGRATION.md) 的中文版本入口，用于记录 SDK API 演进时的迁移路径。

## 迁移原则

- 优先使用 `snaca_sdk` 暴露的 `Agent` / `AgentBuilder`。
- 避免直接依赖 `snaca-server` 或插件 supervisor 内部类型。
- 配置、store、workspace、memory、tools 尽量通过 SDK preset 或 trait 接入。
- 遇到 breaking change 时，在 release notes 和本指南中同时说明。

## 常见迁移

- 从直接构造 engine 迁移到 `AgentBuilder`。
- 从 server 配置迁移到 SDK 专用配置。
- 从手写工具 registry 迁移到 `tools::read_only()`、`tools::coding()` 等 preset。
- 从本地路径常量迁移到显式 `data_root` / `workspace` provider。

完整英文迁移说明见 [SDK_MIGRATION.md](./SDK_MIGRATION.md)。修改迁移流程时请同步维护两个版本。
