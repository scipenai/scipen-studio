/**
 * @file renderer/setup.ts
 * @description Renderer process test setup - configures React Testing Library and DOM environment
 * @depends @testing-library/react, @testing-library/jest-dom, vitest
 */

import * as matchers from '@testing-library/jest-dom/matchers';
import { cleanup } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';

expect.extend(matchers);

afterEach(() => {
  cleanup();
});

// ====== Mock Electron IPC API ======
const mockElectronAPI = {
  readFile: vi.fn().mockResolvedValue(''),
  writeFile: vi.fn().mockResolvedValue(true),
  fileExists: vi.fn().mockResolvedValue(false),
  selectDirectory: vi.fn().mockResolvedValue(null),
  selectFile: vi.fn().mockResolvedValue(null),
  getFileTree: vi.fn().mockResolvedValue(null),
  watchDirectory: vi.fn(),
  unwatchDirectory: vi.fn(),
  showItemInFolder: vi.fn(),
  openExternal: vi.fn(),
  getRecentProjects: vi.fn().mockResolvedValue([]),

  aiChat: vi.fn().mockResolvedValue('Mock AI response'),
  aiChatStream: vi.fn(),
  aiPolish: vi.fn().mockResolvedValue('Mock polished text'),
  aiGenerateFormula: vi.fn().mockResolvedValue('\\frac{a}{b}'),
  stopGeneration: vi.fn().mockReturnValue(false),

  compile: vi.fn().mockResolvedValue({ success: true }),
  compileTypst: vi.fn().mockResolvedValue({ success: true }),

  getWindowId: vi.fn().mockReturnValue(1),
  createWindow: vi.fn().mockResolvedValue(2),
  focusWindow: vi.fn(),
  isWindowFocused: vi.fn().mockResolvedValue(true),

  getConfig: vi.fn().mockResolvedValue({}),
  setConfig: vi.fn().mockResolvedValue(true),

  lspStart: vi.fn().mockResolvedValue(true),
  lspStop: vi.fn().mockResolvedValue(true),
  lspGetCompletions: vi.fn().mockResolvedValue([]),
  lspGetDiagnostics: vi.fn().mockResolvedValue([]),

  on: vi.fn().mockReturnValue(() => {}),
  once: vi.fn().mockReturnValue(() => {}),
  off: vi.fn(),
};

Object.defineProperty(window, 'electron', {
  value: mockElectronAPI,
  writable: true,
});

// Mock matchMedia (for responsive design testing)
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// ====== Mock Browser APIs ======

// Constructable class (not an arrow-returning vi.fn) so `new ResizeObserver(cb)` works —
// PdfPreviewPane and react-resizable-panels construct one.
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
  root: null,
  rootMargin: '',
  thresholds: [],
}));

// ====== Mock node-side electron module ======
//
// vitest runs in node, but main-process code does `import { app } from 'electron'`.
// Without a mock, electron's npm package index.js (`getElectronPath`) reads
// `node_modules/electron/path.txt` — which is only generated on postinstall.
// On CI macOS/Windows runners that postinstall step is flaky (intermittent
// network failures), so `require('electron')` throws "Electron failed to
// install correctly" and the test suite fails to load — not because tests are
// wrong, but because they reach the real npm package's runtime check.
//
// This module-level mock intercepts before that path read happens. Tests that
// need richer behaviour (e.g. ConfigManager / LaTeXCompiler) can still
// `vi.mock('electron', ...)` locally; local mocks override this default.
//
// True root fix would be DI-izing main-process services so test paths never
// `import 'electron'` at all — P0 work tracked separately. This is the small
// version of the same fix at the test-architecture boundary.
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => `/tmp/scipen-test/${name}`),
    getName: vi.fn(() => 'SciPen Studio'),
    getVersion: vi.fn(() => '0.0.0-test'),
    getAppPath: vi.fn(() => '/tmp/scipen-test/app'),
    isPackaged: false,
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    quit: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
  },
  ipcMain: {
    on: vi.fn(),
    handle: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  ipcRenderer: {
    send: vi.fn(),
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    removeAllListeners: vi.fn(),
  },
  BrowserWindow: class MockBrowserWindow {
    static getAllWindows = vi.fn(() => []);
    static getFocusedWindow = vi.fn(() => null);
    webContents = { send: vi.fn(), on: vi.fn(), off: vi.fn() };
    on = vi.fn();
    show = vi.fn();
    hide = vi.fn();
    close = vi.fn();
    loadURL = vi.fn();
    loadFile = vi.fn();
    isDestroyed = vi.fn(() => false);
  },
  dialog: {
    showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
    showOpenDialog: vi.fn(() => Promise.resolve({ canceled: true, filePaths: [] })),
    showSaveDialog: vi.fn(() => Promise.resolve({ canceled: true, filePath: undefined })),
    showErrorBox: vi.fn(),
  },
  Menu: {
    buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })),
    setApplicationMenu: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(() => Promise.resolve()),
    openPath: vi.fn(() => Promise.resolve('')),
    showItemInFolder: vi.fn(),
    beep: vi.fn(),
  },
  nativeImage: {
    createEmpty: vi.fn(() => ({ isEmpty: vi.fn(() => true) })),
    createFromPath: vi.fn(() => ({ isEmpty: vi.fn(() => false) })),
  },
  net: {
    request: vi.fn(),
  },
  webContents: {
    getAllWebContents: vi.fn(() => []),
    fromId: vi.fn(() => null),
  },
}));

// ====== Mock main-process modules with side-effectful module-load ======
//
// Two main-process modules materialize a real singleton at import time:
//   - ConfigManager: `export const configManager = ConfigManager.getInstance()`
//     → electron-store construction requires app.name (fails without real Electron).
//   - SecureStorageService: singleton `secureStore` lazily inits on first use,
//     but ancillary helpers (`isSecureStorageAvailable`) touch safeStorage on call.
//
// These get stubbed globally so any test that transitively imports them (via
// ZoteroOrchestrator / BibTexSyncService / handlers etc.) doesn't need to
// re-declare the mock. Tests that DO want real behavior can override with
// a local `vi.mock(...)` — vitest hoists local mocks above global ones.
//
// CitationKeyStore is NOT globally mocked: its module load is side-effect-free
// (sqlite opens only on `new CitationKeyStore(...)` call). Only the singleton
// factory `getCitationKeyStore()` needs `app.getPath('userData')` — we stub
// just the factory, leaving the real class importable by its own unit test.
//
// True root fix = refactor these modules to `export function getFoo()` so
// module load is side-effect-free. Tracked separately as a P1 refactor.

// Pure stub — no `importActual`, because loading the real module executes
// `export const configManager = ConfigManager.getInstance()` which crashes.
// Tests that need to exercise the real ConfigManager (its own unit test)
// must call `vi.unmock('.../ConfigManager')` at the top of the file to
// opt out of this default.
vi.mock('../../src/main/services/ConfigManager', () => ({
  configManager: {
    get: vi.fn(),
    set: vi.fn(),
    has: vi.fn(),
    delete: vi.fn(),
  },
  ConfigManager: class MockConfigManager {
    static getInstance = vi.fn();
    get = vi.fn();
    set = vi.fn();
    has = vi.fn();
    delete = vi.fn();
  },
  ConfigChangeEvent: class {},
}));

vi.mock('../../src/main/services/SecureStorageService', () => ({
  getZoteroWebApiKey: vi.fn(() => null),
  getZoteroMinerUApiKey: vi.fn(() => null),
  getZoteroEmbeddingApiKey: vi.fn(() => null),
  getOverleafCookies: vi.fn(() => null),
  setZoteroWebApiKey: vi.fn(() => true),
  setZoteroMinerUApiKey: vi.fn(() => true),
  setZoteroEmbeddingApiKey: vi.fn(() => true),
  setOverleafCookies: vi.fn(() => true),
  deleteZoteroWebApiKey: vi.fn(),
  deleteZoteroMinerUApiKey: vi.fn(),
  deleteZoteroEmbeddingApiKey: vi.fn(),
  deleteOverleafCookies: vi.fn(),
  secureHas: vi.fn(() => false),
  secureGet: vi.fn(() => null),
  secureSet: vi.fn(() => true),
  secureDelete: vi.fn(),
  isSecureStorageAvailable: vi.fn(() => false),
  SecureStorageKeys: {
    OverleafCookies: 'overleaf.cookies',
    OverleafCsrfToken: 'overleaf.csrfToken',
    ZoteroMinerUApiKey: 'zotero.mineruApiKey',
    ZoteroEmbeddingApiKey: 'zotero.embeddingApiKey',
    ZoteroWebApiKey: 'zotero.webApiKey',
  },
}));

// Preserve the real CitationKeyStore class (needed by its own test) — only
// stub the singleton factory, which is the piece that reaches into Electron.
vi.mock('../../src/main/services/zotero/CitationKeyStore', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/main/services/zotero/CitationKeyStore')
  >('../../src/main/services/zotero/CitationKeyStore');
  return {
    ...actual,
    getCitationKeyStore: vi.fn(),
  };
});

export { mockElectronAPI };
