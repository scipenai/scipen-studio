import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EditorTab } from '../../../src/renderer/src/components/settings/EditorTab';
import { defaultSettings } from '../../../src/renderer/src/services/core/SettingsService';

const settingsServiceMock = vi.hoisted(() => ({
  updateEditor: vi.fn(),
}));

vi.mock('../../../src/renderer/src/services/core/ServiceRegistry', () => ({
  getSettingsService: () => settingsServiceMock,
}));

vi.mock('../../../src/renderer/src/services/core/hooks', () => ({
  useSettings: () => defaultSettings,
}));

vi.mock('../../../src/renderer/src/locales', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const values: Record<string, string> = {
        'editor.settings.groupTypography': 'Typography',
        'editor.settings.groupDisplay': 'Display',
        'editor.settings.groupBehavior': 'Behavior',
        'editor.settings.groupAI': 'AI assistance',
        'editor.settings.fontSize': 'Font Size',
        'editor.settings.fontFamily': 'Font Family',
        'editor.settings.consolasRecommended': 'Consolas',
        'editor.settings.systemMono': 'System Mono',
        'editor.settings.tabSize': 'Tab Size',
        'editor.settings.cursorStyle': 'Cursor Style',
        'editor.settings.cursorLine': 'Line',
        'editor.settings.cursorBlock': 'Block',
        'editor.settings.cursorUnderline': 'Underline',
        'editor.settings.lineNumbers': 'Line Numbers',
        'editor.settings.minimap': 'Minimap',
        'editor.settings.indentGuides': 'Indent Guides',
        'editor.settings.bracketColor': 'Bracket Colorization',
        'editor.settings.wordWrap': 'Word Wrap',
        'editor.settings.smoothScroll': 'Smooth Scrolling',
        'editor.settings.aiCompletion': 'AI Completion',
        'editor.settings.aiCompletionDesc': 'AI suggestions',
        'editor.settings.ghostText': 'Ghost Text',
        'editor.settings.ghostTextDesc': 'Completion hints',
      };
      return values[key] ?? key;
    },
  }),
}));

describe('EditorTab', () => {
  it('labels the font size slider and keeps it keyboard-visible', () => {
    render(<EditorTab />);

    const slider = screen.getByRole('slider', { name: /Font Size/ });
    expect(slider).toHaveClass('cursor-pointer');
    expect(slider).toHaveClass('focus-visible:ring-2');

    fireEvent.change(slider, { target: { value: '18' } });
    expect(settingsServiceMock.updateEditor).toHaveBeenCalledWith({ fontSize: 18 });
  });
});
