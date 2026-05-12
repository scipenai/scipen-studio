/**
 * @file IMTab.tsx - IM Settings Tab
 * @description Configures IM server connection settings for OpenClaw messaging
 */

import type React from 'react';
import { useTranslation } from '../../locales';
import { getSettingsService } from '../../services/core/ServiceRegistry';
import { useSettings } from '../../services/core/hooks';
import { SectionTitle, SettingItem, inputClassName } from './SettingsUI';

export const IMTab: React.FC = () => {
  const settings = useSettings();
  const settingsService = getSettingsService();
  const { t } = useTranslation();

  return (
    <>
      <SectionTitle>{t('settings.imConnection')}</SectionTitle>

      <SettingItem label={t('settings.imServerUrl')} description={t('settings.imServerUrlDesc')}>
        <input
          type="text"
          value={settings.im.serverUrl}
          onChange={(e) => settingsService.updateIM({ serverUrl: e.target.value })}
          placeholder="https://example.com/im"
          className={inputClassName}
        />
      </SettingItem>

      <SettingItem label={t('settings.imToken')} description={t('settings.imTokenDesc')}>
        <input
          type="password"
          value={settings.im.token}
          onChange={(e) => settingsService.updateIM({ token: e.target.value })}
          placeholder="Token"
          className={inputClassName}
        />
      </SettingItem>
    </>
  );
};
