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
    const unsubscribe = api.app.onUpdateStatus((s) => {
      setStatus(s);
    });
    return unsubscribe;
  }, []);

  const handleCheck = useCallback(async () => {
    const result = await api.app.checkUpdate();
    setStatus(result);
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
      <div className="px-4 py-3 mb-4 rounded-lg bg-zinc-800/50 text-sm">
        <span className="text-zinc-400">v</span>
        <span className="text-zinc-200 font-mono">{status.currentVersion || '...'}</span>
      </div>

      {/* Status display area */}
      <div className="px-4 py-3 mb-4 rounded-lg bg-zinc-800/50">
        {state === 'idle' && (
          <button
            type="button"
            onClick={handleCheck}
            className="flex items-center gap-2 px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-700 text-white transition-colors"
          >
            <RefreshCw size={14} />
            {t('update.checkUpdate')}
          </button>
        )}

        {state === 'checking' && (
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <Loader2 size={14} className="animate-spin" />
            {t('update.checking')}
          </div>
        )}

        {state === 'not-available' && (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-green-400">
              <CheckCircle size={14} />
              {t('update.notAvailable')}
            </div>
            <button
              type="button"
              onClick={handleCheck}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
            >
              <RefreshCw size={12} />
              {t('update.retryCheck')}
            </button>
          </div>
        )}

        {state === 'available' && info && (
          <div className="space-y-3">
            <div className="text-sm text-yellow-400">
              {t('update.available', { version: info.version })}
            </div>
            <button
              type="button"
              onClick={handleDownload}
              className="flex items-center gap-2 px-3 py-1.5 text-sm rounded bg-blue-600 hover:bg-blue-700 text-white transition-colors"
            >
              <Download size={14} />
              {t('update.download')}
            </button>
          </div>
        )}

        {state === 'downloading' && progress && (
          <div className="space-y-2">
            <div className="text-sm text-zinc-300">
              {t('update.downloading', { percent: Math.round(progress.percent) })}
            </div>
            <div className="w-full h-2 rounded-full bg-zinc-700 overflow-hidden">
              <div
                className="h-full rounded-full bg-blue-500 transition-all duration-300"
                style={{ width: `${Math.min(progress.percent, 100)}%` }}
              />
            </div>
          </div>
        )}

        {state === 'downloaded' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-green-400">
              <CheckCircle size={14} />
              {t('update.downloaded')}
            </div>
            <button
              type="button"
              onClick={handleInstall}
              className="flex items-center gap-2 px-3 py-1.5 text-sm rounded bg-green-600 hover:bg-green-700 text-white transition-colors"
            >
              <RotateCcw size={14} />
              {t('update.installAndRestart')}
            </button>
          </div>
        )}

        {state === 'error' && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-red-400">
              <AlertCircle size={14} />
              {t('update.error', { error: error || '' })}
            </div>
            <button
              type="button"
              onClick={handleCheck}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
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
          <div className="px-4 py-3 rounded-lg bg-zinc-800/50 text-sm text-zinc-300 whitespace-pre-wrap max-h-48 overflow-y-auto">
            {info.releaseNotes}
          </div>
        </>
      )}
    </>
  );
};
