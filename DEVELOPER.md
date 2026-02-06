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
│  │   (DI System)    │──│ (Type-Safe)     │  │ ┌─────┐┌─────┐┌─────┐  │ │
│  │                  │  │                 │  │ │ PDF ││ SQL ││ Vec │  │ │
│  │ ┌──────────────┐ │  │ ┌─────────────┐ │  │ └─────┘└─────┘└─────┘  │ │
│  │ │ AIService    │ │  │ │ aiHandlers  │ │  │ ┌─────┐┌─────┐┌─────┐  │ │
│  │ │ FileService  │ │  │ │ fileHandlers│ │  │ │Comp.││File ││ Log │  │ │
│  │ │ Knowledge... │ │  │ │ ...         │ │  │ └─────┘└─────┘└─────┘  │ │
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
import { ServiceContainer } from './ServiceContainer';
import { ServiceNames } from './ServiceNames';
import { AIService } from './AIService';
import type { IAIService } from './interfaces/IAIService';

export function registerServices(container: ServiceContainer): void {
  // Singleton: Same instance for all requests
  container.registerSingleton<IAIService>(
    ServiceNames.AI, 
    () => new AIService()
  );
  
  // Lazy: Created on first use, then cached
  container.registerLazy<IKnowledgeService>(
    ServiceNames.Knowledge,
    () => new MultimodalKnowledgeService(/* deps */)
  );
  
  // Transient: New instance every time
  container.registerTransient<ILogger>(
    ServiceNames.Logger,
    () => new ConsoleLogger()
  );
}
```

#### Service Usage (Correct Way)

```typescript
// ✅ CORRECT: IPC handlers receive dependencies via function arguments
export function registerAIHandlers(deps: AIHandlersDeps): void {
  const { aiService, knowledgeService } = deps;
  
  ipcMain.handle(IpcChannel.AI_Chat, async (_, messages) => {
    return await aiService.chat(messages);
  });
}

// ❌ WRONG: Never import service instances directly
import { aiService } from '../services/AIService'; // FORBIDDEN!
```

#### Interface Definition

All services must have an interface in `src/main/services/interfaces/`:

```typescript
// src/main/services/interfaces/IAIService.ts
export interface IAIService extends IDisposable {
  isConfigured(): boolean;
  chat(messages: ChatMessage[]): Promise<string>;
  polishText(text: string): Promise<string>;
  // ... other methods
}
```

#### Wiring in Main Entry

```typescript
// src/main/index.ts
import { serviceContainer } from './services/ServiceContainer';
import { registerAIHandlers } from './ipc/aiHandlers';

// Get services from container
const aiService = serviceContainer.getService<IAIService>(ServiceNames.AI);
const knowledgeService = serviceContainer.getService<IKnowledgeService>(ServiceNames.Knowledge);

// Pass to handlers
registerAIHandlers({ aiService, knowledgeService });
```

---

## Worker Threads

### Overview

Heavy operations run in isolated Worker Threads to prevent Main Process blocking:

| Worker | File | Purpose | Transfer Method |
|--------|------|---------|-----------------|
| **Vector Search** | `vectorSearch.worker.ts` | HNSW index operations | `Transferable` (Zero-copy) |
| **SQLite** | `sqlite.worker.ts` | Database operations | `Transferable` for embeddings |
| **PDF Parser** | `pdf.worker.ts` | PDF text extraction | Structured Clone |
| **File System** | `file.worker.ts` | File watching (chokidar) | Structured Clone + Batching |
| **Compile** | `compile.worker.ts` | LaTeX/Typst compilation | Structured Clone |
| **Log Parser** | `logParser.worker.ts` | Compile log parsing | Structured Clone |

### Zero-Copy Transfer (Transferable Objects)

For large binary data (e.g., embedding vectors), we use `Transferable` objects:

```typescript
// src/main/workers/VectorSearchClient.ts

// ✅ CORRECT: Zero-copy transfer of Float32Array
async search(embedding: number[]): Promise<SearchResult[]> {
  // Convert to typed array
  const float32 = new Float32Array(embedding);
  
  // Transfer buffer ownership (no copy!)
  const buffer = float32.buffer;
  return this.sendMessage('search', { embedding: buffer }, [buffer]);
}

// ❌ WRONG: Structured clone copies the entire array
return this.sendMessage('search', { embedding: embedding }); // Copies data!
```

**When to use which:**

| Data Type | Transfer Method | Example |
|-----------|-----------------|---------|
| Float32Array, ArrayBuffer | `Transferable` | Embeddings, PDF binary |
| Plain objects, strings | Structured Clone | Metadata, file paths |
| Large JSON arrays | Consider batching | File tree, search results |

### Worker Client Pattern

Each worker has a corresponding client class:

```typescript
// src/main/workers/VectorSearchClient.ts
export class VectorSearchClient {
  private worker: Worker;
  private requestMap = new Map<number, { resolve, reject }>();
  
  async search(options: SearchOptions): Promise<SearchResult[]> {
    return this.sendMessage<SearchResult[]>('search', options, [transferables]);
  }
  
  private sendMessage<T>(type: string, payload: any, transfer?: Transferable[]): Promise<T> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.requestMap.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, payload }, transfer || []);
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
export interface Event<T> {
  (listener: (e: T) => void): IDisposable;
}

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
// src/renderer/src/hooks/useEvent.ts
export function useServiceEvent<T>(event: Event<T>, initialValue: T): T {
  const [value, setValue] = useState(initialValue);
  
  useEffect(() => {
    const disposable = event((newValue) => setValue(newValue));
    return () => disposable.dispose();
  }, [event]);
  
  return value;
}

// Usage in component
function CompileStatus() {
  const isCompiling = useServiceEvent(compileService.onIsCompiling, false);
  const progress = useServiceEvent(compileService.onProgress, 0);
  
  return <StatusBar isCompiling={isCompiling} progress={progress} />;
}
```

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

All IPC channels are defined in `shared/api-types.ts`:

```typescript
// shared/api-types.ts
export enum IpcChannel {
  // File operations
  File_Read = 'file:read',
  File_Write = 'file:write',
  
  // AI operations
  AI_Chat = 'ai:chat',
  AI_Polish = 'ai:polish',
  
  // ...
}

export interface IPCApiContract {
  [IpcChannel.File_Read]: {
    args: [filePath: string];
    return: { content: string } | null;
  };
  [IpcChannel.AI_Chat]: {
    args: [messages: ChatMessage[], options?: ChatOptions];
    return: string;
  };
}
```

### Zod Validation

All IPC inputs are validated with Zod schemas:

```typescript
// src/main/ipc/typedIpc.ts
import { z } from 'zod';

// Path validation - prevents path traversal
const safePathSchema = z.string()
  .min(1)
  .max(4096)
  .refine(p => !p.includes('..'), 'Path traversal not allowed');

export const channelSchemas = new Map<string, z.ZodSchema>([
  [IpcChannel.File_Read, z.tuple([safePathSchema])],
  [IpcChannel.File_Write, z.tuple([
    safePathSchema,
    z.string().max(50 * 1024 * 1024) // 50MB limit
  ])],
  [IpcChannel.AI_Chat, z.tuple([
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

1. **Define in shared types:**
   ```typescript
   // shared/api-types.ts
   export enum IpcChannel {
     MyFeature_DoSomething = 'myfeature:do-something',
   }
   ```

2. **Add Zod schema:**
   ```typescript
   // src/main/ipc/typedIpc.ts
   channelSchemas.set(IpcChannel.MyFeature_DoSomething, z.tuple([
     z.string(),
     z.object({ option: z.boolean() })
   ]));
   ```

3. **Implement handler with DI:**
   ```typescript
   // src/main/ipc/myFeatureHandlers.ts
   export interface MyFeatureHandlersDeps {
     myService: IMyService;
   }
   
   export function registerMyFeatureHandlers(deps: MyFeatureHandlersDeps): void {
     ipcMain.handle(IpcChannel.MyFeature_DoSomething, async (_, arg1, options) => {
       return await deps.myService.doSomething(arg1, options);
     });
   }
   ```

4. **Wire in main:**
   ```typescript
   // src/main/index.ts
   const myService = container.getService<IMyService>(ServiceNames.MyService);
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
createMockKnowledgeService(overrides?)
createMockAgentService(overrides?)
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

### 1. Command Execution Whitelist

Only approved commands can be executed:

```typescript
// src/main/services/AgentService.ts
private static readonly ALLOWED_COMMANDS = new Set([
  'scipen-pdf2tex',
  'scipen-review', 
  'scipen-beamer'
]);

async executeCommand(command: string, args: string[]): Promise<Result> {
  if (!this.isAllowedCommand(command)) {
    return { success: false, message: 'Command not allowed' };
  }
  
  // shell: false prevents injection
  spawn(command, args, { shell: false });
}
```

### 2. Path Traversal Prevention

```typescript
// src/main/ipc/typedIpc.ts
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

// Knowledge base documents: 50MB max
[IpcChannel.Knowledge_AddDocument, z.tuple([
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
   npm run lint        # OxLint + ESLint + Biome
   npm run typecheck   # TypeScript strict mode
   npm run test:run    # All unit tests
   ```

2. **Follow DI pattern:**
   - Define interface in `src/main/services/interfaces/`
   - Register in `ServiceRegistry.ts`
   - Pass to handlers via dependency object

3. **Add Zod validation for new IPC channels**

4. **Use Transferable objects for large binary data**

5. **Clean up resources with DisposableStore**

### Code Style

- Formatting: Biome (auto-formatted on save)
- Linting: OxLint + ESLint + Biome
- No unused imports (enforced)
- No `any` types (enforced)

### Commit Message Format

```
<type>(<scope>): <description>

[optional body]
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`

Example: `feat(knowledge): add hybrid retrieval with RRF fusion`

---

## Quick Reference

### Service Names

```typescript
ServiceNames.AI           // IAIService
ServiceNames.Knowledge    // IKnowledgeService  
ServiceNames.FileSystem   // IFileSystemService
ServiceNames.SyncTeX      // ISyncTeXService
ServiceNames.Overleaf     // IOverleafService
ServiceNames.Compiler     // ICompilerRegistry
```

### Important Files

| Purpose | Location |
|---------|----------|
| DI Container | `src/main/services/ServiceContainer.ts` |
| Service Registration | `src/main/services/ServiceRegistry.ts` |
| IPC Channels | `shared/api-types.ts` |
| Zod Validation | `src/main/ipc/typedIpc.ts` |
| Event System | `shared/utils/event.ts` |
| Lifecycle Utils | `shared/utils/lifecycle.ts` |
| Test Mocks | `tests/setup/MockServiceContainer.ts` |

---

*Last updated: January 2026*

