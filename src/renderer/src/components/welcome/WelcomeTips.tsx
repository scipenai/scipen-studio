/**
 * @file WelcomeTips.tsx - Bottom of the welcome screen's right column: Pro Tip card.
 */

import { motion } from 'framer-motion';
import { Lightbulb } from 'lucide-react';
import type React from 'react';
import { useTranslation } from '../../locales';

export const WelcomeTips: React.FC = () => {
  const { t } = useTranslation();
  const shortcut = 'Ctrl+Shift+P';
  const shortcutMarker = '__SCIPEN_SHORTCUT__';
  const [tipBeforeShortcut, tipAfterShortcut] = t('welcome.proTipDesc', {
    shortcut: shortcutMarker,
  }).split(shortcutMarker);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.8 }}
      className="rounded-2xl p-4"
      style={{
        background: 'var(--welcome-tip-bg)',
        border: '1px solid var(--welcome-tip-border)',
      }}
    >
      <div className="flex items-start gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
          style={{ background: 'var(--color-accent-muted)' }}
        >
          <Lightbulb className="h-5 w-5" style={{ color: 'var(--color-accent)' }} />
        </div>
        <div>
          <h3
            className="mb-1.5 text-sm font-semibold"
            style={{ color: 'var(--color-text-primary)' }}
          >
            {t('welcome.proTipTitle')}
          </h3>
          <p
            className="text-xs leading-relaxed"
            style={{ color: 'var(--color-text-secondary)' }}
            data-testid="welcome-pro-tip-desc"
          >
            {tipBeforeShortcut}
            <kbd
              className="mx-0.5 rounded px-1.5 py-0.5 font-mono text-[10px]"
              style={{
                background: 'var(--color-accent-muted)',
                border: '1px solid var(--welcome-tip-border)',
                color: 'var(--color-accent)',
              }}
            >
              {shortcut}
            </kbd>
            {tipAfterShortcut}
          </p>
        </div>
      </div>
    </motion.div>
  );
};
