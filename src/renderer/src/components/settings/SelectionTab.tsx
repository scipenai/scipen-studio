/**
 * @file SelectionTab.tsx - Selection Assistant Settings Tab
 * @description Configures the selection assistant's enabled state and keyboard shortcuts
 */

import type { SelectionConfigDTO } from '@shared/ipc/types';
import { Hand, Keyboard, Settings2 } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { useTranslation } from '../../locales';
import {
  SectionTitle,
  SettingCard,
  SettingItem,
  Toggle,
  inputClassName,
  selectClassName,
} from './SettingsUI';

/**
 * Selection Assistant Settings Tab Component
 */
export const SelectionTab: React.FC = () => {
  const { t } = useTranslation();
  const [config, setConfig] = useState<SelectionConfigDTO>({
    enabled: false,
    triggerMode: 'shortcut',
    shortcutKey: 'Alt+D',
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const platform = api.app.getPlatform();
  const hookSupported = platform === 'win32' || platform === 'darwin';

  useEffect(() => {
    const loadConfig = async () => {
      setIsLoading(true);
      try {
        const result = await api.selection.getConfig();
        if (result) {
          setConfig(result);
        }
      } catch (err) {
        console.error('[SelectionTab] 加载配置失败:', err);
        setError(t('selectionSettings.loadConfigFailed'));
      } finally {
        setIsLoading(false);
      }
    };

    loadConfig();
  }, [t]);

  const updateConfig = useCallback(
    async (updates: Partial<SelectionConfigDTO>) => {
      setIsSaving(true);
      setError(null);
      setSuccess(null);

      try {
        const result = await api.selection.setConfig(updates);
        if (result.success) {
          setConfig((prev) => ({ ...prev, ...updates }));
          setSuccess(t('selectionSettings.settingsSaved'));
          setTimeout(() => setSuccess(null), 2000);
        } else {
          setError(result.error || t('selectionSettings.saveFailed'));
        }
      } catch (err) {
        console.error('[SelectionTab] 更新配置失败:', err);
        setError(`${t('selectionSettings.saveFailed')}: ${String(err)}`);
      } finally {
        setIsSaving(false);
      }
    },
    [t]
  );

  const handleToggleEnabled = useCallback(
    async (enabled: boolean) => {
      await updateConfig({ enabled });

      // Also call setEnabled to start/stop the service
      try {
        const result = await api.selection.setEnabled(enabled);
        if (!result?.success) {
          setError(result?.error || t('selectionSettings.enableDisableFailed'));
        }
      } catch (err) {
        console.error('[SelectionTab] 切换启用状态失败:', err);
        setError(`${t('selectionSettings.enableDisableFailed')}: ${String(err)}`);
      }
    },
    [updateConfig, t]
  );

  const handleShortcutChange = useCallback(
    async (shortcutKey: string) => {
      await updateConfig({ shortcutKey });
    },
    [updateConfig]
  );

  const handleTriggerModeChange = useCallback(
    async (triggerMode: SelectionConfigDTO['triggerMode']) => {
      await updateConfig({ triggerMode });
    },
    [updateConfig]
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-[var(--color-text-muted)]">{t('selectionSettings.loading')}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-[var(--color-accent-muted)]">
          <Hand className="w-5 h-5 text-[var(--color-accent)]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">
            {t('selectionSettings.title')}
          </h2>
          <p className="text-sm text-[var(--color-text-muted)]">
            {t('selectionSettings.subtitle')}
          </p>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm">
          {success}
        </div>
      )}

      <SectionTitle>{t('selectionSettings.basicSettings')}</SectionTitle>

      <SettingCard>
        <Toggle
          label={t('selectionSettings.enableSelection')}
          desc={t('selectionSettings.enableSelectionDesc')}
          checked={config.enabled}
          onChange={handleToggleEnabled}
          disabled={isSaving}
        />
      </SettingCard>

      <SectionTitle>{t('selectionSettings.shortcutSettings')}</SectionTitle>

      <SettingCard
        title={t('selectionSettings.triggerShortcut')}
        description={t('selectionSettings.triggerShortcutDesc')}
      >
        <SettingItem label={t('selectionSettings.shortcut')}>
          <div className="flex items-center gap-3">
            <Keyboard className="w-4 h-4 text-[var(--color-text-muted)]" />
            <input
              type="text"
              className={inputClassName}
              value={config.shortcutKey}
              onChange={(e) => setConfig((prev) => ({ ...prev, shortcutKey: e.target.value }))}
              onBlur={() => handleShortcutChange(config.shortcutKey)}
              placeholder={t('selectionSettings.shortcutPlaceholder')}
              disabled={isSaving || !config.enabled}
            />
          </div>
        </SettingItem>

        <div className="mt-3 p-3 rounded-lg bg-[var(--color-bg-tertiary)] text-xs text-[var(--color-text-muted)]">
          <p className="font-medium mb-1">{t('selectionSettings.supportedModifiers')}</p>
          <ul className="list-disc list-inside space-y-0.5">
            <li>Ctrl / Command (macOS)</li>
            <li>Alt / Option (macOS)</li>
            <li>Shift</li>
          </ul>
          <p className="mt-2 text-[var(--color-text-secondary)]">
            {t('selectionSettings.modifierExample')}
          </p>
        </div>
      </SettingCard>

      <SectionTitle>{t('selectionSettings.advancedSettings')}</SectionTitle>

      <SettingCard
        title={t('selectionSettings.triggerMode')}
        description={t('selectionSettings.triggerModeDesc')}
      >
        <SettingItem
          label={t('selectionSettings.triggerMode')}
          description={t('selectionSettings.triggerModeDesc')}
        >
          <div className="flex items-center gap-3">
            <Settings2 className="w-4 h-4 text-[var(--color-text-muted)]" />
            <select
              className={selectClassName}
              value={config.triggerMode}
              onChange={(e) =>
                handleTriggerModeChange(e.target.value as SelectionConfigDTO['triggerMode'])
              }
              disabled={isSaving || !config.enabled}
            >
              <option value="shortcut">{t('selectionSettings.shortcutTrigger')}</option>
              <option value="hook" disabled={!hookSupported}>
                {t('selectionSettings.globalSelectionPopup')}
              </option>
            </select>
          </div>
          {!hookSupported && (
            <p className="mt-2 text-xs text-[var(--color-text-muted)]">
              {t('selectionSettings.platformNotSupported')}
            </p>
          )}
        </SettingItem>
      </SettingCard>

      <SectionTitle>{t('selectionSettings.instructions')}</SectionTitle>

      <SettingCard>
        <div className="space-y-3 text-sm text-[var(--color-text-secondary)]">
          <div className="flex items-start gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[var(--color-accent-muted)] text-[var(--color-accent)] flex items-center justify-center text-xs font-medium">
              1
            </span>
            <p>{t('selectionSettings.step1')}</p>
          </div>
          <div className="flex items-start gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[var(--color-accent-muted)] text-[var(--color-accent)] flex items-center justify-center text-xs font-medium">
              2
            </span>
            <p>
              {t('selectionSettings.step2')}{' '}
              <kbd className="px-1.5 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-xs font-mono">
                {config.shortcutKey}
              </kbd>{' '}
              {t('selectionSettings.step2Suffix')}
            </p>
          </div>
          <div className="flex items-start gap-3">
            <span className="flex-shrink-0 w-6 h-6 rounded-full bg-[var(--color-accent-muted)] text-[var(--color-accent)] flex items-center justify-center text-xs font-medium">
              3
            </span>
            <p>{t('selectionSettings.step3')}</p>
          </div>
        </div>
      </SettingCard>
    </div>
  );
};

export default SelectionTab;
