/**
 * @file ActiveRecommendationSegment.tsx — Active citation recommendation badge + popover in the StatusBar.
 *
 * Shape (attention psychology): a persistent "✨ N" badge in the bottom status bar — visible in
 * peripheral vision, fixed slot, zero footprint in the body, never interrupting writing. Users
 * can click to open and see the top-3 cards; clicking elsewhere auto-closes it. This migrates
 * recommendations from "file-tree drawer (pull-based, usually collapsed → delivery fails)" to
 * "status bar (ambient, push-based delivery)".
 *
 * All data and insertion are driven by ActiveRecommendationService (subscribe / getState /
 * insertCitation); this component only renders. When indexState='disabled' → return null (no
 * placeholder), aligned with ZoteroStatusBadge. Counter updates silently without animation
 * (protecting the active-jank red line).
 */

import { Loader2, Sparkles } from 'lucide-react';
import type React from 'react';
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useClickOutside } from '../../hooks';
import { useTranslation } from '../../locales';
import {
  getActiveRecommendationService,
  type RecommendationState,
} from '../../services/zotero/ActiveRecommendationService';

export const ActiveRecommendationSegment: React.FC = () => {
  const { t } = useTranslation();
  const svc = getActiveRecommendationService();
  const state = useSyncExternalStore(
    (l) => svc.subscribe(l),
    () => svc.getState(),
    () => svc.getState()
  );
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();

  useClickOutside(containerRef, () => setOpen(false), open);

  // Feature disabled → hide the whole badge, no placeholder.
  if (state.indexState === 'disabled') return null;

  const busy = state.indexState === 'building' || state.loading;
  const dim = state.indexState === 'no-key' || state.indexState === 'error';

  return (
    <div
      ref={containerRef}
      className="relative h-full"
      style={{ borderLeft: '1px solid var(--color-border-subtle)' }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-3 h-full transition-colors cursor-pointer hover:bg-[var(--color-bg-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
        title={t('zoteroRecommend.title')}
        aria-label={t('zoteroRecommend.title')}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? popoverId : undefined}
      >
        {busy ? (
          <Loader2
            size={11}
            className="animate-spin"
            style={{ color: 'var(--color-text-muted)' }}
          />
        ) : (
          <Sparkles
            size={11}
            style={{ color: dim ? 'var(--color-text-disabled)' : 'var(--color-accent)' }}
          />
        )}
        {state.items.length > 0 && (
          <span className="text-[11px] font-medium" style={{ color: 'var(--color-text-muted)' }}>
            {state.items.length}
          </span>
        )}
      </button>

      {open && (
        <RecommendationPopover
          id={popoverId}
          state={state}
          onInsert={(key) => {
            svc.insertCitation(key);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
};

interface PopoverProps {
  id?: string;
  state: RecommendationState;
  onInsert: (citationKey: string) => void;
  onClose?: () => void;
}

const RecommendationPopover: React.FC<PopoverProps> = ({ id, state, onInsert, onClose }) => {
  const { t } = useTranslation();
  const popoverRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const firstAction = popoverRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');

    if (firstAction) {
      firstAction.focus();
    } else {
      popoverRef.current?.focus();
    }

    return () => {
      previouslyFocusedRef.current?.focus();
    };
  }, []);

  return (
    <div
      ref={popoverRef}
      id={id}
      role="dialog"
      aria-label={t('zoteroRecommend.title')}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose?.();
          return;
        }

        if (event.key !== 'Tab') return;

        const actions = Array.from(
          popoverRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []
        );
        if (actions.length === 0) {
          event.preventDefault();
          popoverRef.current?.focus();
          return;
        }

        const firstAction = actions[0];
        const lastAction = actions[actions.length - 1];

        if (event.shiftKey && document.activeElement === firstAction) {
          event.preventDefault();
          lastAction.focus();
        } else if (!event.shiftKey && document.activeElement === lastAction) {
          event.preventDefault();
          firstAction.focus();
        }
      }}
      className="absolute bottom-full right-0 mb-1 w-72 rounded-xl py-1 z-50 text-[11px]"
      style={{
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--color-border)',
        boxShadow: 'var(--shadow-lg)',
        color: 'var(--color-text-secondary)',
      }}
    >
      <div
        className="px-3 py-1.5 font-semibold uppercase tracking-wider text-[11px]"
        style={{
          color: 'var(--color-text-muted)',
          borderBottom: '1px solid var(--color-border-subtle)',
        }}
      >
        {t('zoteroRecommend.title')}
      </div>
      <RecommendationBody state={state} onInsert={onInsert} />
    </div>
  );
};

const RecommendationBody: React.FC<PopoverProps> = ({ state, onInsert }) => {
  const { t } = useTranslation();
  if (state.indexState === 'no-key') return <Hint text={t('zoteroRecommend.noKey')} />;
  if (state.indexState === 'building') return <Hint text={t('zoteroRecommend.building')} />;
  if (state.indexState === 'error') return <Hint text={t('zoteroRecommend.error')} />;
  if (state.loading && state.items.length === 0)
    return <Hint text={t('zoteroRecommend.loading')} />;
  if (state.items.length === 0) return <Hint text={t('zoteroRecommend.empty')} />;

  return (
    <ul role="list" className="max-h-72 overflow-y-auto py-1">
      {state.items.map((item) => (
        <li key={item.itemKey}>
          <button
            type="button"
            onClick={() => onInsert(item.citationKey ?? item.itemKey)}
            title={t('zoteroRecommend.insertHint')}
            className="block w-full cursor-pointer px-3 py-1.5 text-left hover:bg-[var(--color-bg-hover)] focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]"
          >
            <div
              className="truncate text-[12px] text-[var(--color-text-primary)]"
              title={item.title}
            >
              {item.title}
            </div>
            {item.reason && (
              <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-secondary)]">
                {item.reason}
              </div>
            )}
            <div className="mt-0.5 font-mono text-[10px] text-[var(--color-text-muted)]">
              {item.citationKey ?? item.itemKey}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
};

const Hint: React.FC<{ text: string }> = ({ text }) => (
  <div className="px-3 py-2 text-[11px] text-[var(--color-text-muted)]">{text}</div>
);
