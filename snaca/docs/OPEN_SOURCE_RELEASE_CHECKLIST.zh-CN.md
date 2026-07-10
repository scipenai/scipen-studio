# 开源发布检查清单

[English](./OPEN_SOURCE_RELEASE_CHECKLIST.md) | 中文

公开 GitHub 仓库前使用此清单。

## 必做

- [ ] 轮换所有曾经出现在本地配置文件中的凭证，包括 DeepSeek、Tavily、Lark/Feishu app 凭证。
- [ ] 确认 `snaca.toml` 使用 `${VAR}` 占位符保存凭证。
- [ ] 运行 `./scripts/secret-scan.sh`。
- [ ] 运行 `cargo fmt --all -- --check`。
- [ ] 运行 `cargo test --workspace --all-targets`。
- [ ] 运行 `cargo audit`。
- [ ] 运行 `cargo deny check`。
- [ ] 运行 `cd web && npm ci && npm run build && npm audit --audit-level=high`。
- [ ] 审查 `.cargo/audit.toml` 和 `deny.toml` 中忽略的 advisory。

## GitHub 设置

- [ ] 如果仓库计划支持，启用 secret scanning 和 push protection。
- [ ] 确认默认分支受 CI workflow 保护。
- [ ] 增加私密安全联系方式或启用 GitHub Security Advisory 流程。
- [ ] 首个 release 建议标记为 alpha/pre-release，除非 API 已稳定。

## 说明

`cargo audit` 会扫描完整 `Cargo.lock`，包括可选依赖。任何忽略的 advisory 都需要说明原因。
