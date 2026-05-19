/**
 * @file AgentChatInput - text input + send / cancel for the Agent chat panel.
 *
 * Distinct from the legacy `ChatInput` used by the older Chat subsystem.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

interface AgentChatInputProps {
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  onSend: (text: string) => void;
  onCancel?: () => void;
  /**
   * Externally injected prompt text. Each time `seedKey` changes the input
   * adopts `seedValue` as its current draft, then keeps it editable. Useful
   * for "Ask AI about this compile error" buttons that pre-fill the prompt.
   * Pass `seedKey` as a monotonically increasing counter so identical seeds
   * still trigger a refill.
   */
  seedValue?: string;
  seedKey?: number;
}

export function AgentChatInput({
  busy,
  disabled,
  placeholder,
  onSend,
  onCancel,
  seedValue,
  seedKey,
}: AgentChatInputProps): React.ReactElement {
  const [value, setValue] = useState<string>('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [value]);

  // Apply seed on `seedKey` change. We intentionally don't depend on
  // `seedValue` directly so a re-render with the same key (e.g. parent
  // re-render) won't clobber the user's mid-edit text.
  useEffect(() => {
    if (seedKey === undefined) return;
    setValue(seedValue ?? '');
    // Focus + select-all so the user can immediately overwrite or hit Enter.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seedValue is intentionally not a dep
  }, [seedKey]);

  const submit = useCallback(() => {
    const text = value.trim();
    if (!text || busy || disabled) return;
    onSend(text);
    setValue('');
  }, [value, busy, disabled, onSend]);

  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-bg-primary)] p-2.5">
      <div className="relative rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] focus-within:border-[var(--color-accent)]">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder ?? (disabled ? '初始化中…' : '问点什么 (Enter 发送, Shift+Enter 换行)')}
          disabled={disabled}
          rows={1}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          className="w-full resize-none bg-transparent px-3 py-2 pr-12 text-[13px] leading-[1.55] text-[var(--color-text-primary)] caret-[var(--color-accent)] outline-none placeholder:text-[var(--color-text-muted)] disabled:cursor-not-allowed"
        />
        <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1">
          {busy && onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              title="取消"
              className="rounded-md bg-[var(--color-bg-secondary)] px-2 py-1 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-primary)] hover:text-[var(--color-text)]"
            >
              停止
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!value.trim() || disabled}
              className="rounded-md bg-[var(--color-accent)] px-2 py-1 text-[11px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
