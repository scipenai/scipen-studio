# SciPen Studio 开发指南

本文档描述了 SciPen Studio 的架构设计和开发规范，帮助开发者快速上手并保持代码质量。

## 目录

- [架构概览](#架构概览)
- [开发规范](#开发规范)
- [Git 规范](#git-规范)
- [代码审查清单](#代码审查清单)

---

## 架构概览

### 核心设计模式

SciPen Studio 采用 **VS Code 风格的服务架构**，核心特点：

```
┌─────────────────────────────────────────────────────────────┐
│                      React Components                        │
│  (EditorPane, AIPanel, FileExplorer, PreviewPane, etc.)     │
└─────────────────────────┬───────────────────────────────────┘
                          │ useSyncExternalStore / useCallback
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                     ServiceRegistry                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ Editor   │ │ AI       │ │ Project  │ │ UI       │       │
│  │ Service  │ │ Service  │ │ Service  │ │ Service  │       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ Settings │ │ Compile  │ │ Backup   │ │ Command  │       │
│  │ Service  │ │ Service  │ │ Service  │ │ Service  │       │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘       │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                    Event Bus (Emitter)                       │
│  onDidChangeContent, onDidChangeSettings, onDidCompile...   │
└─────────────────────────────────────────────────────────────┘
```

### ServiceRegistry

所有服务通过 `ServiceRegistry` 单例管理，确保：
- 统一的生命周期管理
- 服务间依赖注入
- 便于测试的 Mock 替换

```typescript
// ✅ 正确：通过 getter 函数获取服务
import { getEditorService, getUIService } from '../services/core';

const editorService = getEditorService();
editorService.openFile(path);

// ❌ 错误：直接实例化服务
const service = new EditorService(); // 禁止！
```

### ViewRegistry

UI 视图通过 `ViewRegistry` 动态注册，支持插件化扩展侧边栏面板：

```typescript
import { getViewRegistry, ViewLocation } from '../services/core';
import { Bug } from 'lucide-react';

// 注册自定义视图
const disposable = getViewRegistry().registerView({
  id: 'my-custom-panel',
  name: '自定义面板',
  icon: Bug,
  order: 350,
  component: MyCustomComponent,
  location: ViewLocation.Sidebar,
});

// 注销视图
disposable.dispose();
```

**内置视图 ID**: `files`, `knowledge`, `ai`, `tools`, `aiconfig`, `settings`

### LanguageFeatureRegistry (CompilerRegistry)

编译器通过 `CompilerRegistry` 动态注册，支持多语言扩展：

```typescript
import { getCompileService } from '../services/core';

// 创建自定义编译器 Provider
const markdownProvider: CompilerProvider = {
  id: 'markdown-local',
  name: 'Markdown',
  supportedExtensions: ['md', 'markdown'],
  priority: 10,
  async compile(filePath, content, options) {
    // 实现编译逻辑
    return { success: true, pdfPath: '...' };
  }
};

// 注册到 CompilerRegistry
const disposable = getCompileService()
  .compilerRegistry
  .register(markdownProvider, 10);
```

**内置编译器**: `latex-local`, `typst-local`, `overleaf-remote`

### Event Bus

服务间通信采用事件驱动模式：

```typescript
// 服务内部定义事件
private readonly _onDidChangeContent = new Emitter<ContentChangeEvent>();
readonly onDidChangeContent: Event<ContentChangeEvent> = this._onDidChangeContent.event;

// 组件订阅事件
useEffect(() => {
  const disposable = editorService.onDidChangeContent((e) => {
    console.log('Content changed:', e.path);
  });
  return () => disposable.dispose();
}, []);
```

### 异步模式

使用 `src/renderer/src/utils/async.ts` 中的工具：

| 工具 | 用途 |
|------|------|
| `Delayer` | 防抖执行，支持 Promise |
| `Throttler` | 节流执行，确保顺序 |
| `RunOnceScheduler` | 单次延迟执行 |
| `CancellationToken` | 取消长时间操作 |

```typescript
// 使用 Delayer 进行防抖
const delayer = new Delayer<void>(300);
delayer.trigger(() => {
  // 300ms 内多次调用只执行最后一次
  runDiagnostics();
});

// 使用 CancellationToken 取消操作
const cts = new CancellationTokenSource();
await longRunningTask(cts.token);
// 需要取消时
cts.cancel();
```

---

## 开发规范

### 1. 服务使用规范

```typescript
// ✅ 正确：使用 getter 函数
import { getEditorService } from '../services/core';
const service = getEditorService();

// ❌ 错误：直接 new
import { EditorService } from '../services/core';
const service = new EditorService();

// ✅ 正确：在 React 组件中使用 hooks
import { useEditorTabs, useActiveTabPath } from '../services/core';
const tabs = useEditorTabs();
const activePath = useActiveTabPath();
```

### 2. 类型安全规范

```typescript
// ✅ 正确：定义明确的接口
interface CompileOptions {
  engine: 'pdflatex' | 'xelatex' | 'lualatex';
  mainFile?: string;
}

// ❌ 错误：使用 any
function compile(options: any) { ... }

// ✅ 正确：使用泛型
function get<T>(key: string, defaultValue?: T): T | undefined;

// ❌ 错误：类型断言为 any
const result = data as any;

// ✅ 正确：使用精确的类型断言
const result = data as CompileResult;
```

### 3. 异步操作规范

```typescript
// ✅ 正确：考虑取消操作
async function search(query: string, token: CancellationToken) {
  for (const item of items) {
    if (token.isCancellationRequested) {
      return; // 提前退出
    }
    await processItem(item);
  }
}

// ✅ 正确：使用防抖避免频繁调用
const debouncedSave = useDelayer<void>(1000);
debouncedSave.trigger(() => saveFile());

// ❌ 错误：不考虑取消，可能导致内存泄漏
async function search(query: string) {
  // 如果组件卸载，这里可能继续执行
  const results = await fetchResults(query);
  setResults(results); // 可能更新已卸载的组件
}
```

### 4. 日志规范

```typescript
// ✅ 正确：使用 LogService
import { createLogger } from '../services/LogService';
const logger = createLogger('MyComponent');

logger.info('Operation started', { id: 123 });
logger.warn('Deprecated API used');
logger.error('Operation failed', error);

// ❌ 错误：直接使用 console
console.log('Debug info'); // 会触发 lint 警告
```

### 5. 依赖注入规范

```typescript
// ✅ 正确：通过构造函数注入依赖
export class BackupService {
  constructor(private readonly _fileSystem: IFileSystem = new ElectronFileSystem()) {}
}

// 测试时注入 Mock
const mockFs = new MockFileSystem();
const service = new BackupService(mockFs);
```

### 6. React 组件规范

```typescript
// ✅ 正确：使用 useSyncExternalStore 订阅服务状态
const tabs = useSyncExternalStore(
  editorService.subscribe,
  editorService.getTabs
);

// ✅ 正确：Effect 依赖完整
useEffect(() => {
  const disposable = service.onDidChange(handler);
  return () => disposable.dispose();
}, [service, handler]); // 依赖完整

// ❌ 错误：缺少依赖
useEffect(() => {
  doSomething(value);
}, []); // value 应该在依赖数组中
```

---

## Git 规范

### Commit Message 格式

采用 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

```
<type>(<scope>): <subject>

<body>

<footer>
```

#### Type 类型

| Type | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档更新 |
| `style` | 代码格式（不影响功能） |
| `refactor` | 重构（不是新功能或修复） |
| `perf` | 性能优化 |
| `test` | 测试相关 |
| `chore` | 构建/工具变更 |

#### 示例

```bash
# 新功能
feat(editor): add auto-save functionality

# Bug 修复
fix(compile): resolve XeLaTeX encoding issue on Windows

# 重构
refactor(services): extract CompileService from EditorPane

Extracted compilation logic into dedicated CompileService:
- Support for LaTeX, Typst, and Overleaf compilation
- Event-driven logging via onDidLog
- Reduced EditorPane from 1443 to 1181 lines

# 文档
docs: add CONTRIBUTING.md with architecture overview
```

### 分支命名

```
feature/<issue-id>-<short-description>
fix/<issue-id>-<short-description>
refactor/<description>
```

---

## 代码审查清单

提交 PR 前，请确认：

### 类型安全
- [ ] 没有使用 `any` 类型
- [ ] 所有函数参数和返回值都有类型定义
- [ ] 使用泛型而非类型断言

### 服务架构
- [ ] 通过 `getService()` 获取服务，而非 `new Service()`
- [ ] 新服务已注册到 `ServiceRegistry`
- [ ] 事件订阅在组件卸载时正确清理

### 异步操作
- [ ] 长时间操作支持 `CancellationToken`
- [ ] 使用 `Delayer`/`Throttler` 避免频繁调用
- [ ] Effect 依赖数组完整

### 代码质量
- [ ] 使用 `LogService` 而非 `console.log`
- [ ] 运行 `npm run typecheck` 无错误
- [ ] 运行 `npm run lint` 无错误

---

## 相关文档

- [架构决策记录 (ADR)](./docs/adr/001-service-architecture.md)
- [VS Code 服务架构参考](https://github.com/microsoft/vscode/wiki/Source-Code-Organization)
