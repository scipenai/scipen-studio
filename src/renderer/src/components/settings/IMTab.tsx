/**
 * @file IMTab.tsx - IM Settings Tab
 * @description Configures IM server connection settings for OpenClaw messaging,
 *   and lets the user pick the assistant runtime (OpenClaw vs SNACA).
 */

import type React from 'react';
import { useTranslation, type TranslationKey } from '../../locales';
import { getSettingsService } from '../../services/core/ServiceRegistry';
import { useSettings } from '../../services/core/hooks';
import type { AssistantRuntime } from '../../types';
import { SectionTitle, SettingItem, inputClassName, selectClassName } from './SettingsUI';

const RUNTIME_OPTIONS: ReadonlyArray<{
  value: AssistantRuntime;
  labelKey: TranslationKey;
  descKey: TranslationKey;
}> = [
  {
    value: 'openclaw',
    labelKey: 'settings.agentRuntimeOpenClaw',
    descKey: 'settings.agentRuntimeOpenClawDesc',
  },
  {
    value: 'snaca',
    labelKey: 'settings.agentRuntimeSnaca',
    descKey: 'settings.agentRuntimeSnacaDesc',
  },
  {
    value: 'builtin',
    labelKey: 'settings.agentRuntimeBuiltin',
    descKey: 'settings.agentRuntimeBuiltinDesc',
  },
];

export const IMTab: React.FC = () => {
  const settings = useSettings();
  const settingsService = getSettingsService();
  const { t } = useTranslation();

  const isOpenClaw = settings.assistant.runtime === 'openclaw';
  const activeDescKey = RUNTIME_OPTIONS.find(
    (o) => o.value === settings.assistant.runtime
  )?.descKey;

  return (
    <>
      <SectionTitle>{t('settings.agentRuntime')}</SectionTitle>
      <SettingItem
        label={t('settings.agentRuntimeLabel')}
        description={activeDescKey ? t(activeDescKey) : undefined}
      >
        <select
          value={settings.assistant.runtime}
          onChange={(e) =>
            settingsService.updateSettings({
              assistant: {
                ...settings.assistant,
                runtime: e.target.value as AssistantRuntime,
              },
            })
          }
          className={selectClassName}
        >
          {RUNTIME_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {t(opt.labelKey)}
            </option>
          ))}
        </select>
      </SettingItem>

      <SectionTitle>{t('settings.imConnection')}</SectionTitle>

      <SettingItem label={t('settings.imServerUrl')} description={t('settings.imServerUrlDesc')}>
        <input
          type="text"
          value={settings.im.serverUrl}
          onChange={(e) => settingsService.updateIM({ serverUrl: e.target.value })}
          placeholder="https://example.com/im"
          className={inputClassName}
          disabled={!isOpenClaw}
        />
      </SettingItem>

      <SettingItem label={t('settings.imToken')} description={t('settings.imTokenDesc')}>
        <input
          type="password"
          value={settings.im.token}
          onChange={(e) => settingsService.updateIM({ token: e.target.value })}
          placeholder="Token"
          className={inputClassName}
          disabled={!isOpenClaw}
        />
      </SettingItem>
    </>
  );
};
