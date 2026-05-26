/**
 * @file ZoteroStatusBadge.tsx — StatusBar 中的 Zotero 索引状态徽章
 * @description 左侧小圆点(颜色映射 BibStatus)+ 鼠标悬停 tooltip 显示 "Zotero: ${status}"。
 *              点击展开 <ZoteroDiagnosticsPopover>(itemCount / lastSyncedAt /
 *              数据源健康度 / 手动刷新按钮)。若用户尚未启用 Zotero 集成
 *              (`integrationEnabled=false`),返回 null —— 不占位、不留痕。
 *
 *              数据来自 useZoteroBibMirror(订阅 main 进程 canonical 索引)。
 */

import type React from 'react';
import { useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useClickOutside } from '../../hooks';
import { useZoteroBibMirror } from '../../hooks/useZoteroBibMirror';
import { useTranslation } from '../../locales';
import { BIB_STATUS_COLOR, isBibStatusBusy } from '../../services/zotero/statusColor';
import { ZoteroDiagnosticsPopover } from './ZoteroDiagnosticsPopover';

export const ZoteroStatusBadge: React.FC = () => {
  const { t } = useTranslation();
  const { state, mirror, enabled } = useZoteroBibMirror();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useClickOutside(containerRef, () => setOpen(false), open);

  if (!enabled) return null;

  const statusLabel = t(`zotero.status.${state.status}` as const);
  const tooltip = `${t('zotero.status.tooltipPrefix')}: ${statusLabel}`;
  const busy = isBibStatusBusy(state.status);

  return (
    <div
      ref={containerRef}
      className="relative h-full"
      style={{ borderLeft: '1px solid var(--color-border-subtle)' }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-3 h-full transition-colors cursor-pointer hover:bg-[var(--color-bg-hover)]"
        title={tooltip}
        aria-label={tooltip}
      >
        {busy ? (
          <Loader2
            size={10}
            className="animate-spin"
            style={{ color: BIB_STATUS_COLOR[state.status] }}
          />
        ) : (
          <span
            className="inline-block w-1.5 h-1.5 rounded-full"
            style={{ background: BIB_STATUS_COLOR[state.status] }}
          />
        )}
        <span
          className="hidden sm:inline text-[11px] font-medium"
          style={{ color: 'var(--color-text-muted)' }}
        >
          {t('zotero.status.label')}
        </span>
      </button>

      {open && (
        <ZoteroDiagnosticsPopover
          state={state}
          mirror={mirror}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
};
