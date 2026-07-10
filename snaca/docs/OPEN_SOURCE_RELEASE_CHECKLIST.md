# Open Source Release Checklist

[中文](./OPEN_SOURCE_RELEASE_CHECKLIST.zh-CN.md) | English

Use this checklist before making the GitHub repository public.

## Required

- [ ] Rotate all credentials that have ever appeared in local config files,
      including DeepSeek, Tavily, and Lark/Feishu app credentials.
- [ ] Confirm `snaca.toml` uses `${VAR}` placeholders for credentials.
- [ ] Run `./scripts/secret-scan.sh`.
- [ ] Run `cargo fmt --all -- --check`.
- [ ] Run `cargo test --workspace --all-targets`.
- [ ] Run `cargo audit`.
- [ ] Run `cargo deny check`.
- [ ] Run `cd web && npm ci && npm run build && npm audit --audit-level=high`.
- [ ] Review ignored advisories in `.cargo/audit.toml` and `deny.toml`.

## GitHub Setup

- [ ] Enable secret scanning and push protection if the repository plan supports it.
- [ ] Confirm the default branch is protected by the `CI` workflow.
- [ ] Add a private security contact or GitHub Security Advisory workflow.
- [ ] Create the first release as an alpha/pre-release unless APIs are stable.

## Notes

`cargo audit` scans the full `Cargo.lock`, including optional dependencies. Any
ignored advisory must have a comment explaining whether it is unreachable from
the default feature graph, transitive through an upstream dependency, or has no
available fixed upgrade.
