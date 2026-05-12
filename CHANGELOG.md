# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-05-12

### Added

- In-app auto-update via `electron-updater` against GitHub Releases
- IM-only collaboration mode with OpenClaw agent integration
- AI Diff Review: inline accept/reject of bot-authored edits with per-hunk decorations
- Project-scoped conversation binding — each project resolves to its own IM conversation
- Offline OT operations: queued edits replay automatically on reconnect
- Research workspace shell with immersive chat-first layout
- Overleaf local-first sync: projects download to disk and push via three-way merge

### Changed

- OT/IM reconnect: exponential backoff + jitter, watchdog, in-memory session state
- Overleaf architecture split into four focused services (Auth / Project / Compile / Live)
- IPC contract refactored into nine domain contract files under `shared/ipc/`
- Main process adopts lightweight DI (`ServiceContainer`); handlers receive deps via arguments

### Removed

- Agent/Knowledge subsystem and CLI sidecar tools (beamer, reviewer, pdf2tex)

## [0.1.2] — 2026-03-02

### Fixed

- WASM SyncTeX path mapping and capability hints
- Typst preview state and compiler settings dialog regressions

## [0.1.1] — 2026-02-25

### Fixed

- Markdown rendering layer stability; Marksman semantic highlighting integration

## [0.1.0] — 2026-02-06

Initial release.

### Features

- LaTeX and Typst editor built on Monaco with TexLab / Tinymist LSP integration
- PDF preview with SyncTeX forward/backward search
- Overleaf sync with remote compile fallback
- Electron app for Windows, macOS, and Linux
