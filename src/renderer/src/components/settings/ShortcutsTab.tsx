/**
 * @file ShortcutsTab.tsx - Shortcuts Settings Tab
 * @description Configures and customizes application keyboard shortcut bindings
 */

import type React from 'react';
import { useTranslation } from '../../locales';
import { getSettingsService } from '../../services/core/ServiceRegistry';
import { useSettings } from '../../services/core/hooks';
import type { AppSettings } from '../../types';
import { EditableShortcut, SectionTitle } from './SettingsUI';

type ShortcutKey = keyof AppSettings['shortcuts'];

export const ShortcutsTab: React.FC = () => {
  const { t } = useTranslation();
  const settings = useSettings();
  const settingsService = getSettingsService();

  const handleShortcutChange = (key: ShortcutKey, newValue: string) => {
    settingsService.updateSettings({
      shortcuts: {
        ...settings.shortcuts,
        [key]: newValue,
      },
    });
  };

  return (
    <>
      <SectionTitle>{t('shortcuts.title')}</SectionTitle>
      <p className="text-xs text-[var(--color-text-muted)] mb-3">{t('shortcuts.desc')}</p>
      <EditableShortcut
        label={t('shortcuts.save')}
        keys={settings.shortcuts.save}
        onChange={(v) => handleShortcutChange('save', v)}
      />
      <EditableShortcut
        label={t('shortcuts.compile')}
        keys={settings.shortcuts.compile}
        onChange={(v) => handleShortcutChange('compile', v)}
      />
      <EditableShortcut
        label={t('shortcuts.commandPalette')}
        keys={settings.shortcuts.commandPalette}
        onChange={(v) => handleShortcutChange('commandPalette', v)}
      />
      <EditableShortcut
        label={t('shortcuts.aiPolish')}
        keys={settings.shortcuts.aiPolish}
        onChange={(v) => handleShortcutChange('aiPolish', v)}
      />
      <EditableShortcut
        label={t('shortcuts.aiChat')}
        keys={settings.shortcuts.aiChat}
        onChange={(v) => handleShortcutChange('aiChat', v)}
      />
      <EditableShortcut
        label={t('shortcuts.togglePreview')}
        keys={settings.shortcuts.togglePreview}
        onChange={(v) => handleShortcutChange('togglePreview', v)}
      />
      <EditableShortcut
        label={t('shortcuts.newWindow')}
        keys={settings.shortcuts.newWindow}
        onChange={(v) => handleShortcutChange('newWindow', v)}
      />
    </>
  );
};
