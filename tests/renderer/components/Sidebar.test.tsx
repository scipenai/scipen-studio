import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Sidebar } from '../../../src/renderer/src/components/layout/Sidebar';

const uiServiceMock = vi.hoisted(() => ({
  setSidebarTab: vi.fn(),
  setResearchLayoutFocus: vi.fn(),
}));

const historyMocks = vi.hoisted(() => ({
  openBrowseLabels: vi.fn(),
}));

vi.mock('../../../src/renderer/src/services/core/ServiceRegistry', () => ({
  getUIService: () => uiServiceMock,
}));

vi.mock('../../../src/renderer/src/services/core/hooks', () => ({
  useProjectPath: () => 'D:/papers/demo',
  useSidebarTab: () => 'im',
}));

vi.mock('../../../src/renderer/src/services/core/HistoryUIBus', () => ({
  historyUIBus: historyMocks,
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'workspaceSidebar.navigation': 'Workspace navigation',
        'workspaceSidebar.imTab': 'Chat',
        'workspaceSidebar.filesTab': 'Files',
        'workspaceSidebar.historyTab': 'History',
        'workspaceSidebar.settingsTab': 'Settings',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('Sidebar', () => {
  it('renders the main workspace rail as named navigation with decorative icons hidden', () => {
    render(<Sidebar />);

    const nav = screen.getByRole('navigation', { name: 'Workspace navigation' });
    const chat = within(nav).getByRole('button', { name: 'Chat' });

    expect(chat).toHaveAttribute('aria-current', 'page');
    expect(chat).toHaveClass('cursor-pointer');
    expect(chat).toHaveClass('focus-visible:ring-2');
    expect(chat.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');

    fireEvent.click(within(nav).getByRole('button', { name: 'Files' }));
    expect(uiServiceMock.setSidebarTab).toHaveBeenCalledWith('files');
    expect(uiServiceMock.setResearchLayoutFocus).toHaveBeenCalledWith('files');

    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(historyMocks.openBrowseLabels).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(uiServiceMock.setSidebarTab).toHaveBeenCalledWith('settings');
  });
});
