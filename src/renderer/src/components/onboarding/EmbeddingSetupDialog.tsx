/**
 * @file EmbeddingSetupDialog — BYOK embedding configuration dialog for M3 active recommendation.
 *   just-in-time: shown when the user enables "active recommendation" in settings. Provider
 *   selection + key input + privacy opt-in (the currently edited paragraph text will be sent
 *   to the chosen embedding provider). The plaintext key is persisted into the keychain via
 *   IPC and is never read back by the renderer. On successful save, onConfirmed triggers
 *   index building.
 */

import { AnimatePresence, motion } from 'framer-motion';
import { Eye, EyeOff, Loader2, ShieldAlert, X } from 'lucide-react';
import type React from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api } from '../../api';
import { useTranslation } from '../../locales';
import type { ZoteroEmbeddingProvider } from '../../../../../shared/types/zotero';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Callback fired after key + provider are saved successfully (caller then enables
   *  activeRecommendation and starts index building). */
  onConfirmed: () => void;
}

const PROVIDERS: ZoteroEmbeddingProvider[] = ['zhipu', 'aliyun', 'openai'];

export const EmbeddingSetupDialog: React.FC<Props> = ({ open, onClose, onConfirmed }) => {
  const { t } = useTranslation();
  const titleId = useId();
  const providerLabelId = useId();
  const keyId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [provider, setProvider] = useState<ZoteroEmbeddingProvider>('zhipu');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async (): Promise<void> => {
    if (!apiKey.trim() || !consent) return;
    setSaving(true);
    setError('');
    try {
      await api.zotero.setSettings({ embeddingProvider: provider });
      const res = await api.zotero.setEmbeddingApiKey(apiKey.trim());
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
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled)'
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
            style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-elevated)' }}
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
                {t('zoteroEmbedding.dialog.title')}
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
              style={{ background: 'var(--color-warning-muted)', color: 'var(--color-warning)' }}
            >
              <ShieldAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <div>
                <div className="font-medium">{t('zoteroEmbedding.dialog.privacyTitle')}</div>
                <div className="mt-1 text-[var(--color-text-secondary)]">
                  {t('zoteroEmbedding.dialog.privacyBody')}
                </div>
              </div>
            </div>

            {/* Provider selection */}
            <div
              id={providerLabelId}
              className="mt-4 block text-[13px] font-medium text-[var(--color-text-secondary)]"
            >
              {t('zoteroEmbedding.dialog.providerLabel')}
            </div>
            <div className="mt-1.5 flex gap-2" role="radiogroup" aria-labelledby={providerLabelId}>
              {PROVIDERS.map((p) => (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={provider === p}
                  onClick={() => setProvider(p)}
                  className={`flex-1 cursor-pointer rounded-lg border px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${
                    provider === p
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent-muted)] text-[var(--color-accent)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]'
                  }`}
                >
                  {t(`zoteroEmbedding.provider.${p}`)}
                </button>
              ))}
            </div>

            {/* Key input */}
            <label
              htmlFor={keyId}
              className="mt-4 block text-[13px] font-medium text-[var(--color-text-secondary)]"
            >
              {t('zoteroEmbedding.dialog.keyLabel')}
            </label>
            <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3">
              <input
                id={keyId}
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t('zoteroEmbedding.dialog.keyPlaceholder')}
                className="flex-1 bg-transparent py-2 text-sm text-[var(--color-text-primary)] outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-label={
                  showKey
                    ? t('zoteroEmbedding.dialog.hideKey')
                    : t('zoteroEmbedding.dialog.showKey')
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

            {error && <div className="mt-2 text-xs text-[var(--color-error)]">{error}</div>}

            {/* Consent */}
            <label className="mt-4 flex cursor-pointer items-start gap-2 text-[13px] text-[var(--color-text-secondary)]">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-0.5"
              />
              <span>{t('zoteroEmbedding.dialog.consent')}</span>
            </label>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                className="cursor-pointer rounded-lg px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
              >
                {t('zoteroEmbedding.dialog.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={!apiKey.trim() || !consent || saving}
                className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
                {t('zoteroEmbedding.dialog.save')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
