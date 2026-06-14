/**
 * @file EmbeddingRecommendationSection — settings panel for "Active literature
 * recommendation (M3)" inside ZoteroTab.
 *
 * Master toggle `activeRecommendation` + embedding index status card (build
 * progress / no-key / error) + configure key (opens EmbeddingSetupDialog) +
 * rebuild index. When the toggle flips true without a key, the setup dialog
 * pops first and the toggle only activates after the key is saved. Flipping
 * false disables it immediately. Status is pushed live via onEmbeddingProgress.
 */

import { KeyRound, RefreshCw } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { useTranslation } from '../../locales';
import { createLogger } from '../../services/LogService';
import type { EmbeddingIndexStatusDTO } from '../../../../../shared/types/zotero-embedding';
import { EmbeddingSetupDialog } from '../onboarding/EmbeddingSetupDialog';
import { SectionTitle, SettingCard, Toggle } from './SettingsUI';

const logger = createLogger('EmbeddingSection');

export const EmbeddingRecommendationSection: React.FC = () => {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [status, setStatus] = useState<EmbeddingIndexStatusDTO | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  // Initial read of settings + index status; subscribe to settings/progress updates.
  useEffect(() => {
    let cancelled = false;
    void api.zotero.getSettings().then((s) => {
      if (cancelled) return;
      setEnabled(s.activeRecommendation);
      setHasKey(s.hasEmbeddingApiKey);
    });
    void api.zotero.getEmbeddingStatus().then((s) => !cancelled && setStatus(s));
    const offSettings = api.zotero.onSettingsChanged((s) => {
      setEnabled(s.activeRecommendation);
      setHasKey(s.hasEmbeddingApiKey);
    });
    const offProgress = api.zotero.onEmbeddingProgress((s) => setStatus(s));
    return () => {
      cancelled = true;
      offSettings();
      offProgress();
    };
  }, []);

  const handleToggle = useCallback(
    async (next: boolean) => {
      if (next && !hasKey) {
        setDialogOpen(true); // No key → configure first; onConfirmed will enable it.
        return;
      }
      try {
        await api.zotero.setSettings({ activeRecommendation: next });
      } catch (err) {
        logger.warn('toggle activeRecommendation failed', err);
      }
    },
    [hasKey]
  );

  const handleConfirmed = useCallback(async () => {
    try {
      await api.zotero.setSettings({ activeRecommendation: true });
    } catch (err) {
      logger.warn('enable after key setup failed', err);
    }
  }, []);

  return (
    <>
      <SectionTitle>{t('zoteroEmbedding.sectionTitle')}</SectionTitle>

      <SettingCard>
        <Toggle
          label={t('zoteroEmbedding.toggleLabel')}
          desc={t('zoteroEmbedding.toggleDesc')}
          checked={enabled}
          onChange={(next) => void handleToggle(next)}
        />
      </SettingCard>

      {enabled && (
        <SettingCard>
          <div className="flex items-center justify-between">
            <span className="text-sm text-[var(--color-text-muted)]">
              {t('zoteroEmbedding.statusLabel')}
            </span>
            <span className="text-sm font-medium text-[var(--color-text-primary)]">
              {status?.state === 'building'
                ? t('zoteroEmbedding.buildProgress')
                    .replace('{{embedded}}', String(status.embedded))
                    .replace('{{total}}', String(status.total))
                : t(`zoteroEmbedding.state.${status?.state ?? 'disabled'}`)}
            </span>
          </div>
          <div className="mt-3 flex gap-2">
            <SmallButton
              icon={<KeyRound size={13} />}
              label={t('zoteroEmbedding.configureKey')}
              onClick={() => setDialogOpen(true)}
            />
            <SmallButton
              icon={<RefreshCw size={13} />}
              label={t('zoteroEmbedding.rebuild')}
              onClick={() => void api.zotero.rebuildEmbeddingIndex()}
            />
          </div>
        </SettingCard>
      )}

      <EmbeddingSetupDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onConfirmed={() => void handleConfirmed()}
      />
    </>
  );
};

const SmallButton: React.FC<{ icon: React.ReactNode; label: string; onClick: () => void }> = ({
  icon,
  label,
  onClick,
}) => (
  <button
    type="button"
    onClick={onClick}
    className="flex items-center gap-1.5 rounded-lg bg-[var(--color-bg-tertiary)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]"
  >
    {icon}
    <span>{label}</span>
  </button>
);
