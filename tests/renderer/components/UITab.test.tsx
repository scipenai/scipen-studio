import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { UITab } from '../../../src/renderer/src/components/settings/UITab';
import { defaultSettings } from '../../../src/renderer/src/services/core/SettingsService';

const settingsServiceMock = vi.hoisted(() => ({
  updateUI: vi.fn(),
}));

vi.mock('../../../src/renderer/src/services/core/ServiceRegistry', () => ({
  getSettingsService: () => settingsServiceMock,
}));

vi.mock('../../../src/renderer/src/services/core/hooks', () => ({
  useSettings: () => defaultSettings,
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  SUPPORTED_LOCALES: [
    { key: 'en-US', nativeName: 'English' },
    { key: 'zh-CN', nativeName: '简体中文' },
  ],
  setLocale: vi.fn(),
  useTranslation: () => ({
    locale: 'en-US',
    t: (key: string) => {
      const values: Record<string, string> = {
        'settings.appearance': 'Appearance',
        'settings.theme': 'Theme',
        'settings.themeDark': 'Dark',
        'settings.themeLight': 'Light',
        'settings.themeSystem': 'System',
        'settings.language': 'Language',
        'settings.chatFontSize': 'Chat font size',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('UITab', () => {
  it('keeps the chat font size slider keyboard-visible and connected to settings', () => {
    render(<UITab />);

    const slider = screen.getByRole('slider', { name: 'Chat font size' });
    expect(slider).toHaveClass('cursor-pointer');
    expect(slider).toHaveClass('focus-visible:ring-2');

    fireEvent.change(slider, { target: { value: '18' } });
    expect(settingsServiceMock.updateUI).toHaveBeenCalledWith({ chatFontSize: 18 });
  });
});
