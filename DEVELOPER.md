# SciPen Studio - Developer Guide

> **The Owner's Manual for Contributors**

This document is for anyone working on the SciPen Studio codebase. It covers architectural decisions, patterns to follow, and how to extend the application correctly.

---

## 📖 Table of Contents

- [Architecture Overview](#architecture-overview)
- [Dependency Injection (DI)](#dependency-injection-di)
- [Worker Threads](#worker-threads)
- [Event-Driven State Management](#event-driven-state-management)
- [IPC Communication](#ipc-communication)
- [Testing](#testing)
- [Security](#security)
- [Contributing Guidelines](#contributing-guidelines)

---

## Architecture Overview

SciPen Studio is an Electron application with strict process separation:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           MAIN PROCESS                                  │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐ │
│  │ ServiceContainer │  │  IPC Handlers   │  │    Worker Threads       │ │
│  │   (DI System)    │──│ (Type-Safe)     │  │ ┌─────┐┌─────┐         │ │
│  │                  │  │                 │  │ │ PDF ││Comp.│         │ │
│  │ ┌──────────────┐ │  │ ┌─────────────┐ │  │ └─────┘└─────┘         │ │
│  │ │ AIService    │ │  │ │ aiHandlers  │ │  │ ┌─────┐┌─────┐         │ │
│  │ │ FileSystem   │ │  │ │ fileHandlers│ │  │ │File ││ Log │         │ │
│  │ │ Compiler ... │ │  │ │ ...         │ │  │ └─────┘└─────┘         │ │
│  │ └──────────────┘ │  │ └─────────────┘ │  └─────────────────────────┘ │
│  └─────────────────┘  └─────────────────┘                               │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ IPC (contextBridge)
                                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         RENDERER PROCESS                                │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐ │
│  │ ServiceRegistry │  │ React Components│  │   Monaco Editor         │ │
│  │ (Event-Driven)  │  │ (UI Layer)      │  │   PDF Viewer            │ │
│  └─────────────────┘  └─────────────────┘  └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

### Key Principles

1. **Interface-First Design**: All services define interfaces before implementation
2. **Dependency Injection**: Services are resolved via containers, never imported directly
3. **Event-Driven Communication**: VS Code-style `Event`/`Emitter` pattern, not global state
4. **Worker Isolation**: CPU-intensive tasks run in Worker Threads
5. **Type-Safe IPC**: All IPC channels validated with Zod schemas

---

## Dependency Injection (DI)

### Main Process: `ServiceContainer`

The Main process uses a custom DI container located at `src/main/services/ServiceContainer.ts`.

#### Service Registration

Services are registered in `src/main/services/ServiceRegistry.ts`:

```typescript
// src/main/services/ServiceRegistry.ts
import { ServiceContainer, ServiceNames } from './ServiceContainer';
import { createAIService } from './AIService';
import type { IAIService } from './interfaces/IAIService';
import type { ISyncTeXService } from './interfaces/ISyncTeXService';
import { createSyncTeXService } from './SyncTeXService';

export function registerServices(container: ServiceContainer): void {
  // Singleton: same instance for all requests
  container.registerSingleton<IAIService>(
    ServiceNames.AI,
    () => createAIService()
  );

  // Lazy: created on first use, then cached
  container.registerLazy<ISyncTeXService>(
    ServiceNames.SYNCTEX,
    () => createSyncTeXService()
  );

  // Transient: a new instance per resolution (rarely used in this codebase)
  // container.registerTransient<ILogger>(ServiceNames.LOGGER, () => new ConsoleLogger());
}
```

> Service-name constants live in `ServiceContainer.ts` (`export const ServiceNames`) and use `SCREAMING_SNAKE_CASE` (`AI`, `FILE_SYSTEM`, `SYNCTEX`, `LATEX_COMPILER`, `OVERLEAF_FILE_SYSTEM`, …).

#### Service Usage (Correct Way)

```typescript
// ✅ CORRECT: IPC handlers receive dependencies via function arguments
export function registerAIHandlers(deps: AIHandlersDeps): void {
  const { aiService } = deps;

  ipcMain.handle(IpcChannel.AI_Completion, async (_, context: string) => {
    return await aiService.getCompletion(context);
  });
}

// ❌ WRONG: Never import service instances directly
import { aiService } from '../services/AIService'; // FORBIDDEN!
```

> Real handlers in `src/main/ipc/aiHandlers.ts` use `createTypedHandlers` / `registerTypedHandler` from `typedIpc.ts` instead of bare `ipcMain.handle` — the typed wrapper applies Zod validation automatically. The plain form above is shown only for illustration.

#### Interface Definition

All services must have an interface in `src/main/services/interfaces/`:

```typescript
// src/main/services/interfaces/IAIService.ts
export interface IAIService extends Partial<IDisposable> {
  isConfigured(): boolean;
  getCompletion(context: string): Promise<string>;
  chat(messages: AIMessage[]): Promise<string>;
  chatStream(messages: AIMessage[]): AsyncGenerator<StreamChunk>;
  // ... other methods (updateConfig, getConfig, testConnection, stopGeneration, isGenerating)
}
```

#### Wiring in Main Entry

```typescript
// src/main/index.ts
import { getServiceContainer, ServiceNames } from './services/ServiceContainer';
import { registerAIHandlers } from './ipc/aiHandlers';

// Get services from container
const container = getServiceContainer();
const aiService = container.get<IAIService>(ServiceNames.AI);

// Pass to handlers
registerAIHandlers({ aiService });
```

---

## Worker Threads

### Overview

Heavy operations run in isolated Worker Threads to keep the main process responsive:

| Worker | File | Purpose | Transfer Method |
|--------|------|---------|-----------------|
| **Compile** | `compile.worker.ts` | LaTeX / Typst compilation (Tectonic, Tinymist) | Structured Clone |
| **PDF Parser** | `pdf.worker.ts` | PDF text extraction (`pdf-parse`) | Structured Clone |
| **File System** | `file.worker.ts` | Recursive file watching (chokidar) | Structured Clone + Batching |
| **Log Parser** | `logParser.worker.ts` | LaTeX / Typst compile log parsing | Structured Clone |

### Transfer strategy

Most worker payloads are plain objects (file paths, compile options, log chunks) and use structured clone. For large binary data — notably PDF rendering output — prefer `Transferable` (`ArrayBuffer` / typed arrays) to avoid copying:

```typescript
// Structured clone — copies the whole array
this.worker.postMessage({ kind: 'render', pdfBytes: uint8 });

// Transferable — zero-copy, transfers buffer ownership to the worker
const buffer = uint8.buffer;
this.worker.postMessage({ kind: 'render', pdfBytes: uint8 }, [buffer]);
```

Rule of thumb:

| Data Type | Transfer Method | Example |
|-----------|-----------------|---------|
| `ArrayBuffer`, typed arrays | `Transferable` | PDF bytes, compile output |
| Plain objects, strings, small JSON | Structured Clone | File paths, compile options |
| Very large JSON arrays | Consider batching | Large file-tree scans |

### Worker Client Pattern

Each worker has a corresponding client class under `src/main/workers/`:

```typescript
// src/main/workers/PDFWorkerClient.ts (shape simplified for illustration)
export class PDFWorkerClient {
  private worker: Worker | null = null;
  private requestId = 0;
  private pending = new Map<string, { resolve: Function; reject: Function }>();

  async parsePDF(
    filePath: string,
    options?: PDFProcessOptions,
    chunkingConfig?: Partial<ChunkingConfig>,
    abortId?: string
  ): Promise<PDFParseResult> {
    return this.sendRequest('parse', { filePath, options, chunkingConfig, abortId });
  }

  private sendRequest<T>(type: string, payload: unknown, timeout?: number): Promise<T> {
    const id = `pdf-${++this.requestId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage({ id, type, payload });
      // ... timeout handling, abort, etc.
    });
  }
}
```

---

## Event-Driven State Management

### VS Code-Style Events (Not Zustand!)

We use the VS Code event pattern for state management:

```typescript
// shared/utils/event.ts
export type IEvent<T> = (
  listener: (e: T) => unknown,
  thisArgs?: unknown,
  disposables?: IDisposable[] | DisposableStore
) => IDisposable;
export type Event<T> = IEvent<T>; // alias

export class Emitter<T> {
  private listeners: ((e: T) => void)[] = [];
  
  get event(): Event<T> {
    return (listener) => {
      this.listeners.push(listener);
      return { dispose: () => this.removeListener(listener) };
    };
  }
  
  fire(event: T): void {
    this.listeners.forEach(l => l(event));
  }
}
```

### React Integration

Use `useServiceEvent` hook to subscribe to events:

```typescript
// src/renderer/src/services/core/hooks.ts
// useSyncExternalStore-style: pass a getSnapshot callback so React can re-read state
// whenever the event fires, instead of caching an initial value.
export function useServiceEvent<T, E = unknown>(
  event: Event<E>,
  getSnapshot: () => T
): T {
  // ... uses useSyncExternalStore internally
}

// Usage in component
function CompileStatus() {
  const isCompiling = useServiceEvent(
    compileService.onIsCompilingChange,
    () => compileService.isCompiling
  );
  return <StatusBar isCompiling={isCompiling} />;
}
```

> Lower-level hooks (`useEvent`, `useEventValue`, `useEmitter`, `useIpcEvent`) live in `src/renderer/src/hooks/useEvent.ts` and use the initial-value `useState` pattern for one-off event listening. `useServiceEvent` is the service-layer wrapper that always reads fresh state from the service.

### DisposableStore Pattern

Always clean up resources:

```typescript
// src/renderer/src/components/editor/EditorPane.tsx
const disposablesRef = useRef<DisposableStore>(new DisposableStore());

useEffect(() => {
  const disposables = disposablesRef.current;
  
  // Register listeners
  disposables.add(editorService.onDidChangeContent((e) => handleChange(e)));
  disposables.add(compileService.onProgress((p) => updateProgress(p)));
  
  // Cleanup on unmount
  return () => disposables.dispose();
}, []);
```

---

## IPC Communication

### Type-Safe IPC Contract

IPC channels are defined by domain under `shared/ipc/`:

```
shared/ipc/
├── channels.ts          # IpcChannel enum (every channel name)
├── index.ts             # Aggregates IPCApiContract from all domain contracts
├── ai-contract.ts       # IPCAiContract
├── app-contract.ts      # IPCAppContract
├── compile-contract.ts  # IPCCompileContract
├── file-contract.ts     # IPCFileContract
├── im-contract.ts       # IPCImContract
├── lsp-contract.ts      # IPCLspContract
├── ot-contract.ts       # IPCOtContract
├── overleaf-contract.ts # IPCOverleafContract
└── project-contract.ts  # IPCProjectContract
```

Channel names live in `channels.ts`, and each domain contract maps channels to `{ args, result }` shapes:

```typescript
// shared/ipc/channels.ts
export enum IpcChannel {
  File_Read = 'read-file',
  File_Write = 'write-file',
  AI_Completion = 'ai:completion',
  AI_ChatStream = 'ai:chat-stream',
  // ...
}

// shared/ipc/file-contract.ts
export interface IPCFileContract {
  [IpcChannel.File_Read]: {
    args: [filePath: string];
    result: { content: string; mtime: number };
  };
  [IpcChannel.File_Write]: {
    args: [filePath: string, content: string, expectedMtime?: number];
    result: { success: boolean; conflict?: boolean; currentMtime?: number };
  };
}

// shared/ipc/index.ts aggregates: IPCApiContract = IPCFileContract & IPCAiContract & ...
```

> Channel string values follow two patterns: file/window/OT channels use kebab-case verbs (`'read-file'`, `'write-file'`), while newer domains (AI / IM / Overleaf) use `'domain:action'` colons (`'ai:completion'`). Both are valid Electron channel names — the convention is historical, don't try to normalize them.

### Zod Validation

All IPC inputs are validated with Zod schemas. The schema registry lives in `src/main/ipc/ipcSchemas.ts`; `src/main/ipc/typedIpc.ts` wires schemas into the `ipcMain.handle` pipeline:

```typescript
// src/main/ipc/ipcSchemas.ts
import { z } from 'zod';

// Path validation — blocks path traversal and null bytes
const safePathSchema = z.string()
  .min(1)
  .max(4096)
  .refine(p => !p.includes('..'), 'Path traversal not allowed')
  .refine(p => !p.includes('\0'), 'Null bytes not allowed');

export const channelSchemas = new Map<string, z.ZodSchema>([
  [IpcChannel.File_Read, z.tuple([safePathSchema])],
  [IpcChannel.File_Write, z.tuple([
    safePathSchema,
    z.string().max(50 * 1024 * 1024) // 50MB limit
  ])],
  [IpcChannel.AI_ChatStream, z.tuple([
    z.array(z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string().min(1)
    })).min(1),
    z.object({
      maxTokens: z.number().optional(),
      temperature: z.number().min(0).max(2).optional()
    }).optional()
  ])],
]);
```

### Adding a New IPC Channel

1. **Declare the channel name** in `shared/ipc/channels.ts`:
   ```typescript
   export enum IpcChannel {
     MyFeature_DoSomething = 'myfeature:do-something',
   }
   ```

2. **Add or extend a domain contract** (e.g. create `shared/ipc/myfeature-contract.ts` or extend an existing one):
   ```typescript
   export interface IPCMyFeatureContract {
     [IpcChannel.MyFeature_DoSomething]: {
       args: [input: string, options: { flag: boolean }];
       result: { ok: boolean };
     };
   }
   ```
   Then merge it into `IPCApiContract` in `shared/ipc/index.ts`.

3. **Add Zod schema** in `src/main/ipc/ipcSchemas.ts`:
   ```typescript
   channelSchemas.set(IpcChannel.MyFeature_DoSomething, z.tuple([
     z.string(),
     z.object({ flag: z.boolean() })
   ]));
   ```

4. **Implement handler with DI:**
   ```typescript
   // src/main/ipc/myFeatureHandlers.ts
   export interface MyFeatureHandlersDeps {
     myService: IMyService;
   }

   export function registerMyFeatureHandlers(deps: MyFeatureHandlersDeps): void {
     ipcMain.handle(IpcChannel.MyFeature_DoSomething, async (_, input, options) => {
       return await deps.myService.doSomething(input, options);
     });
   }
   ```

5. **Wire in main:**
   ```typescript
   // src/main/index.ts — add the service to ServiceNames first,
   // register it in ServiceRegistry.ts, then resolve it here.
   const myService = container.get<IMyService>(ServiceNames.MY_FEATURE);
   registerMyFeatureHandlers({ myService });
   ```

---

## Testing

### Mock Service Container

Use `createMockContainer` for unit tests:

```typescript
// tests/setup/MockServiceContainer.ts
import { createMockAIService, createMockContainer } from '../setup';

describe('AIHandlers', () => {
  it('should handle chat request', async () => {
    // 1. Create mock services
    const mockAI = createMockAIService({
      isConfigured: true,
      chatResponse: 'Mock response'
    });
    
    // 2. Create mock container
    const container = createMockContainer({
      [ServiceNames.AI]: mockAI
    });
    
    // 3. Get service and test
    const aiService = container.get<IAIService>(ServiceNames.AI);
    const result = await aiService.chat([{ role: 'user', content: 'Hello' }]);
    
    expect(result).toBe('Mock response');
    expect(mockAI.chat).toHaveBeenCalled();
  });
});
```

### Available Mock Factories

```typescript
createMockAIService(overrides?)
createMockFileSystemService(overrides?)
createMockCompilerRegistry(overrides?)
createMockOverleafService(overrides?)
createMockSyncTeXService(overrides?)
```

### Running Tests

```bash
# Unit tests
npm run test:run

# Watch mode
npm run test

# Coverage report
npm run test:coverage

# E2E tests (requires built app)
npm run test:e2e
```

---

## Security

### 1. External Process Execution

The app only spawns vetted binaries shipped under `resources/bin` (TexLab, Tinymist, Marksman) and user-configured TeX engines (Tectonic / pdfLaTeX / XeLaTeX / LuaLaTeX). All spawns go through `LSPService` / `CompilerProviders`, never `shell: true`, and arguments are constructed from validated inputs — never interpolated from raw user strings.

### 2. Path Traversal Prevention

```typescript
// src/main/ipc/ipcSchemas.ts — the real definition has whitelist + blacklist
// + null-byte / traversal checks; the snippet below is the conceptual core.
const safePathSchema = z.string()
  .refine(p => !p.includes('..'), 'Path traversal blocked')
  .refine(p => !p.includes('\0'), 'Null bytes blocked');

// In handlers
const baseName = path.basename(userInput);
const safePath = path.join(allowedDir, baseName);

if (!safePath.startsWith(allowedDir + path.sep)) {
  throw new Error('Path escape attempt blocked');
}
```

### 3. Input Size Limits

```typescript
// Compile content: 10MB max
[IpcChannel.Compile_LaTeX, z.tuple([
  z.string().max(10 * 1024 * 1024)
])]

// File write: 50MB max
[IpcChannel.File_Write, z.tuple([
  safePathSchema,
  z.string().max(50 * 1024 * 1024)
])]
```

### 4. API Key Protection

- All AI API calls happen in Main Process
- API keys never sent to Renderer
- Sensitive data auto-redacted in logs

---

## Contributing Guidelines

### Before Submitting a PR

1. **Run quality checks:**
   ```bash
   npm run lint:check   # OxLint
   npm run format:check # Biome (format + lint)
   npm run typecheck:all # tsc --noEmit (renderer + node)
   npm run test:run     # Vitest unit tests
   ```

2. **Follow DI pattern:**
   - Define interface in `src/main/services/interfaces/`
   - Register in `ServiceRegistry.ts`
   - Pass to handlers via dependency object

3. **Add Zod validation for new IPC channels**

4. **Use Transferable objects for large binary data**

5. **Clean up resources with DisposableStore**

### Code Style

- Formatting: Biome (`biome format` + `biome lint`, run via `npm run format`)
- Linting: OxLint (`npm run lint:check`)
- TypeScript `strict: true`; no unused imports
- Avoid `any`; prefer `unknown` + narrowing at boundaries

### Commit Message Format

```
<type>(<scope>): <description>

[optional body]
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`

Example: `feat(compile): add WASM XeTeX engine fallback`

---

## Quick Reference

### Service Names

Constants are defined in `ServiceContainer.ts` as `SCREAMING_SNAKE_CASE`:

```typescript
ServiceNames.AI                    // IAIService
ServiceNames.CHAT_ORCHESTRATOR     // IChatOrchestrator
ServiceNames.FILE_SYSTEM           // IFileSystemService
ServiceNames.SYNCTEX               // ISyncTeXService
ServiceNames.LATEX_COMPILER        // ICompilerRegistry
ServiceNames.OVERLEAF_FILE_SYSTEM  // IOverleafFileSystemService
ServiceNames.OVERLEAF_COMPILER     // OverleafCompileService
ServiceNames.STUDIO_IM             // StudioIMService
ServiceNames.STUDIO_OT             // StudioOTService
ServiceNames.STUDIO_OVERLEAF_LIVE  // StudioOverleafLiveService
ServiceNames.SELECTION             // ISelectionService
ServiceNames.PROJECT_BINDING       // IProjectBindingService
ServiceNames.PROJECT_CONVERSATION  // ProjectConversationService
ServiceNames.CONFIG                // IConfigManager
```

### Important Files

| Purpose | Location |
|---------|----------|
| DI Container & ServiceNames | `src/main/services/ServiceContainer.ts` |
| Service Registration | `src/main/services/ServiceRegistry.ts` |
| IPC Channel Enum | `shared/ipc/channels.ts` |
| IPC Domain Contracts | `shared/ipc/*-contract.ts` |
| Zod Schemas | `src/main/ipc/ipcSchemas.ts` |
| Typed IPC Wrapper | `src/main/ipc/typedIpc.ts` |
| Event System | `shared/utils/event.ts` |
| Lifecycle Utils | `shared/utils/lifecycle.ts` |
| Test Mocks | `tests/setup/MockServiceContainer.ts` |

---

## WASM Compile Engines

SciPen Studio embeds two WASM compile pipelines so the app can produce a PDF
without a system TeX install:

| Engine id (internal) | UI label      | Toolchain                                          | Targets                       |
| -------------------- | ------------- | -------------------------------------------------- | ----------------------------- |
| `wasm-pdftex`        | BusyTeX pdfTeX  | [BusyTeX](https://github.com/vk-cs/busytex) ESM   | LaTeX (pdfTeX flavor)         |
| `wasm-xetex`         | BusyTeX XeTeX   | BusyTeX ESM                                       | LaTeX (XeTeX flavor)          |
| `wasm-lualatex`      | BusyTeX LuaTeX  | BusyTeX ESM                                       | LaTeX (LuaTeX flavor)         |
| `wasm-typst`         | Typst           | [typst-ts-web-compiler](https://www.npmjs.com/package/@myriaddreamin/typst-ts-web-compiler) v0.6 | Typst                |

Both are wired through the same six-layer IPC + provider pattern as the CLI
engines — refer to the "IPC Communication" section above for the channel /
contract / schema / handler / preload / renderer api flow.

### Why a custom `scipen-wasm://` protocol

Workers spawned from a `file://` page in Chromium can `importScripts(file://)`
synchronously but cannot `fetch(file://)`. BusyTeX and typst-ts both `fetch()`
their data packages and font files at runtime, so a separate privileged scheme
is registered in `src/main/services/WasmAssetProtocol.ts`:

- `supportFetchAPI: true` — bypass the `file://` fetch ban
- `corsEnabled: true` + `Access-Control-Allow-Origin: *` — the worker script is
  loaded same-origin from the renderer URL, but its sub-resources cross-origin
  into `scipen-wasm://`
- `standard: true, secure: true` — required for `WebAssembly.compileStreaming`
  and module-mode Workers

The CSP in `index.html` must include `scipen-wasm:` in `connect-src`,
`script-src`, `worker-src`, and `'wasm-unsafe-eval'` for `script-src` —
without all three, the engine fails silently at fetch / streaming compile time.

### Path resolution: `resolveWasmRoot()`

`WasmAssetProtocol.ts` exports `resolveWasmRoot()` — the single source of truth
for `<app>/out/renderer/wasm/`. Use it anywhere main-side code needs to read
bundled WASM assets directly (e.g. the Typst capability probe reads
`typst-ts/manifest.json` outside the protocol handler). Don't recompute the
path; the layout differs between dev (electron-vite output) and prod
(electron-builder's `asarUnpack` rule).

### Typst font loading strategy

Fonts are bundled, not lazy:

- **Local manifest** (`public/wasm/typst-ts/fonts/manifest.json` + `*.ttf` /
  `*.otf`) — full typst-assets v0.13.1 (17 Latin/math fonts: Libertinus Serif,
  NewCM, NewCMMath, DejaVuSansMono) + Noto CJK SC (5 entries: Serif R/B, Sans
  R/B, Sans Mono Regular). Loaded eagerly on worker init; a failure here is
  fatal.
- **Remote endpoint** (`settings.compiler.typstFontEndpoint`) — optional
  best-effort supplement, e.g. for TC / JP / KR users. URLs ending in `.json`
  are treated as a manifest URL; anything else is treated as a base URL with
  `/manifest.json` appended. A reference manifest is checked in at
  `public/wasm/typst-ts/examples/noto-cjk-sc.json`.

When a missing-font diagnostic surfaces, the CompilerProvider builds a
three-state hint based on `TypstWasmEngine.fontContext`:

| `endpointConfigured` | `endpointReachable` | Hint shown                                       |
| -------------------- | ------------------- | ------------------------------------------------ |
| false                | —                   | "Add a font endpoint to fetch missing glyphs"    |
| true                 | false               | "Remote endpoint fetch failed, check the URL"    |
| true                 | true                | "Endpoint loaded N fonts, glyph still missing"   |

### Engine recycling (typst#334 workaround)

`typst-ts-web-compiler` has a known memory-growth issue where each compile
allocates without releasing fully. The provider in
`src/renderer/src/services/core/CompilerProviders.ts` recycles the engine
every `RECYCLE_THRESHOLD = 50` compiles (close + lazy re-init on next call) —
incremental cache is sacrificed at the cycle boundary but RSS stays bounded.

### Refreshing bundled artifacts

```bash
# LaTeX WASM (BusyTeX)
npm run download:busytex                # full set
npm run download:busytex:minimal        # minimal data packages, smaller install

# Typst WASM
npm run download:typst-wasm:cjk         # bundles Noto CJK SC by default (used by prebuild)
npm run download:typst-wasm             # Latin/math only
npm run download:typst-wasm:no-fonts    # zero fonts, BYO endpoint
```

`prebuild` runs `download:typst-wasm:cjk` to keep the default installer
self-sufficient for Simplified Chinese workflows.

### Known limitations

**SyncTeX is not available for Typst — none of the three Typst engines (CLI
tinymist, CLI typst, WASM typst-ts).** The underlying constraint is in the
toolchain, not our integration:

- The Typst CLI (`typst-cli` and `tinymist`) does not emit a `.synctex.gz`
  file. Typst's source-position metadata is internal and not exposed through
  the binary's output.
- `typst-ts-web-compiler` v0.6.x exposes `query` / `get_ast` /
  `get_semantic_tokens` but **no source-position API** — verified by reading
  the generated `.d.ts`. We cannot reconstruct the mapping at runtime.

Upstream paths that would unblock this:

1. Wait for `typst-ts-web-compiler` to expose source-pos through a new wasm-
   bindgen export (no public timeline as of writing).
2. Switch the Typst preview stack to `reflexo` / `typst-preview`'s rendering
   pipeline, which has a different position-tracking design. This is a large
   rewrite — both the renderer-side viewer and the IPC contract change.

Until one of those lands, Typst projects in SciPen Studio render PDFs but the
"jump to source from PDF" / "jump to PDF from source" actions are disabled.
LaTeX (CLI and BusyTeX WASM `pdftex` / `xetex` / `lualatex`) is unaffected and
keeps session-level SyncTeX.
