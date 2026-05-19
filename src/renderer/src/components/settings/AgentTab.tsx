/**
 * @file AgentTab.tsx - AI agent / memory entry tab.
 *
 * Single section: two buttons that open the Memory / Skills viewer
 * in a secondary window. Settings is the wrong home for the viewer
 * itself (Memory is runtime data the user reads repeatedly), so this
 * tab only hosts launchers.
 */

import { BookOpen, Brain } from 'lucide-react';
import type React from 'react';
import { useCallback } from 'react';
import { useTranslation } from '../../locales';
import { agentClient } from '../../services/agent/AgentClientService';
import { SectionTitle, SettingItem } from './SettingsUI';

export const AgentTab: React.FC = () => {
  const { t } = useTranslation();

  const openMemory = useCallback(() => {
    void agentClient.openMemoryViewer('memory');
  }, []);

  const openSkills = useCallback(() => {
    void agentClient.openMemoryViewer('skills');
  }, []);

  const buttonClass =
    'inline-flex items-center gap-2 px-3 py-1.5 text-sm rounded border ' +
    'border-[var(--color-border)] bg-[var(--color-bg-secondary)] ' +
    'text-[var(--color-text-primary)] hover:bg-[var(--color-bg-tertiary)]';

  return (
    <>
      <SectionTitle>{t('settingsAgent.viewer')}</SectionTitle>
      <p className="text-xs text-[var(--color-text-muted)] mb-3 -mt-1">
        {t('settingsAgent.viewerDesc')}
      </p>

      <SettingItem
        label={t('settingsAgent.memoryLabel')}
        description={t('settingsAgent.memoryDesc')}
      >
        <button type="button" onClick={openMemory} className={buttonClass}>
          <Brain size={14} />
          {t('settingsAgent.openMemory')}
        </button>
      </SettingItem>

      <SettingItem
        label={t('settingsAgent.skillsLabel')}
        description={t('settingsAgent.skillsDesc')}
      >
        <button type="button" onClick={openSkills} className={buttonClass}>
          <BookOpen size={14} />
          {t('settingsAgent.openSkills')}
        </button>
      </SettingItem>
    </>
  );
};
