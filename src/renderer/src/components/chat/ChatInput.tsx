/**
 * @file ChatInput.tsx - Chat Input Component
 * @description Optimized chat input component with @ file reference autocomplete
 */

import { AtSign, BookOpen, File, Folder, Send, Square } from 'lucide-react';
import type React from 'react';
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type CompletionItem, useFileCompletion } from '../../hooks/useFileCompletion';
import { useTranslation } from '../../locales';
import { IconButton } from '../ui';

export interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  isLoading: boolean;
  isDisabled: boolean;
  placeholder?: string;
  selectedLibraryName?: string;
  selectedLibraryDocCount?: number;
  autoFocus?: boolean;
}

/**
 * Extract @ query from input value
 * Returns null if cursor is not after @
 */
function extractAtQuery(
  value: string,
  cursorPos: number
): { query: string; startPos: number } | null {
  // Search backwards from cursor position for @
  let atPos = -1;
  for (let i = cursorPos - 1; i >= 0; i--) {
    const char = value[i];
    if (char === '@') {
      atPos = i;
      break;
    }
    // Stop if we encounter whitespace or other special characters
    if (/[\s,;!?()[\]{}'"<>]/.test(char)) {
      break;
    }
  }

  if (atPos === -1) {
    return null;
  }

  // @ must be at start of line or preceded by whitespace
  if (atPos > 0 && !/[\s]/.test(value[atPos - 1])) {
    return null;
  }

  const query = value.substring(atPos + 1, cursorPos);
  return { query, startPos: atPos };
}

/**
 * Chat input component
 *
 * Performance optimizations:
 * 1. Uses React.memo to avoid re-renders when parent updates
 * 2. Uses useCallback to cache event handlers
 * 3. Minimizes props, only passes necessary data
 */
export const ChatInput = memo<ChatInputProps>(
  ({
    value,
    onChange,
    onSend,
    onStop,
    isLoading,
    isDisabled,
    placeholder,
    selectedLibraryName,
    selectedLibraryDocCount,
    autoFocus = false,
  }) => {
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const { t } = useTranslation();
    const resolvedPlaceholder = placeholder ?? t('chat.inputPlaceholder');
    const [isFocused, setIsFocused] = useState(false);
    // Use ref to track if focus should be maintained, avoiding re-render cycle issues with state
    const shouldKeepFocus = useRef(false);

    /**
     * Safe focus: save and restore all parent container scroll positions
     */
    const focusInput = useCallback(() => {
      const textarea = inputRef.current;
      if (!textarea) return;

      const scrollPositions: Array<{ el: Element; top: number; left: number }> = [];
      let parent: Element | null = textarea.parentElement;
      while (parent) {
        if (parent.scrollTop !== 0 || parent.scrollLeft !== 0) {
          scrollPositions.push({
            el: parent,
            top: parent.scrollTop,
            left: parent.scrollLeft,
          });
        }
        parent = parent.parentElement;
      }

      try {
        textarea.focus({ preventScroll: true });
      } catch {
        // fallback for older browsers
        textarea.focus();
      }

      // Immediately restore scroll positions
      for (const { el, top, left } of scrollPositions) {
        el.scrollTop = top;
        el.scrollLeft = left;
      }
    }, []);

    const [showCompletion, setShowCompletion] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [atQueryInfo, setAtQueryInfo] = useState<{ query: string; startPos: number } | null>(
      null
    );
    const { filteredItems, setQuery } = useFileCompletion(50);
    const completionVisible = showCompletion && filteredItems.length > 0;

    const updateAtQuery = useCallback(() => {
      const textarea = inputRef.current;
      if (!textarea) return;

      const cursorPos = textarea.selectionStart;
      const info = extractAtQuery(value, cursorPos);

      if (info) {
        setAtQueryInfo(info);
        setQuery(info.query);
        setShowCompletion(true);
        setSelectedIndex(0);
      } else {
        setShowCompletion(false);
        setAtQueryInfo(null);
      }
    }, [value, setQuery]);

    const insertCompletion = useCallback(
      (item: CompletionItem) => {
        if (!atQueryInfo) return;

        const before = value.substring(0, atQueryInfo.startPos);
        const after = value.substring(atQueryInfo.startPos + 1 + atQueryInfo.query.length);

        const newValue = `${before}@${item.path}${after}`;
        onChange(newValue);
        setShowCompletion(false);
        setAtQueryInfo(null);

        // Move cursor after inserted content
        requestAnimationFrame(() => {
          const textarea = inputRef.current;
          if (textarea) {
            const newPos = before.length + 1 + item.path.length;
            textarea.setSelectionRange(newPos, newPos);
            focusInput();
          }
        });
      },
      [value, atQueryInfo, onChange, focusInput]
    );

    useEffect(() => {
      const textarea = inputRef.current;
      if (textarea) {
        textarea.style.height = 'auto';
        const newHeight = Math.max(44, Math.min(textarea.scrollHeight, 200)); // Min 44px (~1 line), max 200px
        textarea.style.height = `${newHeight}px`;
      }
    }, [value]);

    // Auto-focus with multiple attempts to ensure success
    useEffect(() => {
      if (autoFocus && inputRef.current && !isDisabled) {
        shouldKeepFocus.current = true;

        focusInput();

        // Use multiple delayed attempts to ensure focus after other state updates complete
        const attempts = [0, 50, 100, 200];
        const timers = attempts.map((delay) =>
          setTimeout(() => {
            if (inputRef.current && document.activeElement !== inputRef.current) {
              focusInput();
            }
          }, delay)
        );

        return () => {
          timers.forEach((timer) => clearTimeout(timer));
        };
      }
    }, [autoFocus, isDisabled, focusInput]);

    // Restore focus after re-render - only execute under specific conditions to avoid frequent triggers
    useLayoutEffect(() => {
      // Only restore if focus is lost and should be maintained
      if (
        shouldKeepFocus.current &&
        inputRef.current &&
        !isDisabled &&
        document.activeElement !== inputRef.current
      ) {
        // Use requestAnimationFrame to delay to next frame, avoiding conflicts with other DOM operations
        const raf = requestAnimationFrame(() => {
          if (shouldKeepFocus.current && inputRef.current) {
            focusInput();
          }
        });
        return () => cancelAnimationFrame(raf);
      }
    }, [isDisabled, focusInput]);

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (showCompletion && filteredItems.length > 0) {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex((prev) => (prev + 1) % filteredItems.length);
            return;
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
            return;
          }
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            insertCompletion(filteredItems[selectedIndex]);
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            setShowCompletion(false);
            return;
          }
        }

        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (value.trim() && !isLoading && !isDisabled) {
            onSend();
            shouldKeepFocus.current = true;
          }
        }
      },
      [
        value,
        isLoading,
        isDisabled,
        onSend,
        showCompletion,
        filteredItems,
        selectedIndex,
        insertCompletion,
      ]
    );

    const handleChange = useCallback(
      (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        onChange(e.target.value);
        // Delay @ query update to wait for value update
        requestAnimationFrame(() => {
          updateAtQuery();
        });
      },
      [onChange, updateAtQuery]
    );

    const handleSelect = useCallback(() => {
      updateAtQuery();
    }, [updateAtQuery]);

    const handleFocus = useCallback(() => {
      setIsFocused(true);
      shouldKeepFocus.current = true;
    }, []);

    const handleBlur = useCallback(() => {
      setIsFocused(false);
      shouldKeepFocus.current = false;
    }, []);

    const handleStop = useCallback(async () => {
      if (onStop) {
        onStop();
      }
    }, [onStop]);

    const handleSendClick = useCallback(() => {
      if (value.trim() && !isDisabled) {
        onSend();
        requestAnimationFrame(() => {
          focusInput();
          shouldKeepFocus.current = true;
        });
      }
    }, [value, isDisabled, onSend, focusInput]);

    const containerRef = useRef<HTMLDivElement>(null);

    // Calculate completion panel position (use fixed positioning to avoid affecting layout)
    const [completionPosition, setCompletionPosition] = useState<{
      bottom: number;
      left: number;
      width: number;
    } | null>(null);

    const updateCompletionPosition = useCallback(() => {
      if (!completionVisible || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setCompletionPosition({
        bottom: window.innerHeight - rect.top + 8,
        left: rect.left,
        width: rect.width,
      });
    }, [completionVisible]);

    useEffect(() => {
      if (!completionVisible) return;
      updateCompletionPosition();

      const handleReposition = () => updateCompletionPosition();
      window.addEventListener('resize', handleReposition);

      return () => {
        window.removeEventListener('resize', handleReposition);
      };
    }, [completionVisible, updateCompletionPosition]);

    return (
      <div
        ref={containerRef}
        className="p-4 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] flex-shrink-0 sticky bottom-0"
      >
        <div
          className={`relative transition-all duration-200 rounded-xl border ${
            isFocused
              ? 'border-[var(--color-accent)]/50 ring-2 ring-[var(--color-accent-muted)]'
              : 'border-[var(--color-border)]'
          } bg-[var(--color-bg-tertiary)]`}
        >
          {completionVisible &&
            completionPosition &&
            createPortal(
              <div
                className="fixed rounded-lg overflow-hidden z-[9999] overscroll-contain"
                style={{
                  bottom: completionPosition.bottom,
                  left: completionPosition.left,
                  width: completionPosition.width,
                  background: 'var(--color-bg-elevated)',
                  border: '1px solid var(--color-border)',
                  boxShadow: 'var(--shadow-lg)',
                  overscrollBehavior: 'contain',
                }}
                onWheel={(event) => {
                  event.stopPropagation();
                }}
              >
                <div
                  className="px-3 py-2 text-xs flex items-center gap-2"
                  style={{
                    borderBottom: '1px solid var(--color-border)',
                    color: 'var(--color-text-muted)',
                  }}
                >
                  <AtSign size={12} />
                  <span>{t('chat.fileReference')}</span>
                </div>
                <div className="max-h-48 overflow-y-auto overscroll-contain">
                  {filteredItems.map((item, index) => (
                    <button
                      key={item.path}
                      type="button"
                      onClick={() => insertCompletion(item)}
                      onMouseEnter={() => setSelectedIndex(index)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left cursor-pointer transition-colors"
                      style={{
                        background:
                          index === selectedIndex ? 'var(--color-bg-hover)' : 'transparent',
                        color: 'var(--color-text-primary)',
                      }}
                    >
                      {item.type === 'directory' ? (
                        <Folder size={14} style={{ color: 'var(--color-warning)' }} />
                      ) : (
                        <File size={14} style={{ color: 'var(--color-info)' }} />
                      )}
                      <span className="truncate">{item.path}</span>
                    </button>
                  ))}
                </div>
              </div>,
              document.body
            )}

          <textarea
            ref={inputRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onSelect={handleSelect}
            placeholder={resolvedPlaceholder}
            rows={1}
            disabled={isLoading || isDisabled}
            className="w-full px-4 py-3 pr-12 text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] resize-none focus:outline-none bg-transparent transition-colors disabled:opacity-50 overflow-y-auto"
            style={{ minHeight: '44px' }}
          />
          <div className="absolute right-2 bottom-2 flex items-center gap-2">
            {isLoading ? (
              <IconButton
                onClick={handleStop}
                variant="destructive"
                className="bg-[var(--color-error)] hover:bg-[var(--color-error)]/80 text-white"
                tooltip={t('chat.stopGeneration')}
              >
                <Square size={14} className="fill-current" />
              </IconButton>
            ) : (
              <IconButton
                onClick={handleSendClick}
                disabled={!value.trim() || isDisabled}
                variant={value.trim() && !isDisabled ? 'solid' : 'default'}
                className={
                  value.trim() && !isDisabled
                    ? 'bg-[var(--color-accent)] hover:bg-[var(--color-accent-dim)] text-white'
                    : ''
                }
                tooltip={t('chat.sendMessage')}
              >
                <Send size={14} />
              </IconButton>
            )}
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between px-1">
          <div className="flex items-center gap-3">
            {selectedLibraryName ? (
              <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
                <BookOpen size={10} className="text-[var(--color-accent)]" />
                <span>
                  KB:{' '}
                  <span className="text-[var(--color-text-secondary)] font-medium">
                    {selectedLibraryName}
                  </span>{' '}
                  ({selectedLibraryDocCount ?? 0})
                </span>
              </div>
            ) : null}

            <div className="flex items-center gap-1.5 text-[10px] text-[var(--color-text-muted)]">
              <AtSign size={10} />
              <span>{t('chat.atReference')}</span>
            </div>
          </div>

          {value.length > 0 && !isLoading && (
            <div className="text-[10px] text-[var(--color-text-disabled)] animate-fade-in">
              <kbd className="px-1 py-0.5 rounded bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-[var(--color-text-muted)]">
                Enter
              </kbd>{' '}
              {t('chat.toSend')}
            </div>
          )}
        </div>
      </div>
    );
  },
  (prevProps, nextProps) => {
    // Custom comparison: only re-render when these props change
    return (
      prevProps.value === nextProps.value &&
      prevProps.isLoading === nextProps.isLoading &&
      prevProps.isDisabled === nextProps.isDisabled &&
      prevProps.placeholder === nextProps.placeholder &&
      prevProps.selectedLibraryName === nextProps.selectedLibraryName &&
      prevProps.selectedLibraryDocCount === nextProps.selectedLibraryDocCount &&
      prevProps.autoFocus === nextProps.autoFocus
    );
  }
);

ChatInput.displayName = 'ChatInput';
