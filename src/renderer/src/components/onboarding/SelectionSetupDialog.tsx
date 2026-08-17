/**
 * @file SelectionSetupDialog — first-time opt-in for cross-app selection capture.
 *
 * Kept structurally similar to MinerUSetupDialog (backdrop, motion, focus trap,
 * consent-checkbox-gates-Save pattern) so the two consent surfaces feel like
 * one product mechanic. Persists the consent flag to ConfigManager via
 * `api.config.set` and lets the caller enable the service on success.
 */

import { ConfigKeys } from '@shared/types/config-keys';
import { AnimatePresence, motion } from 'framer-motion';
import { Loader2, ShieldAlert, X } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api } from '../../api';
import { useTranslation } from '../../locales';

interface Props {
  open: boolean;
  /** Fired when the user dismisses without granting consent. */
  onClose: () => void;
  /**
   * Fired after consent has been persisted. Caller is expected to proceed
   * with enabling the SelectionService; splitting keeps the dialog agnostic
   * of the callback's next step (settings toggle vs. onboarding wizard).
   *
   * Return type accepts a Promise so a caller enabling the service (an
   * async operation) can be awaited by the dialog and its rejection lands
   * in this file's catch block while the dialog is still visible.
   */
  onConfirmed: () => void | Promise<void>;
  /**
   * When false, renders the "copy with Ctrl+C first" caveat that applies
   * on platforms where the native hook is unavailable (Linux / hook
   * load failure).
   */
  hookAvailable: boolean;
}

export const SelectionSetupDialog: React.FC<Props> = ({
  open,
  onClose,
  onConfirmed,
  hookAvailable,
}) => {
  const { t } = useTranslation();
  const titleId = useId();
  // Distinct id for the privacy notice so aria-describedby on the dialog
  // points a screen reader at the actual informed-consent content on open,
  // not just the terse title.
  const privacyId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async (): Promise<void> => {
    if (!consent) return;
    setSaving(true);
    setError('');
    try {
      await api.config.set(ConfigKeys.SelectionCaptureConsent, true, true);
      // Await onConfirmed so its async failures land in the surrounding
      // try/catch and get surfaced on the still-visible dialog. Firing
      // without await would resolve immediately, hand control to
      // onClose(), and any async rejection would fire after the dialog
      // has already begun its exit animation — no error UI, no retry.
      await onConfirmed();
      onClose();
    } catch (err) {
      // Clicking Save disables the focused button, which in Chromium drops
      // focus to <body>; from there the container-level Tab-trap / Escape
      // keydown handler never fires. Refocus the dialog so keyboard /
      // screen-reader users stay inside the consent gate after a failed save.
      dialogRef.current?.focus();
      // Prefix with a localized error label — the raw `err.message` is
      // typically an English IPC string and would surface in a zh-CN
      // dialog mid-flow. Matches the pattern used in SelectionTab.
      const detail = err instanceof Error ? err.message : String(err);
      setError(`${t('common.error')}: ${detail}`);
    } finally {
      setSaving(false);
    }
  };

  // Close-path guard: while `saving` is true, api.config.set may still
  // be in flight. If the user dismisses the dialog now, the promise
  // will finish AFTER unmount and still call onConfirmed — which in
  // the caller flips SelectionService on despite the user's explicit
  // cancel. Blocking every dismiss path during save keeps consent
  // strictly opt-in.
  const guardedClose = useCallback(() => {
    if (saving) return;
    onClose();
  }, [saving, onClose]);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Focus the consent checkbox specifically — not the first tabbable
    // element, which in DOM order is the header X close button. Landing
    // on Close would mean an accidental Enter/Space dismisses the dialog
    // before the user reads the privacy notice, undermining the whole
    // point of an informed-consent gate.
    const consentCheckbox = dialogRef.current?.querySelector<HTMLElement>('input[type="checkbox"]');
    (consentCheckbox ?? dialogRef.current)?.focus();
    return () => {
      previouslyFocusedRef.current?.focus();
      previouslyFocusedRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setConsent(false);
      // Clear any stale error from a previous failed save so reopening
      // the dialog does not imply the current attempt already failed.
      setError('');
    }
  }, [open]);

  const handleDialogKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        guardedClose();
        return;
      }
      if (event.key !== 'Tab') return;
      // Cover every focusable element type. The current dialog only
      // renders button+input, but restricting the selector would silently
      // break Tab cycling the moment someone adds a select / textarea /
      // link / custom tabindex control here.
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [guardedClose]
  );

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-md"
          style={{ background: 'color-mix(in srgb, var(--color-backdrop) 40%, transparent)' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={guardedClose}
        >
          <motion.div
            ref={dialogRef}
            className="w-[min(520px,92vw)] rounded-[20px] border p-6 shadow-[var(--shadow-lg)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={privacyId}
            tabIndex={-1}
            onKeyDown={handleDialogKeyDown}
            style={{
              borderColor: 'var(--color-border)',
              background: 'var(--color-bg-elevated)',
            }}
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.96, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div
                id={titleId}
                className="text-base font-semibold text-[var(--color-text-primary)]"
              >
                {t('selectionConsent.title')}
              </div>
              <button
                type="button"
                onClick={guardedClose}
                disabled={saving}
                aria-label={t('common.close')}
                className="cursor-pointer rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            <div
              id={privacyId}
              className="mt-4 flex gap-2 rounded-xl p-3 text-[13px] leading-relaxed"
              style={{
                background: 'var(--color-warning-muted)',
                color: 'var(--color-warning)',
              }}
            >
              <ShieldAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <div>
                <div className="font-medium">{t('selectionConsent.privacyTitle')}</div>
                <div className="mt-1 text-[var(--color-text-secondary)]">
                  {t('selectionConsent.privacyBody')}
                </div>
              </div>
            </div>

            {!hookAvailable && (
              <div className="mt-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-[12px] text-[var(--color-text-secondary)]">
                {t('selectionConsent.hookUnavailable')}
              </div>
            )}

            {error && (
              <div className="mt-2 text-xs text-[var(--color-error)]" role="alert">
                {error}
              </div>
            )}

            <label className="mt-4 flex cursor-pointer items-start gap-2 text-[13px] text-[var(--color-text-secondary)]">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5 cursor-pointer accent-[var(--color-accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              />
              <span>{t('selectionConsent.consent')}</span>
            </label>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={guardedClose}
                disabled={saving}
                className="cursor-pointer rounded-lg px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t('selectionConsent.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={!consent || saving}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                {t('selectionConsent.save')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
