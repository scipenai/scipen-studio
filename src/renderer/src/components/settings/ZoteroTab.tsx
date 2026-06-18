/**
 * @file ZoteroTab.tsx — Zotero integration settings entry.
 * @description Master switch `integrationEnabled` gates everything:
 *              - Disabled state: onboarding card + "Start wizard" button (opens wizard)
 *              - Enabled state: live status card (BibStatus / itemCount / lastSyncedAt)
 *                + data source health (Local API / Better BibTeX)
 *                + three action buttons (refresh / reopen wizard / redetect install)
 *
 *              Status card reuses the `useZoteroBibMirror` singleton, so it shares
 *              the same source of truth as the StatusBar badge. First enable
 *              (toggle flips true while `localApiEnabled=false`) auto-pops the wizard.
 *              Disabling only stops the mirror without clearing sub-settings — users
 *              can toggle the trial on/off without losing their configuration.
 */

import { BookMarked, CheckCircle2, RefreshCw, Sparkles, XCircle } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { useZoteroBibMirror } from '../../hooks/useZoteroBibMirror';
import { useZoteroWizard } from '../../hooks/useZoteroWizard';
import { useTranslation } from '../../locales';
import { createLogger } from '../../services/LogService';
import { BIB_STATUS_COLOR } from '../../services/zotero/statusColor';
import type { ZoteroDiagnosticsDTO } from '../../../../../shared/types/zotero-events';
import { ZoteroSetupWizard } from '../onboarding/ZoteroSetupWizard';
import { BibTexSyncSection } from './BibTexSyncSection';
import { EmbeddingRecommendationSection } from './EmbeddingRecommendationSection';
import { Toggle } from '../ui';
import { FormRow, FormSection, SettingCard } from './SettingsUI';

const logger = createLogger('ZoteroTab');

export const ZoteroTab: React.FC = () => {
  const { t } = useTranslation();
  const { state, mirror, enabled } = useZoteroBibMirror();
  const wizard = useZoteroWizard();

  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<ZoteroDiagnosticsDTO | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [redetecting, setRedetecting] = useState(false);
  // Prevent the wizard from re-popping while settings sync asynchronously
  // after the toggle flips true.
  const [autoOpenedOnce, setAutoOpenedOnce] = useState(false);

  // When enabled and status transitions, refetch the full diagnostics
  // (data source health). Depends on state.status rather than state.etag —
  // etag changes on every patch, but source health only meaningfully shifts
  // when status (ready/degraded/error) actually changes.
  useEffect(() => {
    if (!enabled) {
      setDiagnostics(null);
      return;
    }
    let cancelled = false;
    void api.zotero
      .getDiagnostics()
      .then((d) => {
        if (!cancelled) setDiagnostics(d);
      })
      .catch((err) => logger.warn('getDiagnostics failed', err));
    return () => {
      cancelled = true;
    };
  }, [enabled, state.status]);

  // First enable + localApiEnabled not yet ready → auto-open the wizard.
  // The wizard controller reference is unstable (useZoteroWizard is not
  // memoized), so we synchronously set autoOpenedOnce=true to short-circuit
  // effect re-entry and avoid duplicate getSettings IPC calls.
  useEffect(() => {
    if (!enabled || autoOpenedOnce) return;
    setAutoOpenedOnce(true);
    let cancelled = false;
    void api.zotero
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        if (!settings.localApiEnabled) {
          wizard.open();
        }
      })
      .catch((err) => logger.warn('check localApiEnabled failed', err));
    return () => {
      cancelled = true;
    };
  }, [enabled, autoOpenedOnce, wizard]);

  const handleToggle = useCallback(async (next: boolean) => {
    setToggling(true);
    setError(null);
    try {
      await api.zotero.setSettings({ integrationEnabled: next });
      if (!next) {
        // Reset auto-popup policy on disable, so the next enable re-evaluates.
        setAutoOpenedOnce(false);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      logger.warn('toggle integrationEnabled failed', err);
    } finally {
      setToggling(false);
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await mirror.refresh();
      const d = await api.zotero.getDiagnostics();
      setDiagnostics(d);
    } catch (err) {
      logger.warn('refresh failed', err);
    } finally {
      setRefreshing(false);
    }
  }, [mirror, refreshing]);

  const handleRedetect = useCallback(async () => {
    if (redetecting) return;
    setRedetecting(true);
    try {
      await api.zotero.detectInstallation();
    } catch (err) {
      logger.warn('redetect failed', err);
    } finally {
      setRedetecting(false);
    }
  }, [redetecting]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2 rounded-lg bg-[var(--color-accent-muted)]">
          <BookMarked className="w-5 h-5 text-[var(--color-accent)]" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text-primary)]">
            {t('zoteroSettings.title')}
          </h2>
          <p className="text-sm text-[var(--color-text-muted)]">{t('zoteroSettings.subtitle')}</p>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error}
        </div>
      )}

      <FormSection title={t('zoteroSettings.basicSettings')} first>
        <FormRow
          title={t('zoteroSettings.enableIntegration')}
          description={t('zoteroSettings.enableIntegrationDesc')}
        >
          <Toggle
            size="sm"
            checked={enabled}
            onChange={(next) => void handleToggle(next)}
            disabled={toggling}
            aria-label={t('zoteroSettings.enableIntegration')}
          />
        </FormRow>
      </FormSection>

      {!enabled ? (
        <NotEnabledGuide onStart={() => wizard.open()} />
      ) : (
        <EnabledPanel
          state={state}
          diagnostics={diagnostics}
          refreshing={refreshing}
          redetecting={redetecting}
          onRefresh={handleRefresh}
          onReopenWizard={() => wizard.open()}
          onRedetect={() => void handleRedetect()}
        />
      )}

      <ZoteroSetupWizard controller={wizard} />
    </div>
  );
};

const NotEnabledGuide: React.FC<{ onStart: () => void }> = ({ onStart }) => {
  const { t } = useTranslation();
  return (
    <SettingCard
      title={t('zoteroSettings.notEnabledTitle')}
      description={t('zoteroSettings.notEnabledDesc')}
    >
      <button
        type="button"
        onClick={onStart}
        className="flex cursor-pointer items-center gap-2 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2"
      >
        <Sparkles size={14} aria-hidden="true" />
        {t('zoteroSettings.startWizard')}
      </button>
    </SettingCard>
  );
};

interface EnabledPanelProps {
  state: ReturnType<typeof useZoteroBibMirror>['state'];
  diagnostics: ZoteroDiagnosticsDTO | null;
  refreshing: boolean;
  redetecting: boolean;
  onRefresh: () => void;
  onReopenWizard: () => void;
  onRedetect: () => void;
}

const EnabledPanel: React.FC<EnabledPanelProps> = ({
  state,
  diagnostics,
  refreshing,
  redetecting,
  onRefresh,
  onReopenWizard,
  onRedetect,
}) => {
  const { t } = useTranslation();
  return (
    <>
      <FormSection title={t('zoteroSettings.indexStatus')}>
        <div className="flex items-center justify-between rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-4">
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: BIB_STATUS_COLOR[state.status] }}
            />
            <span className="text-sm font-medium text-[var(--color-text-primary)]">
              {t(`zotero.status.${state.status}` as const)}
            </span>
          </div>
          <div className="flex items-center gap-8">
            <div className="text-right">
              <div className="text-xs text-[var(--color-text-muted)]">
                {t('zoteroSettings.itemCount')}
              </div>
              <div className="font-mono text-base font-semibold text-[var(--color-text-primary)]">
                {state.itemCount}
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-[var(--color-text-muted)]">
                {t('zoteroSettings.lastSyncedAt')}
              </div>
              <div className="font-mono text-sm text-[var(--color-text-secondary)]">
                {state.lastSyncedAt
                  ? new Date(state.lastSyncedAt).toLocaleString()
                  : t('zoteroSettings.never')}
              </div>
            </div>
          </div>
        </div>
      </FormSection>

      <FormSection title={t('zoteroSettings.sources')}>
        <SettingCard>
          <SourceRow
            label={t('zoteroSettings.localApi')}
            ok={diagnostics?.sources.localApi.ok ?? null}
            error={diagnostics?.sources.localApi.error}
          />
          <div className="my-2 border-t border-[var(--color-border-subtle)]" />
          <SourceRow
            label={t('zoteroSettings.betterBibTex')}
            ok={diagnostics?.sources.betterBibTex.ok ?? null}
            error={diagnostics?.sources.betterBibTex.error}
          />
        </SettingCard>
      </FormSection>

      <FormSection title={t('zoteroSettings.actions')}>
        <SettingCard>
          <div className="space-y-2">
            <ActionRow
              label={t('zoteroSettings.refreshNow')}
              desc={t('zoteroSettings.refreshNowDesc')}
              busy={refreshing}
              icon={<RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />}
              onClick={onRefresh}
            />
            <ActionRow
              label={t('zoteroSettings.reopenWizard')}
              desc={t('zoteroSettings.reopenWizardDesc')}
              icon={<Sparkles size={13} />}
              onClick={onReopenWizard}
            />
            <ActionRow
              label={t('zoteroSettings.redetect')}
              desc={t('zoteroSettings.redetectDesc')}
              busy={redetecting}
              icon={<BookMarked size={13} />}
              onClick={onRedetect}
            />
          </div>
        </SettingCard>
      </FormSection>

      <BibTexSyncSection />

      <EmbeddingRecommendationSection />
    </>
  );
};

const SourceRow: React.FC<{ label: string; ok: boolean | null; error?: string }> = ({
  label,
  ok,
  error,
}) => (
  <div className="flex items-center justify-between" title={error ?? ''}>
    <span className="text-sm text-[var(--color-text-secondary)]">{label}</span>
    {ok === null ? (
      <span className="text-xs text-[var(--color-text-disabled)]">…</span>
    ) : ok ? (
      <CheckCircle2 size={16} style={{ color: 'var(--color-success)' }} />
    ) : (
      <XCircle size={16} style={{ color: 'var(--color-error)' }} />
    )}
  </div>
);

interface ActionRowProps {
  label: string;
  desc: string;
  icon: React.ReactNode;
  busy?: boolean;
  onClick: () => void;
}

const ActionRow: React.FC<ActionRowProps> = ({ label, desc, icon, busy, onClick }) => {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-[var(--color-text-primary)]">{label}</div>
        <div className="text-xs text-[var(--color-text-muted)]">{desc}</div>
      </div>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        title={label}
        aria-label={label}
        className="flex flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--color-bg-tertiary)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span aria-hidden="true">{icon}</span>
        <span>{busy ? t('zoteroSettings.busy') : t('zoteroSettings.execute')}</span>
      </button>
    </div>
  );
};

export default ZoteroTab;
