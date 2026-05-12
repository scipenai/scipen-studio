# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.2.x   | :white_check_mark: |
| < 0.2   | :x: |

## Reporting a Vulnerability

If you discover a security vulnerability in SciPen Studio, please report it
privately — do **not** open a public GitHub issue.

- **GitHub Security Advisories**: use the [Report a vulnerability](https://github.com/scipenai/scipen-studio/security/advisories/new) link on this repository (preferred)
- **Email**: security@scipen.ai

### What to include

- A description of the vulnerability and its potential impact
- Steps to reproduce (a minimal reproducer is ideal)
- Affected version(s) and platform(s) (Windows / macOS / Linux)
- Any suggested remediation

### Response timeline

- **Acknowledgement**: within 72 hours
- **Initial assessment**: within 7 days
- **Remediation plan**: within 14 days for critical issues

We will credit reporters in release notes unless anonymity is requested.

## Scope

In-scope vulnerabilities include, but are not limited to:

- Remote code execution via crafted LaTeX / Typst / PDF input or IPC payloads
- Path-traversal or sandbox escape through the Electron main process
- Credential leakage (API keys, OAuth tokens) from the renderer to disk or network
- WebSocket / IPC channels bypassing Zod schema validation
- Privilege escalation through the `collaborative_edit` tool or OT protocol

Out of scope:

- Issues requiring a compromised local machine or physical access
- Third-party dependency vulnerabilities without a practical attack path in SciPen Studio
- User-supplied AI API keys that the user chose to embed in plaintext configuration
