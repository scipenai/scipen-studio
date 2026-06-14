/**
 * @file CopyButton.tsx - Generic one-tap copy button
 * @description Copies text to the clipboard and shows a "copied" feedback for 1.4s. Warm
 *              (non-terminal) styling, used for AI message copy and similar surfaces. Reuses
 *              the copy pattern that originated in MarkdownCodeBlock.
 */

import { clsx } from 'clsx';
import { Check, Copy } from 'lucide-react';
import type React from 'react';
import { useCallback, useState } from 'react';
import { useTranslation } from '../../locales';

export interface CopyButtonProps {
  /** Text to copy */
  text: string;
  /** Custom class name (forwarded to the button) */
  className?: string;
  /** Custom "copy" label (defaults to chat.copyMessage) */
  label?: string;
}

export const CopyButton: React.FC<CopyButtonProps> = ({ text, className, label }) => {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Stay silent when the clipboard is unavailable (no permission / non-secure context)
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={() => {
        void handleCopy();
      }}
      className={clsx(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors',
        'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]',
        className
      )}
    >
      {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
      <span aria-live="polite">{copied ? t('chat.copied') : (label ?? t('chat.copyMessage'))}</span>
    </button>
  );
};

export default CopyButton;
