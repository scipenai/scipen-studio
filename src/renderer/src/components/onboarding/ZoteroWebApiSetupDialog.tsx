/**
 * @file ZoteroWebApiSetupDialog — userId + apiKey capture with live probe
 * @description Web-mode gate: the user must (a) paste a numeric userId
 *              and an API key generated at zotero.org/settings/keys, then
 *              (b) hit "Test" to have main-process `probeWebApi` validate
 *              the pair before we commit the key to keychain. Modelled on
 *              `MinerUSetupDialog.tsx` — same focus trap, escape close,
 *              and secret-input UX. Never round-trips plaintext through
 *              renderer state after save (SecureStorage owns it).
 */

import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, ExternalLink, Eye, EyeOff, Loader2, ShieldAlert, X } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api } from '../../api';
import { useTranslation } from '../../locales';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Fired after a successful test-then-save; caller flips dataSource to 'web'. */
  onConfirmed: () => void;
  /** Pre-fill the userId input from settings; string of digits or empty. */
  initialUserId?: string;
}

export const ZoteroWebApiSetupDialog: React.FC<Props> = ({
  open,
  onClose,
  onConfirmed,
  initialUserId,
}) => {
  const { t } = useTranslation();
  const titleId = useId();
  const userIdInputId = useId();
  const apiKeyInputId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [userId, setUserId] = useState(initialUserId ?? '');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  // Signature of the exact (uid,apiKey) pair that most recently passed probeWebApi.
  // Save is only enabled when this equals the *current* inputs, closing the race
  // where an in-flight ping resolves AFTER the user edited the inputs.
  const [testedSig, setTestedSig] = useState<string | null>(null);
  const [testedUsername, setTestedUsername] = useState<string | null>(null);
  const [error, setError] = useState('');

  const currentSig = `${userId.trim()}:${apiKey.trim()}`;
  const isTested = testedSig === currentSig && testedSig !== ':';

  const handleTest = useCallback(async (): Promise<void> => {
    const uid = userId.trim();
    const key = apiKey.trim();
    if (!uid || !key) return;
    const attemptSig = `${uid}:${key}`;
    setTesting(true);
    setError('');
    setTestedSig(null);
    setTestedUsername(null);
    try {
      const res = await api.zotero.pingWebApi({ userId: uid, apiKey: key });
      if (res.ok) {
        // Only apply the test result if inputs haven't drifted while we waited —
        // else a stale ping would re-enable Save for the wrong credentials.
        setTestedSig(attemptSig);
        setTestedUsername(res.username ?? '');
      } else {
        setError(res.error ?? t('zoteroWebApi.dialog.errorUnknown'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  }, [userId, apiKey, t]);

  const handleSave = useCallback(async (): Promise<void> => {
    const uid = userId.trim();
    const key = apiKey.trim();
    if (!uid || !key || !isTested) return;
    setSaving(true);
    setError('');
    // Persist secret FIRST — if it fails we haven't touched settings, so no
    // orphan userId is left behind. If setSettings then fails, roll back the
    // key so we don't leave a keychain entry for a userId we couldn't record.
    try {
      const keyRes = await api.zotero.setWebApiKey(key);
      if (!keyRes.success) throw new Error(t('zoteroWebApi.dialog.errorSaveFailed'));
      try {
        await api.zotero.setSettings({ webApiUserId: uid });
      } catch (err) {
        await api.zotero.clearWebApiKey().catch(() => undefined);
        throw err;
      }
      onConfirmed();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [userId, apiKey, isTested, onClose, onConfirmed, t]);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const firstAction = dialogRef.current?.querySelector<HTMLElement>(
      'input, button:not(:disabled)'
    );
    (firstAction ?? dialogRef.current)?.focus();
    return () => {
      previouslyFocusedRef.current?.focus();
      previouslyFocusedRef.current = null;
    };
  }, [open]);

  // Reset test-result signature whenever inputs change — the "Connected as X"
  // banner belongs to a specific (uid,key) pair; editing invalidates it and
  // disables Save until the user re-runs Test.
  useEffect(() => {
    setTestedSig(null);
    setTestedUsername(null);
    setError('');
  }, [userId, apiKey]);

  // Fully reset transient + sensitive state whenever the dialog closes.
  // The parent mounts this component permanently (open is a prop, not a
  // conditional render), so without this effect the plaintext apiKey would
  // persist in React state after cancel/save and be visible in DevTools;
  // re-opening the dialog would even re-display the old key if Show was on.
  // Also re-syncs userId to the latest initialUserId prop on re-open, so
  // parent-side edits are reflected instead of showing a stale first-mount value.
  useEffect(() => {
    if (open) {
      setUserId(initialUserId ?? '');
    } else {
      setUserId('');
      setApiKey('');
      setShowKey(false);
      setTestedSig(null);
      setTestedUsername(null);
      setError('');
    }
  }, [open, initialUserId]);

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
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), a[href]'
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
    [onClose]
  );

  const testDisabled = !userId.trim() || !apiKey.trim() || testing;
  const saveDisabled = !isTested || saving;

  // Backdrop click cancels — but not while an IPC save is in flight, else
  // the user could visually dismiss the dialog while the two-step keychain
  // write is mid-flight, leaving them unclear whether the save landed.
  const handleBackdropClick = saving ? undefined : onClose;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-md"
          style={{ background: 'color-mix(in srgb, var(--color-backdrop) 40%, transparent)' }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={handleBackdropClick}
        >
          <motion.div
            ref={dialogRef}
            className="w-[min(560px,92vw)] rounded-[20px] border p-6 shadow-[var(--shadow-lg)]"
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
              <div
                id={titleId}
                className="text-base font-semibold text-[var(--color-text-primary)]"
              >
                {t('zoteroWebApi.dialog.title')}
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

            {/* Where to get the key */}
            <div
              className="mt-4 flex gap-2 rounded-xl p-3 text-[13px] leading-relaxed"
              style={{
                background: 'var(--color-info-muted, var(--color-bg-secondary))',
                color: 'var(--color-text-secondary)',
              }}
            >
              <ShieldAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <div>
                <div className="font-medium text-[var(--color-text-primary)]">
                  {t('zoteroWebApi.dialog.instructionsTitle')}
                </div>
                <div className="mt-1">{t('zoteroWebApi.dialog.instructionsBody')}</div>
                <a
                  href="https://www.zotero.org/settings/keys"
                  target="_blank"
                  rel="noreferrer"
                  className="mt-1 inline-flex items-center gap-1 text-[var(--color-accent)] hover:underline"
                >
                  {t('zoteroWebApi.dialog.openZoteroSettings')}
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              </div>
            </div>

            {/* User ID */}
            <label
              htmlFor={userIdInputId}
              className="mt-4 block text-[13px] font-medium text-[var(--color-text-secondary)]"
            >
              {t('zoteroWebApi.dialog.userIdLabel')}
            </label>
            <input
              id={userIdInputId}
              type="text"
              inputMode="numeric"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder={t('zoteroWebApi.dialog.userIdPlaceholder')}
              className="mt-1.5 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
            />

            {/* API key */}
            <label
              htmlFor={apiKeyInputId}
              className="mt-3 block text-[13px] font-medium text-[var(--color-text-secondary)]"
            >
              {t('zoteroWebApi.dialog.apiKeyLabel')}
            </label>
            <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3">
              <input
                id={apiKeyInputId}
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t('zoteroWebApi.dialog.apiKeyPlaceholder')}
                className="flex-1 bg-transparent py-2 text-sm text-[var(--color-text-primary)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-label={
                  showKey ? t('zoteroWebApi.dialog.hideKey') : t('zoteroWebApi.dialog.showKey')
                }
                aria-pressed={showKey}
                className="cursor-pointer rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                {showKey ? (
                  <EyeOff size={16} aria-hidden="true" />
                ) : (
                  <Eye size={16} aria-hidden="true" />
                )}
              </button>
            </div>

            {/* Test result — only surfaces when the tested (uid,key) still matches
                the current inputs, so an in-flight ping resolving after the user
                edits inputs won't leave a stale "Connected as X" banner. */}
            {isTested && testedUsername !== null && !error && (
              <div className="mt-3 flex items-center gap-2 rounded-lg bg-[var(--color-success-muted,var(--color-bg-secondary))] p-2 text-[13px] text-[var(--color-success)]">
                <CheckCircle2 size={14} aria-hidden="true" />
                <span>
                  {testedUsername
                    ? t('zoteroWebApi.dialog.connectedAs', { username: testedUsername })
                    : t('zoteroWebApi.dialog.connectedNoUsername')}
                </span>
              </div>
            )}
            {error && <div className="mt-3 text-xs text-[var(--color-error)]">{error}</div>}

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="cursor-pointer rounded-lg px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                {t('zoteroWebApi.dialog.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleTest()}
                disabled={testDisabled}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--color-accent)] px-4 py-2 text-sm font-medium text-[var(--color-accent)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {testing && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                {t('zoteroWebApi.dialog.test')}
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saveDisabled}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
                title={!isTested ? t('zoteroWebApi.dialog.saveNeedsTest') : undefined}
              >
                {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                {t('zoteroWebApi.dialog.save')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
