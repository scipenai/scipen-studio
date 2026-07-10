# 贡献指南

[English](./CONTRIBUTING.md) | 中文

SNACA 仍处于早期阶段，接口和配置可能快速变化。小而聚焦的改动最容易 review。

## 开发

- 安装 Rust 1.88 或更新版本。
- 如需构建 admin Web UI，安装 Node.js 和 npm。
- 本地运行测试时，把 `snaca.toml.example` 复制为 `snaca.toml`。真实 API key 尽量放在环境变量里；`snaca.toml` 已被 gitignore。

常用检查：

```sh
cargo fmt --all -- --check
cargo test --workspace --all-targets
(cd web && npm run build)
```

Live tests 标记为 `#[ignore]`，需要 `DEEPSEEK_API_KEY` 或 `ANTHROPIC_API_KEY` 等 provider 凭证。

## Pull Request

- 包含测试，或简短说明为什么不适合加测试。
- 行为改动里不要混入无关格式化或重构。
- 修改用户可见配置或流程时，同步更新 `README.md`、`README.zh-CN.md`、`docs/USAGE.md` 或 `docs/USAGE.zh-CN.md`。
