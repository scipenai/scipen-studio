/**
 * @file SelectionActionCard - 4-button action card for a captured selection.
 *
 * Rendered above the composer inside ChatSidebar when a Ctrl+L / Alt+D
 * capture arrives. Emits `onAction(action)` for the caller to translate into
 * a prompt + ChatSidebar.handleSend; owns no send-side plumbing itself so
 * new features (@ mentions, title generation, composer branch) keep working
 * through the single existing send path.
 */

import { X } from 'lucide-react';
import type React from 'react';
import { useId, useMemo, useState } from 'react';
import type { SelectionAction, UnifiedSelection } from '@shared/types/selection-action';
import { useTranslation, type TranslationKey } from '../../locales';
import {
  SELECTION_MAX_CHARS,
  selectionExceedsLimit,
} from '../../services/agent/selectionActionPrompts';

interface SelectionActionCardProps {
  selection: UnifiedSelection;
  onAction: (action: SelectionAction) => void;
  onDismiss: () => void;
  /**
   * Global gate — disables all four action buttons. Used when the agent
   * is initializing / busy / errored so a fast double-click cannot enqueue
   * multiple turns. Dismiss stays enabled either way.
   */
  disabled?: boolean;
  /**
   * Per-action gates. Values become the button's native `title` tooltip
   * (only — no aria-description is set) explaining why a specific action
   * is unavailable (e.g. Zotero integration off for `find_related_lit_local`).
   * Presence in this record disables the corresponding button.
   *
   * Note: Firefox does not deliver pointer events (and thus doesn't show
   * the `title` tooltip) on `disabled` buttons; the reason is discoverable
   * via keyboard focus / screen reader only in that browser.
   */
  disabledActions?: Partial<Record<SelectionAction, string>>;
}

const ACTION_ORDER: SelectionAction[] = [
  'translate',
  'explain',
  'distill',
  'find_related_lit_local',
];

// Display-only slice cap for the card's blockquote. CSS clamp is visual
// only — the browser still lays out every character in the DOM node —
// so a multi-MB whole-document capture would jank the renderer at mount
// time. 2× the code-point cap always covers what the prompt clamp keeps,
// so nothing the user actually sees is hidden by this slice.
const DISPLAY_SLICE_UNITS = SELECTION_MAX_CHARS * 2;

const ACTION_LABEL_KEY: Record<SelectionAction, TranslationKey> = {
  translate: 'chat.selectionAction.actions.translate',
  explain: 'chat.selectionAction.actions.explain',
  distill: 'chat.selectionAction.actions.distill',
  find_related_lit_local: 'chat.selectionAction.actions.findRelatedLit',
};

export function SelectionActionCard({
  selection,
  onAction,
  onDismiss,
  disabled = false,
  disabledActions,
}: SelectionActionCardProps): React.ReactElement {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // Selection arrives via IPC and the TS `string` guarantee doesn't hold
  // across the wire, so coerce once at the boundary. Downstream uses:
  //   - `rawText` feeds the O(n) limit check + the truncation banner
  //     (must reflect the FULL captured text, not a display-capped copy).
  //   - `displayText` feeds the blockquote render; capped to a bounded
  //     window because CSS clamp is visual only — the browser still lays
  //     out every character in the DOM node, so a multi-MB whole-doc
  //     capture would jank the renderer at mount time.
  //
  // The parent (ChatSidebar) still holds `selection.text` intact for the
  // prompt builder, which enforces its own 20K code-point clamp there.
  const rawText = useMemo(
    () => (typeof selection.text === 'string' ? selection.text : String(selection.text ?? '')),
    [selection.text]
  );
  const truncated = useMemo(() => selectionExceedsLimit(rawText), [rawText]);
  // Cheap UTF-16 code-unit slice (O(k) not O(n)). Trailing ellipsis makes
  // the CSS clamp match reality when the underlying node is already
  // shorter than what would be visible anyway.
  //
  // The slice can land mid surrogate pair (emoji / astral CJK); the tail
  // would then be a lone high surrogate that renders as U+FFFD next to
  // the ellipsis. Trim it if present.
  const displayText = useMemo(() => {
    if (rawText.length <= DISPLAY_SLICE_UNITS) return rawText;
    let sliced = rawText.slice(0, DISPLAY_SLICE_UNITS);
    const lastUnit = sliced.charCodeAt(sliced.length - 1);
    if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) sliced = sliced.slice(0, -1);
    return `${sliced}…`;
  }, [rawText]);
  // React.useId is SSR-safe, deterministic across renders, and never
  // collides across instances — the pattern the rest of the codebase
  // (OverleafDownloadDialog / SelectionSetupDialog / Modal) already uses.
  // A module-level counter would double-mount under Strict Mode and
  // desync in concurrent rendering.
  const blockquoteId = useId();

  const resolveOrigin = (): string => {
    if (selection.source === 'editor') {
      return t('chat.selectionAction.originEditor');
    }
    if (selection.sourceApp) {
      return t('chat.selectionAction.originExternal', { app: selection.sourceApp });
    }
    return t('chat.selectionAction.originExternalUnknown');
  };
  const origin = resolveOrigin();

  return (
    <div
      className="mx-auto mb-2 w-full max-w-3xl rounded-xl border border-[var(--color-accent)]/40 bg-[var(--color-bg-elevated)] px-3 py-2.5 shadow-[var(--shadow-sm)]"
      role="region"
      aria-label={origin}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="truncate text-[11px] font-medium text-[var(--color-text-secondary)]">
          {origin}
        </span>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('chat.selectionAction.dismiss')}
          title={t('chat.selectionAction.dismiss')}
          className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
        >
          <X size={13} aria-hidden="true" />
        </button>
      </div>

      <blockquote
        id={blockquoteId}
        className={`mb-2 whitespace-pre-wrap border-l-2 border-[var(--color-accent)]/40 bg-[var(--color-bg-secondary)] px-2 py-1 text-[11px] leading-relaxed text-[var(--color-text-secondary)] ${
          expanded ? 'max-h-40 overflow-y-auto' : 'line-clamp-2'
        }`}
      >
        {displayText}
      </blockquote>

      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[10px] text-[var(--color-text-muted)]">
          {t('chat.selectionAction.hint')}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={blockquoteId}
          className="cursor-pointer text-[10px] text-[var(--color-text-muted)] underline-offset-2 transition-colors hover:text-[var(--color-text-primary)] hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
        >
          {expanded ? t('chat.selectionAction.collapse') : t('chat.selectionAction.expand')}
        </button>
      </div>

      {truncated && (
        <div
          role="alert"
          className="mb-2 rounded border border-[var(--color-warning)]/40 bg-[var(--color-warning-muted)]/40 px-2 py-1 text-[10px] text-[var(--color-warning)]"
        >
          {t('chat.selectionAction.truncated', { limit: String(SELECTION_MAX_CHARS) })}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {ACTION_ORDER.map((action) => {
          const perActionReason = disabledActions?.[action];
          // Match the prop-doc contract: "Presence in this record disables
          // the corresponding button". Boolean(perActionReason) treated
          // empty strings as absent — a latent bug (no caller passes '',
          // but the mismatch between doc and impl was pointed out).
          const isDisabled = disabled || perActionReason !== undefined;
          // per-action reason takes precedence; fall back to a generic
          // "agent busy / not ready" hint when the button is disabled
          // for the whole-card reason but there's no specific per-action
          // message. Undefined title = silently disabled = bad UX.
          const tooltip =
            perActionReason ?? (disabled ? t('chat.selectionAction.disabledGeneric') : undefined);
          return (
            <button
              key={action}
              type="button"
              onClick={() => onAction(action)}
              disabled={isDisabled}
              title={tooltip}
              className="cursor-pointer rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-text-primary)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--color-border)] disabled:hover:bg-[var(--color-bg-primary)]"
            >
              {t(ACTION_LABEL_KEY[action])}
            </button>
          );
        })}
      </div>
    </div>
  );
}
