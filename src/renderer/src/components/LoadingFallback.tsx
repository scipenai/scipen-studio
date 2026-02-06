/**
 * @file LoadingFallback.tsx - Loading Fallback Component
 * @description Placeholder for lazy-loaded components, provides unified loading state feedback
 */

import { Loader2 } from 'lucide-react';
import type React from 'react';
import { t } from '../locales';

interface LoadingFallbackProps {
  message?: string;
  className?: string;
}

export const LoadingFallback: React.FC<LoadingFallbackProps> = ({ message, className = '' }) => {
  const displayMessage = message ?? t('loading.default');
  return (
    <div
      className={`h-full w-full flex flex-col items-center justify-center bg-[var(--color-bg-secondary)] ${className}`}
    >
      <Loader2 className="w-8 h-8 text-[var(--color-accent)] animate-spin mb-4" />
      <p className="text-sm text-[var(--color-text-muted)]">{displayMessage}</p>
    </div>
  );
};

export const EditorLoadingFallback: React.FC = () => (
  <LoadingFallback message={t('loading.editor')} />
);

export const PreviewLoadingFallback: React.FC = () => (
  <LoadingFallback message={t('loading.preview')} />
);
