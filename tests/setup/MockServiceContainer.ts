/**
 * @file MockServiceContainer.ts
 * @description DI-aware test helpers providing mock implementations of all service interfaces
 * @depends vitest, main/services/interfaces, main/services/ServiceContainer
 */

import { EventEmitter } from 'events';
import { vi } from 'vitest';
import type {
  AIConfig,
  FileNode,
  ForwardSyncResult,
  IAIService,
  IFileSystemService,
  IKnowledgeService,
  IOverleafService,
  ISyncTeXService,
  InverseSyncResult,
  OverleafProject,
  StreamChunk,
} from '../../src/main/services/interfaces';

import { ServiceContainer, ServiceNames } from '../../src/main/services/ServiceContainer';

// ============ Mock Service Types ============

export type MockFn<T = any> = ReturnType<typeof vi.fn<T>>;

// ============ Mock AI Service ============

export interface MockAIServiceOptions {
  isConfigured?: boolean;
  chatResponse?: string;
  completionResponse?: string;
  polishResponse?: string;
  formulaResponse?: string;
  reviewResponse?: string;
  testConnectionResult?: { success: boolean; message: string };
  config?: AIConfig | null;
}

export function createMockAIService(options: MockAIServiceOptions = {}): IAIService {
  const {
    isConfigured = false,
    chatResponse = 'Mock AI response',
    completionResponse = 'Mock completion',
    polishResponse = 'Mock polished text',
    formulaResponse = '\\frac{a}{b}',
    reviewResponse = 'Mock review',
    testConnectionResult = { success: true, message: 'Connection successful' },
    config = null,
  } = options;

  let currentConfig: AIConfig | null = config;
  let generating = false;

  return {
    updateConfig: vi.fn((cfg: AIConfig) => {
      currentConfig = cfg;
    }),
    getConfig: vi.fn(() => currentConfig),
    isConfigured: vi.fn(() => isConfigured || (currentConfig?.apiKey ? true : false)),
    getCompletion: vi.fn().mockResolvedValue(completionResponse),
    polishText: vi.fn().mockResolvedValue(polishResponse),
    chat: vi.fn().mockResolvedValue(chatResponse),
    chatStream: vi.fn(async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'chunk', content: chatResponse };
      yield { type: 'complete' };
    }),
    stopGeneration: vi.fn(() => {
      if (generating) {
        generating = false;
        return true;
      }
      return false;
    }),
    isGenerating: vi.fn(() => generating),
    generateFormula: vi.fn().mockResolvedValue(formulaResponse),
    reviewDocument: vi.fn().mockResolvedValue(reviewResponse),
    testConnection: vi.fn().mockResolvedValue(testConnectionResult),
  };
}

// ============ Mock File System Service ============

export interface MockFileSystemServiceOptions {
  fileTree?: FileNode;
  fileContents?: Map<string, string>;
  mtimeCache?: Map<string, number>;
}

export function createMockFileSystemService(
  options: MockFileSystemServiceOptions = {}
): IFileSystemService {
  const {
    fileTree = { name: 'root', path: '/', type: 'directory', children: [] },
    mtimeCache = new Map(),
  } = options;

  const emitter = new EventEmitter();

  const service = Object.assign(emitter, {
    buildFileTree: vi.fn().mockResolvedValue(fileTree),
    startWatching: vi.fn().mockResolvedValue(undefined),
    stopWatching: vi.fn().mockResolvedValue(undefined),
    recordFileMtime: vi.fn().mockResolvedValue(undefined),
    updateFileMtime: vi.fn((path: string, mtime: number) => {
      mtimeCache.set(path, mtime);
    }),
    getCachedMtime: vi.fn((path: string) => mtimeCache.get(path)),
    getFileExtension: vi.fn((path: string) => {
      const ext = path.split('.').pop() || '';
      return ext.startsWith('.') ? ext : `.${ext}`;
    }),
    isLaTeXFile: vi.fn((path: string) => {
      const ext = path.toLowerCase().split('.').pop();
      return ['tex', 'ltx', 'latex'].includes(ext || '');
    }),
    findMainTexFile: vi.fn().mockResolvedValue(null),
    findFiles: vi.fn().mockResolvedValue([]),
  }) as IFileSystemService;

  return service;
}

// ============ Mock SyncTeX Service ============

export interface MockSyncTeXServiceOptions {
  forwardResult?: ForwardSyncResult | null;
  inverseResult?: InverseSyncResult | null;
}

export function createMockSyncTeXService(options: MockSyncTeXServiceOptions = {}): ISyncTeXService {
  const {
    forwardResult = { page: 1, x: 100, y: 200, width: 400, height: 20 },
    inverseResult = { file: 'main.tex', line: 10, column: 0 },
  } = options;

  return {
    forwardSync: vi.fn().mockResolvedValue(forwardResult),
    inverseSync: vi.fn().mockResolvedValue(inverseResult),
  };
}

// ============ Mock Overleaf Service ============

export interface MockOverleafServiceOptions {
  isLoggedIn?: boolean;
  projects?: OverleafProject[];
}

export function createMockOverleafService(
  options: MockOverleafServiceOptions = {}
): IOverleafService {
  const { isLoggedIn = false, projects = [] } = options;

  const emitter = new EventEmitter();

  const service = Object.assign(emitter, {
    init: vi.fn().mockResolvedValue({ success: true }),
    testConnection: vi.fn().mockResolvedValue({ success: true, message: 'Connected' }),
    login: vi.fn().mockResolvedValue({ success: true, message: 'Logged in' }),
    isLoggedIn: vi.fn(() => isLoggedIn),
    getCookies: vi.fn(() => null),
    getProjects: vi.fn().mockResolvedValue(projects),
    getProjectDetails: vi.fn().mockResolvedValue(null),
    updateProjectSettings: vi.fn().mockResolvedValue(true),
    compile: vi.fn().mockResolvedValue({ success: true, pdfUrl: null, logs: [] }),
    stopCompile: vi.fn().mockResolvedValue(true),
    getBuildId: vi.fn(() => null),
    syncCode: vi.fn().mockResolvedValue(null),
    syncPdf: vi.fn().mockResolvedValue(null),
    getDoc: vi.fn().mockResolvedValue({ success: true, content: '' }),
    updateDoc: vi.fn().mockResolvedValue({ success: true }),
    updateDocDebounced: vi.fn().mockResolvedValue({ success: true }),
    flushUpdates: vi.fn().mockResolvedValue({ success: true }),
    getDocCached: vi.fn().mockResolvedValue(null),
    clearCache: vi.fn().mockResolvedValue(undefined),
  }) as unknown as IOverleafService;

  return service;
}

// ============ Mock Knowledge Service ============

export interface MockKnowledgeServiceOptions {
  libraries?: any[];
  searchResults?: any[];
  isInitialized?: boolean;
}

export function createMockKnowledgeService(
  options: MockKnowledgeServiceOptions = {}
): IKnowledgeService {
  const { libraries = [], searchResults = [], isInitialized = true } = options;

  const emitter = new EventEmitter();

  const service = Object.assign(emitter, {
    initialize: vi.fn().mockResolvedValue(isInitialized),
    updateConfig: vi.fn().mockResolvedValue(undefined),
    createLibrary: vi.fn().mockResolvedValue({ id: 'new-lib', name: 'New Library' }),
    getLibraries: vi.fn().mockResolvedValue(libraries),
    getLibrary: vi.fn().mockResolvedValue(null),
    updateLibrary: vi.fn().mockResolvedValue({}),
    deleteLibrary: vi.fn().mockResolvedValue({ success: true }),
    addDocument: vi.fn().mockResolvedValue({ documentId: 'doc-1' }),
    addText: vi.fn().mockResolvedValue({ documentId: 'text-1' }),
    getDocument: vi.fn().mockResolvedValue(null),
    getDocuments: vi.fn().mockResolvedValue([]),
    deleteDocument: vi.fn().mockResolvedValue({ success: true }),
    reprocessDocument: vi.fn().mockResolvedValue({ taskId: 'task-1' }),
    search: vi.fn().mockResolvedValue(searchResults),
    searchEnhanced: vi.fn().mockResolvedValue({ results: searchResults }),
    query: vi.fn().mockResolvedValue({ answer: 'Mock answer', sources: [] }),
    getTaskStatus: vi.fn().mockResolvedValue(null),
    getQueueStats: vi
      .fn()
      .mockResolvedValue({ pending: 0, processing: 0, completed: 0, failed: 0 }),
    testEmbedding: vi.fn().mockResolvedValue({ success: true, dimension: 1536 }),
    getDiagnostics: vi.fn().mockResolvedValue({}),
    rebuildFTSIndex: vi.fn().mockResolvedValue({ success: true, count: 0 }),
    generateMissingEmbeddings: vi.fn().mockResolvedValue({ success: true, count: 0 }),
    getAdvancedRetrievalConfig: vi.fn().mockResolvedValue({}),
    setAdvancedRetrievalConfig: vi.fn().mockResolvedValue({ success: true }),
    selectFiles: vi.fn().mockResolvedValue(null),
  }) as unknown as IKnowledgeService;

  return service;
}

// ============ Mock Compiler Registry ============

export function createMockCompilerRegistry() {
  const emitter = new EventEmitter();

  return Object.assign(emitter, {
    register: vi.fn(),
    unregister: vi.fn().mockReturnValue(true),
    get: vi.fn().mockReturnValue(undefined),
    getByExtension: vi.fn().mockReturnValue(undefined),
    getByEngine: vi.fn().mockReturnValue(undefined),
    getByFilePath: vi.fn().mockReturnValue(undefined),
    getAll: vi.fn().mockReturnValue([]),
    getEnabled: vi.fn().mockReturnValue([]),
    getLocal: vi.fn().mockReturnValue([]),
    getRemote: vi.fn().mockReturnValue([]),
    setEnabled: vi.fn().mockReturnValue(true),
    isInstantiated: vi.fn().mockReturnValue(false),
    getStatus: vi.fn().mockReturnValue({}),
    clear: vi.fn(),
  });
}

// ============ Mock Service Container ============

export interface MockContainerOptions {
  aiService?: IAIService;
  fileSystemService?: IFileSystemService;
  syncTeXService?: ISyncTeXService;
  overleafService?: IOverleafService;
  knowledgeService?: IKnowledgeService;
  compilerRegistry?: ReturnType<typeof createMockCompilerRegistry>;
}

/**
 * Create a mock ServiceContainer with optional service overrides.
 *
 * Services not explicitly provided will be created with default mock implementations.
 */
export function createMockContainer(options: MockContainerOptions = {}): ServiceContainer {
  const container = new ServiceContainer();

  // Register mock services with defaults
  container.registerSingleton(ServiceNames.AI, () => options.aiService || createMockAIService());

  container.registerSingleton(
    ServiceNames.FILE_SYSTEM,
    () => options.fileSystemService || createMockFileSystemService()
  );

  container.registerSingleton(
    ServiceNames.SYNCTEX,
    () => options.syncTeXService || createMockSyncTeXService()
  );

  container.registerSingleton(
    ServiceNames.OVERLEAF_COMPILER,
    () => options.overleafService || createMockOverleafService()
  );

  container.registerSingleton(
    ServiceNames.KNOWLEDGE,
    () => options.knowledgeService || createMockKnowledgeService()
  );

  // Note: CompilerRegistry is typically registered as 'compilerRegistry'
  // Add if needed for specific tests

  return container;
}

/**
 * Create handler dependencies with mock services.
 *
 * This is useful for testing IPC handlers directly without going through IPC.
 */
export function createMockHandlerDeps<T extends Record<string, unknown>>(
  overrides: Partial<T> = {}
): T {
  const defaultDeps = {
    aiService: createMockAIService(),
    knowledgeService: createMockKnowledgeService(),
    fileSystemService: createMockFileSystemService(),
    syncTeXService: createMockSyncTeXService(),
    overleafService: createMockOverleafService(),
    compilerRegistry: createMockCompilerRegistry(),
    getMainWindow: vi.fn(() => null),
    getWindows: vi.fn(() => new Map()),
  };

  return { ...defaultDeps, ...overrides } as T;
}

// ============ Test Utilities ============

/**
 * Reset all mocks on a service object.
 */
export function resetServiceMocks(service: Record<string, unknown>): void {
  for (const key of Object.keys(service)) {
    const value = service[key];
    if (typeof value === 'function' && 'mockReset' in value) {
      (value as MockFn).mockReset();
    }
  }
}

/**
 * Assert that a service method was called with specific arguments.
 */
export function expectServiceCall(
  service: Record<string, unknown>,
  method: string,
  ...args: unknown[]
): void {
  const fn = service[method];
  if (typeof fn === 'function' && 'toHaveBeenCalledWith' in vi.expect(fn)) {
    expect(fn).toHaveBeenCalledWith(...args);
  } else {
    throw new Error(`${method} is not a mock function`);
  }
}

// Re-export ServiceNames and ServiceContainer for convenience
export { ServiceNames, ServiceContainer };
