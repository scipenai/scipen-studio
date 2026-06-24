import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SelectionTab } from '../../../src/renderer/src/components/settings/SelectionTab';

const apiMocks = vi.hoisted(() => ({
  getPlatform: vi.fn(),
  getConfig: vi.fn(),
  setConfig: vi.fn(),
  setEnabled: vi.fn(),
}));

vi.mock('../../../src/renderer/src/api', () => ({
  api: {
    app: {
      getPlatform: apiMocks.getPlatform,
    },
    selection: {
      getConfig: apiMocks.getConfig,
      setConfig: apiMocks.setConfig,
      setEnabled: apiMocks.setEnabled,
    },
  },
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'selectionSettings.title': 'Selection Assistant',
        'selectionSettings.subtitle': 'Review captured text from any application',
        'selectionSettings.loading': 'Loading...',
        'selectionSettings.loadConfigFailed': 'Failed to load config',
        'selectionSettings.settingsSaved': 'Settings saved',
        'selectionSettings.saveFailed': 'Save failed',
        'selectionSettings.enableDisableFailed': 'Enable/disable failed',
        'selectionSettings.basicSettings': 'Basic Settings',
        'selectionSettings.enableSelection': 'Enable Selection Assistant',
        'selectionSettings.enableSelectionDesc': 'Enable captured text review',
        'selectionSettings.triggerShortcut': 'Trigger Shortcut',
        'selectionSettings.triggerShortcutDesc': 'Press this shortcut after selecting text',
        'selectionSettings.shortcut': 'Shortcut',
        'selectionSettings.shortcutPlaceholder': 'e.g., Alt+D',
        'selectionSettings.supportedModifiers': 'Supported modifiers:',
        'selectionSettings.modifierExample': 'Example: Alt+D',
        'selectionSettings.triggerMode': 'Trigger Mode',
        'selectionSettings.triggerModeDesc': 'Choose how selection opens',
        'selectionSettings.shortcutTrigger': 'Shortcut Trigger',
        'selectionSettings.globalSelectionPopup': 'Global Selection Popup',
        'selectionSettings.platformNotSupported': 'Unsupported platform',
        'selectionSettings.instructions': 'Instructions',
        'selectionSettings.step1': 'Select text',
        'selectionSettings.step2': 'Press',
        'selectionSettings.step2Suffix': 'to open',
        'selectionSettings.step3': 'Review text',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('SelectionTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getPlatform.mockReturnValue('win32');
    apiMocks.getConfig.mockResolvedValue({
      enabled: true,
      triggerMode: 'shortcut',
      shortcutKey: 'Alt+D',
    });
    apiMocks.setConfig.mockResolvedValue({ success: true });
    apiMocks.setEnabled.mockResolvedValue({ success: true });
  });

  it('labels icon-wrapped shortcut and trigger controls with visible state', async () => {
    render(<SelectionTab />);

    await waitFor(() => expect(apiMocks.getConfig).toHaveBeenCalled());

    const shortcut = screen.getByRole('textbox', { name: 'Shortcut' });
    expect(shortcut).toHaveAccessibleDescription('Press this shortcut after selecting text');
    expect(shortcut).toHaveClass('disabled:cursor-not-allowed');

    const mode = screen.getByRole('combobox', { name: 'Trigger Mode' });
    expect(mode).toHaveAccessibleDescription('Choose how selection opens');
    expect(mode).toHaveClass('cursor-pointer');
    expect(mode).toHaveClass('disabled:cursor-not-allowed');

    expect(document.querySelectorAll('svg[aria-hidden="true"]').length).toBeGreaterThanOrEqual(3);
  });
});
