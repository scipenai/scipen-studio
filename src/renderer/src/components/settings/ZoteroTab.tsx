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

import {
  BookMarked,
  CheckCircle2,
  Cloud,
  HardDrive,
  KeyRound,
  RefreshCw,
  Sparkles,
  XCircle,
} from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { useZoteroBibMirror } from '../../hooks/useZoteroBibMirror';
import { useZoteroWizard } from '../../hooks/useZoteroWizard';
import { useTranslation } from '../../locales';
import { createLogger } from '../../services/LogService';
import { BIB_STATUS_COLOR } from '../../services/zotero/statusColor';
import type {
  ZoteroDataSource,
  ZoteroItemDTO,
  ZoteroSettingsDTO,
} from '../../../../../shared/types/zotero';
import type { ZoteroDiagnosticsDTO } from '../../../../../shared/types/zotero-events';
import { ZoteroSetupWizard } from '../onboarding/ZoteroSetupWizard';
import { ZoteroWebApiSetupDialog } from '../onboarding/ZoteroWebApiSetupDialog';
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
  // Settings snapshot subscribed to `onSettingsChanged` — carries dataSource /
  // webApiUserId / hasWebApiKey used by the mode + credential UI. Kept
  // separate from mirror state (which is items-only) so a settings-only edit
  // does not force a full mirror re-render.
  const [settings, setSettings] = useState<ZoteroSettingsDTO | null>(null);
  const [webDialogOpen, setWebDialogOpen] = useState(false);

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

  // Subscribe to settings — needed for dataSource + web-API card. Uses the
  // dedicated `Zotero_SettingsChanged` broadcast so it survives handler
  // side-effects (SetWebApiKey / SetSettings) without polling.
  useEffect(() => {
    let cancelled = false;
    void api.zotero
      .getSettings()
      .then((s) => {
        if (!cancelled) setSettings(s);
      })
      .catch((err) => logger.warn('getSettings failed', err));
    const unsub = api.zotero.onSettingsChanged((s) => setSettings(s));
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const handleDataSourceChange = useCallback(
    async (next: ZoteroDataSource) => {
      // Switching to 'web' without a stored key would leave the orchestrator
      // in the "not configured" error state on the next refresh. Instead of
      // silently letting that happen, gate the switch: if web is picked but
      // credentials are missing, pop the setup dialog first and defer the
      // settings flip to `onConfirmed` (which recalls this same handler).
      if (next === 'web' && (!settings?.hasWebApiKey || !settings?.webApiUserId)) {
        setWebDialogOpen(true);
        return;
      }
      try {
        await api.zotero.setSettings({ dataSource: next });
      } catch (err) {
        logger.warn('setSettings(dataSource) failed', err);
      }
    },
    [settings?.hasWebApiKey, settings?.webApiUserId]
  );

  const handleClearWebKey = useCallback(async () => {
    try {
      await api.zotero.clearWebApiKey();
    } catch (err) {
      logger.warn('clearWebApiKey failed', err);
    }
  }, []);

  // `mirror.getAllItems()` clones the internal Map values into a fresh array
  // every call. Without this memo, every unrelated re-render (webDialogOpen,
  // refreshing, settings, …) hands a new array reference to
  // CitationKeyOriginSection, defeating its inner useMemo and re-running the
  // O(n) origin-count loop for no reason. `state.etag` isn't used inside the
  // factory but IS the external change signal we need to re-run on — it's
  // the mirror's monotonic version cursor, bumped on every hydrate / patch.
  const items = useMemo(
    () => (enabled ? mirror.getAllItems() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- state.etag is an external re-run signal, not a value consumed inside
    [enabled, mirror, state.etag]
  );

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

      {enabled && settings && (
        <DataSourceSection
          settings={settings}
          onChange={(next) => void handleDataSourceChange(next)}
          onConfigureWeb={() => setWebDialogOpen(true)}
          onClearWebKey={() => void handleClearWebKey()}
        />
      )}

      {!enabled ? (
        <NotEnabledGuide onStart={() => wizard.open()} />
      ) : (
        <EnabledPanel
          state={state}
          diagnostics={diagnostics}
          refreshing={refreshing}
          redetecting={redetecting}
          dataSource={settings?.dataSource ?? 'local'}
          items={items}
          onRefresh={handleRefresh}
          onReopenWizard={() => wizard.open()}
          onRedetect={() => void handleRedetect()}
        />
      )}

      <ZoteroSetupWizard controller={wizard} />
      <ZoteroWebApiSetupDialog
        open={webDialogOpen}
        onClose={() => setWebDialogOpen(false)}
        onConfirmed={() => void handleDataSourceChange('web')}
        initialUserId={settings?.webApiUserId}
      />
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
  dataSource: ZoteroDataSource;
  items: ZoteroItemDTO[];
  onRefresh: () => void;
  onReopenWizard: () => void;
  onRedetect: () => void;
}

const EnabledPanel: React.FC<EnabledPanelProps> = ({
  state,
  diagnostics,
  refreshing,
  redetecting,
  dataSource,
  items,
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
          {dataSource === 'web' ? (
            <SourceRow
              label={t('zoteroSettings.webApi.source')}
              ok={diagnostics?.sources.web?.ok ?? null}
              error={diagnostics?.sources.web?.error}
            />
          ) : (
            <>
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
            </>
          )}
        </SettingCard>
      </FormSection>

      {dataSource === 'web' && <CitationKeyOriginSection items={items} />}

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

interface DataSourceSectionProps {
  settings: ZoteroSettingsDTO;
  onChange: (next: ZoteroDataSource) => void;
  onConfigureWeb: () => void;
  onClearWebKey: () => void;
}

const DataSourceSection: React.FC<DataSourceSectionProps> = ({
  settings,
  onChange,
  onConfigureWeb,
  onClearWebKey,
}) => {
  const { t } = useTranslation();
  const current = settings.dataSource;
  return (
    <FormSection title={t('zoteroSettings.dataSource.title')}>
      <SettingCard description={t('zoteroSettings.dataSource.description')}>
        <div className="space-y-2">
          <DataSourceOption
            checked={current === 'local'}
            icon={<HardDrive size={14} aria-hidden="true" />}
            label={t('zoteroSettings.dataSource.local')}
            desc={t('zoteroSettings.dataSource.localDesc')}
            onSelect={() => onChange('local')}
          />
          <DataSourceOption
            checked={current === 'web'}
            icon={<Cloud size={14} aria-hidden="true" />}
            label={t('zoteroSettings.dataSource.web')}
            desc={t('zoteroSettings.dataSource.webDesc')}
            onSelect={() => onChange('web')}
          />
        </div>
      </SettingCard>

      {current === 'web' && (
        <SettingCard title={t('zoteroSettings.webApi.credential')}>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  {t('zoteroSettings.webApi.userIdLabel')}
                </div>
                <div className="font-mono text-sm text-[var(--color-text-primary)]">
                  {settings.webApiUserId || t('zoteroSettings.webApi.userIdEmpty')}
                </div>
              </div>
              <div>
                <div className="text-xs text-[var(--color-text-muted)]">
                  {t('zoteroSettings.webApi.apiKeyLabel')}
                </div>
                <div className="flex items-center gap-1.5 text-sm text-[var(--color-text-primary)]">
                  <KeyRound size={12} aria-hidden="true" />
                  {settings.hasWebApiKey ? '••••••••' : t('zoteroSettings.webApi.apiKeyEmpty')}
                </div>
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={onConfigureWeb}
                className="flex-shrink-0 cursor-pointer rounded-lg bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                {settings.hasWebApiKey
                  ? t('zoteroSettings.webApi.reconfigure')
                  : t('zoteroSettings.webApi.configure')}
              </button>
              {settings.hasWebApiKey && (
                <button
                  type="button"
                  onClick={onClearWebKey}
                  className="flex-shrink-0 cursor-pointer rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
                >
                  {t('zoteroSettings.webApi.clear')}
                </button>
              )}
            </div>
            <div className="mt-2 rounded-lg bg-[var(--color-warning-muted)] p-2 text-[12px] text-[var(--color-warning)]">
              <div className="font-medium">{t('zoteroSettings.webApi.warningTitle')}</div>
              <div className="mt-0.5 text-[var(--color-text-secondary)]">
                {t('zoteroSettings.webApi.warningBody')}
              </div>
            </div>
          </div>
        </SettingCard>
      )}
    </FormSection>
  );
};

interface DataSourceOptionProps {
  checked: boolean;
  icon: React.ReactNode;
  label: string;
  desc: string;
  onSelect: () => void;
}

const DataSourceOption: React.FC<DataSourceOptionProps> = ({
  checked,
  icon,
  label,
  desc,
  onSelect,
}) => (
  <label
    className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-[var(--color-bg-hover)]"
    style={{
      borderColor: checked ? 'var(--color-accent)' : 'var(--color-border-subtle)',
      background: checked ? 'var(--color-accent-muted)' : undefined,
    }}
  >
    <input
      type="radio"
      name="zotero-data-source"
      checked={checked}
      onChange={onSelect}
      className="mt-1"
    />
    <span aria-hidden="true" className="mt-0.5 text-[var(--color-text-secondary)]">
      {icon}
    </span>
    <div className="flex-1 min-w-0">
      <div className="text-sm font-medium text-[var(--color-text-primary)]">{label}</div>
      <div className="text-xs text-[var(--color-text-muted)]">{desc}</div>
    </div>
  </label>
);

interface CitationKeyOriginSectionProps {
  items: ZoteroItemDTO[];
}

const CitationKeyOriginSection: React.FC<CitationKeyOriginSectionProps> = ({ items }) => {
  const { t } = useTranslation();
  // Counts recomputed per render — cheap for typical library sizes (thousands),
  // and settings-tab renders are already gated behind the settings modal so
  // there is no perf hot-path here.
  const counts = useMemo(() => {
    let bbt = 0;
    let studio = 0;
    let override = 0;
    for (const item of items) {
      if (item.citationKeyOrigin === 'bbt') bbt++;
      else if (item.citationKeyOrigin === 'user_override') override++;
      else if (item.citationKeyOrigin === 'studio_mint') studio++;
    }
    return { bbt, studio, override };
  }, [items]);

  return (
    <FormSection title={t('zoteroSettings.citationKey.title')}>
      <SettingCard description={t('zoteroSettings.citationKey.description')}>
        <div className="grid grid-cols-3 gap-3">
          <OriginStat label={t('zoteroSettings.citationKey.bbt')} value={counts.bbt} />
          <OriginStat label={t('zoteroSettings.citationKey.studioMint')} value={counts.studio} />
          <OriginStat
            label={t('zoteroSettings.citationKey.userOverride')}
            value={counts.override}
          />
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            disabled
            title={t('zoteroSettings.citationKey.manageComingSoon')}
            className="cursor-not-allowed rounded-lg px-3 py-1.5 text-xs text-[var(--color-text-muted)] opacity-60"
          >
            {t('zoteroSettings.citationKey.manage')}
          </button>
        </div>
      </SettingCard>
    </FormSection>
  );
};

const OriginStat: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-3">
    <div className="text-xs text-[var(--color-text-muted)]">{label}</div>
    <div className="mt-1 font-mono text-lg font-semibold text-[var(--color-text-primary)]">
      {value}
    </div>
  </div>
);

export default ZoteroTab;
