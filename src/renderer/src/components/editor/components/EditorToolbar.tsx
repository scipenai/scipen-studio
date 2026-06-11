/**
 * @file EditorToolbar.tsx - Editor Toolbar
 * @description Editor top toolbar with tabs, compile button and editor actions
 */

import { clsx } from 'clsx';
import { ArrowDown, Check, Link2, Play, X } from 'lucide-react';
import type React from 'react';
import { t } from '../../../locales';
import { normalizeReviewPath } from '../../../services/core/DiffReviewService';
import type { EditorTab } from '../../../types';

export interface EditorToolbarProps {
  openTabs: EditorTab[];
  activeTabPath: string | null;
  isCompiling: boolean;
  hasPdf: boolean;
  onTabClick: (path: string) => void;
  onTabClose: (e: React.MouseEvent, path: string) => void;
  onSyncTexJump: () => void;
  onCompile: () => void;
  /** Set of file IDs with pending reviews (shown as an orange dot on the tab) */
  reviewFileIds?: Set<string>;
  pendingReview?: {
    fileName: string;
    hunkCount: number;
    lineCount: number;
    disabled?: boolean;
    onAcceptAll: () => void;
    onRejectAll: () => void;
    onNextChange: () => void;
  };
}

export const EditorToolbar: React.FC<EditorToolbarProps> = ({
  openTabs,
  activeTabPath,
  isCompiling,
  hasPdf,
  onTabClick,
  onTabClose,
  onSyncTexJump,
  onCompile,
  reviewFileIds,
  pendingReview,
}) => {
  const isCompileDisabled = openTabs.length === 0;
  const pendingReviewSummary = pendingReview
    ? t('diffReview.changesCount', { count: String(pendingReview.hunkCount) })
    : '';

  return (
    <div
      className="flex items-center gap-1 px-2 py-1.5"
      style={{
        background: 'var(--color-bg-void)',
        borderBottom: '1px solid var(--color-border-subtle)',
      }}
    >
      <div className="flex-1 flex gap-1 overflow-x-auto">
        {openTabs.map((tab) => {
          const isActive = tab.path === activeTabPath;
          return (
            // Modern tab: active = floating white pill (bg-primary + light shadow); inactive transparent muted.
            // Recessed tab row (bg-void) provides the base, sharing the segmented-control vocabulary with the right panel. Old violet gradient indicator bar removed.
            <div
              key={tab.path}
              onClick={() => onTabClick(tab.path)}
              className="group flex items-center gap-2 rounded-md px-3 py-1 text-sm transition-colors cursor-pointer"
              style={{
                background: isActive ? 'var(--color-bg-primary)' : 'transparent',
                color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
                boxShadow: isActive ? 'var(--shadow-xs)' : 'none',
              }}
            >
              {tab.isDirty && (
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ background: 'var(--color-accent)' }}
                />
              )}
              {reviewFileIds?.has(tab._id || normalizeReviewPath(tab.path)) && (
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ background: 'var(--color-warning)' }}
                  title={t('diffReview.pendingReview')}
                />
              )}
              <span className="truncate max-w-[140px] font-medium">{tab.name}</span>
              <span
                onClick={(e) => onTabClose(e, tab.path)}
                className="ml-1 p-1 rounded-md opacity-0 group-hover:opacity-100 transition-all cursor-pointer"
                style={{ background: 'transparent' }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--color-bg-hover)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                <X size={12} />
              </span>
            </div>
          );
        })}
      </div>

      <div
        className="flex items-center gap-2 px-2"
        style={{ borderLeft: '1px solid var(--color-border-subtle)' }}
      >
        {pendingReview && (
          <div
            className="flex items-center gap-2 rounded-xl border px-3 py-1.5 text-[12px]"
            style={{
              borderColor: 'color-mix(in srgb, var(--color-warning) 24%, transparent)',
              background:
                'linear-gradient(135deg, color-mix(in srgb, var(--color-warning-muted) 74%, var(--color-bg-elevated) 26%) 0%, color-mix(in srgb, var(--color-bg-elevated) 94%, transparent) 100%)',
              boxShadow: '0 10px 22px color-mix(in srgb, var(--color-warning) 12%, transparent)',
              color: 'var(--color-warning)',
            }}
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
            <div className="flex items-center gap-2">
              <span className="font-medium">{t('diffReview.pendingReview')}</span>
              <span
                style={{
                  color:
                    'color-mix(in srgb, var(--color-warning) 72%, var(--color-text-muted) 28%)',
                }}
              >
                {pendingReviewSummary}
              </span>
            </div>
            <button
              type="button"
              onClick={pendingReview.onNextChange}
              className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50"
              style={{
                borderColor: 'color-mix(in srgb, var(--color-warning) 18%, transparent)',
                background: 'color-mix(in srgb, var(--color-bg-primary) 82%, transparent)',
                color: 'var(--color-warning)',
              }}
              title={t('diffReview.nextChange')}
              disabled={pendingReview.disabled}
            >
              <ArrowDown size={12} />
              <span>{t('diffReview.nextChange')}</span>
            </button>
            <button
              type="button"
              onClick={pendingReview.onAcceptAll}
              className="flex items-center gap-1.5 rounded-lg bg-[linear-gradient(135deg,#16a34a_0%,#22c55e_100%)] px-3.5 py-1.5 text-sm font-semibold text-white shadow-[0_12px_24px_rgba(34,197,94,0.22)] transition-all hover:-translate-y-[1px] hover:shadow-[0_16px_28px_rgba(34,197,94,0.26)] disabled:translate-y-0 disabled:opacity-50 disabled:shadow-none"
              title={t('diffReview.acceptAll')}
              disabled={pendingReview.disabled}
            >
              <Check size={12} />
              <span>{t('diffReview.acceptAll')}</span>
            </button>
            <button
              type="button"
              onClick={pendingReview.onRejectAll}
              className="flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50"
              style={{
                borderColor: 'color-mix(in srgb, var(--color-error) 18%, transparent)',
                background: 'color-mix(in srgb, var(--color-bg-primary) 80%, transparent)',
                color: 'var(--color-error)',
              }}
              title={t('diffReview.rejectAll')}
              disabled={pendingReview.disabled}
            >
              <X size={12} />
              <span>{t('diffReview.rejectAll')}</span>
            </button>
          </div>
        )}

        <button
          onClick={onSyncTexJump}
          disabled={!hasPdf}
          className={clsx(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm transition-all',
            hasPdf ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'
          )}
          style={{ color: 'var(--color-text-muted)' }}
          onMouseEnter={(e) => {
            if (hasPdf) {
              e.currentTarget.style.background = 'var(--color-accent-muted)';
              e.currentTarget.style.color = 'var(--color-accent)';
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--color-text-muted)';
          }}
          title={t('editorToolbar.jumpToPdf')}
        >
          <Link2 size={15} />
        </button>

        <button
          data-compile-button
          onClick={onCompile}
          disabled={isCompileDisabled}
          className={clsx(
            'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ml-1',
            isCompileDisabled ? 'cursor-not-allowed' : 'cursor-pointer'
          )}
          style={{
            // ghost/outline: transparent by default, only blue text + blue icon + a faint border — avoids competing visually with the file tabs.
            background: 'transparent',
            color: isCompiling
              ? 'var(--color-error)'
              : isCompileDisabled
                ? 'var(--color-text-disabled)'
                : 'var(--color-accent)',
            border: `1px solid ${
              isCompiling
                ? 'color-mix(in srgb, var(--color-error) 30%, transparent)'
                : isCompileDisabled
                  ? 'var(--color-border-subtle)'
                  : 'color-mix(in srgb, var(--color-accent) 22%, transparent)'
            }`,
          }}
          onMouseEnter={(e) => {
            if (isCompileDisabled) return;
            // A single very faint fill is the hover feedback — the old glow was dropped to lighten the visual weight.
            e.currentTarget.style.background = isCompiling
              ? 'color-mix(in srgb, var(--color-error) 12%, transparent)'
              : 'var(--color-accent-muted)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
          }}
          title={isCompiling ? t('editorToolbar.stopCompile') : t('editorToolbar.compile')}
        >
          {isCompiling ? <X size={14} /> : <Play size={14} />}
          <span className="hidden sm:inline">
            {isCompiling ? t('editorToolbar.stop') : t('editor.compile')}
          </span>
        </button>
      </div>
    </div>
  );
};
