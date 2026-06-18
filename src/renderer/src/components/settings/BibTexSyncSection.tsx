/**
 * @file BibTexSyncSection.tsx — references.bib sync controls inside the Zotero tab.
 * @description Enable toggle / file name / translator selector / sync-now
 *              button / current status. All writes go through the main process
 *              via api.zotero.setSettings({ bibTexSync: ... }); the handler side
 *              applies the change immediately via BibTexSyncService.setConfig.
 */

import { FileText, Loader2, RefreshCw } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useId, useState } from 'react';
import { api } from '../../api';
import { useTranslation } from '../../locales';
import { createLogger } from '../../services/LogService';
import type { BibTexSyncConfigDTO, ZoteroSettingsDTO } from '../../../../../shared/types/zotero';
import type { BibTexSyncStatusDTO } from '../../../../../shared/types/zotero-events';
import {
  SectionTitle,
  SettingCard,
  Toggle,
  inputMonoClassName,
  selectClassName,
} from './SettingsUI';

const logger = createLogger('BibTexSyncSection');

const TRANSLATORS = ['BetterBibLaTeX', 'BetterBibTeX', 'BibLaTeX', 'BibTeX'] as const;
const STATUS_POLL_INTERVAL_MS = 2000;

export const BibTexSyncSection: React.FC = () => {
  const { t } = useTranslation();
  const fileNameId = useId();
  const translatorId = useId();
  const [config, setConfig] = useState<BibTexSyncConfigDTO | null>(null);
  const [status, setStatus] = useState<BibTexSyncStatusDTO>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Initial read of settings to grab the current config, plus subscribe to
  // changes (so toggling the master switch or external edits stay in sync).
  useEffect(() => {
    let cancelled = false;
    void api.zotero
      .getSettings()
      .then((s) => {
        if (!cancelled) setConfig(s.bibTexSync);
      })
      .catch((err) => logger.warn('getSettings failed', err));
    const unsub = api.zotero.onSettingsChanged((s: ZoteroSettingsDTO) => {
      setConfig(s.bibTexSync);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  // Pull the status once and refresh on a timer. Sync usually completes in
  // < 100ms, so a 2s poll feels instant to the user.
  useEffect(() => {
    let cancelled = false;
    const pull = (): void => {
      void api.zotero
        .getBibTexSyncStatus()
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch((err) => logger.warn('getBibTexSyncStatus failed', err));
    };
    pull();
    const timer = setInterval(pull, STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const patchConfig = useCallback(
    async (next: Partial<BibTexSyncConfigDTO>) => {
      if (!config) return;
      const merged: BibTexSyncConfigDTO = { ...config, ...next };
      setSaving(true);
      try {
        await api.zotero.setSettings({ bibTexSync: merged });
        setConfig(merged);
      } catch (err) {
        logger.warn('setSettings.bibTexSync failed', err);
      } finally {
        setSaving(false);
      }
    },
    [config]
  );

  const handleSyncNow = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const result = await api.zotero.syncBibTex();
      setStatus(result);
    } catch (err) {
      logger.warn('syncBibTex failed', err);
    } finally {
      setSyncing(false);
    }
  }, [syncing]);

  if (!config) {
    return null;
  }

  return (
    <>
      <SectionTitle>{t('zoteroSettings.bibtexSync.title')}</SectionTitle>

      <SettingCard description={t('zoteroSettings.bibtexSync.description')}>
        <Toggle
          label={t('zoteroSettings.bibtexSync.enable')}
          desc={t('zoteroSettings.bibtexSync.enableDesc')}
          checked={config.enabled}
          onChange={(next) => void patchConfig({ enabled: next })}
          disabled={saving}
        />
      </SettingCard>

      <SettingCard>
        <div className="space-y-3">
          <div>
            <label
              htmlFor={fileNameId}
              className="block text-xs text-[var(--color-text-muted)] mb-1"
            >
              {t('zoteroSettings.bibtexSync.fileName')}
            </label>
            <input
              id={fileNameId}
              type="text"
              className={`${inputMonoClassName} focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]`}
              value={config.fileName}
              onChange={(e) => setConfig({ ...config, fileName: e.target.value })}
              onBlur={() =>
                void patchConfig({
                  fileName: config.fileName.trim() || '.scipen/zotero_library.bib',
                })
              }
              disabled={saving || !config.enabled}
              placeholder=".scipen/zotero_library.bib"
            />
            <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
              {t('zoteroSettings.bibtexSync.fileNameDesc')}
            </div>
          </div>

          <div>
            <label
              htmlFor={translatorId}
              className="block text-xs text-[var(--color-text-muted)] mb-1"
            >
              {t('zoteroSettings.bibtexSync.translator')}
            </label>
            <select
              id={translatorId}
              className={`${selectClassName} focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]`}
              value={config.translator}
              onChange={(e) => void patchConfig({ translator: e.target.value })}
              disabled={saving || !config.enabled}
            >
              {TRANSLATORS.map((tr) => (
                <option key={tr} value={tr}>
                  {tr}
                </option>
              ))}
            </select>
            <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
              {t('zoteroSettings.bibtexSync.translatorDesc')}
            </div>
          </div>
        </div>
      </SettingCard>

      <SettingCard>
        <div className="flex items-center justify-between gap-3">
          <StatusBadge status={status} />
          <button
            type="button"
            onClick={() => void handleSyncNow()}
            disabled={syncing}
            className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--color-bg-tertiary)] px-3 py-1.5 text-xs font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {syncing ? (
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw size={13} aria-hidden="true" />
            )}
            {t('zoteroSettings.bibtexSync.syncNow')}
          </button>
        </div>
      </SettingCard>

      {/*
        Even when enabled, LaTeX compilation still requires an explicit
        \addbibresource{} in the .tex file — texlab being able to see the
        .bib doesn't mean LaTeX builds will use it. We surface the standard
        snippet here so the user can copy it.
      */}
      {config.enabled && (
        <SettingCard>
          <div className="text-xs text-[var(--color-text-secondary)] mb-2">
            {t('zoteroSettings.bibtexSync.hintTitle')}
          </div>
          <pre
            className="px-3 py-2 rounded-lg font-mono text-[11px] overflow-x-auto"
            style={{
              background: 'var(--color-bg-tertiary)',
              color: 'var(--color-text-primary)',
              border: '1px solid var(--color-border-subtle)',
            }}
          >
            {`\\addbibresource{${config.fileName}}`}
          </pre>
          <div className="text-[10px] text-[var(--color-text-muted)] mt-1.5">
            {t('zoteroSettings.bibtexSync.hintDesc')}
          </div>
        </SettingCard>
      )}
    </>
  );
};

const StatusBadge: React.FC<{ status: BibTexSyncStatusDTO }> = ({ status }) => {
  const { t } = useTranslation();
  switch (status.kind) {
    case 'idle':
      return (
        <span className="text-xs text-[var(--color-text-muted)]">
          {t('zoteroSettings.bibtexSync.status.idle')}
        </span>
      );
    case 'syncing':
      return (
        <span className="flex items-center gap-1.5 text-xs text-[var(--color-accent)]">
          <Loader2 size={11} className="animate-spin" aria-hidden="true" />
          {t('zoteroSettings.bibtexSync.status.syncing')}
        </span>
      );
    case 'ok':
      return (
        <div className="flex flex-col">
          <span className="flex items-center gap-1.5 text-xs text-[var(--color-success)]">
            <FileText size={11} aria-hidden="true" />
            {t('zoteroSettings.bibtexSync.status.ok')}
          </span>
          <span className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
            {status.filePath} · {status.bytesWritten} B · {formatTime(status.lastSyncedAt)}
          </span>
        </div>
      );
    case 'skipped-no-change':
      return (
        <div className="flex flex-col">
          <span className="text-xs text-[var(--color-text-secondary)]">
            {t('zoteroSettings.bibtexSync.status.skipped')}
          </span>
          <span className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
            {status.filePath} · {formatTime(status.lastSyncedAt)}
          </span>
        </div>
      );
    case 'conflict':
      return (
        <div className="flex flex-col" title={status.reason}>
          <span className="text-xs text-[var(--color-warning)]">
            {t('zoteroSettings.bibtexSync.status.conflict')}
          </span>
          <span className="text-[10px] text-[var(--color-text-muted)] mt-0.5 truncate max-w-[280px]">
            {status.filePath}
          </span>
        </div>
      );
    case 'error':
      return (
        <span
          className="text-xs text-[var(--color-error)] truncate max-w-[320px]"
          title={status.reason}
        >
          {t('zoteroSettings.bibtexSync.status.error')}: {status.reason}
        </span>
      );
  }
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return iso;
  }
}
