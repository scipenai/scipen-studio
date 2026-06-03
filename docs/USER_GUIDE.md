# SciPen Studio User Guide

> **Version:** 0.3.0-pre.1
> **Last updated:** 2026-06-04

**English** · [简体中文](USER_GUIDE.zh-CN.md)

---

## Table of contents

1. [Getting started](#getting-started)
2. [Editor](#editor)
3. [Compile and PDF preview](#compile-and-pdf-preview)
4. [AI assistant](#ai-assistant)
5. [Overleaf integration](#overleaf-integration)
6. [Settings](#settings)
7. [Keyboard shortcuts](#keyboard-shortcuts)
8. [FAQ](#faq)

---

## Getting started

### Install

1. Download the installer for your platform (Windows / macOS / Linux) from [GitHub Releases](https://github.com/scipenai/scipen-studio/releases).
2. Run the installer and follow the prompts.
3. On first launch, configure AI as needed:
   - **Chat / Agent:** the SNACA agent runtime ships **inside the app** — no external server to run. Open *Settings → AI* and pick a chat provider (OpenAI / Anthropic / DeepSeek / OpenAI-compatible) so the agent has an LLM to talk to.
   - **Editor inline completion:** add an OpenAI / Anthropic API key under *Settings → AI*.
   - **Optional:** *Settings → Agent → Web search* — paste a Tavily API key if you want the agent to use the **WebSearch** tool (WebFetch works without a key).
   - All paths are independent — you can configure any subset.

> macOS users: first launch may show "App is damaged / can't be opened." This is Gatekeeper rejecting an unsigned build, not an actual problem. Either right-click the app and choose *Open* (then *Open* again in the dialog), or in Terminal run `xattr -dr com.apple.quarantine "/Applications/SciPen Studio.app"`. Windows users may see a SmartScreen warning — click *More info → Run anyway*.

### Open a project

The welcome screen offers three entry points:

- **Open local project** — pick a local folder containing `.tex` / `.typ` / `.md` files; SciPen Studio scans the directory and builds a file tree.
- **Cloud project** — after connecting to Overleaf, browse and download a remote project to disk.
- **Recent projects** — recently opened projects are listed at the bottom of the welcome screen for one-click reopen.

> The current release ships no LaTeX / Typst project templates. To start a new document, create an empty folder yourself and open it via *Open local project*.

### First compile

1. Open any `.tex` or `.typ` file.
2. Click **Compile** in the toolbar or press `Ctrl+Enter`.
3. By default the bundled **WASM compiler** (StellarLatex pdfTeX) runs — no local TeX installation required.
4. The PDF preview on the right updates automatically. Click on the PDF to jump back to the source; `Ctrl+click` in the editor jumps forward to the matching PDF location (SyncTeX).

---

## Editor

### Supported file types

| Type | Extensions | LSP |
|------|------------|-----|
| LaTeX | `.tex`, `.bib`, `.sty`, `.cls` | TexLab |
| Typst | `.typ` | Tinymist |
| Markdown | `.md` | Marksman |

LSP binaries ship with the installer — **no manual setup needed**.

### Key capabilities

- Syntax highlighting, completion, diagnostics, hover documentation
- Go-to-definition (`Ctrl+click`) and find-references
- Section / environment-block folding
- Multi-cursor (`Alt+click`) and column selection
- Find / replace (`Ctrl+F` / `Ctrl+H`)
- Command palette (`Ctrl+P`) — global command search and file jump

---

## Compile and PDF preview

### Compile engines

| Engine | Notes | Local install required |
|--------|-------|------------------------|
| **WASM pdfTeX** (default) | Bundled StellarLatex, works out of the box | No |
| **WASM XeTeX** | Bundled, supports Unicode / CJK | No |
| **Tectonic** | Fetches packages on demand, good for larger projects | Yes |
| **TeX Live** (pdfLaTeX / XeLaTeX / LuaLaTeX) | Full distribution | Yes |

Switch the default engine under *Settings → Compiler*, or override per project via the toolbar engine selector.

### PDF preview

- Rendered with pdf.js — arbitrary zoom, virtualized scroll, CJK glyph support
- **Two-way SyncTeX** — `Ctrl+click` in the editor jumps to the corresponding PDF location; click on the PDF jumps back to the source
- The editor side panel shows compile errors; clicking an error entry jumps to the matching line

> Hovering over a LaTeX formula in the editor shows a KaTeX-rendered preview (independent of the PDF rendering layer).

---

## AI assistant

> SciPen Studio splits AI into two independent paths:
> - **Chat / agent / formula generation / text polish** → routed through the **built-in SNACA agent runtime** (ships inside the app — no external server)
> - **Editor inline completion** → direct API calls (OpenAI / Anthropic, etc.)
>
> The two paths don't depend on each other.

### 1. Project chat

Ask questions in the chat panel — the assistant answers using your currently open files as context.
- Type `@` in the input to open a file picker; any project file can be referenced as context (e.g. `@chapters/intro.tex`)
- When a compile fails, the error log is automatically attached as context for diagnostic help
- Pick the chat provider/model under *Settings → AI* (the same screen as inline completion). Anthropic models also get **prompt-cache hits** across turns (base prompt + project memory stay cached; only the per-turn recall block changes)

### 2. Agent tools (built-in)

Once a chat model is configured, the assistant can call tools to read / edit project files and ground its answers in real data. Every bot-authored edit surfaces as a **Diff Review** card before it lands:
- Inline green / yellow / red decorations show additions / modifications / deletions
- A top overlay bar offers *Accept All* / *Reject All*
- Each hunk has its own ✓ / ✗ buttons

Built-in tools include `Read` / `Write` / `Edit` / `MultiEdit` / `Grep` / `Glob` / `LS` / `Bash` / `Skill` / memory + Zotero / **WebSearch / WebFetch** / **AskUserQuestion**. The high-risk ones (file mutations, shell, Bash) route through an **approval card** in chat — *Allow once*, *Always allow*, or *Deny*.

### 3. AskUserQuestion (interactive multiple-choice)

When the agent isn't sure what you want, it can put a card in the chat asking you to pick:
- One card holds **1–4 questions**, each with **2–4 options** (single- or multi-select)
- Every question has an implicit **Other** field — type a free-form answer instead
- Click *Submit* — your selection becomes the agent's next step verbatim
- Long-running cards are still cancellable: closing the project / aborting the turn reclaims them

The card disappears as soon as you submit. The model then sees your answer as its next tool result and continues the turn.

### 4. Web search and fetch

The agent has two web tools out of the box:
- **WebFetch** — fetches one page and feeds the rendered text to the model. No key needed.
- **WebSearch** — runs a Tavily search and returns top-N results. Requires a **Tavily API key** (free tier at <https://tavily.com>). Configure under *Settings → Agent → Web search*. Without a key, WebSearch still appears in the tool list but returns a friendly "missing key" error — WebFetch keeps working.

The Tavily key is held only in the agent process env at spawn time and never persists into the agent config file.

### 5. Bundled academic-research Skills

Four Skills ship inside the installer (under the SNACA *Bundled* scope) and work with no configuration:
- `academic-paper` — drafting / structuring an academic paper (intake → outline → draft → revise)
- `academic-paper-reviewer` — single-blind peer review for a manuscript
- `academic-pipeline` — orchestrate the whole literature → paper pipeline
- `deep-research` — multi-source fact-checked report

Tenant- or project-scoped Skills (`<workspace>/.scipen/skills/...`) override bundled ones with the same name, so you can customise behaviour without forking the app.

### 6. Memory and Skills viewer

The agent remembers user preferences and project facts in per-project markdown under
`~/.scipen-studio/snaca/<tenant>/projects/<project>/memory/`. Two read-only inspectors are available from *Settings → Agent*:
- **Memory viewer** — browse / search what's been written for the active project, see source (extractor vs user) and self-rated confidence
- **Skills viewer** — list all Skills currently in scope (Bundled / Tenant / Project), inspect their body

Low-confidence extractor entries are filtered out of automatic recall (configurable floor); they still show in the viewer.

---

## Overleaf integration

### Connect

1. On the welcome screen, click **Cloud project** to open the Overleaf connection dialog.
2. Fill in the server URL (default `https://www.overleaf.com`) and a session cookie (e.g. `overleaf_session2=...`, copyable from the Network panel of your browser's DevTools).
3. Click connect. The cookie is stored locally, and your project list is pulled for selection.

### Open a remote project

After a successful connection:
1. Pick *Overleaf project* on the welcome screen.
2. The selected project is **downloaded to disk** (`~/.scipen-studio/overleaf-projects/{project-name}/`).
3. From that point on you work locally — fully offline-capable.

### Sync strategy

SciPen Studio uses a **local-first + background sync** model:

- **Local writes** — save lands on disk first (local disk is the source of truth, edits have no network latency)
- **Background push** — after save, edits are pushed to Overleaf asynchronously, never blocking the editor
- **Three-way merge** — on push, base (last-synced snapshot) / local / remote are compared:
  - Local changes only → push directly
  - Remote changes only → pull and overwrite local
  - Both sides changed → a **conflict-resolution dialog** opens, asking you to keep local or accept remote

---

## Settings

Open the settings panel from the command palette (`Ctrl+P`, search "Open Settings") or click the settings button in the top-right corner.

### General

| Option | Description |
|--------|-------------|
| Theme | Light / Dark / Follow system |
| Language | English / 中文 |
| Font | Editor font family and size |

### AI

| Option | Description |
|--------|-------------|
| Provider | OpenAI / Anthropic / DeepSeek / OpenAI-compatible endpoint |
| API Key | Stored locally |
| API Host | Custom endpoint, for private proxies or aggregator services |
| Chat model | Used by the **built-in agent** for chat / tool-use turns |
| Completion model | Used for **editor inline completion** (`Ctrl+L`) |

> The chat model is the only thing the agent strictly needs. The agent runtime itself ships inside the app — no separate server.

### Agent

| Option | Description |
|--------|-------------|
| Approval mode | How the agent confirms before file mutations / shell tools: *Interactive* (default; pop a card) / *Auto-allow* / *Auto-deny*. *Auto-allow* is a CI-style default — not recommended for a desktop user. |
| Web search → Tavily API key | Required for the **WebSearch** tool; **WebFetch** works without it. Saving restarts the agent runtime so the change takes effect. Leave empty to disable WebSearch. |
| Engine knobs (folded) | `max_iterations` / `loop_guard_max_repeats` / `concurrent_tool_limit` / `max_tokens` / `history_limit` / `compact_after_input_tokens` / cache + memory tunables. Most users never touch these; defaults are model-aware. |
| Memory viewer | Open the secondary window listing memory entries for the active project. |
| Skills viewer | List all Skills currently in scope (Bundled / Tenant / Project) and inspect their content. |

### Compiler

| Option | Description |
|--------|-------------|
| LaTeX engine | WASM pdfTeX / WASM XeTeX / Tectonic / TeX Live |
| Typst engine | Compiled via the bundled Tinymist |
| TeX Live package endpoint | URL the WASM compiler uses to fetch TeX packages on demand (leave blank for the default, or point to your own mirror) |

### Keyboard shortcuts

Customize the bindings for compile, AI invocation, command palette, and other commands under the *Shortcuts* tab.

---

## Keyboard shortcuts

> On macOS, some shortcuts use `Cmd` instead of `Ctrl`. Bindings can be customized under *Settings → Shortcuts*.

### File / window

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` | Save current file |
| `Ctrl+Shift+N` | New window |
| `Ctrl+P` | Command palette / file jump |
| `Cmd+W` (macOS) / `Alt+F4` (Windows · Linux) | Close window / quit app |

### Edit

| Shortcut | Action |
|----------|--------|
| `Ctrl+Z` / `Ctrl+Y` | Undo / redo |
| `Ctrl+F` / `Ctrl+H` | Find / replace |
| `Shift+Alt+↓` / `Shift+Alt+↑` | Copy line down / up |
| `Alt+↑` / `Alt+↓` | Move line up / down |
| `Alt+click` | Add cursor |
| `Ctrl+D` | Add next match to selection (Monaco default) |

### Compile and preview

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` | Compile current document |
| `Ctrl+click` (editor) | SyncTeX forward jump |
| Click (PDF) | SyncTeX reverse jump |

### AI

| Shortcut | Action |
|----------|--------|
| `Ctrl+L` | Invoke AI on the current selection |
| `@` (AI input) | Reference a project file |

### Interface

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+V` | Toggle PDF preview pane |

> There is no dedicated shortcut for "Open Settings" yet — search "Open Settings" in the command palette (`Ctrl+P`), or click the settings button in the top-right corner.

---

## FAQ

### Q: Compile fails saying it can't find a LaTeX engine?

**A:** The default is the bundled WASM engine, no external toolchain required. If you switched to Tectonic / TeX Live but haven't installed it:
- Install [Tectonic](https://tectonic-typesetting.github.io/) (lightweight, fetches packages on demand)
- Or install [TeX Live](https://www.tug.org/texlive/)
- Or switch back to *WASM pdfTeX* under *Settings → Compiler → Default engine*

### Q: PDF preview is blank?

**A:** Common causes:

1. Compile hasn't succeeded yet — check the build log below
2. The WASM engine takes a few seconds to load on first run
3. The document is too large — consider splitting it into chapters
4. Try restarting the app

### Q: macOS says "App is damaged / can't be opened"

**A:** That's Gatekeeper rejecting an unsigned build (pre-1.0 releases ship unsigned). The app is fine. Either:
- Right-click *SciPen Studio.app* → *Open* → *Open* in the confirmation dialog, or
- Run `xattr -dr com.apple.quarantine "/Applications/SciPen Studio.app"` in Terminal.

### Q: Windows shows a SmartScreen warning

**A:** Same situation as Gatekeeper: pre-1.0 builds are unsigned. Click *More info* → *Run anyway*.

### Q: The agent says "WebSearch unsupported / no Tavily API key"

**A:** WebSearch needs a Tavily key. Get one free at <https://tavily.com>, paste it under *Settings → Agent → Web search → Tavily API key*. The agent runtime restarts automatically and WebSearch becomes available on the next turn. WebFetch (fetching a single page) works without a key.

### Q: Will the agent edit my files without asking?

**A:** No, by default *Approval mode* is **Interactive**: any file-mutation tool (Edit / Write / MultiEdit) and any shell command surface an approval card in chat. You decide *Allow once* / *Always allow* / *Deny*. The result of an *Always allow* decision is remembered per project. Switch to *Auto-allow* only if you're comfortable letting the agent run unsupervised.

### Q: How do I update the app?

**A:** SciPen Studio ships with built-in auto-update (against GitHub Releases) and prompts you when a new version is available. You can also download manually from [Releases](https://github.com/scipenai/scipen-studio/releases); local data and settings are preserved across installs.

---

## Getting help

- **GitHub Issues:** <https://github.com/scipenai/scipen-studio/issues>
- **GitHub Discussions:** <https://github.com/scipenai/scipen-studio/discussions>

---

*Thanks for using SciPen Studio.*
