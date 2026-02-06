/**
 * @file AgentsTab.tsx - Smart Tools Settings Tab
 * @description Configures AI tool parameters for PDF conversion, Beamer generation
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import { useTranslation } from '../../locales';
import { getSettingsService } from '../../services/core/ServiceRegistry';
import { useSettings } from '../../services/core/hooks';
import { Badge } from '../ui';
import { SectionTitle, SettingItem } from './SettingsUI';

interface ToolStatus {
  pdf2latex: boolean;
  reviewer: boolean;
  paper2beamer: boolean;
}

export const AgentsTab: React.FC = () => {
  const { t } = useTranslation();
  // Using the new service architecture
  const settings = useSettings();
  const settingsService = getSettingsService();

  const [toolStatus, setToolStatus] = useState<ToolStatus | null>(null);

  useEffect(() => {
    const checkToolStatus = async () => {
      const status = await api.agent.getAvailable();
      setToolStatus(status);
    };
    checkToolStatus();
  }, []);

  return (
    <>
      <SectionTitle>{t('agents.cliStatus')}</SectionTitle>

      <div className="space-y-2 mb-4">
        <ToolStatusItem
          name="scipen-pdf2tex"
          label={t('agents.pdf2latex')}
          installed={toolStatus?.pdf2latex ?? false}
        />
        <ToolStatusItem
          name="scipen-review"
          label={t('agents.aiReview')}
          installed={toolStatus?.reviewer ?? false}
        />
        <ToolStatusItem
          name="scipen-beamer"
          label={t('agents.paper2beamer')}
          installed={toolStatus?.paper2beamer ?? false}
        />
      </div>

      <SectionTitle>{t('agents.generalSettings')}</SectionTitle>
      <SettingItem label={`${t('agents.timeout')} ${settings.agents.timeout / 1000}s`}>
        <input
          type="range"
          min="60000"
          max="1800000"
          step="60000"
          value={settings.agents.timeout}
          onChange={(e) =>
            settingsService.updateSettings({
              agents: { ...settings.agents, timeout: Number.parseInt(e.target.value) },
            })
          }
          className="w-full accent-[var(--color-accent)]"
        />
      </SettingItem>

      <SectionTitle>{t('agents.pdf2latexSettings')}</SectionTitle>
      <SettingItem
        label={`${t('agents.concurrency')} ${settings.agents.pdf2latex.maxConcurrentPages}`}
        description={t('agents.concurrencyDesc')}
      >
        <input
          type="range"
          min="1"
          max="10"
          value={settings.agents.pdf2latex.maxConcurrentPages}
          onChange={(e) =>
            settingsService.updateSettings({
              agents: {
                ...settings.agents,
                pdf2latex: {
                  ...settings.agents.pdf2latex,
                  maxConcurrentPages: Number.parseInt(e.target.value),
                },
              },
            })
          }
          className="w-full accent-[var(--color-accent)]"
        />
      </SettingItem>

      <p className="text-xs text-[var(--color-text-muted)] mt-4 px-1">
        {t('agents.beamerReviewHint')}
      </p>
    </>
  );
};

const ToolStatusItem: React.FC<{
  name: string;
  label: string;
  installed: boolean;
}> = ({ name, label, installed }) => {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between px-3 py-2 bg-[var(--color-bg-tertiary)] rounded-lg">
      <div className="flex items-center gap-2">
        <Badge variant={installed ? 'success' : 'error'} dot />
        <span className="text-sm text-[var(--color-text-primary)]">{label}</span>
        <span className="text-xs text-[var(--color-text-muted)]">({name})</span>
      </div>
      <span
        className={`text-xs ${installed ? 'text-[var(--color-success)]' : 'text-[var(--color-error)]'}`}
      >
        {installed ? t('agents.installed') : t('agents.notInstalled')}
      </span>
    </div>
  );
};
