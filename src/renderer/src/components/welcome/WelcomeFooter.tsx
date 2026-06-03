/**
 * @file WelcomeFooter.tsx - Welcome 屏底部 footer
 */

import { motion } from 'framer-motion';
import type React from 'react';
import { useTranslation } from '../../locales';

export const WelcomeFooter: React.FC = () => {
  const { t } = useTranslation();
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 1 }}
      className="absolute bottom-6 left-0 right-0 text-center"
    >
      <p className="text-xs" style={{ color: 'var(--color-text-disabled)' }}>
        SciPen Studio · {t('welcome.footer')}
      </p>
    </motion.div>
  );
};
