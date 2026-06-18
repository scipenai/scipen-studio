import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ResearchWorkspaceShell } from '../../../src/renderer/src/components/research/ResearchWorkspaceShell';

vi.mock('react-resizable-panels', () => ({
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    selection: {
      onTextCaptured: () => vi.fn(),
    },
  },
}));

vi.mock('../../../src/renderer/src/hooks/useLazyModule', () => ({
  useLazyModule: () => null,
}));

vi.mock('../../../src/renderer/src/services/core', () => ({
  TaskPriority: { Low: 0 },
  cancelIdleTask: vi.fn(),
  getUIService: () => ({
    setSidebarTab: vi.fn(),
    requestChatWithText: vi.fn(),
    setChatVisible: vi.fn(),
    setEditorVisible: vi.fn(),
    setPreviewVisible: vi.fn(),
    chatVisible: true,
  }),
  scheduleIdleTask: vi.fn(),
  useActiveTabPath: () => 'paper.tex',
  useChatVisible: () => true,
  useEditorVisible: () => true,
  usePreviewVisible: () => true,
  useProjectPath: () => 'D:/papers/demo-project',
  useSidebarTab: () => 'im',
}));

vi.mock('../../../src/renderer/src/services/core/FileOpenService', () => ({
  openFileInEditor: vi.fn(),
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  t: (key: string) => {
    const values: Record<string, string> = {
      'research.panelChat': 'Chat',
      'research.panelEditor': 'Editor',
      'research.panelPreview': 'Preview',
      'mainLayout.editor': 'Editor',
    };
    return values[key] ?? key;
  },
}));

vi.mock('../../../src/renderer/src/components/chat', () => ({
  ChatSidebar: () => <div data-testid="chat-sidebar" />,
}));

vi.mock('../../../src/renderer/src/components/FileExplorer', () => ({
  FileExplorer: () => <div data-testid="file-explorer" />,
}));

vi.mock('../../../src/renderer/src/components/ErrorBoundary', () => ({
  PanelErrorBoundary: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../../src/renderer/src/components/LoadingFallback', () => ({
  EditorLoadingFallback: () => <div data-testid="editor-loading" />,
}));

vi.mock('../../../src/renderer/src/components/research/PreviewPanel', () => ({
  PreviewPanel: () => <div data-testid="preview-panel" />,
  usePreviewTitle: () => 'Preview',
}));

vi.mock('../../../src/renderer/src/components/research/researchWorkspaceHelpers', () => ({
  PANEL_DEFAULT_SIZE: { chat: 25, editor: 45, preview: 30 },
  WorkspaceResizeHandle: () => <div data-testid="resize-handle" />,
}));

describe('ResearchWorkspaceShell', () => {
  it('renders visible panel labels with a readable separator in the header', () => {
    render(<ResearchWorkspaceShell />);

    expect(screen.getByText('Chat / Editor / Preview')).toBeInTheDocument();
  });
});
