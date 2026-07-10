# Security Policy

[中文](./SECURITY.zh-CN.md) | English

SNACA can execute tools, call LLM providers, read workspaces, and bridge IM
plugins. Treat deployments as privileged automation systems.

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability. Report it to
the project maintainer privately. If no dedicated security contact is listed
on the repository, use the maintainer contact shown on the GitHub profile.

Include:

- Affected version or commit.
- Reproduction steps and expected impact.
- Whether credentials, workspace files, IM messages, or tool execution are
  involved.

## Deployment Notes

- Do not commit `snaca.toml`, `.env` files, SQLite databases, logs, or local
  workspace data.
- Prefer `${VAR}` placeholders for provider and plugin credentials.
- Rotate any credential that has been placed in a local config file before
  publishing the repository.
- Review plugin commands and MCP servers before enabling them in multi-tenant
  environments.
