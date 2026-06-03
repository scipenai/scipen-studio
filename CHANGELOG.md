# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0-pre.1] — 2026-06-04

Pre-release. The agent runtime (SNACA) is now ported in tree and the desktop bundle ships
it as an embedded sidecar. The previous external "OpenClaw" runtime is gone — the agent
works with no server to run.

### Added

- **AskUserQuestion** — agent can ask the user a structured multiple-choice question
  (1–4 questions per card, 2–4 options each, single- or multi-select, optional free-form
  "Other"). The card renders inline in chat; the user's selection becomes the tool
  result that resumes the turn.
- **WebSearch + WebFetch tools** — agent can search the web (Tavily) and fetch one page
  (no key needed for WebFetch). Tavily API key configured under *Settings → Agent →
  Web search*; key value is injected only into the sidecar process env, never persisted
  in the agent config file.
- **Bundled academic-research skills** — `academic-paper`, `academic-paper-reviewer`,
  `academic-pipeline`, `deep-research` ship inside the installer (SNACA Bundled scope).
  Project- or tenant-scoped Skills still override them.
- **Cache-aware system prompt** — Anthropic prompt-cache breakpoint now lands on the
  stable base+memory prefix; per-turn recall stays volatile. Cache creation / read
  tokens + hit-rate logged each turn.
- **Memory quality gate** — extractor proposals carry self-rated `confidence`. Recall
  multiplies cosine by `confidence` and drops adjusted scores below
  `recall_confidence_floor` (default 0.30). Legacy entries without frontmatter
  unaffected. Entries persist with YAML frontmatter (`source`, `confidence`,
  `created_at`).
- **Memory / Skills viewer** — secondary window for inspecting per-project memory and
  the active Skill registry. Launched from *Settings → Agent*.
- **Reverse-RPC reuse** — AskUserQuestion shares the existing `context.request /
  context.respond` plumbing with the Zotero context tools; only the timeout is bumped
  (10 min vs 5 s) since it waits on a human.
- **Bundled skills directory in `SnacaConfig`** — `bundled_skills_dir` field added so
  the editor binary picks up the shipped skills automatically.

### Changed

- **Build chain — macOS universal2** — `build:snaca` on macOS runners now compiles both
  `x86_64-apple-darwin` and `aarch64-apple-darwin` and `lipo`-fuses into one fat
  binary; the resulting `.dmg` works on both Intel and Apple Silicon Macs.
- **Bundled-skills CI checkout** — `build.yml` jobs check out
  `Imbad0202/academic-research-skills` into the workspace and point
  `ARS_SKILLS_DIR` at it (the script's official override hook).
- **CI test gate — Windows boundary** — `ci.yml` test job on `windows-latest` is now
  `continue-on-error`; the failure mode is a known testing-architecture limit
  (vitest+node trying to load `electron` for main-process tests + occasional
  postinstall flake) and is tracked separately. Ubuntu / macOS test still hard-gates.
- **Vitest `hookTimeout` 10s → 30s** — covers slow CI runners where
  `vi.resetModules()` + dynamic `import` in `beforeEach/beforeAll` push past the
  default budget.
- **DeepSeek convert** — drops empty-content assistant messages on the wire (DeepSeek
  rejects assistant rows with neither `content` nor `tool_calls`).
- **`loop_guard_max_repeats` default 3 → 5** — 3 tripped on benign Read-before-Edit
  retries when the model tried offset/limit Read first.
- **Skills layout** — new `Global` scope (rank 1) between `Bundled` and `Tenant`;
  Skill registries can now hold nested directory-form skills (one folder = one Skill
  with assets).

### Fixed

- **Malformed tool-args recovery** — when DeepSeek emits invalid JSON in a streamed
  `tool_use`, engine retries the same request once on the non-streaming endpoint
  (sidesteps the SSE-concat bug). If both paths land the same broken string, engine
  persists a synthetic user-feedback message naming the parse error / tool / escaping
  rules and re-enters the loop so the model can self-correct. Bounded by
  `malformed_tool_args_max_retries` (default 2).
- **Per-thread Read tracker** — the "Read before Edit" gate now persists across turns
  on the same thread; a mid-task user ping no longer forces a full re-Read just to
  satisfy the gate (the wedged-loop pattern `loop_guard` used to trip on).
- **Loop-guard hint** — when the guard trips, the next turn's system prompt carries
  a one-shot hint naming the tool and input snippet so the model can break out
  instead of re-walking the same call.
- **Per-project memory-extraction lock** — concurrent extractor tasks on the same
  project no longer race on `MEMORY.md` regeneration or same-name entry files.
- **memory-viewer theme** — secondary window now applies the persisted theme on
  first paint (previously it bypassed `useThemeSync` and rendered light-mode
  regardless of settings).
- **Tavily key plumbing** — Tavily key now flows from Settings into the sidecar
  process env on save and triggers a debounced sidecar restart so the change takes
  effect.

### Removed

- **OpenClaw external runtime** — the desktop bundle no longer references the legacy
  "OpenClaw" component. The built-in SNACA sidecar replaces it; existing
  *Collaboration / IM* settings that pointed at an external server are no longer
  required.

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
