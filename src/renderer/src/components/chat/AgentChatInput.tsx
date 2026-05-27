/**
 * @file AgentChatInput - text input + send / cancel for the Agent chat panel.
 *
 * Distinct from the legacy `ChatInput` used by the older Chat subsystem.
 *
 * Composer "task mode" is modeled as a **one-shot armed flag** owned by this
 * component. Submitting always resets it — the parent dispatches by the
 * `intent` it receives, never by querying mode state. This keeps the
 * consume-then-reset semantics atomic and physically prevents the
 * "forgot to clear taskMode after send" class of bugs.
 *
 * `@` autocomplete is wired by composing three pieces:
 *   - `useMentionTrigger` parses the token under the caret
 *   - `useFilePathIndex` exposes the project's file list (watcher-backed)
 *   - `AtFileDropdown` renders + keyboard-navigates the candidate set
 * Each piece is independent; this component only wires data flow.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMentionTrigger } from '../../hooks/useMentionTrigger';
import { useZoteroWizardController } from '../../hooks/useZoteroWizard';
import { useTranslation } from '../../locales';
import { useFilePathIndex } from '../../services/core/hooks';
import type { BibSearchHit } from '../../services/zotero/bibSearchScoring';
import { getZoteroBibMirror } from '../../services/zotero/ZoteroBibMirror';
import { AtCiteDropdown } from './AtCiteDropdown';
import { AtFileDropdown, scoreFilePath } from './AtFileDropdown';

export type SendIntent = 'chat' | 'composer';

export interface ComposerChipConfig {
  /** Label shown on the chip (e.g. "任务模式"). */
  label: string;
  /** Tooltip when chip is currently armed (e.g. "下次发送将触发任务模式"). */
  armedTooltip?: string;
  /** Tooltip when chip is idle. */
  idleTooltip?: string;
}

interface AgentChatInputProps {
  busy: boolean;
  disabled?: boolean;
  placeholder?: string;
  /**
   * Submit callback. `intent` reflects the input's armed state at submit
   * time; armed state is reset immediately after dispatch so callers never
   * need to (and cannot) manage it externally.
   */
  onSend: (text: string, intent: SendIntent) => void;
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
  /**
   * When provided, renders a 🛠 toggle chip that arms the next submit as
   * a composer (plan-first) turn. Omit to hide the chip entirely.
   */
  composer?: ComposerChipConfig;
}

const DROPDOWN_MAX_ITEMS = 12;

export function AgentChatInput({
  busy,
  disabled,
  placeholder,
  onSend,
  onCancel,
  seedValue,
  seedKey,
  composer,
}: AgentChatInputProps): React.ReactElement {
  const { t } = useTranslation();
  const [value, setValue] = useState<string>('');
  const [armed, setArmed] = useState<boolean>(false);
  const [caretPos, setCaretPos] = useState<number>(0);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [citeCandidates, setCiteCandidates] = useState<BibSearchHit[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const filePathIndex = useFilePathIndex();
  const wizard = useZoteroWizardController();

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
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seedValue is intentionally not a dep
  }, [seedKey]);

  // ----- @ autocomplete -----

  const trigger = useMentionTrigger(value, caretPos);

  // Two-mode dropdown: plain query => file picker; `cite:` prefix =>
  // citation picker. Mutually exclusive — checking the cite prefix first
  // keeps the file dropdown unaware of citations.
  const citeQuery = useMemo(() => {
    if (!trigger) return null;
    const m = /^cite:(.*)$/i.exec(trigger.query);
    return m ? m[1] : null;
  }, [trigger]);

  const fileDropdownActive = trigger !== null && !trigger.query.includes(':');
  const citeDropdownActive = trigger !== null && citeQuery !== null;

  const candidates = useMemo(() => {
    if (!fileDropdownActive || !trigger) return [];
    if (filePathIndex.length === 0) return [];
    const scored: Array<{ path: string; score: number }> = [];
    for (const path of filePathIndex) {
      const score = scoreFilePath(path, trigger.query);
      if (score >= 0) scored.push({ path, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, DROPDOWN_MAX_ITEMS).map((s) => s.path);
  }, [fileDropdownActive, trigger, filePathIndex]);

  // ----- citation candidates (sync,from main canonical mirror) -----
  // mirror.searchByQueryWithScore 是同步;主线程实测 <8ms / 5k entry。空索引
  // (mirror 还没 hydrate 或 itemCount=0)弹 just-in-time wizard(PM-3)。
  useEffect(() => {
    if (!citeDropdownActive || citeQuery === null) {
      setCiteCandidates([]);
      return;
    }
    const mirror = getZoteroBibMirror();
    const state = mirror.getState();
    if (!state.ready || state.itemCount === 0) {
      wizard.open();
      setCiteCandidates([]);
      return;
    }
    setCiteCandidates(mirror.searchByQueryWithScore(citeQuery, DROPDOWN_MAX_ITEMS));
  }, [citeDropdownActive, citeQuery, wizard]);

  // Reset selection whenever the candidate set changes shape — avoids
  // pointing at an out-of-range index after the query narrows.
  useEffect(() => {
    setSelectedIndex(0);
  }, [trigger?.query, candidates.length, citeCandidates.length]);

  const applyMention = useCallback(
    (path: string) => {
      if (!trigger) return;
      // Append a trailing space so a subsequent `@` keeps triggering.
      const before = value.slice(0, trigger.replaceFrom);
      const after = value.slice(trigger.replaceTo);
      const inserted = `@${path} `;
      const next = `${before}${inserted}${after}`;
      const nextCaret = before.length + inserted.length;
      setValue(next);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(nextCaret, nextCaret);
        setCaretPos(nextCaret);
      });
    },
    [trigger, value]
  );

  const applyCiteMention = useCallback(
    (hit: BibSearchHit) => {
      if (!trigger) return;
      // 优先用人类可读 BBT key,BBT 缺失时退到 Zotero itemKey,任一形态都
      // 给 LLM 一个稳定 identifier。
      const key = hit.item.citationKey ?? hit.item.itemKey;
      const before = value.slice(0, trigger.replaceFrom);
      const after = value.slice(trigger.replaceTo);
      const inserted = `@cite:${key} `;
      const next = `${before}${inserted}${after}`;
      const nextCaret = before.length + inserted.length;
      setValue(next);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(nextCaret, nextCaret);
        setCaretPos(nextCaret);
      });
    },
    [trigger, value]
  );

  const cancelDropdown = useCallback(() => {
    // Nudging caret out of the token via a noop selection update would
    // also work; simplest is just to clear `trigger` indirectly by
    // moving caret one past the @ block. But the trigger is derived,
    // so the cleanest path is to add a space which breaks the token.
    if (!trigger) return;
    const before = value.slice(0, trigger.replaceTo);
    const after = value.slice(trigger.replaceTo);
    setValue(`${before} ${after}`);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      const next = trigger.replaceTo + 1;
      el.focus();
      el.setSelectionRange(next, next);
      setCaretPos(next);
    });
  }, [trigger, value]);

  // ----- send -----

  const submit = useCallback(() => {
    const text = value.trim();
    if (!text || busy || disabled) return;
    const intent: SendIntent = armed ? 'composer' : 'chat';
    onSend(text, intent);
    setValue('');
    setArmed(false);
    setCaretPos(0);
  }, [value, busy, disabled, onSend, armed]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Dropdown captures Up / Down / Enter / Tab / Esc when active so
      // the user can navigate without the textarea hijacking the keys.
      const fileNavigable = fileDropdownActive && candidates.length > 0;
      const citeNavigable = citeDropdownActive && citeCandidates.length > 0;
      if (fileNavigable || citeNavigable) {
        const count = fileNavigable ? candidates.length : citeCandidates.length;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIndex((idx) => Math.min(idx + 1, count - 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIndex((idx) => Math.max(idx - 1, 0));
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          if (fileNavigable) applyMention(candidates[selectedIndex]);
          else applyCiteMention(citeCandidates[selectedIndex]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          cancelDropdown();
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    },
    [
      fileDropdownActive,
      citeDropdownActive,
      candidates,
      citeCandidates,
      selectedIndex,
      applyMention,
      applyCiteMention,
      cancelDropdown,
      submit,
    ]
  );

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    setCaretPos(e.target.selectionStart ?? 0);
  }, []);

  const syncCaret = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    setCaretPos(e.currentTarget.selectionStart ?? 0);
  }, []);

  return (
    <div className="border-t border-[var(--color-border)] bg-[var(--color-bg-primary)] p-2.5">
      {composer && (
        <div className="mb-1.5 flex items-center gap-1">
          <button
            type="button"
            onClick={() => setArmed((v) => !v)}
            disabled={disabled || busy}
            title={armed ? composer.armedTooltip : composer.idleTooltip}
            aria-pressed={armed}
            className={`rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              armed
                ? 'bg-[var(--color-accent)] text-white'
                : 'bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
            }`}
          >
            🛠 {composer.label}
          </button>
        </div>
      )}
      <div className="relative rounded-md border border-[var(--color-border)] bg-[var(--color-bg-elevated)] focus-within:border-[var(--color-accent)]">
        {fileDropdownActive && (
          <AtFileDropdown
            items={candidates}
            selectedIndex={selectedIndex}
            onSelect={applyMention}
            onCancel={cancelDropdown}
          />
        )}
        {citeDropdownActive && (
          <AtCiteDropdown
            items={citeCandidates}
            selectedIndex={selectedIndex}
            onSelect={applyCiteMention}
            emptyText={
              citeQuery && citeQuery.length > 0
                ? t('atCiteDropdown.noMatch')
                : t('atCiteDropdown.prompt')
            }
          />
        )}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          placeholder={placeholder ?? (disabled ? '初始化中…' : '问点什么 (Enter 发送, Shift+Enter 换行, @ 引用文件)')}
          disabled={disabled}
          rows={1}
          onKeyDown={handleKeyDown}
          className="w-full resize-none bg-transparent px-3 py-2 pr-12 text-[13px] leading-[1.55] text-[var(--color-text-primary)] caret-[var(--color-accent)] outline-none placeholder:text-[var(--color-text-muted)] disabled:cursor-not-allowed"
        />
        <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1">
          {busy && onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              title="取消"
              className="rounded-md bg-[var(--color-bg-secondary)] px-2 py-1 text-[11px] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-primary)] hover:text-[var(--color-text-primary)]"
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
