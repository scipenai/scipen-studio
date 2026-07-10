# Contributing

[中文](./CONTRIBUTING.zh-CN.md) | English

SNACA is still early-stage. Interfaces and configuration may change quickly,
so small, focused changes are easiest to review.

## Development

- Install Rust 1.88 or newer.
- Install Node.js and npm for the admin web UI.
- Copy `snaca.toml.example` to `snaca.toml` for local runtime testing. Keep
  real API keys in environment variables where possible; `snaca.toml` is
  intentionally gitignored.

Common checks:

```sh
cargo fmt --all -- --check
cargo test --workspace --all-targets
(cd web && npm run build)
```

Live tests are marked `#[ignore]` and require provider credentials such as
`DEEPSEEK_API_KEY` or `ANTHROPIC_API_KEY`.

## Pull Requests

- Include tests or a short note explaining why tests are not practical.
- Keep unrelated formatting and refactors out of behavioral changes.
- Update `README.md`, `README.zh-CN.md`, `docs/USAGE.md`, `docs/USAGE.zh-CN.md`,
  or `snaca.toml.example` when changing user-visible configuration or workflows.
