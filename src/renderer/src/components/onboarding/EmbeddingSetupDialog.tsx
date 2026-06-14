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
import { useState } from 'react';
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
            className="w-[min(520px,92vw)] rounded-[20px] border p-6 shadow-[var(--shadow-lg)]"
            style={{ borderColor: 'var(--color-border)', background: 'var(--color-bg-elevated)' }}
            initial={{ scale: 0.96, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.96, opacity: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div className="text-base font-semibold text-[var(--color-text-primary)]">
                {t('zoteroEmbedding.dialog.title')}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
              >
                <X size={18} />
              </button>
            </div>

            {/* Privacy notice */}
            <div
              className="mt-4 flex gap-2 rounded-xl p-3 text-[13px] leading-relaxed"
              style={{ background: 'var(--color-warning-muted)', color: 'var(--color-warning)' }}
            >
              <ShieldAlert size={16} className="mt-0.5 shrink-0" />
              <div>
                <div className="font-medium">{t('zoteroEmbedding.dialog.privacyTitle')}</div>
                <div className="mt-1 text-[var(--color-text-secondary)]">
                  {t('zoteroEmbedding.dialog.privacyBody')}
                </div>
              </div>
            </div>

            {/* Provider selection */}
            <label className="mt-4 block text-[13px] font-medium text-[var(--color-text-secondary)]">
              {t('zoteroEmbedding.dialog.providerLabel')}
            </label>
            <div className="mt-1.5 flex gap-2">
              {PROVIDERS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setProvider(p)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm ${
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
            <label className="mt-4 block text-[13px] font-medium text-[var(--color-text-secondary)]">
              {t('zoteroEmbedding.dialog.keyLabel')}
            </label>
            <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={t('zoteroEmbedding.dialog.keyPlaceholder')}
                className="flex-1 bg-transparent py-2 text-sm text-[var(--color-text-primary)] outline-none"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
              >
                {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
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
                className="rounded-lg px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
              >
                {t('zoteroEmbedding.dialog.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={!apiKey.trim() || !consent || saving}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving && <Loader2 size={14} className="animate-spin" />}
                {t('zoteroEmbedding.dialog.save')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
