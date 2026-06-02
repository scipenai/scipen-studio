/**
 * @file SettingsPage.tsx - Workspace Settings Overlay
 * @description Overlay settings page that temporarily covers the current workspace
 */

import { motion } from 'framer-motion';
import { X } from 'lucide-react';
import type React from 'react';
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
  const GeneralSettingsPanel = useLazyModule(() =>
    import('../SettingsPanel').then((m) => m.SettingsPanel)
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
            <div className="text-[16px] font-semibold text-[var(--color-text-primary)]">
              {t('settingsPanel.title')}
            </div>
            <div className="mt-1 text-sm text-[var(--color-text-muted)]">
              {t('settingsPanel.description')}
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            title={t('settingsPanel.close')}
            className="flex h-10 w-10 items-center justify-center rounded-2xl border transition-colors"
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
            <X size={16} />
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
