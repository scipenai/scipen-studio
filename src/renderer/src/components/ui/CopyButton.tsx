/**
 * @file CopyButton.tsx - 通用一键复制按钮
 * @description 复制 text 到剪贴板,1.4s 内显示"已复制"反馈。温度风(非终端),
 *              用于 AI 消息复制等场景。复用了原 MarkdownCodeBlock 的 copy 模式。
 */

import { clsx } from 'clsx';
import { Check, Copy } from 'lucide-react';
import type React from 'react';
import { useCallback, useState } from 'react';
import { useTranslation } from '../../locales';

export interface CopyButtonProps {
  /** 要复制的文本 */
  text: string;
  /** 自定义类名(透传到 button) */
  className?: string;
  /** 自定义"复制"标签(默认 chat.copyMessage) */
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
      // 剪贴板不可用时静默(无权限/非安全上下文)
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
