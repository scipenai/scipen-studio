import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsPanel } from '../../../src/renderer/src/components/SettingsPanel';

const stored = vi.hoisted(() => ({
  value: 'ai',
  store: vi.fn((_: string, value: string) => {
    stored.value = value;
  }),
}));

vi.mock('../../../src/renderer/src/services/StorageService', () => ({
  getStorageService: () => ({
    getString: vi.fn(() => stored.value),
    store: stored.store,
  }),
}));

vi.mock('../../../src/renderer/src/components/settings', () => ({
  AITab: () => <div>AI Settings</div>,
  AgentTab: () => <div>Agent Settings</div>,
  CompilerTab: () => <div>Compiler Settings</div>,
  EditorTab: () => <div>Editor Settings</div>,
  SelectionTab: () => <div>Selection Settings</div>,
  ShortcutsTab: () => <div>Shortcuts Settings</div>,
  UITab: () => <div>UI Settings</div>,
  UpdateTab: () => <div>Update Settings</div>,
  ZoteroTab: () => <div>Zotero Settings</div>,
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'settings.groups.aiEngine': 'AI Engine',
        'settings.groups.basics': 'Basics',
        'settings.groups.workflow': 'Workflow',
        'settings.groups.system': 'System',
        'settings.tabs.ai': 'AI',
        'settings.tabs.agent': 'Agent',
        'settings.tabs.ui': 'Interface',
        'settings.tabs.shortcuts': 'Shortcuts',
        'settings.tabs.editor': 'Editor',
        'settings.tabs.zotero': 'Zotero',
        'settings.tabs.selection': 'Selection',
        'settings.tabs.compiler': 'Compiler',
        'settings.tabs.update': 'Updates',
        'settingsPanel.summaries.ai': 'Configure AI.',
        'settingsPanel.summaries.agent': 'Configure agent.',
        'settingsPanel.summaries.ui': 'Configure interface.',
        'settingsPanel.summaries.shortcuts': 'Configure shortcuts.',
        'settingsPanel.summaries.editor': 'Configure editor.',
        'settingsPanel.summaries.zotero': 'Configure Zotero.',
        'settingsPanel.summaries.selection': 'Configure selection.',
        'settingsPanel.summaries.compiler': 'Configure compiler.',
        'settingsPanel.summaries.update': 'Configure updates.',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('SettingsPanel', () => {
  it('renders settings navigation as accessible tabs with focus feedback', () => {
    render(<SettingsPanel />);

    expect(screen.getAllByRole('tablist')).toHaveLength(4);

    const ai = screen.getByRole('tab', { name: 'AI' });
    expect(ai).toHaveAttribute('aria-selected', 'true');
    expect(ai).toHaveClass('cursor-pointer');
    expect(ai).toHaveClass('focus-visible:ring-2');

    const shortcuts = screen.getByRole('tab', { name: 'Shortcuts' });
    expect(shortcuts).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(shortcuts);

    expect(shortcuts).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Shortcuts Settings')).toBeInTheDocument();
    expect(stored.store).toHaveBeenLastCalledWith('ui.settingsPanelTab', 'shortcuts');
  });
});
