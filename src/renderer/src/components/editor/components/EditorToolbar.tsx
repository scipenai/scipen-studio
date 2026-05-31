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
  documentMode?: boolean;
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
  documentMode = false,
  onTabClick,
  onTabClose,
  onSyncTexJump,
  onCompile,
  reviewFileIds,
  pendingReview,
}) => {
  const isCompileDisabled = openTabs.length === 0;
  const activeTab = openTabs.find((tab) => tab.path === activeTabPath) ?? null;
  const isMarkdown = Boolean(activeTab?.name.toLowerCase().endsWith('.md'));
  const showCompileButton = !isMarkdown;
  const pendingReviewSummary = pendingReview
    ? t('diffReview.changesCount', { count: String(pendingReview.hunkCount) })
    : '';

  if (documentMode && activeTab) {
    return (
      <div
        className="flex items-center justify-between px-4 py-2.5"
        style={{
          background: 'color-mix(in srgb, var(--color-bg-elevated) 92%, transparent)',
          borderBottom: '1px solid var(--color-border-subtle)',
        }}
      >
        <div className="min-w-0 flex items-center gap-2.5">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-2xl"
            style={{ background: 'var(--color-accent-muted)', color: 'var(--color-accent)' }}
          >
            {activeTab.name.endsWith('.typ') ? 'T' : activeTab.name.endsWith('.tex') ? 'L' : 'F'}
          </div>
          <div className="min-w-0">
            <div
              className="truncate text-[15px] font-medium tracking-[-0.02em]"
              style={{ color: 'var(--color-text-primary)' }}
            >
              {activeTab.name}
            </div>
            <div
              className="mt-0.5 flex items-center gap-2 text-[11px]"
              style={{ color: 'var(--color-text-muted)' }}
            >
              <span>{activeTab.language || 'Document'}</span>
              {activeTab.isDirty && (
                <span style={{ color: 'var(--color-warning)' }}>
                  {t('editorToolbar.unsavedChanges')}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {pendingReview && (
            <div
              className="flex items-center gap-2 rounded-[18px] border px-3 py-1.5 text-[12px]"
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
                className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors"
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
                className="flex items-center gap-1.5 rounded-full bg-[linear-gradient(135deg,#16a34a_0%,#22c55e_100%)] px-3.5 py-1.5 text-sm font-semibold text-white shadow-[0_12px_24px_rgba(34,197,94,0.22)] transition-all hover:-translate-y-[1px] hover:shadow-[0_16px_28px_rgba(34,197,94,0.26)] disabled:translate-y-0 disabled:shadow-none"
                title={t('diffReview.acceptAll')}
                disabled={pendingReview.disabled}
              >
                <Check size={12} />
                <span>{t('diffReview.acceptAll')}</span>
              </button>
              <button
                type="button"
                onClick={pendingReview.onRejectAll}
                className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50"
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
              'flex items-center gap-1.5 rounded-full px-3 py-2 text-sm transition-all',
              hasPdf ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'
            )}
            style={{
              color: 'var(--color-text-muted)',
              background: 'color-mix(in srgb, var(--color-bg-primary) 80%, transparent)',
              border: '1px solid var(--color-border-subtle)',
            }}
            title={t('editorToolbar.jumpToPdf')}
          >
            <Link2 size={15} />
          </button>

          {showCompileButton ? (
            <button
              data-compile-button
              onClick={onCompile}
              disabled={isCompileDisabled}
              className={clsx(
                'flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-all',
                isCompileDisabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
              )}
              style={{
                background: isCompiling
                  ? 'color-mix(in srgb, var(--color-error) 12%, transparent)'
                  : isCompileDisabled
                    ? 'color-mix(in srgb, var(--color-bg-primary) 82%, transparent)'
                    : 'color-mix(in srgb, var(--color-accent) 10%, transparent)',
                color: isCompiling
                  ? 'var(--color-error)'
                  : isCompileDisabled
                    ? 'var(--color-text-disabled)'
                    : 'var(--color-accent)',
                border: `1px solid ${isCompiling ? 'color-mix(in srgb, var(--color-error) 18%, transparent)' : 'color-mix(in srgb, var(--color-accent) 14%, transparent)'}`,
              }}
              title={isCompiling ? t('editorToolbar.stopCompile') : t('editorToolbar.compile')}
            >
              {isCompiling ? <X size={14} /> : <Play size={14} />}
              <span>{isCompiling ? t('editorToolbar.stop') : t('editor.compile')}</span>
            </button>
          ) : (
            <div
              className="rounded-full px-3 py-2 text-[12px]"
              style={{
                background: 'var(--color-bg-hover)',
                color: 'var(--color-text-muted)',
              }}
            >
              {t('editorToolbar.livePreview')}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex items-center"
      style={{
        background: 'var(--color-bg-primary)',
        borderBottom: '1px solid var(--color-border-subtle)',
      }}
    >
      <div className="flex-1 flex overflow-x-auto">
        {openTabs.map((tab) => {
          const isActive = tab.path === activeTabPath;
          return (
            <div
              key={tab.path}
              onClick={() => onTabClick(tab.path)}
              className="group relative flex items-center gap-2 px-4 py-2.5 text-sm transition-all cursor-pointer"
              style={{
                background: isActive ? 'var(--color-bg-secondary)' : 'transparent',
                color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
                borderRight: '1px solid var(--color-border-subtle)',
              }}
            >
              {isActive && (
                <div
                  className="absolute top-0 left-0 right-0 h-[2px]"
                  style={{ background: 'var(--gradient-accent)' }}
                />
              )}
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
            className="flex items-center gap-2 rounded-[18px] border px-3 py-1.5 text-[12px]"
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
              className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50"
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
              className="flex items-center gap-1.5 rounded-full bg-[linear-gradient(135deg,#16a34a_0%,#22c55e_100%)] px-3.5 py-1.5 text-sm font-semibold text-white shadow-[0_12px_24px_rgba(34,197,94,0.22)] transition-all hover:-translate-y-[1px] hover:shadow-[0_16px_28px_rgba(34,197,94,0.26)] disabled:translate-y-0 disabled:opacity-50 disabled:shadow-none"
              title={t('diffReview.acceptAll')}
              disabled={pendingReview.disabled}
            >
              <Check size={12} />
              <span>{t('diffReview.acceptAll')}</span>
            </button>
            <button
              type="button"
              onClick={pendingReview.onRejectAll}
              className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50"
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
            'flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ml-1',
            isCompileDisabled ? 'cursor-not-allowed' : 'cursor-pointer'
          )}
          style={{
            background: isCompiling
              ? 'color-mix(in srgb, var(--color-error) 15%, transparent)'
              : isCompileDisabled
                ? 'var(--color-bg-tertiary)'
                : 'var(--color-accent-muted)',
            color: isCompiling
              ? 'var(--color-error)'
              : isCompileDisabled
                ? 'var(--color-text-disabled)'
                : 'var(--color-accent)',
            border: `1px solid ${
              isCompiling ? 'color-mix(in srgb, var(--color-error) 30%, transparent)' : 'color-mix(in srgb, var(--color-accent) 20%, transparent)'
            }`,
          }}
          onMouseEnter={(e) => {
            if (!isCompiling && !isCompileDisabled) {
              e.currentTarget.style.background = 'color-mix(in srgb, var(--color-accent) 25%, transparent)';
              e.currentTarget.style.boxShadow = '0 0 15px color-mix(in srgb, var(--color-accent) 20%, transparent)';
            } else if (isCompiling) {
              e.currentTarget.style.background = 'color-mix(in srgb, var(--color-error) 25%, transparent)';
              e.currentTarget.style.boxShadow = '0 0 15px color-mix(in srgb, var(--color-error) 20%, transparent)';
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = isCompiling
              ? 'color-mix(in srgb, var(--color-error) 15%, transparent)'
              : 'var(--color-accent-muted)';
            e.currentTarget.style.boxShadow = 'none';
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
