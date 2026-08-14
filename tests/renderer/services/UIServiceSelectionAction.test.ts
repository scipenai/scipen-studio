/**
 * @file UIServiceSelectionAction.test.ts — event contract for the new
 *       Ctrl+L / Alt+D → SelectionActionCard channel.
 *
 * Locks two properties:
 *   1. `requestSelectionAction` fires exactly one event with the payload.
 *   2. The call side-effects the sidebar into IM view (identical to
 *      requestChatWithText, so an existing user reflex still works).
 *
 * Kept isolated from UIService's other subsystems by not importing
 * CompileService / EditorService fixtures — the constructor lazily wires
 * those, so we tolerate their "get service failed" warn logs in this test.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    file: {
      exists: vi.fn().mockResolvedValue(false),
      readBinary: vi.fn(),
    },
  },
}));

vi.mock('../../../src/renderer/src/services/StorageService', () => {
  const store = new Map<string, unknown>();
  const inst = {
    get: <T>(k: string, dflt?: T): T => (store.has(k) ? (store.get(k) as T) : (dflt as T)),
    getString: (k: string, dflt = ''): string => (store.get(k) as string) ?? dflt,
    getBoolean: (k: string, dflt = false): boolean => (store.get(k) as boolean) ?? dflt,
    getNumber: (k: string, dflt = 0): number => (store.get(k) as number) ?? dflt,
    store: (k: string, v: unknown): void => {
      store.set(k, v);
    },
  };
  return { getStorageService: () => inst };
});

// UIService lazily wires CompileService + EditorService via ServiceRegistry
// on construct. Provide no-op stubs so its constructor doesn't throw before
// the event we're testing runs.
vi.mock('../../../src/renderer/src/services/core/ServiceRegistry', () => ({
  getEditorService: () => ({
    onDidChangeActiveTab: () => ({ dispose: () => undefined }),
    onDidChangeDirtyState: () => ({ dispose: () => undefined }),
    get activeTabPath() {
      return null;
    },
  }),
}));

vi.mock('../../../src/renderer/src/services/core/CompileService', () => ({
  getCompileServiceAsync: async () => ({
    onDidStartCompile: () => ({ dispose: () => undefined }),
    onDidFinishCompile: () => ({ dispose: () => undefined }),
    onDidLog: () => ({ dispose: () => undefined }),
  }),
}));

import type { UnifiedSelection } from '../../../shared/types/selection-action';
import { UIService } from '../../../src/renderer/src/services/core/UIService';

function sampleSelection(over: Partial<UnifiedSelection> = {}): UnifiedSelection {
  return {
    text: 'demo',
    source: 'editor',
    capturedAt: 1_700_000_000_000,
    ...over,
  };
}

describe('UIService.requestSelectionAction', () => {
  it('fires onDidRequestSelectionAction with the full payload', () => {
    const ui = new UIService();
    const seen: UnifiedSelection[] = [];
    const dispose = ui.onDidRequestSelectionAction((req) => seen.push(req.selection));

    const sel = sampleSelection({ source: 'external', sourceApp: 'Chrome' });
    ui.requestSelectionAction({ selection: sel });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(sel);
    dispose.dispose();
    ui.dispose();
  });

  it('expands the sidebar and switches to the IM tab', () => {
    const ui = new UIService();
    ui.setSidebarCollapsed(true);
    ui.setSidebarTab('files');

    ui.requestSelectionAction({ selection: sampleSelection() });

    expect(ui.isSidebarCollapsed).toBe(false);
    expect(ui.sidebarTab).toBe('im');
    ui.dispose();
  });

  it('does not fire the legacy onDidRequestChatWithText channel', () => {
    const ui = new UIService();
    const chatSeed = vi.fn();
    const dispose = ui.onDidRequestChatWithText(chatSeed);

    ui.requestSelectionAction({ selection: sampleSelection() });

    expect(chatSeed).not.toHaveBeenCalled();
    dispose.dispose();
    ui.dispose();
  });
});
