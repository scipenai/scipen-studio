/**
 * @file WelcomeTips.tsx - Welcome 屏右列下半:Pro Tip 提示卡
 */

import { motion } from 'framer-motion';
import { Lightbulb } from 'lucide-react';
import type React from 'react';
import { useTranslation } from '../../locales';

export const WelcomeTips: React.FC = () => {
  const { t } = useTranslation();
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
          >
            {t('welcome.proTipDesc', { shortcut: '' })}
            <kbd
              className="mx-0.5 rounded px-1.5 py-0.5 font-mono text-[10px]"
              style={{
                background: 'var(--color-accent-muted)',
                border: '1px solid var(--welcome-tip-border)',
                color: 'var(--color-accent)',
              }}
            >
              Ctrl+Shift+P
            </kbd>
          </p>
        </div>
      </div>
    </motion.div>
  );
};
