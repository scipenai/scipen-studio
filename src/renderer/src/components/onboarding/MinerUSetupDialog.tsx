/**
 * @file MinerUSetupDialog — BYOK token configuration + privacy opt-in dialog for MinerU
 *   precision parsing. just-in-time: shown when the user clicks "precision parse" without
 *   a token. The plaintext token is persisted into the keychain via IPC (the renderer never
 *   reads the plaintext back); the consent checkbox (PDFs are uploaded to a third-party
 *   cloud) must be ticked before saving is allowed.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { Eye, EyeOff, Loader2, ShieldAlert, X } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api } from '../../api';
import { useTranslation } from '../../locales';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Callback fired after the token is saved successfully; the caller then resumes parsing. */
  onConfirmed: () => void;
}

export const MinerUSetupDialog: React.FC<Props> = ({ open, onClose, onConfirmed }) => {
  const { t } = useTranslation();
  const titleId = useId();
  const tokenId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async (): Promise<void> => {
    if (!token.trim() || !consent) return;
    setSaving(true);
    setError('');
    try {
      const res = await api.zotero.setMinerUApiKey(token.trim());
      if (!res.success) throw new Error('save failed');
      onClose();
      onConfirmed();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!open) return;

    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const firstAction = dialogRef.current?.querySelector<HTMLElement>('button:not(:disabled)');
    (firstAction ?? dialogRef.current)?.focus();

    return () => {
      previouslyFocusedRef.current?.focus();
      previouslyFocusedRef.current = null;
    };
  }, [open]);

  const handleDialogKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ??
          []
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
    [onClose]
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
          onClick={onClose}
        >
          <motion.div
            ref={dialogRef}
            className="w-[min(520px,92vw)] rounded-[20px] border p-6 shadow-[var(--shadow-lg)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
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
              <div id={titleId} className="text-base font-semibold text-[var(--color-text-primary)]">
                {t('zoteroMineru.dialog.title')}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={t('common.close')}
                className="cursor-pointer rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>

            {/* Privacy notice */}
            <div
              className="mt-4 flex gap-2 rounded-xl p-3 text-[13px] leading-relaxed"
              style={{
                background: 'var(--color-warning-muted)',
                color: 'var(--color-warning)',
              }}
            >
              <ShieldAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <div>
                <div className="font-medium">{t('zoteroMineru.dialog.privacyTitle')}</div>
                <div className="mt-1 text-[var(--color-text-secondary)]">
                  {t('zoteroMineru.dialog.privacyBody')}
                </div>
              </div>
            </div>

            {/* Token input */}
            <label
              htmlFor={tokenId}
              className="mt-4 block text-[13px] font-medium text-[var(--color-text-secondary)]"
            >
              {t('zoteroMineru.dialog.tokenLabel')}
            </label>
            <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3">
              <input
                id={tokenId}
                type={showToken ? 'text' : 'password'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={t('zoteroMineru.dialog.tokenPlaceholder')}
                className="flex-1 bg-transparent py-2 text-sm text-[var(--color-text-primary)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
              />
              <button
                type="button"
                onClick={() => setShowToken((v) => !v)}
                aria-label={
                  showToken
                    ? t('zoteroMineru.dialog.hideToken')
                    : t('zoteroMineru.dialog.showToken')
                }
                aria-pressed={showToken}
                className="cursor-pointer rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                {showToken ? (
                  <EyeOff size={16} aria-hidden="true" />
                ) : (
                  <Eye size={16} aria-hidden="true" />
                )}
              </button>
            </div>

            {error && <div className="mt-2 text-xs text-[var(--color-error)]">{error}</div>}

            {/* Consent */}
            <label className="mt-4 flex cursor-pointer items-start gap-2 text-[13px] text-[var(--color-text-secondary)]">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5"
              />
              <span>{t('zoteroMineru.dialog.consent')}</span>
            </label>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="cursor-pointer rounded-lg px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                {t('zoteroMineru.dialog.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={!token.trim() || !consent || saving}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                {t('zoteroMineru.dialog.save')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
