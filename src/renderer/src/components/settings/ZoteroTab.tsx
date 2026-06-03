/**
 * @file ZoteroTab.tsx — Zotero 集成设置入口
 * @description 主开关 `integrationEnabled` 一统全局:
 *              - 未启用态:引导卡片 + "立即引导设置" 按钮(打开 wizard)
 *              - 已启用态:实时状态卡(BibStatus / itemCount / lastSyncedAt)+
 *                          数据源健康度(Local API / Better BibTeX)+
 *                          三个动作按钮(刷新 / 重开向导 / 重检测安装)
 *
 *              状态卡复用 `useZoteroBibMirror` 单例,与 StatusBar 徽章看到同一份事实。
 *              首次启用(toggle 翻 true 且 `localApiEnabled=false`)自动弹 wizard。
 *              停用仅停镜像,不清子设置 —— 用户切换试用不会丢配置。
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
import { SectionTitle, SettingCard, Toggle } from './SettingsUI';

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
  // 防止 toggle 翻 true 后,settings 异步同步期间反复触发 wizard 自动弹出。
  const [autoOpenedOnce, setAutoOpenedOnce] = useState(false);

  // 已启用 + 状态切换时拉一次完整诊断(数据源健康度)。
  // 依赖 state.status 而非 state.etag —— etag 每次 patch 都变,但源健康度只在
  // status(ready/degraded/error)切换时才有意义重拉。
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

  // 首次启用 + localApiEnabled 还未就绪 → 自动开 wizard。
  // wizard controller 引用不稳定(useZoteroWizard 未 memo),所以这里同步 set
  // autoOpenedOnce=true 以拦截 effect 重入,避免多发 getSettings IPC。
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
        // 关闭时让自动弹窗策略复位,下次再开重新评估。
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
    <div className="space-y-6">
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
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error}
        </div>
      )}

      <SectionTitle>{t('zoteroSettings.basicSettings')}</SectionTitle>

      <SettingCard>
        <Toggle
          label={t('zoteroSettings.enableIntegration')}
          desc={t('zoteroSettings.enableIntegrationDesc')}
          checked={enabled}
          onChange={(next) => void handleToggle(next)}
          disabled={toggling}
        />
      </SettingCard>

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
        className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-[var(--color-accent)] text-white hover:opacity-90 transition-opacity"
      >
        <Sparkles size={14} />
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
      <SectionTitle>{t('zoteroSettings.indexStatus')}</SectionTitle>

      <SettingCard>
        <div className="flex items-center justify-between">
          <span className="text-sm text-[var(--color-text-muted)]">
            {t('zoteroSettings.statusLabel')}
          </span>
          <span className="flex items-center gap-2 text-sm font-medium">
            <span
              className="inline-block w-2 h-2 rounded-full"
              style={{ background: BIB_STATUS_COLOR[state.status] }}
            />
            {t(`zotero.status.${state.status}` as const)}
          </span>
        </div>
      </SettingCard>

      <SettingCard>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs text-[var(--color-text-muted)] mb-1">
              {t('zoteroSettings.itemCount')}
            </div>
            <div className="text-lg font-mono font-semibold text-[var(--color-text-primary)]">
              {state.itemCount}
            </div>
          </div>
          <div>
            <div className="text-xs text-[var(--color-text-muted)] mb-1">
              {t('zoteroSettings.lastSyncedAt')}
            </div>
            <div className="text-sm font-mono text-[var(--color-text-secondary)]">
              {state.lastSyncedAt
                ? new Date(state.lastSyncedAt).toLocaleString()
                : t('zoteroSettings.never')}
            </div>
          </div>
        </div>
      </SettingCard>

      <SectionTitle>{t('zoteroSettings.sources')}</SectionTitle>

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

      <SectionTitle>{t('zoteroSettings.actions')}</SectionTitle>

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
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text-primary)] disabled:opacity-50 flex-shrink-0"
      >
        {icon}
        <span>{busy ? t('zoteroSettings.busy') : t('zoteroSettings.execute')}</span>
      </button>
    </div>
  );
};

export default ZoteroTab;
