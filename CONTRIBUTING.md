# Contributing to SciPen Studio

Thanks for your interest! SciPen Studio is an Electron-based desktop IDE for scientific writing in LaTeX and Typst, with optional AI assistance and Overleaf sync.

## Development setup

Requirements: Node.js 20+ (22.x recommended), npm 10+.

```bash
git clone https://github.com/scipenai/scipen-studio.git
cd scipen-studio
npm run setup        # installs deps + downloads LSP binaries
npm run dev          # electron-vite dev server
```

See [`DEVELOPER.md`](./DEVELOPER.md) for the full architecture overview (main/renderer split, DI container, worker threads, IPC contract).

## Architecture at a glance

```
src/
├── main/           Electron main process — services, IPC handlers, workers
├── preload/        contextBridge API exposed to the renderer
├── renderer/src/   React UI — components, hooks, renderer-side services
shared/             Shared types and IPC contracts (imported by both sides)
tests/              Vitest unit tests + Playwright E2E
```

Key design principles:

- **Interface-first services**: every main-process service has an interface in `src/main/services/interfaces/`
- **Dependency Injection**: services are registered in `ServiceContainer` and passed to IPC handlers via argument objects — never imported directly
- **Type-safe IPC**: channels declared in `shared/ipc/*-contract.ts`, runtime-validated with Zod schemas in `src/main/ipc/ipcSchemas.ts`
- **Event-driven state**: VS Code-style `Emitter` / `Event` pattern instead of global state libraries
- **Worker isolation**: PDF parsing, file watching, compilation, log parsing all run in `worker_threads`

## Code style

- TypeScript `strict: true`
- Formatter: **Biome** (`biome.jsonc`) — run `npm run format` locally, CI runs `format:check`
- Linter: **OxLint** (`.oxlintrc.json`) — run `npm run lint:check` in CI / pre-commit (`npm run lint` auto-fixes)
- Imports: no unused imports (enforced), absolute aliases via `tsconfig.json` `paths`
- Comments: English only; prefer **why** over **what**; avoid trivial WHAT comments

## Hard limits

Match [the project style guide](./CLAUDE.md) where applicable:

- Functions: ≤ 50 lines → split if you exceed
- Files: ≤ 500 lines → extract modules
- Nesting: ≤ 3 levels → early-return or helper function
- Function parameters: ≤ 5 → use a DTO/options object

## Testing

```bash
npm run test:run        # Vitest unit tests
npm run test:e2e        # Playwright end-to-end
npm run typecheck:all   # tsc --noEmit for renderer + node configs
```

Required before opening a PR:

- [ ] `npm run lint:check` — zero new warnings
- [ ] `npm run typecheck:all` — zero errors
- [ ] `npm run test:run` — all unit tests pass
- [ ] If you touched an IPC channel: Zod schema added to `src/main/ipc/ipcSchemas.ts`
- [ ] If you touched a service: interface in `src/main/services/interfaces/` is up to date
- [ ] Feature under `src/renderer/src/components/**`: manual smoke test in a real Electron window

Tests live in `tests/electron/`, `tests/renderer/`, and `tests/e2e/`. Mock factories for DI-injected services are in `tests/setup/MockServiceContainer.ts`.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/):

- `feat(scope): ...` — new user-visible feature
- `fix(scope): ...` — bug fix
- `refactor(scope): ...` — restructure without behavior change
- `docs(scope): ...` — documentation
- `test(scope): ...` — test changes only
- `chore(scope): ...` — build/tooling/dependency updates
- `perf(scope): ...` — performance improvement

Common scopes: `editor`, `ot`, `im`, `overleaf`, `compile`, `lsp`, `ui`, `settings`, `ipc`.

## Branch naming

- `feature/<short-description>` — new work
- `fix/<short-description>` — bug fixes
- `refactor/<short-description>` — restructuring

## Security

Never commit secrets (API keys, tokens, `.env.local`). `.gitignore` already excludes `.env*`. If you suspect a secret leaked, rotate it immediately and see [`SECURITY.md`](./SECURITY.md) for the private disclosure process.

Dual-use paths to watch for in reviews:

- Path-traversal in IPC handlers that touch the filesystem (`src/main/ipc/file*.ts`, `PathSecurityService`)
- External process execution (LSP / compiler binaries spawned from `resources/bin` must be path-validated)
- Input size caps on IPC Zod schemas (compile content, AI prompt payloads)

## License

By contributing, you agree that your contributions will be licensed under the MIT License. See [`LICENSE`](./LICENSE).
