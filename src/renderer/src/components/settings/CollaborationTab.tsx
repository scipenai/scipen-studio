/**
 * @file CollaborationTab.tsx - Collaboration Settings Tab
 * @description Configures OT collaborative editing connection
 */

import type React from 'react';
import { useTranslation } from '../../locales';
import { getSettingsService } from '../../services/core/ServiceRegistry';
import { useSettings } from '../../services/core/hooks';
import { SectionTitle, SettingItem, Toggle, inputClassName } from './SettingsUI';

export const CollaborationTab: React.FC = () => {
  const settings = useSettings();
  const settingsService = getSettingsService();
  const { t } = useTranslation();

  return (
    <>
      <SectionTitle>{t('settings.collaborationConnection')}</SectionTitle>

      <Toggle
        label={t('settings.collaborationEnabled')}
        desc={t('settings.collaborationEnabledDesc')}
        checked={settings.collaboration.enabled}
        onChange={(checked) => settingsService.updateCollaboration({ enabled: checked })}
      />

      <SettingItem
        label={t('settings.collaborationServerUrl')}
        description={t('settings.collaborationServerUrlDesc')}
      >
        <input
          type="text"
          value={settings.collaboration.serverUrl}
          onChange={(e) => settingsService.updateCollaboration({ serverUrl: e.target.value })}
          placeholder="https://example.com/ot"
          className={inputClassName}
        />
      </SettingItem>

      <SettingItem
        label={t('settings.collaborationToken')}
        description={t('settings.collaborationTokenDesc')}
      >
        <input
          type="password"
          value={settings.collaboration.token}
          onChange={(e) => settingsService.updateCollaboration({ token: e.target.value })}
          placeholder="Token"
          className={inputClassName}
        />
      </SettingItem>
    </>
  );
};
