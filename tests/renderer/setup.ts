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

  knowledgeGetLibraries: vi.fn().mockResolvedValue([]),
  knowledgeCreateLibrary: vi.fn().mockResolvedValue({ id: 'test-id' }),
  knowledgeDeleteLibrary: vi.fn().mockResolvedValue(true),
  knowledgeSearch: vi.fn().mockResolvedValue([]),

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

global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

global.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
  root: null,
  rootMargin: '',
  thresholds: [],
}));

export { mockElectronAPI };
