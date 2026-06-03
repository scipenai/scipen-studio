/**
 * @file MinerUSetupDialog —— MinerU 精解析的 BYOK token 配置 + 隐私 opt-in 弹框。
 *   just-in-time:用户点「精解析」且无 token 时弹出。token 明文经 IPC 存入
 *   keychain(renderer 永不回读明文);必须勾选同意(PDF 上传第三方云)才能保存。
 */

import { AnimatePresence, motion } from 'framer-motion';
import { Eye, EyeOff, Loader2, ShieldAlert, X } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import { api } from '../../api';
import { useTranslation } from '../../locales';

interface Props {
  open: boolean;
  onClose: () => void;
  /** token 保存成功后回调,调用方据此继续触发解析。 */
  onConfirmed: () => void;
}

export const MinerUSetupDialog: React.FC<Props> = ({ open, onClose, onConfirmed }) => {
  const { t } = useTranslation();
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
              <div className="text-base font-semibold text-[var(--color-text-primary)]">
                {t('zoteroMineru.dialog.title')}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
              >
                <X size={18} />
              </button>
            </div>

            {/* 隐私提示 */}
            <div
              className="mt-4 flex gap-2 rounded-xl p-3 text-[13px] leading-relaxed"
              style={{
                background: 'var(--color-warning-muted)',
                color: 'var(--color-warning)',
              }}
            >
              <ShieldAlert size={16} className="mt-0.5 shrink-0" />
              <div>
                <div className="font-medium">{t('zoteroMineru.dialog.privacyTitle')}</div>
                <div className="mt-1 text-[var(--color-text-secondary)]">
                  {t('zoteroMineru.dialog.privacyBody')}
                </div>
              </div>
            </div>

            {/* token 输入 */}
            <label className="mt-4 block text-[13px] font-medium text-[var(--color-text-secondary)]">
              {t('zoteroMineru.dialog.tokenLabel')}
            </label>
            <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3">
              <input
                type={showToken ? 'text' : 'password'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={t('zoteroMineru.dialog.tokenPlaceholder')}
                className="flex-1 bg-transparent py-2 text-sm text-[var(--color-text-primary)] outline-none"
              />
              <button
                type="button"
                onClick={() => setShowToken((v) => !v)}
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"
              >
                {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>

            {error && <div className="mt-2 text-xs text-[var(--color-error)]">{error}</div>}

            {/* 同意 */}
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
                className="rounded-lg px-4 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
              >
                {t('zoteroMineru.dialog.cancel')}
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={!token.trim() || !consent || saving}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving && <Loader2 size={14} className="animate-spin" />}
                {t('zoteroMineru.dialog.save')}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
