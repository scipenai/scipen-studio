/**
 * @file EditorTab.tsx - Editor Settings Tab
 * @description Configures editor font, indentation, auto-save parameters
 */

import type React from 'react';
import { useTranslation } from '../../locales';
import { getSettingsService } from '../../services/core/ServiceRegistry';
import { useSettings } from '../../services/core/hooks';
import { SectionTitle, SettingItem, Toggle, selectClassName } from './SettingsUI';

export const EditorTab: React.FC = () => {
  const { t } = useTranslation();
  // Using the new service architecture
  const settings = useSettings();
  const settingsService = getSettingsService();

  return (
    <>
      <SectionTitle>{t('editor.settings.title')}</SectionTitle>
      <SettingItem label={`${t('editor.settings.fontSize')} ${settings.editor.fontSize}px`}>
        <input
          type="range"
          min="10"
          max="24"
          value={settings.editor.fontSize}
          onChange={(e) =>
            settingsService.updateEditor({ fontSize: Number.parseInt(e.target.value) })
          }
          className="w-full accent-[var(--color-accent)]"
        />
      </SettingItem>
      <SettingItem label={t('editor.settings.fontFamily')}>
        <select
          value={settings.editor.fontFamily}
          onChange={(e) => settingsService.updateEditor({ fontFamily: e.target.value })}
          className={selectClassName}
        >
          <option value='Consolas, "Courier New", monospace'>
            {t('editor.settings.consolasRecommended')}
          </option>
          <option value='"Courier New", monospace'>Courier New</option>
          <option value="monospace">{t('editor.settings.systemMono')}</option>
        </select>
      </SettingItem>
      <SettingItem label={t('editor.settings.tabSize')}>
        <select
          value={settings.editor.tabSize}
          onChange={(e) =>
            settingsService.updateEditor({ tabSize: Number.parseInt(e.target.value) })
          }
          className={selectClassName}
        >
          <option value="2">2</option>
          <option value="4">4</option>
        </select>
      </SettingItem>
      <SettingItem label={t('editor.settings.cursorStyle')}>
        <select
          value={settings.editor.cursorStyle}
          onChange={(e) =>
            settingsService.updateEditor({
              cursorStyle: e.target.value as 'line' | 'block' | 'underline',
            })
          }
          className={selectClassName}
        >
          <option value="line">{t('editor.settings.cursorLine')}</option>
          <option value="block">{t('editor.settings.cursorBlock')}</option>
          <option value="underline">{t('editor.settings.cursorUnderline')}</option>
        </select>
      </SettingItem>
      <Toggle
        label={t('editor.settings.wordWrap')}
        checked={settings.editor.wordWrap}
        onChange={(v) => settingsService.updateEditor({ wordWrap: v })}
      />
      <Toggle
        label={t('editor.settings.lineNumbers')}
        checked={settings.editor.lineNumbers}
        onChange={(v) => settingsService.updateEditor({ lineNumbers: v })}
      />
      <Toggle
        label={t('editor.settings.minimap')}
        checked={settings.editor.minimap}
        onChange={(v) => settingsService.updateEditor({ minimap: v })}
      />
      <Toggle
        label={t('editor.settings.bracketColor')}
        checked={settings.editor.bracketPairColorization}
        onChange={(v) => settingsService.updateEditor({ bracketPairColorization: v })}
      />
      <Toggle
        label={t('editor.settings.indentGuides')}
        checked={settings.editor.indentGuides}
        onChange={(v) => settingsService.updateEditor({ indentGuides: v })}
      />
      <Toggle
        label={t('editor.settings.smoothScroll')}
        checked={settings.editor.smoothScrolling}
        onChange={(v) => settingsService.updateEditor({ smoothScrolling: v })}
      />
      <Toggle
        label={t('editor.settings.aiCompletion')}
        desc={t('editor.settings.aiCompletionDesc')}
        checked={settings.editor.autoCompletion}
        onChange={(v) => settingsService.updateEditor({ autoCompletion: v })}
      />
      <Toggle
        label={t('editor.settings.ghostText')}
        desc={t('editor.settings.ghostTextDesc')}
        checked={settings.editor.ghostText}
        onChange={(v) => settingsService.updateEditor({ ghostText: v })}
      />
    </>
  );
};
