/**
 * @file UpdateTab.tsx — Application update settings page
 * @description Displays the current version, checks for updates, shows download progress,
 * and installs/restarts.
 */

import { RefreshCw, Download, RotateCcw, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { useTranslation } from '../../locales';
import type { UpdateStatus } from '../../../../../shared/ipc/app-contract';
import { SectionTitle } from './SettingsUI';

export const UpdateTab: React.FC = () => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<UpdateStatus>({
    state: 'idle',
    currentVersion: '',
  });

  useEffect(() => {
    // Fetch the current version.
    api.app.getVersion().then((version) => {
      setStatus((prev) => ({ ...prev, currentVersion: version }));
    });

    // Subscribe to update-status pushes.
    // `api.app.onUpdateStatus` forwards to the generic `onEvent`, which is
    // centrally validated via `eventSchemas` registered in `event-schemas.ts`;
    // invalid payloads are dropped at that layer, so anything we receive here
    // is guaranteed to be valid.
    const unsubscribe = api.app.onUpdateStatus((s) => {
      setStatus(s);
    });
    return unsubscribe;
  }, []);

  const handleCheck = useCallback(async () => {
    // `api.app.checkUpdate` validates its return value with the same
    // `updateStatusSchema`; invalid responses throw, and the catch below
    // handles that fallback.
    try {
      const result = await api.app.checkUpdate();
      setStatus(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus((prev) => ({ ...prev, state: 'error', error: msg }));
    }
  }, []);

  const handleDownload = useCallback(async () => {
    await api.app.downloadUpdate();
  }, []);

  const handleInstall = useCallback(() => {
    api.app.installUpdate();
  }, []);

  const { state, info, progress, error } = status;

  return (
    <>
      <SectionTitle>{t('update.currentVersion')}</SectionTitle>
      <div className="px-4 py-3 mb-4 rounded-lg bg-[var(--color-bg-secondary)] text-sm">
        <span className="text-[var(--color-text-muted)]">v</span>
        <span className="text-[var(--color-text-primary)] font-mono">
          {status.currentVersion || '...'}
        </span>
      </div>

      {/* Status display area */}
      <div className="px-4 py-3 mb-4 rounded-lg bg-[var(--color-bg-secondary)]">
        {state === 'idle' && (
          <button
            type="button"
            onClick={handleCheck}
            className="flex items-center gap-2 px-3 py-1.5 text-sm rounded bg-[var(--color-accent)] hover:opacity-90 text-white transition-colors"
          >
            <RefreshCw size={14} />
            {t('update.checkUpdate')}
          </button>
        )}

        {state === 'checking' && (
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <Loader2 size={14} className="animate-spin" />
            {t('update.checking')}
          </div>
        )}

        {state === 'not-available' && (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-[var(--color-success)]">
              <CheckCircle size={14} />
              {t('update.notAvailable')}
            </div>
            <button
              type="button"
              onClick={handleCheck}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors"
            >
              <RefreshCw size={12} />
              {t('update.retryCheck')}
            </button>
          </div>
        )}

        {state === 'available' && info && (
          <div className="space-y-3">
            <div className="text-sm text-[var(--color-warning)]">
              {t('update.available', { version: info.version })}
            </div>
            <button
              type="button"
              onClick={handleDownload}
              className="flex items-center gap-2 px-3 py-1.5 text-sm rounded bg-[var(--color-accent)] hover:opacity-90 text-white transition-colors"
            >
              <Download size={14} />
              {t('update.download')}
            </button>
          </div>
        )}

        {state === 'downloading' && progress && (
          <div className="space-y-2">
            <div className="text-sm text-[var(--color-text-secondary)]">
              {t('update.downloading', { percent: Math.round(progress.percent) })}
            </div>
            <div className="w-full h-2 rounded-full bg-[var(--color-bg-hover)] overflow-hidden">
              <div
                className="h-full rounded-full bg-[var(--color-accent)] transition-all duration-300"
                style={{ width: `${Math.min(progress.percent, 100)}%` }}
              />
            </div>
          </div>
        )}

        {state === 'downloaded' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-[var(--color-success)]">
              <CheckCircle size={14} />
              {t('update.downloaded')}
            </div>
            <button
              type="button"
              onClick={handleInstall}
              className="flex items-center gap-2 px-3 py-1.5 text-sm rounded bg-[var(--color-success)] hover:opacity-90 text-white transition-colors"
            >
              <RotateCcw size={14} />
              {t('update.installAndRestart')}
            </button>
          </div>
        )}

        {state === 'error' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-[var(--color-error)]">
              <AlertCircle size={14} />
              {t('update.error', { error: error || '' })}
            </div>
            <button
              type="button"
              onClick={handleCheck}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors"
            >
              <RefreshCw size={12} />
              {t('update.retryCheck')}
            </button>
          </div>
        )}
      </div>

      {/* Release Notes */}
      {info?.releaseNotes && (state === 'available' || state === 'downloaded') && (
        <>
          <SectionTitle>{t('update.releaseNotes')}</SectionTitle>
          <div className="px-4 py-3 rounded-lg bg-[var(--color-bg-secondary)] text-sm text-[var(--color-text-secondary)] whitespace-pre-wrap max-h-48 overflow-y-auto">
            {info.releaseNotes}
          </div>
        </>
      )}
    </>
  );
};
