# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-06-16

First non-pre `0.3.x` release. Highlights: a full local history / restore system, a
WASM LaTeX engine swap (StellarLatex → BusyTeX), a Typst engine refresh (typst.ts +
bundled CJK fonts), a reworked Settings UI, and a long tail of agent-stability fixes.

### Added

- **Local history & restore** — Background versioning of the open project, no Git
  required. Layered as L0–L4: SHA-256 content-addressed BlobStore + chunk store,
  Step DAG keyed by `(sessionId, parentHash)`, and a unified browser dialog.
  - **Labels** — manual checkpoints with name + optional description; restore writes
    every tracked file back to disk and reloads open tabs.
  - **Auto-labels** — drift-triggered after the AI writes more than ~5 KB cumulative
    bytes, plus milestone labels on every successful compile.
  - **Sessions / Step DAG** — every SNACA tool call that touched files is recorded
    as a step under the active chat thread. The dialog renders a git-log-style
    timeline with per-file unified diffs and per-step restore.
  - **Per-message rollback** — hover a user message in chat to revert all open tabs
    to the most recent step recorded *before* that message.
  - **Storage hygiene** — orphan blob sweep daemon, automatic chunk merging on
    sweep, persistent refcount in SQLite (`node:sqlite`).
- **Chat thread copy** — Header button serializes the entire active thread (user
  messages, assistant text, thinking trace summary, tool call list, edit proposal
  list) to a single markdown block on the clipboard.
- **Edit proposals woven into the timeline** — `edit.propose` events now render
  inline with the tool call that produced them, instead of stacking at the bottom
  of the turn. Legacy IDB turns are back-filled at read time so existing threads
  keep showing their edit cards.
- **Auto-generated chat titles** — First user message in an untitled thread fires
  a background call to the completion model; the returned topic (≤ 24 chars)
  replaces the default placeholder. User-renamed threads are never overwritten.
- **Typst engine refresh** — typst.ts WASM runtime is now bundled by default;
  full CJK font set ships offline (`download:typst-wasm:cjk`); custom font
  manifests via *Settings → Compiler → Typst font manifest*.
- **Settings UI rework** — AI-first left navigation, modern form components,
  Agent / AI / Zotero tabs rebuilt with clearer grouping.
- **Three-panel main layout** — Chat / editor / preview each toggle independently
  via the right-hand status bar; only mounted panels stay in the DOM, so closing
  preview frees Monaco + pdf.js from the main thread.
- **Command palette `Ctrl+P`** — Single unified `History browser` entry, AI chat,
  compile, file save, view shortcuts. Hover-to-select with keyboard navigation.

### Changed

- **WASM LaTeX engine: StellarLatex → BusyTeX.** SyncTeX is now driven end-to-end
  by the renderer for all three engines (xetex / pdftex / lualatex); session-scoped
  forward / backward jump works the same across local, WASM, and Tectonic paths.
- **StatusBar engine dropdown** — Per-engine description rows removed; each row
  now shows only the engine name plus a checkmark for the current selection. The
  SyncTeX capability matrix lives in *Settings → Compiler* (`syncTexTitle` card)
  where it belongs.
- **History dialogs unified** — Previously two separate `BrowseLabelsDialog` /
  `BrowseSessionsDialog`; merged into a single `HistoryBrowserDialog` with a tab
  strip. Sidebar collapses to one `History` entry, command palette to one
  `History browser` entry.
- **Code language policy** — Code-layer comments / log messages / internal strings
  are now English; user-facing UI strings go through `t()` and ship in
  `zh-CN.json` / `en-US.json`. A `lint:no-cjk` script guards against regressions.
- **Approval / AskUserQuestion cards** — Rewritten with explicit Skip, deny-once
  vs. always-deny semantics, high-risk-action cooldown, full keyboard navigation,
  and structured failure when the user closes the card without choosing.
- **Per-project memory recall** — Quality-gated by self-rated confidence; entries
  below `recall_confidence_floor` (default 0.30) are filtered out.
- **Accessibility sweep across the renderer.** Framework-level a11y automation in
  shared UI primitives — `Button` auto-`aria-hidden`s decorative left/right icons,
  `Modal` uses `useId` to wire `aria-labelledby` / `aria-describedby`, `SettingItem`
  cloneElements native `input` / `select` / `textarea` children with auto-generated
  `id` + merged `aria-describedby`. Across the renderer: `cursor-pointer` /
  `disabled:cursor-not-allowed` on every clickable surface, explicit `type="button"`
  on icon-only buttons, `focus-visible:ring` on every focusable element, decorative
  Unicode glyphs (`✦`, `⏎`, `⇧⏎`) replaced by Lucide icons or plain text for
  cross-platform consistency. Send / Stop in chat composer became square icon-only
  buttons aligned with mainstream chat UIs. The lint baseline (previously 4
  warnings) now compiles cleanly.
- **Component test coverage.** 61 new component specs covering the renderer-level
  UI (~112 new tests, total goes from 506 to 618). Tests double as a11y contract
  guards going forward.

### Fixed

- **Streaming chat timeline re-mount.** `ChatMessage` Timeline list keys were
  derived from array index, so React re-mounted `ThinkingRenderer` /
  `MarkdownContent` / `ProposalRow` whenever events streamed in (animation replay,
  collapse state reset, content flicker). Keys are now derived from a stable hash
  of the event content plus an occurrence counter for legitimate duplicates.

- **Loop-guard tripped → chat input frozen.** SNACA's `turn_engine` emits Error
  without a paired Done on engine failures (e.g. `LoopGuardTripped`); the
  renderer's turn state machine now finalizes on either event, so the stop button
  releases and the input enables itself for a retry.
- **Auto-generated titles never fired.** SNACA's `session.new_thread` returns
  `"New conversation"` as a non-empty sentinel when no title is supplied; the
  renderer mistook that for a user-assigned title and skipped summarization. Now
  the sentinel is recognized and the summary runs as designed. Same fix surfaces
  the localized placeholder in the header on Chinese UI.
- **History browser stale until reopen.** Write sites (`NewLabelDialog`,
  `AutoLabelScheduler`, SNACA tool-step recorder) now broadcast on
  `historyUIBus`; the open browser refetches the affected tab immediately.
- **Edit-proposal cards vanished from legacy turns.** When the per-event timeline
  was promoted to the source of truth for ordering, IDB records written before
  that change still had `proposals` but no proposal events — the read path now
  back-fills missing events on hydrate.
- **Drag-select across user messages.** The hover-revealed per-message rollback
  button used to split selections that crossed it. It now drops out of the
  hit-test while a non-collapsed selection is active.
- **"No project open" when opening history.** `ProjectRuntimeContext.projectId`
  was never being set by anyone — history actions read directly from the OT
  service path or the active tab now.
- **OT joinFile race after tab switch.** OT connection lifecycle and per-file
  `join` were merged into a single effect that tore down the WebSocket on tab
  changes; split into two effects so tab swap no longer re-handshakes OT.
- **`api.dialog.*` defaults were Chinese.** Defaults now go through i18n; native
  dialogs respect the current UI locale.

### Removed

- StellarLatex WASM TeX engine and its asset pipeline.
- Standalone `BrowseLabelsDialog` / `BrowseSessionsDialog` (merged into
  `HistoryBrowserDialog`).
- Per-engine description i18n keys in StatusBar (`fastEnglishOnly`,
  `recommendedUnicode`, `unicodeAndLua`, `modernCompiler`, `wasmNoInstall`,
  `recommendedFullFeatures`, `officialCliTool`, `unicodeSupport`,
  `traditionalLatex`) — dropdown rows no longer show descriptions.
- `MainLayout` wrapper — replaced by the three-panel `WorkspaceMode` model.
- Dead preload-typed `historyApi` (renderer reaches IPC through
  `ipcRenderer.invoke` against the allow-list; the typed bridge was a stale
  duplicate).

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
  Content from [Imbad0202/academic-research-skills](https://github.com/Imbad0202/academic-research-skills);
  project- or tenant-scoped Skills still override them.
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
