/**
 * @file BibTexSyncSection.tsx —— Zotero tab 内的 references.bib 同步控制
 * @description 启用 toggle / 文件名 / translator 选择 / 立即同步按钮 / 当前状态。
 *              所有写操作通过 api.zotero.setSettings({bibTexSync: ...}) 走主进程,
 *              BibTexSyncService.setConfig 由 handler 端立即应用。
 */

import { FileText, Loader2, RefreshCw } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { useTranslation } from '../../locales';
import { createLogger } from '../../services/LogService';
import type {
  BibTexSyncConfigDTO,
  ZoteroSettingsDTO,
} from '../../../../../shared/types/zotero';
import type { BibTexSyncStatusDTO } from '../../../../../shared/types/zotero-events';
import {
  SectionTitle,
  SettingCard,
  Toggle,
  inputClassName,
  selectClassName,
} from './SettingsUI';

const logger = createLogger('BibTexSyncSection');

const TRANSLATORS = ['BetterBibLaTeX', 'BetterBibTeX', 'BibLaTeX', 'BibTeX'] as const;
const STATUS_POLL_INTERVAL_MS = 2000;

export const BibTexSyncSection: React.FC = () => {
  const { t } = useTranslation();
  const [config, setConfig] = useState<BibTexSyncConfigDTO | null>(null);
  const [status, setStatus] = useState<BibTexSyncStatusDTO>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // 初始读 settings 拿当前 config + 订阅变更(主开关切换 / 在别处改也能同步)。
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

  // 拉一次状态 + 定时刷新(同步通常 < 100ms,2s 轮询体感即时)。
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
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">
              {t('zoteroSettings.bibtexSync.fileName')}
            </label>
            <input
              type="text"
              className={inputClassName}
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
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">
              {t('zoteroSettings.bibtexSync.translator')}
            </label>
            <select
              className={selectClassName}
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
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text-primary)] disabled:opacity-50 flex-shrink-0"
          >
            {syncing ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <RefreshCw size={13} />
            )}
            {t('zoteroSettings.bibtexSync.syncNow')}
          </button>
        </div>
      </SettingCard>

      {/*
        启用后 LaTeX 编译还是要 .tex 显式 \addbibresource{} —— texlab 看得见
        .bib 文件不等于 LaTeX 编译能用。给出标准片段供用户复制。
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
      return <span className="text-xs text-[var(--color-text-muted)]">
        {t('zoteroSettings.bibtexSync.status.idle')}
      </span>;
    case 'syncing':
      return (
        <span className="flex items-center gap-1.5 text-xs text-[var(--color-accent)]">
          <Loader2 size={11} className="animate-spin" />
          {t('zoteroSettings.bibtexSync.status.syncing')}
        </span>
      );
    case 'ok':
      return (
        <div className="flex flex-col">
          <span className="flex items-center gap-1.5 text-xs text-[var(--color-success)]">
            <FileText size={11} />
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
        <span className="text-xs text-[var(--color-error)] truncate max-w-[320px]" title={status.reason}>
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
