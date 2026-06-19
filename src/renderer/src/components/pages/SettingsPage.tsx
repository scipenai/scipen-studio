/**
 * @file SettingsPage.tsx - Workspace Settings Overlay
 * @description Overlay settings page that temporarily covers the current workspace
 */

import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from '../../locales';
import { useLazyModule } from '../../hooks/useLazyModule';

const LoadingFallback = () => {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
      {t('workspaceSidebar.settingsLoading')}
    </div>
  );
};

export const SettingsPage: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useTranslation();
  const titleId = 'workspace-settings-title';
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const GeneralSettingsPanel = useLazyModule(() =>
    import('../SettingsPanel').then((m) => m.SettingsPanel)
  );

  useEffect(() => {
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const firstAction = dialogRef.current?.querySelector<HTMLElement>('button:not(:disabled)');

    (firstAction ?? dialogRef.current)?.focus();

    return () => {
      previouslyFocusedRef.current?.focus();
    };
  }, []);

  const handleDialogKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose]
  );

  return (
    <div
      className="flex h-full w-full justify-start p-4 backdrop-blur-[4px]"
      style={{ background: 'color-mix(in srgb, var(--color-backdrop) 28%, transparent)' }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
        initial={{ x: -40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: -40, opacity: 0 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        className="flex h-full w-[min(720px,100%)] flex-col overflow-hidden rounded-[28px] border shadow-[var(--shadow-lg)]"
        style={{
          borderColor: 'var(--color-border)',
          background: 'color-mix(in srgb, var(--color-bg-primary) 96%, transparent)',
        }}
      >
        <div
          className="flex items-center justify-between border-b px-6 py-5"
          style={{ borderBottomColor: 'var(--color-border-subtle)' }}
        >
          <div>
            <div
              id={titleId}
              className="text-[16px] font-semibold text-[var(--color-text-primary)]"
            >
              {t('settingsPanel.title')}
            </div>
            <div className="mt-1 text-sm text-[var(--color-text-muted)]">
              {t('settingsPanel.description')}
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label={t('settingsPanel.close')}
            title={t('settingsPanel.close')}
            className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-2xl border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            style={{
              borderColor: 'var(--color-border-subtle)',
              background: 'color-mix(in srgb, var(--color-bg-elevated) 92%, transparent)',
              color: 'var(--color-text-muted)',
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = 'var(--color-bg-hover)';
              event.currentTarget.style.color = 'var(--color-text-primary)';
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background =
                'color-mix(in srgb, var(--color-bg-elevated) 92%, transparent)';
              event.currentTarget.style.color = 'var(--color-text-muted)';
            }}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        <div
          className="min-h-0 flex-1 overflow-hidden"
          style={{ background: 'var(--color-bg-secondary)' }}
        >
          {GeneralSettingsPanel ? <GeneralSettingsPanel /> : <LoadingFallback />}
        </div>
      </motion.div>
    </div>
  );
};
