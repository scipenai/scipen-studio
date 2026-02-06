/**
 * @file EditorToolbar.tsx - Editor Toolbar
 * @description Editor top toolbar with tabs, compile button and AI polish features
 */

import { clsx } from 'clsx';
import { Link2, Play, Wand2, X } from 'lucide-react';
import type React from 'react';
import { t } from '../../../locales';
import type { EditorTab } from '../../../types';

export interface EditorToolbarProps {
  openTabs: EditorTab[];
  activeTabPath: string | null;
  isCompiling: boolean;
  hasPdf: boolean;
  onTabClick: (path: string) => void;
  onTabClose: (e: React.MouseEvent, path: string) => void;
  onPolish: () => void;
  onSyncTexJump: () => void;
  onCompile: () => void;
}

export const EditorToolbar: React.FC<EditorToolbarProps> = ({
  openTabs,
  activeTabPath,
  isCompiling,
  hasPdf,
  onTabClick,
  onTabClose,
  onPolish,
  onSyncTexJump,
  onCompile,
}) => {
  const isCompileDisabled = openTabs.length === 0;

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
        className="flex items-center gap-0.5 px-2"
        style={{ borderLeft: '1px solid var(--color-border-subtle)' }}
      >
        <button
          onClick={onPolish}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm transition-all cursor-pointer"
          style={{ color: 'var(--color-text-muted)' }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(245, 158, 11, 0.1)';
            e.currentTarget.style.color = '#f59e0b';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--color-text-muted)';
          }}
          title={t('editorToolbar.aiPolish')}
        >
          <Wand2 size={15} />
        </button>

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
              ? 'rgba(239, 68, 68, 0.15)'
              : isCompileDisabled
                ? 'var(--color-bg-tertiary)'
                : 'var(--color-accent-muted)',
            color: isCompiling
              ? '#ef4444'
              : isCompileDisabled
                ? 'var(--color-text-disabled)'
                : 'var(--color-accent)',
            border: `1px solid ${
              isCompiling ? 'rgba(239, 68, 68, 0.3)' : 'rgba(34, 211, 238, 0.2)'
            }`,
          }}
          onMouseEnter={(e) => {
            if (!isCompiling && !isCompileDisabled) {
              e.currentTarget.style.background = 'rgba(34, 211, 238, 0.25)';
              e.currentTarget.style.boxShadow = '0 0 15px rgba(34, 211, 238, 0.2)';
            } else if (isCompiling) {
              e.currentTarget.style.background = 'rgba(239, 68, 68, 0.25)';
              e.currentTarget.style.boxShadow = '0 0 15px rgba(239, 68, 68, 0.2)';
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = isCompiling
              ? 'rgba(239, 68, 68, 0.15)'
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
